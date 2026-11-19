export class Worker {
  constructor({ store, bookstack, desk, supportEmails = [], logger = console }) {
    Object.assign(this, { store, bookstack, desk, supportEmails, logger });
    this.running = false;
    this.timer = null;
    this.stopping = false;
  }
  start() {
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
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
    if (this.desk) {
      this.desk.captureEmail(ticket.key, message, { receiptId: row.id, isReply, source: message.desk?.source || 'email',
        reopen: isReply && !this.supportEmails.includes(message.from.address) });
      this.desk.addAssets(ticket.key, assets);
    }
    this.store.complete(row.id, ticket.key);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
  }
}
