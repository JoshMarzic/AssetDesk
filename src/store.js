import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function receiptId(message) {
  return createHash('sha256').update(`${message.from.address}\0${message.messageId}`).digest('hex');
}

/** A single durable consumer owns this database. Accepted messages survive restarts. */
export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tickets (
        key TEXT PRIMARY KEY, requester TEXT NOT NULL, subject TEXT NOT NULL,
        page_id INTEGER NOT NULL, page_url TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, sender TEXT NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        ticket_key TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ticket_outbound_messages (
        message_id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, recipient TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY(ticket_key) REFERENCES tickets(key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ticket_outbound_ticket ON ticket_outbound_messages(ticket_key);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(message_id);
      CREATE INDEX IF NOT EXISTS messages_queue ON messages(state, next_attempt);
      CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_key, state);
      UPDATE messages SET state='pending' WHERE state='processing';
    `);
  }
  accept(message) {
    const id = receiptId(message);
    const now = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO messages
      (id,message_id,sender,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, message.messageId, message.from.address, JSON.stringify(message), now, now).changes;
    return { ...this.receipt(id), duplicate: !inserted };
  }
  receipt(id) {
    return this.db.prepare(`SELECT id,state,ticket_key AS ticketKey,attempts,last_error AS error,
      created_at AS createdAt,updated_at AS updatedAt FROM messages WHERE id=?`).get(id);
  }
  message(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return row ? { ...row, message: JSON.parse(row.payload) } : null;
  }
  pendingLocalMessages(limit = 100, after = 0) {
    return this.db.prepare(`SELECT rowid AS local_sequence,* FROM messages WHERE ticket_key IS NULL AND rowid>?
      ORDER BY rowid LIMIT ?`).all(after, limit).map(row => {
      try { return { ...row, message: JSON.parse(row.payload) }; }
      catch { return { ...row, message: null }; }
    });
  }
  bind(id, key) {
    this.db.prepare('UPDATE messages SET ticket_key=? WHERE id=? AND (ticket_key IS NULL OR ticket_key=?)').run(key, id, key);
  }
  next(now = Date.now()) {
    const row = this.db.prepare(`SELECT * FROM messages WHERE state='pending' AND next_attempt<=?
      ORDER BY rowid LIMIT 1`).get(now);
    if (!row) return null;
    this.db.prepare(`UPDATE messages SET state='processing',attempts=attempts+1,updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), row.id);
    return { ...row, attempts: row.attempts + 1, message: JSON.parse(row.payload) };
  }
  findThread(message, supportEmails = []) {
    const references = [...new Set([message.inReplyTo, ...(message.references ?? []).toReversed()].filter(Boolean))];
    for (const reference of references) {
      const ticket = this.db.prepare(`SELECT t.* FROM messages m JOIN tickets t ON t.key=m.ticket_key
        WHERE m.message_id=? AND (t.requester=? OR ?=1) ORDER BY m.rowid LIMIT 1`)
        .get(reference, message.from.address, supportEmails.includes(message.from.address) ? 1 : 0);
      if (ticket) return ticket;
      const outbound = this.db.prepare(`SELECT t.* FROM ticket_outbound_messages m JOIN tickets t ON t.key=m.ticket_key
        WHERE m.message_id=? AND (LOWER(t.requester)=LOWER(?) OR ?=1) LIMIT 1`)
        .get(reference, message.from.address, supportEmails.includes(message.from.address) ? 1 : 0);
      if (outbound) return outbound;
    }
    return null;
  }
  recordOutboundMessage({ messageId, ticketKey, recipient } = {}) {
    const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
    if (typeof messageId !== 'string' || !/^<[^<>\s\x00-\x1f\x7f]{1,990}>$/.test(messageId)
      || typeof ticketKey !== 'string' || ticketKey.length > 100
      || typeof recipient !== 'string' || recipient.length > 254 || !/^[^\s<>\x00-\x1f@]+@[^\s<>\x00-\x1f@]+\.[^\s<>\x00-\x1f@]+$/.test(recipient.trim())) throw invalid('Provide a valid ticket email reference.');
    const ticket = this.ticket(ticketKey);
    if (!ticket) throw invalid('Ticket not found.', 404);
    const address = recipient.trim().toLowerCase();
    if (address !== ticket.requester.trim().toLowerCase()) throw invalid('Automated ticket email must be addressed to the original requester.');
    this.db.prepare('INSERT OR IGNORE INTO ticket_outbound_messages(message_id,ticket_key,recipient,created_at) VALUES(?,?,?,?)').run(messageId, ticketKey, address, new Date().toISOString());
    const saved = this.db.prepare('SELECT message_id,ticket_key,recipient,created_at FROM ticket_outbound_messages WHERE message_id=?').get(messageId);
    if (saved.ticket_key !== ticketKey || saved.recipient !== address) throw invalid('This outgoing email reference already belongs to another ticket.', 409);
    return { ...saved };
  }
  awaitingThread(message, supportEmails = []) {
    for (const reference of [message.inReplyTo, ...(message.references ?? [])].filter(Boolean)) {
      const row = this.db.prepare(`SELECT sender FROM messages WHERE message_id=? AND state!='done' LIMIT 1`).get(reference);
      if (row && (row.sender === message.from.address || supportEmails.includes(message.from.address))) return true;
    }
    return false;
  }
  pendingReference(message, supportEmails = []) {
    for (const reference of [message.inReplyTo, ...(message.references ?? []).toReversed()].filter(Boolean)) {
      const row = this.db.prepare(`SELECT * FROM messages WHERE message_id=? AND ticket_key IS NULL
        AND (sender=? OR ?=1) ORDER BY rowid LIMIT 1`)
        .get(reference, message.from.address, supportEmails.includes(message.from.address) ? 1 : 0);
      if (row) return { ...row, message: JSON.parse(row.payload) };
    }
    return null;
  }
  ticket(key) { return this.db.prepare('SELECT * FROM tickets WHERE key=?').get(key); }
  saveTicket({ key, requester, subject, page_id, page_url, created_at }) {
    const createdAt = created_at && Number.isFinite(Date.parse(created_at)) ? new Date(created_at).toISOString() : new Date().toISOString();
    this.db.prepare(`INSERT INTO tickets (key,requester,subject,page_id,page_url,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET page_id=excluded.page_id,page_url=excluded.page_url`)
      .run(key, requester, subject, page_id, page_url, createdAt);
    return this.ticket(key);
  }
  complete(id, key) {
    this.db.prepare(`UPDATE messages SET state='done',ticket_key=?,last_error=NULL,updated_at=? WHERE id=?`)
      .run(key, new Date().toISOString(), id);
  }
  fail(row, error) {
    const terminal = row.attempts >= 8;
    const delay = Math.min(300_000, 1000 * 2 ** row.attempts);
    // Store only a safe operational summary, not upstream response bodies or credentials.
    const summary = error.safeMessage ?? 'Processing failed; check service connectivity and API permissions.';
    this.db.prepare(`UPDATE messages SET state=?,next_attempt=?,last_error=?,updated_at=? WHERE id=?`)
      .run(terminal ? 'failed' : 'pending', Date.now() + delay, summary, new Date().toISOString(), row.id);
  }
  retry(id) {
    return this.db.prepare(`UPDATE messages SET state='pending',attempts=0,next_attempt=0,last_error=NULL
      WHERE id=? AND state='failed'`).run(id).changes > 0;
  }
  counts() {
    return this.db.prepare('SELECT state,COUNT(*) AS count FROM messages GROUP BY state').all();
  }
  close() { this.db.close(); }
}
