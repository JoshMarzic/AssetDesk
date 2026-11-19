import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES = ['general', 'hardware', 'software', 'network', 'access'];
export const SLA_HOURS = Object.freeze({ low: { response: 24, resolution: 120 }, normal: { response: 8, resolution: 72 }, high: { response: 2, resolution: 24 }, urgent: { response: 1, resolution: 8 } });
const ACTIVE = ['open', 'in_progress', 'waiting'];
const TRANSITIONS = {
  open: ['in_progress', 'waiting', 'resolved'],
  in_progress: ['open', 'waiting', 'resolved'],
  waiting: ['open', 'in_progress', 'resolved'],
  resolved: ['open', 'in_progress', 'closed'],
  closed: ['open'],
};
const now = () => new Date().toISOString();
const digest = token => createHash('sha256').update(String(token)).digest('hex');
const safeUser = user => user ? { id: user.id, name: user.name, email: user.email, role: user.role, active: Boolean(user.active) } : null;
const actorName = actor => actor?.name || actor?.email || 'System';
const DEFAULT_RESPONSES = [
  { id: 'default-more-information', title: 'Request more information', body: 'Hi {{requester}},\n\nTo help us investigate {{ticket_id}} — {{subject}}, please share the exact error message, when the issue started, and the steps to reproduce it.\n\nThank you,\n{{technician}}' },
  { id: 'default-troubleshooting-update', title: 'Troubleshooting update', body: 'Hi {{requester}},\n\nWe are investigating {{ticket_id}} — {{subject}}. We will document our findings and next steps here. Please let us know if anything changes while we work on the issue.\n\n{{technician}}' },
  { id: 'default-resolution-confirmation', title: 'Resolution confirmation', body: 'Hi {{requester}},\n\nWe have completed the work on {{ticket_id}} — {{subject}}. Please confirm that everything is working as expected, or reply with any remaining symptoms.\n\nThank you,\n{{technician}}' },
];
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode, safeMessage: message }); }
function text(value, name, max = 200, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) throw error(`${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
function email(value) {
  const result = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(result)) throw error('Enter a valid email address.');
  return result;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw error('Passwords must contain 12 to 256 characters.');
  return value;
}
async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password(value), salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
function sla(created, priority) {
  const start = Date.parse(created);
  return { response_due_at: new Date(start + SLA_HOURS[priority].response * 3600000).toISOString(), resolution_due_at: new Date(start + SLA_HOURS[priority].resolution * 3600000).toISOString() };
}

/** Persistent ticket workflow, users, and sessions layered onto the existing queue. */
export class DeskStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    const columns = new Set(this.db.prepare('PRAGMA table_info(tickets)').all().map(c => c.name));
    const additions = {
      description: "TEXT NOT NULL DEFAULT ''", requester_name: "TEXT NOT NULL DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT 'open'", priority: "TEXT NOT NULL DEFAULT 'normal'", category: "TEXT NOT NULL DEFAULT 'general'",
      assignee_id: 'TEXT', updated_at: 'TEXT', response_due_at: 'TEXT', resolution_due_at: 'TEXT',
      first_response_at: 'TEXT', resolved_at: 'TEXT', version: 'INTEGER NOT NULL DEFAULT 1',
      source: "TEXT NOT NULL DEFAULT 'email'", resolution: "TEXT NOT NULL DEFAULT ''",
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, type] of Object.entries(additions)) if (!columns.has(name)) this.db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${type}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS technicians (
          id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
          role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desk_sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES technicians(id)
        );
        CREATE TABLE IF NOT EXISTS ticket_notes (
          id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL,
          actor_id TEXT, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ticket_events (
          id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
          actor_id TEXT, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ticket_assets (
          ticket_key TEXT NOT NULL, ref TEXT NOT NULL, page_id INTEGER, url TEXT NOT NULL,
          PRIMARY KEY(ticket_key,ref)
        );
        CREATE TABLE IF NOT EXISTS desk_receipts (receipt_id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ticket_sync (
          ticket_key TEXT PRIMARY KEY, version INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT, queued_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ticket_asset_recovery (
          ticket_key TEXT NOT NULL, ref TEXT NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(ticket_key,ref)
        );
        CREATE TABLE IF NOT EXISTS response_templates (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manual_asset_links (
          ticket_key TEXT NOT NULL, ref TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
          last_error TEXT, created_at TEXT NOT NULL, PRIMARY KEY(ticket_key,ref)
        );
        CREATE INDEX IF NOT EXISTS tickets_workflow ON tickets(status,assignee_id,priority);
        CREATE INDEX IF NOT EXISTS notes_ticket ON ticket_notes(ticket_key,created_at);
        CREATE INDEX IF NOT EXISTS events_ticket ON ticket_events(ticket_key,created_at);
        CREATE INDEX IF NOT EXISTS assets_reference ON ticket_assets(ref,ticket_key);
        CREATE INDEX IF NOT EXISTS tickets_requester ON tickets(requester COLLATE NOCASE,updated_at DESC);
        CREATE INDEX IF NOT EXISTS tickets_missing_sla ON tickets(key)
          WHERE updated_at IS NULL OR response_due_at IS NULL OR resolution_due_at IS NULL;
      `);
      for (const response of DEFAULT_RESPONSES) this.db.prepare('INSERT OR IGNORE INTO response_templates (id,title,body,updated_at,actor_name) VALUES (?,?,?,?,?)').run(response.id, response.title, response.body, now(), 'System');
      if (!columns.has('status')) {
        // The old queue only saved a ticket timestamp after remote processing.
        // On the one-time conversion, recover when the request actually arrived.
        for (const ticket of this.db.prepare('SELECT key,created_at FROM tickets').all()) {
          let earliest = Date.parse(ticket.created_at);
          for (const row of this.db.prepare('SELECT payload FROM messages WHERE ticket_key=?').all(ticket.key)) {
            try {
              const received = Date.parse(JSON.parse(row.payload).receivedAt);
              if (Number.isFinite(received) && received < earliest) earliest = received;
            } catch { /* Invalid legacy payloads do not block the rest of the migration. */ }
          }
          if (earliest < Date.parse(ticket.created_at)) this.db.prepare('UPDATE tickets SET created_at=? WHERE key=?').run(new Date(earliest).toISOString(), ticket.key);
        }
      }
      this.initializeRows();
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    // Legacy queue payloads retain the original message; populate existing tickets without replacing page content.
    for (const row of this.db.prepare(`SELECT m.id,m.ticket_key,m.payload FROM messages m
      LEFT JOIN desk_receipts d ON d.receipt_id=m.id
      WHERE m.state='done' AND m.ticket_key IS NOT NULL AND d.receipt_id IS NULL ORDER BY m.rowid`).all()) {
      if (!this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(row.ticket_key)) continue;
      try {
        const message = JSON.parse(row.payload);
        const exists = this.db.prepare('SELECT 1 FROM desk_receipts WHERE ticket_key=?').get(row.ticket_key);
        this.captureEmail(row.ticket_key, message, { receiptId: row.id, isReply: Boolean(exists), migrate: true });
      } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
  }

  initializeRows() {
    for (const row of this.db.prepare('SELECT key,created_at,priority FROM tickets WHERE updated_at IS NULL OR response_due_at IS NULL OR resolution_due_at IS NULL').all()) {
      const due = sla(row.created_at, row.priority);
      this.db.prepare('UPDATE tickets SET updated_at=COALESCE(updated_at,created_at),response_due_at=COALESCE(response_due_at,?),resolution_due_at=COALESCE(resolution_due_at,?) WHERE key=?')
        .run(due.response_due_at, due.resolution_due_at, row.key);
    }
  }
  transaction(action) {
    // All callers are synchronous; nested local-ingest operations share the same
    // atomic commit instead of issuing multiple WAL fsyncs per accepted ticket.
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  user(id) { return safeUser(this.db.prepare('SELECT * FROM technicians WHERE id=?').get(id)); }
  listTechnicians() { return this.db.prepare('SELECT * FROM technicians ORDER BY active DESC,name COLLATE NOCASE').all().map(safeUser); }
  async ensureAdmin({ name = 'Administrator', email: address, password: secret }) {
    const existing = this.db.prepare("SELECT * FROM technicians WHERE role='admin' AND active=1 LIMIT 1").get();
    if (existing) return safeUser(existing);
    return this.createTechnician({ name, email: address, password: secret, role: 'admin' });
  }
  async createTechnician(input) {
    const name = text(input.name, 'Name', 100), address = email(input.email), role = input.role ?? 'technician';
    if (!['admin', 'technician'].includes(role)) throw error('Select an administrator or technician role.');
    const hash = await hashPassword(input.password);
    if (this.db.prepare('SELECT 1 FROM technicians WHERE email=?').get(address)) throw error('An account with that email already exists.', 409);
    const id = randomUUID();
    this.db.prepare('INSERT INTO technicians (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, address, name, role, hash, now());
    return this.user(id);
  }
  async updateTechnician(id, fields) {
    if (!this.user(id)) throw error('Technician not found.', 404);
    const allowed = ['name', 'role', 'active', 'password'];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length || Object.keys(fields).some(key => !allowed.includes(key))) throw error('Unsupported account field.');
    const suppliedName = fields.name === undefined ? undefined : text(fields.name, 'Name', 100);
    if (fields.role !== undefined && !['admin', 'technician'].includes(fields.role)) throw error('Select an administrator or technician role.');
    if (fields.active !== undefined && typeof fields.active !== 'boolean') throw error('Active must be true or false.');
    const hash = fields.password === undefined ? null : await hashPassword(fields.password);
    return this.transaction(() => {
      // Password hashing yields to other requests. Apply only supplied fields to
      // the current account so a password reset cannot undo a concurrent disable.
      const original = this.user(id);
      if (!original) throw error('Technician not found.', 404);
      const name = suppliedName ?? original.name, role = fields.role ?? original.role, active = fields.active ?? original.active;
      if (original.role === 'admin' && original.active && (role !== 'admin' || !active)) {
        const admins = this.db.prepare("SELECT COUNT(*) AS count FROM technicians WHERE active=1 AND role='admin'").get().count;
        if (admins <= 1) throw error('Keep at least one active administrator.', 409);
      }
      this.db.prepare('UPDATE technicians SET name=?,role=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=?').run(name, role, active ? 1 : 0, hash, id);
      if (!active || hash) this.db.prepare('DELETE FROM desk_sessions WHERE user_id=?').run(id);
      return this.user(id);
    });
  }
  async verifyUser(address, secret) {
    const validInput = typeof address === 'string' && typeof secret === 'string' && secret.length <= 256;
    const row = validInput ? this.db.prepare('SELECT * FROM technicians WHERE email=?').get(address.trim().toLowerCase()) : null;
    const [, salt, expectedHex] = (row?.password_hash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`).split('$');
    const result = await derive(validInput ? secret : '', salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === result.length && timingSafeEqual(expected, result) && row?.active ? safeUser(row) : null;
  }
  createSession(userId) {
    const user = this.user(userId);
    if (!user?.active) throw error('Active account required.', 401);
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 3600000).toISOString();
    this.db.prepare('DELETE FROM desk_sessions WHERE expires_at<=?').run(now());
    this.db.prepare('INSERT INTO desk_sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)').run(digest(token), userId, csrfToken, expiresAt);
    return { token, csrfToken, expiresAt };
  }
  session(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const session = this.db.prepare('SELECT * FROM desk_sessions WHERE token_hash=? AND expires_at>?').get(digest(token), now());
    const user = session ? this.user(session.user_id) : null;
    return user?.active ? { user, csrfToken: session.csrf_token, expiresAt: session.expires_at } : null;
  }
  deleteSession(token) { this.db.prepare('DELETE FROM desk_sessions WHERE token_hash=?').run(digest(token)); }

  decorate(row) {
    if (!row) return null;
    const active = ACTIVE.includes(row.status), timestamp = Date.now();
    const responseOverdue = active && !row.first_response_at && Date.parse(row.response_due_at) < timestamp;
    const resolutionOverdue = active && Date.parse(row.resolution_due_at) < timestamp;
    const { page_id, page_url, ...native } = row;
    return { ...native, assignee: row.assignee_id ? this.user(row.assignee_id) : null,
      is_overdue: responseOverdue || resolutionOverdue, response_overdue: responseOverdue,
      resolution_overdue: resolutionOverdue };
  }
  getTicket(key) {
    this.initializeRows();
    const ticket = this.decorate(this.db.prepare('SELECT * FROM tickets WHERE key=?').get(key));
    if (!ticket) return null;
    return { ...ticket,
      notes: this.db.prepare('SELECT * FROM ticket_notes WHERE ticket_key=? ORDER BY created_at,rowid').all(key),
      events: this.db.prepare('SELECT * FROM ticket_events WHERE ticket_key=? ORDER BY created_at,rowid').all(key) };
  }
  listTickets({ search = '', status, priority, assignee, category, view, sort = 'newest', limit = 100, offset = 0 } = {}) {
    this.initializeRows();
    const clauses = [], args = [];
    for (const [field, value, options] of [['status', status, STATUSES], ['priority', priority, PRIORITIES], ['category', category, CATEGORIES]]) {
      if (!value || value === 'all') continue;
      if (!options.includes(value)) throw error(`Invalid ${field} filter.`);
      clauses.push(`${field}=?`); args.push(value);
    }
    if (search) {
      const term = text(search, 'Search', 200).replace(/[\\%_]/g, value => `\\${value}`);
      clauses.push("(key LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR requester LIKE ? ESCAPE '\\' OR requester_name LIKE ? ESCAPE '\\')");
      args.push(...Array(4).fill(`%${term}%`));
    }
    if (assignee === 'unassigned') clauses.push('assignee_id IS NULL');
    else if (assignee && assignee !== 'all') { clauses.push('assignee_id=?'); args.push(assignee); }
    if (view === 'open') clauses.push("status IN ('open','in_progress','waiting')");
    else if (view === 'unassigned') clauses.push("assignee_id IS NULL AND status IN ('open','in_progress','waiting')");
    else if (view === 'overdue') { clauses.push("status IN ('open','in_progress','waiting') AND (resolution_due_at<? OR (first_response_at IS NULL AND response_due_at<?))"); args.push(now(), now()); }
    else if (view === 'resolved') clauses.push("status IN ('resolved','closed')");
    else if (view && view !== 'all') throw error('Invalid ticket view.');
    const count = Number(limit), start = Number(offset);
    if (!Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(start) || start < 0) throw error('Invalid pagination.');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sorts = {
      newest: 'created_at DESC,key', oldest: 'created_at ASC,key',
      priority: "CASE status WHEN 'closed' THEN 2 WHEN 'resolved' THEN 1 ELSE 0 END,CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,created_at DESC,key",
      due: "CASE status WHEN 'closed' THEN 2 WHEN 'resolved' THEN 1 ELSE 0 END,CASE WHEN first_response_at IS NULL AND response_due_at<resolution_due_at THEN response_due_at ELSE resolution_due_at END ASC,key",
    };
    if (!Object.hasOwn(sorts, sort)) throw error('Invalid ticket sort.');
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM tickets ${where}`).get(...args).count;
    const rows = this.db.prepare(`SELECT * FROM tickets ${where} ORDER BY ${sorts[sort]} LIMIT ? OFFSET ?`).all(...args, count, start);
    return { tickets: rows.map(row => this.decorate(row)), total };
  }
  event(key, type, body, actor) {
    this.db.prepare('INSERT INTO ticket_events (id,ticket_key,type,body,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), key, type, body, actor?.id ?? null, actorName(actor), now());
  }
  updateTicket(key, patch, { actor, version } = {}) {
    const allowed = ['subject', 'status', 'priority', 'category', 'assignee_id', 'resolution', 'first_response'];
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(field => !allowed.includes(field))) throw error('Unsupported ticket field.');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tickets WHERE key=?').get(key);
      if (!row) throw error('Ticket not found.', 404);
      if (!Number.isInteger(version) || row.version !== version) throw error('This ticket changed. Refresh it before saving.', 409);
      const values = { ...row };
      for (const [field, options] of [['status', STATUSES], ['priority', PRIORITIES], ['category', CATEGORIES]]) {
        if (patch[field] !== undefined) { if (!options.includes(patch[field])) throw error(`Invalid ${field}.`); values[field] = patch[field]; }
      }
      if (patch.subject !== undefined) values.subject = text(patch.subject, 'Subject', 240);
      if (patch.assignee_id !== undefined) {
        if (patch.assignee_id !== null && patch.assignee_id !== row.assignee_id && !this.user(patch.assignee_id)?.active) throw error('Assign an active technician or leave this ticket unassigned.');
        values.assignee_id = patch.assignee_id;
      }
      if (patch.resolution !== undefined) values.resolution = text(patch.resolution, 'Resolution', 10000, { empty: true });
      if (values.status !== row.status) {
        if (!TRANSITIONS[row.status].includes(values.status)) throw error('That ticket status transition is not allowed.');
        if (values.status === 'resolved' && !values.resolution.trim()) throw error('Add a resolution summary before resolving this ticket.');
        if (values.status === 'resolved') values.resolved_at = now();
        else if (ACTIVE.includes(values.status)) values.resolved_at = null;
      }
      if (patch.first_response !== undefined && patch.first_response !== true) throw error('First response can only be marked complete.');
      if (patch.first_response === true && !row.first_response_at) values.first_response_at = now();
      if (values.priority !== row.priority) Object.assign(values, sla(row.created_at, values.priority));
      this.db.prepare(`UPDATE tickets SET subject=?,status=?,priority=?,category=?,assignee_id=?,resolution=?,resolved_at=?,first_response_at=?,response_due_at=?,resolution_due_at=?,updated_at=?,version=version+1 WHERE key=?`)
        .run(values.subject, values.status, values.priority, values.category, values.assignee_id, values.resolution, values.resolved_at, values.first_response_at, values.response_due_at, values.resolution_due_at, now(), key);
      for (const field of ['subject', 'status', 'priority', 'category', 'assignee_id']) {
        if (values[field] === row[field]) continue;
        const label = field === 'assignee_id' ? 'Assignee' : field[0].toUpperCase() + field.slice(1);
        const from = field === 'assignee_id' ? this.user(row[field])?.name ?? 'Unassigned' : row[field];
        const to = field === 'assignee_id' ? this.user(values[field])?.name ?? 'Unassigned' : values[field];
        this.event(key, field === 'assignee_id' ? 'assignment' : field, `${label}: ${from} → ${to}`, actor);
      }
      if (values.resolution !== row.resolution) this.event(key, 'resolution', values.resolution || 'Resolution summary cleared', actor);
      if (values.first_response_at !== row.first_response_at) this.event(key, 'response', 'First response marked complete', actor);
      return this.getTicket(key);
    });
  }
  addNote(key, { body, actor, kind = 'note' }) {
    const content = text(body, 'Note', 20000);
    if (kind !== 'note') throw error('Use internal notes for technician comments.');
    if (!this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(key)) throw error('Ticket not found.', 404);
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO ticket_notes (id,ticket_key,body,kind,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?)').run(id, key, content, kind, actor?.id ?? null, actorName(actor), now());
      this.db.prepare('UPDATE tickets SET updated_at=?,version=version+1 WHERE key=?').run(now(), key);
      this.event(key, 'note', 'Added an internal note', actor);
      return this.getTicket(key);
    });
  }
  addAssets(key, assets) {
    if (!this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(key)) throw error('Ticket not found.', 404);
    for (const asset of assets) {
      const ref = text(asset.ref, 'Asset ID', 120).toUpperCase();
      let url; try { url = new URL(asset.url); } catch { throw error('Asset URL must be HTTP or HTTPS.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('Asset URL must be HTTP or HTTPS.');
      this.db.prepare('INSERT INTO ticket_assets (ticket_key,ref,page_id,url) VALUES (?,?,?,?) ON CONFLICT(ticket_key,ref) DO UPDATE SET page_id=excluded.page_id,url=excluded.url').run(key, ref, asset.id ?? null, asset.url);
      this.db.prepare('DELETE FROM ticket_asset_recovery WHERE ticket_key=? AND ref=?').run(key, ref);
    }
  }
  captureEmail(key, message, { receiptId, isReply = false, source = 'email', reopen = true, migrate = false, includeDetails = true } = {}) {
    if (!receiptId) throw error('Receipt ID is required.');
    if (!this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(key)) throw error('Ticket not found.', 404);
    if (this.db.prepare('SELECT 1 FROM desk_receipts WHERE receipt_id=?').get(receiptId)) return includeDetails ? this.getTicket(key) : this.store.ticket(key);
    const body = text(message.text, 'Email body', 100000), name = String(message.from?.name || '').slice(0, 200);
    return this.transaction(() => {
      this.initializeRows();
      this.db.prepare('INSERT INTO desk_receipts (receipt_id,ticket_key) VALUES (?,?)').run(receiptId, key);
      if (!isReply) {
        this.db.prepare('UPDATE tickets SET description=CASE WHEN description=\'\' THEN ? ELSE description END,requester_name=CASE WHEN requester_name=\'\' THEN ? ELSE requester_name END,source=? WHERE key=?').run(body, name, source === 'manual' ? 'manual' : 'email', key);
        const original = this.db.prepare('SELECT created_at,version FROM tickets WHERE key=?').get(key);
        let initialAssignee = null;
        if (original.version === 1) {
          const priority = message.desk?.priority ?? 'normal';
          const category = message.desk?.category ?? 'general';
          if (!PRIORITIES.includes(priority) || !CATEGORIES.includes(category)) throw error('Invalid initial ticket priority or category.');
          initialAssignee = message.desk?.assignee_id && this.user(message.desk.assignee_id)?.active ? message.desk.assignee_id : null;
          const due = sla(original.created_at, priority);
          this.db.prepare('UPDATE tickets SET priority=?,category=?,assignee_id=?,response_due_at=?,resolution_due_at=? WHERE key=?')
            .run(priority, category, initialAssignee, due.response_due_at, due.resolution_due_at, key);
        }
        const actor = source === 'manual' && message.desk?.actor ? message.desk.actor : { name: message.from?.name || message.from?.address || 'Requester' };
        this.event(key, 'created', source === 'manual' ? 'Ticket created manually' : 'Ticket received by email', actor);
        if (initialAssignee) this.event(key, 'assignment', `Assigned to ${this.user(initialAssignee).name}`, actor);
      } else {
        const sender = message.from?.name ? `${message.from.name} (${message.from.address})` : message.from?.address || 'Requester';
        this.db.prepare('INSERT INTO ticket_notes (id,ticket_key,body,kind,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), key, body, 'email', null, sender, message.receivedAt || now());
        const row = this.db.prepare('SELECT status FROM tickets WHERE key=?').get(key);
        if (!migrate && reopen && ['resolved', 'closed'].includes(row.status)) {
          this.db.prepare("UPDATE tickets SET status='open',resolved_at=NULL WHERE key=?").run(key);
          this.event(key, 'status', 'Reopened by an email reply', { name: sender });
        }
        this.event(key, 'email', 'Email update received', { name: sender });
      }
      if (!migrate) this.db.prepare('UPDATE tickets SET updated_at=?,version=version+1 WHERE key=?').run(now(), key);
      return includeDetails ? this.getTicket(key) : this.store.ticket(key);
    });
  }
  listResponses({ includeInactive = false } = {}) {
    return this.db.prepare(`SELECT id,title,body,active,updated_at FROM response_templates ${includeInactive ? '' : 'WHERE active=1'} ORDER BY title COLLATE NOCASE,id`).all()
      .map(row => ({ ...row, active: Boolean(row.active) }));
  }
  createResponse(input, actor) {
    const title = text(input?.title, 'Response title', 100), body = text(input?.body, 'Response body', 10000);
    const id = randomUUID();
    this.db.prepare('INSERT INTO response_templates (id,title,body,updated_at,actor_id,actor_name) VALUES (?,?,?,?,?,?)').run(id, title, body, now(), actor?.id ?? null, actorName(actor));
    return this.listResponses().find(row => row.id === id);
  }
  updateResponse(id, fields, actor) {
    const original = this.db.prepare('SELECT * FROM response_templates WHERE id=?').get(id);
    if (!original) throw error('Saved response not found.', 404);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length || Object.keys(fields).some(key => !['title', 'body', 'active'].includes(key))) throw error('Unsupported saved response field.');
    const title = fields.title === undefined ? original.title : text(fields.title, 'Response title', 100);
    const body = fields.body === undefined ? original.body : text(fields.body, 'Response body', 10000);
    if (fields.active !== undefined && typeof fields.active !== 'boolean') throw error('Active must be true or false.');
    const active = fields.active ?? Boolean(original.active);
    this.db.prepare('UPDATE response_templates SET title=?,body=?,active=?,updated_at=?,actor_id=?,actor_name=? WHERE id=?').run(title, body, active ? 1 : 0, now(), actor?.id ?? null, actorName(actor), id);
    return { id, title, body, active, updated_at: this.db.prepare('SELECT updated_at FROM response_templates WHERE id=?').get(id).updated_at };
  }
  dashboard() {
    this.initializeRows();
    const timestamp = now(), midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const count = (where = '', values = []) => this.db.prepare(`SELECT COUNT(*) AS count FROM tickets ${where ? `WHERE ${where}` : ''}`).get(...values).count;
    const active = "status IN ('open','in_progress','waiting')";
    const counts = {
        total: count(), active: count(active), unassigned: count(`${active} AND assignee_id IS NULL`),
        overdue: count(`${active} AND (resolution_due_at<? OR (first_response_at IS NULL AND response_due_at<?))`, [timestamp, timestamp]),
        awaitingResponse: count(`${active} AND first_response_at IS NULL`), resolvedToday: count("status IN ('resolved','closed') AND resolved_at>=?", [midnight.toISOString()]),
      };
    const activity = this.db.prepare(`SELECT e.*,t.subject AS ticket_subject FROM ticket_events e JOIN tickets t ON t.key=e.ticket_key ORDER BY e.created_at DESC,e.rowid DESC LIMIT 12`).all();
    return {
      stats: { ...counts, open: counts.active }, counts,
      statusCounts: this.db.prepare('SELECT status,COUNT(*) AS count FROM tickets GROUP BY status').all(),
      priorityCounts: this.db.prepare(`SELECT priority,COUNT(*) AS count FROM tickets WHERE ${active} GROUP BY priority`).all(),
      workload: this.db.prepare(`SELECT u.id,u.name,u.email,COUNT(t.key) AS active_tickets,
        SUM(CASE WHEN t.resolution_due_at<? OR (t.first_response_at IS NULL AND t.response_due_at<?) THEN 1 ELSE 0 END) AS overdue_tickets
        FROM technicians u LEFT JOIN tickets t ON t.assignee_id=u.id AND t.status IN ('open','in_progress','waiting')
        WHERE u.active=1 GROUP BY u.id ORDER BY active_tickets DESC,u.name`).all(timestamp, timestamp),
      activity, recentActivity: activity,
      sla: { targetsHours: SLA_HOURS, mode: 'elapsed', dayBoundary: 'UTC' },
    };
  }
}
