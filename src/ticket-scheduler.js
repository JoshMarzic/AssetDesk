/** Resume durable scheduled ticket pauses, including dates missed while offline. */
export class TicketScheduler {
  constructor({ desk, intervalMs = 1000, logger = console }) {
    if (!desk || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new TypeError('A ticket store and positive scheduler interval are required.');
    this.desk = desk;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
  }
  tick() {
    try { return this.desk.resumeDueTickets(); }
    catch { this.logger.error?.('Scheduled ticket resumption failed; the next scan will retry.'); return 0; }
  }
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
