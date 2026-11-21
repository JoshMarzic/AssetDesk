/** Local, durable email intake. Knowledge and inventory share the same database. */
export class Worker {
  constructor({ store, desk, workspace, supportEmails = [], logger = console, ai }) {
    if (!store || !desk || !workspace) throw new Error('Store, DeskStore, and WorkspaceStore are required.');
    Object.assign(this, { store, desk, workspace, supportEmails, logger, ai });
    this.stopping = false;
    this.running = false;
  }
  accept(message) {
    return this.desk.transaction(() => {
      const accepted = this.store.accept(message);
      this.materialize(this.store.message(accepted.id));
      return { ...this.store.receipt(accepted.id), duplicate: accepted.duplicate };
    });
  }
  materialize(row, trail = new Set()) {
    return this.desk.transaction(() => {
      if (trail.has(row.id)) return null;
      trail.add(row.id);
      const message = row.message;
      const ownKey = `HD-${row.id.slice(0, 16).toUpperCase()}`;
      const receipt = this.store.receipt(row.id);
      let ticket = receipt.ticketKey ? this.store.ticket(receipt.ticketKey) : null;
      ticket ||= this.store.findThread(message, this.supportEmails);
      if (!ticket) {
        const parent = this.store.pendingReference(message, this.supportEmails);
        if (parent && parent.id !== row.id && !trail.has(parent.id)) {
          this.materialize(parent, trail);
          ticket = this.store.findThread(message, this.supportEmails);
        }
      }
      ticket ||= this.store.ticket(ownKey) || this.store.saveTicket({
        key: ownKey, requester: message.from.address, subject: message.subject,
        page_id: 0, page_url: '', created_at: message.receivedAt,
      });
      const isReply = ticket.key !== ownKey;
      this.desk.captureEmail(ticket.key, message, { receiptId: row.id, isReply,
        source: message.desk?.source || 'email',
        reopen: isReply && !this.supportEmails.includes(message.from.address), includeDetails: false });
      for (const ref of message.assetRefs || []) {
        const asset = this.workspace.upsertAutoAsset(ref);
        this.workspace.linkTicket(ticket.key, asset.id);
      }
      this.store.bind(row.id, ticket.key);
      this.store.complete(row.id, ticket.key);
      try { this.ai?.enqueue(ticket.key, { receipt_id: row.id, source: message.desk?.source || 'email', is_reply: isReply, auto_reply_allowed: message.autoReplyAllowed !== false }); }
      catch { this.logger.error?.({ ticket: ticket.key, error: 'AI review could not be queued.' }); }
      return ticket;
    });
  }
  start() { this.wake(); }
  wake() {
    if (!this.running && !this.stopping) {
      this.running = true;
      this.active = this.drain().finally(() => { this.running = false; });
    }
    return this.active;
  }
  async drain() {
    let after = 0;
    while (!this.stopping) {
      const rows = this.store.db.prepare(`SELECT rowid AS local_sequence,* FROM messages
        WHERE rowid>? AND (state!='done' OR ticket_key IS NULL) ORDER BY rowid LIMIT 100`).all(after);
      for (const row of rows) {
        after = row.local_sequence;
        try { this.materialize({ ...row, message: JSON.parse(row.payload) }); }
        catch (error) {
          this.store.fail({ ...row, attempts: row.attempts + 1 }, error);
          this.logger.error({ receipt: row.id, error: error.safeMessage || 'Local ticket recovery failed' });
        }
      }
      if (rows.length < 100) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    // Old manual-link jobs are resolved locally once, without contacting a wiki.
    for (const row of this.store.db.prepare('SELECT * FROM manual_asset_links ORDER BY rowid').all()) {
      try {
        const actor = row.actor_id ? this.desk.user(row.actor_id) : undefined;
        if (row.actor_id && !actor?.active) continue;
        this.workspace.transaction(() => {
          const asset = this.workspace.upsertAutoAsset(row.ref);
          this.workspace.linkTicket(row.ticket_key, asset.id, actor);
          this.store.db.prepare('DELETE FROM manual_asset_links WHERE ticket_key=? AND ref=?').run(row.ticket_key, row.ref);
        });
      } catch (error) { this.logger.error({ ticket: row.ticket_key, error: error.safeMessage || 'Asset recovery failed' }); }
    }
  }
  async stop() { this.stopping = true; await this.active; }
}
