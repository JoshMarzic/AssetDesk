import { randomUUID } from 'node:crypto';

const TABLES = Object.freeze({ statuses: 'ticket_statuses', priorities: 'ticket_priorities', categories: 'ticket_categories' });
const KINDS = ['active', 'resolved', 'closed'];
const DEFAULTS = {
  statuses: [
    ['open', 'Open', 'active'], ['in_progress', 'In progress', 'active'], ['waiting', 'Waiting', 'active'],
    ['resolved', 'Resolved', 'resolved'], ['closed', 'Closed', 'closed'],
  ],
  priorities: [['low', 'Low', 1, 24, 120], ['normal', 'Normal', 2, 8, 72], ['high', 'High', 3, 2, 24], ['urgent', 'Urgent', 4, 1, 8]],
  categories: [['general', 'General'], ['hardware', 'Hardware'], ['software', 'Software'], ['network', 'Network'], ['access', 'Access']],
};
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
const normalized = value => value.normalize('NFKC').toLowerCase();
const dto = row => row ? { ...row, active: Boolean(row.active), system: Boolean(row.system) } : null;

function table(type) {
  if (!Object.hasOwn(TABLES, type)) throw invalid('Choose statuses, priorities, or categories.');
  return TABLES[type];
}
function name(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw invalid('Enter a name with 1 to 100 characters.');
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!result || [...result].length > 100) throw invalid('Enter a name with 1 to 100 characters.');
  return result;
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Provide valid settings fields.');
}
function priorityValues(values) {
  if (!Number.isSafeInteger(values.rank) || values.rank < 1) throw invalid('Priority rank must be a positive whole number.');
  for (const field of ['response_hours', 'resolution_hours']) if (typeof values[field] !== 'number' || !Number.isFinite(values[field]) || values[field] <= 0 || values[field] > 87600) throw invalid('SLA targets must be greater than zero and no more than 87,600 hours.');
  if (values.resolution_hours < values.response_hours) throw invalid('The resolution target must be at least the response target.');
}

