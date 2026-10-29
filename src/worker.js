export class Worker {
  constructor({ store, bookstack, supportEmails = [], logger = console }) {
    Object.assign(this, { store, bookstack, supportEmails, logger });
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
  }
  async process(row) {
    const message = row.message;
    let ticket = this.store.findThread(message, this.supportEmails);
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
        page_id: page.id, page_url: page.url });
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
  }
}
