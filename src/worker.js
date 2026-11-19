export class Worker {
  constructor({ store, bookstack, desk, supportEmails = [], logger = console }) {
    Object.assign(this, { store, bookstack, desk, supportEmails, logger });
    this.running = false;
    this.timer = null;
    this.stopping = false;
    this.assetCache = new Map();
  }
  // Acceptance performs only local, durable work. Wiki calls never delay the user.
  accept(message) {
    if (!this.desk) return this.store.accept(message);
    return this.desk.transaction(() => {
      const accepted = this.store.accept(message);
      this.materialize(this.store.message(accepted.id));
      return { ...this.store.receipt(accepted.id), duplicate: accepted.duplicate };
    });
  }
  materialize(row, trail = new Set()) {
    if (!this.desk) return null;
    return this.desk.transaction(() => this.materializeRecord(row, trail));
  }
  materializeRecord(row, trail) {
    if (trail.has(row.id)) return null;
    trail.add(row.id);
    const message = row.message;
    const ownKey = `HD-${row.id.slice(0, 16).toUpperCase()}`;
    const receipt = this.store.receipt(row.id);
    let ticket = receipt.ticketKey ? this.store.ticket(receipt.ticketKey) : null;
    if (!ticket) ticket = this.store.findThread(message, this.supportEmails);
    if (!ticket) {
      // An upgrade may leave an earlier queued message without a local record.
      // Materialize that known parent first so a reply keeps the same ticket.
      const pending = this.store.pendingReference(message, this.supportEmails);
      if (pending && pending.id !== row.id && !trail.has(pending.id)) {
        this.materialize(pending, trail);
        ticket = this.store.findThread(message, this.supportEmails);
      }
    }
    if (!ticket) ticket = this.store.ticket(ownKey) || this.store.saveTicket({
      key: ownKey, requester: message.from.address, subject: message.subject,
      page_id: 0, page_url: '', created_at: message.receivedAt,
    });
    const isReply = ticket.key !== ownKey;
    this.desk.captureEmail(ticket.key, message, { receiptId: row.id, isReply,
      source: message.desk?.source || 'email',
      reopen: isReply && !this.supportEmails.includes(message.from.address), includeDetails: false });
    this.store.bind(row.id, ticket.key);
    return { ticket: this.store.ticket(ticket.key), isReply };
  }
  start() {
    if (this.desk) {
      this.localRecovery = this.recoverLocalQueue().catch(() => {
        this.logger.error({ error: 'Local ticket recovery failed' });
      });
    }
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }
  async recoverLocalQueue() {
    // Resume large pre-upgrade queues in bounded local batches. The continuation
    // runs independently of remote calls so a wiki outage cannot hide the rest.
    let after = 0;
    while (!this.stopping) {
      const rows = this.store.pendingLocalMessages(100, after);
      for (const row of rows) {
        after = row.local_sequence;
        try { this.materialize(row); } catch (error) {
          this.logger.error({ receipt: row.id, error: error.safeMessage || 'Local ticket recovery failed' });
        }
      }
      if (rows.length < 100) break;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  wake() {
    if (!this.running && !this.stopping) {
      this.running = true;
      this.active = this.drain().finally(() => { this.running = false; });
    }
    return this.active;
  }
  async drain() {
    let row;
    while (!this.stopping && (row = this.store.next())) {
      try {
        await this.process(row);
      } catch (error) {
        this.assetCache.clear();
        this.store.fail(row, error);
        this.logger.error({ receipt: row.id, attempt: row.attempts, error: error.safeMessage ?? 'BookStack processing failed' });
      }
    }
    if (this.desk && !this.stopping) {
      for (const link of this.desk.pendingAssetLinks()) {
        if (this.stopping) break;
        try {
          const workspace = await this.bookstack.ensureWorkspace();
          const ticket = this.store.ticket(link.key);
          const asset = await this.bookstack.ensureAsset(link.ref, workspace);
          await this.bookstack.linkAssetToTicket({ id: ticket.page_id }, { ...asset, ref: link.ref });
          await this.bookstack.linkTicketToAsset(asset, { key: ticket.key, id: ticket.page_id, url: ticket.page_url, subject: ticket.subject });
          this.desk.completeAssetLink(link.key, link.ref, { ...asset, ref: link.ref });
        } catch (error) {
          this.desk.failAssetLink(link.key, link.ref, error);
        }
      }
      for (const mention of this.desk.pendingAssetRecovery()) {
        if (this.stopping) break;
        try {
          const asset = await this.bookstack.findAsset(mention.ref);
          if (asset) this.desk.addAssets(mention.key, [{ ...asset, ref: mention.ref }]);
          else this.desk.deferAssetRecovery(mention.key, mention.ref);
        } catch {
          this.desk.deferAssetRecovery(mention.key, mention.ref);
        }
      }
      for (const ticket of this.desk.pendingSync()) {
        if (this.stopping) break;
        try {
          await this.bookstack.syncTicketMetadata(ticket);
          this.desk.markSynced(ticket.key, ticket.version);
        } catch (error) {
          this.desk.failSync(ticket.key, error);
          this.logger.error({ ticket: ticket.key, error: error.safeMessage ?? 'BookStack metadata sync failed' });
        }
      }
    }
  }
  async process(row) {
    if (!this.desk) return this.legacyProcess(row);
    const { ticket: local, isReply } = this.materialize(row);
    const message = row.message;
    let ticket = local;
    if (isReply && !ticket.page_id) {
      const error = new Error('The original ticket is waiting for BookStack synchronization.');
      error.safeMessage = error.message;
      throw error;
    }
    const workspace = await this.bookstack.ensureWorkspace();
    const assets = await this.resolveAssets(message.assetRefs || [], workspace);
    if (isReply) {
      await this.bookstack.appendReply({ id: ticket.page_id, url: ticket.page_url }, {
        id: row.id, from: message.from, text: message.text,
        receivedAt: message.receivedAt, assets,
      });
    } else if (!ticket.page_id) {
      // Local triage may have changed while remote calls were in flight.
      const current = this.desk.getTicket(ticket.key);
      const page = await this.bookstack.ensureTicket({
        key: ticket.key, subject: current.subject,
        requester: { address: current.requester, name: current.requester_name },
        text: current.description || message.text, receivedAt: current.created_at, assets,
      }, workspace);
      ticket = this.store.saveTicket({ key: current.key, requester: current.requester,
        subject: current.subject, page_id: page.id, page_url: page.url,
        created_at: current.created_at });
    }
    for (const asset of assets) {
      await this.bookstack.linkTicketToAsset(asset, {
        key: ticket.key, id: ticket.page_id, url: ticket.page_url, subject: ticket.subject,
      });
    }
    this.desk.addAssets(ticket.key, assets);
    this.store.complete(row.id, ticket.key);
  }
  async resolveAssets(refs, workspace) {
    // Resolve a small number concurrently; repeated devices reuse only IDs/URLs.
    // Backlink methods still fetch current page contents before updating them.
    const assets = new Array(refs.length);
    let next = 0;
    const resolve = async () => {
      while (next < refs.length) {
        const index = next++, ref = refs[index];
        let entry = this.assetCache.get(ref);
        if (!entry || entry.expires < Date.now()) {
          const promise = this.bookstack.ensureAsset(ref, workspace).then(asset => ({ id: asset.id, url: asset.url }));
          entry = { promise, expires: Date.now() + 120000 };
          this.assetCache.delete(ref);
          this.assetCache.set(ref, entry);
          if (this.assetCache.size > 500) this.assetCache.delete(this.assetCache.keys().next().value);
        }
        try { assets[index] = { ...await entry.promise, ref }; }
        catch (error) { this.assetCache.delete(ref); throw error; }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, refs.length) }, resolve));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return assets;
  }
  async legacyProcess(row) {
    const message = row.message;
    let ticket = this.store.findThread(message, this.supportEmails);
    const isReply = Boolean(ticket);
    if (!ticket && this.store.awaitingThread(message, this.supportEmails)) {
      const error = new Error('Referenced message is not processed yet; retry its receipt first.');
      error.safeMessage = error.message;
      throw error;
    }
    const workspace = await this.bookstack.ensureWorkspace();
    const assets = [];
    for (const ref of message.assetRefs) {
      const asset = await this.bookstack.ensureAsset(ref, workspace);
      assets.push({ ...asset, ref });
    }
    if (ticket) {
      await this.bookstack.appendReply({ id: ticket.page_id, url: ticket.page_url }, {
        id: row.id, from: message.from, text: message.text,
        receivedAt: message.receivedAt, assets,
      });
    } else {
      const key = `HD-${row.id.slice(0, 16).toUpperCase()}`;
      const page = await this.bookstack.ensureTicket({
        key, subject: message.subject, requester: message.from,
        text: message.text, receivedAt: message.receivedAt, assets,
      }, workspace);
      ticket = this.store.saveTicket({ key, requester: message.from.address, subject: message.subject,
        page_id: page.id, page_url: page.url, created_at: message.receivedAt });
    }
    for (const asset of assets) {
      await this.bookstack.linkTicketToAsset(asset, {
        key: ticket.key, id: ticket.page_id, url: ticket.page_url, subject: ticket.subject,
      });
    }
    this.store.complete(row.id, ticket.key);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
    await this.localRecovery;
  }
}