/** Persistent workflow choices; immutable IDs keep ticket history stable. */
export class WorkflowSettings {
  constructor(db) {
    this.db = db;
    this.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ticket_statuses (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('active','resolved','closed')),
          active INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ticket_priorities (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, rank INTEGER NOT NULL,
          response_hours REAL NOT NULL, resolution_hours REAL NOT NULL,
          active INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ticket_categories (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ticket_workflow_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
        INSERT OR IGNORE INTO ticket_workflow_meta(id,version) VALUES(1,1);
      `);
      const status = db.prepare('INSERT OR IGNORE INTO ticket_statuses(id,name,kind,system) VALUES (?,?,?,1)');
      for (const values of DEFAULTS.statuses) status.run(...values);
      const priority = db.prepare('INSERT OR IGNORE INTO ticket_priorities(id,name,rank,response_hours,resolution_hours,system) VALUES (?,?,?,?,?,1)');
      for (const values of DEFAULTS.priorities) priority.run(...values);
      const category = db.prepare('INSERT OR IGNORE INTO ticket_categories(id,name,system) VALUES (?,?,1)');
      for (const values of DEFAULTS.categories) category.run(...values);
    });
  }
  transaction(action) {
    if (this.db.isTransaction) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot() {
    const version = this.db.prepare('SELECT version FROM ticket_workflow_meta WHERE id=1').get().version;
    return { version,
      statuses: this.db.prepare('SELECT * FROM ticket_statuses ORDER BY rowid').all().map(dto),
      priorities: this.db.prepare('SELECT * FROM ticket_priorities ORDER BY rank DESC,name COLLATE NOCASE,id').all().map(dto),
      categories: this.db.prepare('SELECT * FROM ticket_categories ORDER BY rowid').all().map(dto) };
  }
  get(type, id) { return typeof id === 'string' ? dto(this.db.prepare(`SELECT * FROM ${table(type)} WHERE id=?`).get(id)) : null; }
  statusKind(id) { return this.get('statuses', id)?.kind || 'active'; }
  isActiveStatus(id) { return this.statusKind(id) === 'active'; }
  validateChoice(type, id, { allowInactiveId } = {}) {
    const record = this.get(type, id);
    if (!record || (!record.active && record.id !== allowInactiveId)) throw invalid(`Choose an active ${type === 'statuses' ? 'status' : type === 'priorities' ? 'priority' : 'category'}.`);
    return record;
  }
  sla(created, priority) {
    const choice = this.get('priorities', priority), start = Date.parse(created);
    if (!choice || !Number.isFinite(start)) throw invalid('Choose a valid priority and submission date.');
    const response = new Date(start + choice.response_hours * 3600000), resolution = new Date(start + choice.resolution_hours * 3600000);
    if (!Number.isFinite(response.getTime()) || !Number.isFinite(resolution.getTime())) throw invalid('SLA deadlines exceed the supported date range.');
    return { response_due_at: response.toISOString(), resolution_due_at: resolution.toISOString() };
  }
  checkVersion(version) {
    if (!Number.isSafeInteger(version) || version < 1) throw invalid('The current settings version is required. Refresh and try again.');
    if (version !== this.db.prepare('SELECT version FROM ticket_workflow_meta WHERE id=1').get().version) throw invalid('Settings changed. Refresh before saving your changes.', 409);
  }
  uniqueName(type, candidate, exceptId) {
    if (this.db.prepare(`SELECT id,name FROM ${table(type)}`).all().some(row => row.id !== exceptId && normalized(row.name) === normalized(candidate))) throw invalid('An option with that name already exists.', 409);
  }
  id(type, candidate) {
    const prefix = candidate.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    let id = /^[a-z]/.test(prefix) ? prefix : `${type === 'statuses' ? 'status' : type === 'priorities' ? 'priority' : 'category'}-${prefix || randomUUID().slice(0, 8)}`;
    if (this.get(type, id)) id = `${id.slice(0, 48)}-${randomUUID().slice(0, 8)}`;
    return id;
  }
  create(type, input, { version, actor } = {}) {
    table(type);
    const allowed = type === 'statuses' ? ['name', 'kind'] : type === 'priorities' ? ['name', 'rank', 'response_hours', 'resolution_hours'] : ['name'];
    fields(input, allowed);
    return this.transaction(() => {
      this.checkVersion(version);
      const label = name(input.name); this.uniqueName(type, label);
      const id = this.id(type, label);
      if (type === 'statuses') {
        if (!KINDS.includes(input.kind)) throw invalid('Choose an active, resolved, or closed status type.');
        this.db.prepare('INSERT INTO ticket_statuses(id,name,kind) VALUES (?,?,?)').run(id, label, input.kind);
      } else if (type === 'priorities') {
        priorityValues(input);
        this.db.prepare('INSERT INTO ticket_priorities(id,name,rank,response_hours,resolution_hours) VALUES (?,?,?,?,?)').run(id, label, input.rank, input.response_hours, input.resolution_hours);
      } else this.db.prepare('INSERT INTO ticket_categories(id,name) VALUES (?,?)').run(id, label);
      this.db.prepare('UPDATE ticket_workflow_meta SET version=version+1 WHERE id=1').run();
      return this.snapshot();
    });
  }
  update(type, id, input, { version, actor } = {}) {
    table(type);
    const allowed = type === 'priorities' ? ['name', 'rank', 'response_hours', 'resolution_hours', 'active', 'recalculate_open_tickets'] : ['name', 'active'];
    fields(input, allowed);
    return this.transaction(() => {
      this.checkVersion(version);
      const original = this.get(type, id);
      if (!original) throw invalid('The settings option was not found.', 404);
      const values = { ...original, ...input, name: input.name === undefined ? original.name : name(input.name) };
      this.uniqueName(type, values.name, id);
      if (input.active !== undefined && typeof input.active !== 'boolean') throw invalid('Active must be true or false.');
      if (original.system && input.active === false) throw invalid('Default workflow options must remain active. Rename or adjust them instead.');
      let affected = 0;
      if (type === 'priorities') {
        priorityValues(values);
        if (input.recalculate_open_tickets !== undefined && typeof input.recalculate_open_tickets !== 'boolean') throw invalid('Choose whether to recalculate active ticket deadlines.');
        this.db.prepare('UPDATE ticket_priorities SET name=?,rank=?,response_hours=?,resolution_hours=?,active=? WHERE id=?').run(values.name, values.rank, values.response_hours, values.resolution_hours, values.active ? 1 : 0, id);
        if (input.recalculate_open_tickets) {
          const rows = this.db.prepare("SELECT t.key,t.created_at FROM tickets t JOIN ticket_statuses s ON s.id=t.status WHERE t.priority=? AND s.kind='active'").all(id);
          const timestamp = new Date().toISOString();
          const update = this.db.prepare('UPDATE tickets SET response_due_at=?,resolution_due_at=?,updated_at=?,version=version+1 WHERE key=?');
          const event = this.db.prepare('INSERT INTO ticket_events(id,ticket_key,type,body,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?)');
          for (const row of rows) {
            const due = this.sla(row.created_at, id);
            update.run(due.response_due_at, due.resolution_due_at, timestamp, row.key);
            event.run(randomUUID(), row.key, 'sla', `SLA deadlines recalculated for ${values.name} from the original submission time`, actor?.id || null, actor?.name || actor?.email || 'System', timestamp);
          }
          affected = rows.length;
        }
      } else this.db.prepare(`UPDATE ${table(type)} SET name=?,active=? WHERE id=?`).run(values.name, values.active ? 1 : 0, id);
      this.db.prepare('UPDATE ticket_workflow_meta SET version=version+1 WHERE id=1').run();
      return { ...this.snapshot(), affected_tickets: affected };
    });
  }
}
