import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { parseRawEmail } from './email.js';

function authorized(token) {
  return (req, res, next) => {
    const value = req.get('authorization') ?? '';
    const expected = Buffer.from(`Bearer ${token}`);
    const provided = Buffer.from(value);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'A valid bearer token is required.' });
    }
    next();
  };
}

export function createApp({ store, worker, bookstack, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  const admin = authorized(config.adminToken);
  const intake = authorized(config.inboundToken);
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await bookstack.checkHealth();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable', error: 'BookStack is unavailable or API permissions are incomplete.' });
    }
  });
  function accepted(message, res) {
    const receipt = store.accept(message);
    worker.wake();
    return res.status(receipt.duplicate ? 200 : 202).json({
      ...receipt, statusUrl: `/api/receipts/${receipt.id}`,
    });
  }
  app.post('/api/inbound/email', intake, express.raw({ type: ['message/rfc822', 'application/octet-stream', 'text/plain'], limit: '10mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Use Content-Type: message/rfc822.' });
    const message = await parseRawEmail(req.body, { prefixes: config.prefixes });
    return accepted(message, res);
  });
  app.post('/api/tickets', admin, express.json({ limit: '512kb' }), async (req, res) => {
    const { subject, from, text, messageId } = req.body ?? {};
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 240 || /[\r\n\0]/.test(subject)
      || typeof from !== 'string' || from.length > 320 || /[\r\n\0]/.test(from)
      || typeof text !== 'string' || !text.trim() || text.length > 100_000
      || (messageId !== undefined && (typeof messageId !== 'string' || !/^<[^<>\s\x00-\x1f]{1,990}>$/.test(messageId)))) {
      return res.status(400).json({ error: 'Provide subject (1–240 characters), from (email), text (1–100000 characters), and an optional RFC Message-ID.' });
    }
    // MIME construction uses validated single-line headers; all rendered content is escaped.
    const raw = `From: ${from}\r\nSubject: ${subject}\r\n${messageId ? `Message-ID: ${messageId}\r\n` : ''}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64')}`;
    return accepted(await parseRawEmail(raw, { prefixes: config.prefixes }), res);
  });
  app.get('/api/receipts/:id', admin, (req, res) => {
    const receipt = store.receipt(req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found.' });
    res.json({ ...receipt, ticket: receipt.ticketKey ? store.ticket(receipt.ticketKey) : null });
  });
  app.post('/api/receipts/:id/retry', admin, (req, res) => {
    if (!store.retry(req.params.id)) return res.status(409).json({ error: 'Only failed receipts can be retried.' });
    worker.wake();
    res.status(202).json(store.receipt(req.params.id));
  });
  app.get('/api/tickets/:key', admin, (req, res) => {
    const ticket = store.ticket(req.params.key);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
    res.json(ticket);
  });
  app.get('/api/queue', admin, (_req, res) => res.json({ counts: store.counts() }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    const code = error.statusCode ?? error.status ?? 500;
    const safeCode = [400, 413, 415].includes(code) ? code : 500;
    const message = safeCode === 500 ? 'Internal error.' : safeCode === 413 ? 'Message is too large.' : error instanceof SyntaxError ? 'Malformed JSON.' : error.message;
    res.status(safeCode).json({ error: message });
  });
  return app;
}
