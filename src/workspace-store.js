import { randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';

export const GENERAL_CATEGORY_ID = '00000000-0000-4000-8000-000000000001';
export const ASSETS_CATEGORY_ID = '00000000-0000-4000-8000-000000000002';
export const ASSET_TYPES = Object.freeze(['personnel', 'pc', 'laptop', 'server', 'printer', 'network', 'peripheral', 'hardware', 'other']);
export const ASSET_STATUSES = Object.freeze(['active', 'spare', 'repair', 'retired', 'unverified']);
const ASSET_TEXT = { name: 200, owner_name: 200, email: 254, department: 200, location: 300, serial_number: 200, manufacturer: 200, model: 200, description: 100_000 };
const stamp = () => new Date().toISOString();
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode, safeMessage: message }); }
function text(value, label, max = 200, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) throw fail(`${label} must contain ${empty ? '0' : '1'} to ${max} characters.`);
  return value.trim();
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fail('Unsupported field.');
}
function auth(user) {
  if (!user?.id || !['admin', 'technician'].includes(user.role) || user.active === false) throw fail('Sign in to continue.', 401);
}
function admin(user) { auth(user); if (user.role !== 'admin') throw fail('Administrator access is required.', 403); }
function pagination({ limit = 50, offset = 0 } = {}) {
  const size = Number(limit), start = Number(offset);
  if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isSafeInteger(start) || start < 0 || start > 1_000_000) throw fail('Invalid pagination.');
  return { limit: size, offset: start };
}
function reference(value) {
  const ref = text(value, 'Asset reference', 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(ref)) throw fail('Asset references may contain letters, numbers, dots, underscores, and hyphens.');
  return ref;
}
function plain(html) { return sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim(); }
function likeTerm(value) { return text(value, 'Search', 200).replace(/[\\%_]/g, c => `\\${c}`); }
function versionOf(patch, options) { return options?.version ?? patch?.version; }
function matchesVersion(row, version) { if (!Number.isSafeInteger(version) || version !== row.version) throw fail('This record changed. Refresh it before saving.', 409); }
function inferType(ref) {
  if (/^(?:PERSON|PERSONNEL|EMPLOYEE|STAFF)-/.test(ref)) return 'personnel';
  if (/^(?:LAPTOP|NOTEBOOK)-/.test(ref)) return 'laptop';
  if (/^(?:PC|DESKTOP)-/.test(ref)) return 'pc';
  if (/^(?:SRV|SERVER)-/.test(ref)) return 'server';
  if (/^(?:PRINTER|PRINT)-/.test(ref)) return 'printer';
  if (/^(?:SW|SWITCH|AP|ROUTER|FW)-/.test(ref)) return 'network';
  if (/^(?:MONITOR|DOCK|KEYBOARD|MOUSE)-/.test(ref)) return 'peripheral';
  return 'hardware';
}

/** Native knowledge, asset inventory, and category access control. */
export class WorkspaceStore {
  constructor(desk) {
    this.desk = desk;
    this.db = desk.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'knowledge', visibility TEXT NOT NULL DEFAULT 'all',
        reader_ids TEXT NOT NULL DEFAULT '[]', editor_ids TEXT NOT NULL DEFAULT '[]',
        allow_staff_edit INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(name COLLATE NOCASE,kind)
      );
      CREATE TABLE IF NOT EXISTS knowledge_articles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL,
        category_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT,
        FOREIGN KEY(category_id) REFERENCES knowledge_categories(id)
      );
      CREATE TABLE IF NOT EXISTS native_assets (
        id TEXT PRIMARY KEY, ref TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'hardware', category_id TEXT NOT NULL,
        owner_id TEXT, owner_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        serial_number TEXT NOT NULL DEFAULT '', manufacturer TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unverified', description TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT, updated_by TEXT,
        FOREIGN KEY(category_id) REFERENCES knowledge_categories(id), FOREIGN KEY(owner_id) REFERENCES native_assets(id)
      );
      CREATE TABLE IF NOT EXISTS native_asset_tickets (
        asset_id TEXT NOT NULL, ticket_key TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT,
        PRIMARY KEY(asset_id,ticket_key), FOREIGN KEY(asset_id) REFERENCES native_assets(id), FOREIGN KEY(ticket_key) REFERENCES tickets(key)
      );
      CREATE TABLE IF NOT EXISTS workspace_media (
        id TEXT PRIMARY KEY, article_id TEXT, asset_id TEXT, category_id TEXT NOT NULL,
        filename TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(article_id) REFERENCES knowledge_articles(id), FOREIGN KEY(asset_id) REFERENCES native_assets(id)
      );
      CREATE TABLE IF NOT EXISTS workspace_imports (
        source TEXT NOT NULL, source_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        imported_at TEXT NOT NULL, PRIMARY KEY(source,source_id,target_type)
      );
      CREATE TABLE IF NOT EXISTS workspace_migrations (name TEXT PRIMARY KEY,completed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS native_articles_category ON knowledge_articles(category_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS native_assets_category ON native_assets(category_id,type,updated_at DESC);
      CREATE INDEX IF NOT EXISTS native_assets_owner ON native_assets(owner_id);
      CREATE INDEX IF NOT EXISTS native_asset_ticket_lookup ON native_asset_tickets(ticket_key,asset_id);
      CREATE INDEX IF NOT EXISTS workspace_media_article ON workspace_media(article_id);
      CREATE INDEX IF NOT EXISTS workspace_media_asset ON workspace_media(asset_id);
    `);
    const time = stamp();
    const insert = this.db.prepare('INSERT OR IGNORE INTO knowledge_categories (id,name,description,kind,system,created_at,updated_at) VALUES (?,?,?,?,1,?,?)');
    insert.run(GENERAL_CATEGORY_ID, 'General', 'Shared guides, procedures, and troubleshooting knowledge.', 'knowledge', time, time);
    insert.run(ASSETS_CATEGORY_ID, 'Assets', 'Personnel, computers, hardware, ownership, and linked support history.', 'assets', time, time);
    this.migrateLegacyAssets();
  }
  transaction(action) { return this.desk.transaction(action); }
  categoryRow(id) { return this.db.prepare('SELECT * FROM knowledge_categories WHERE id=?').get(id); }
  canReadCategory(category, user) {
    if (!category || !user?.id || !['admin', 'technician'].includes(user.role) || user.active === false) return false;
    if (user.role === 'admin') return true;
    return category.visibility === 'all' || JSON.parse(category.reader_ids).includes(user.id) || JSON.parse(category.editor_ids).includes(user.id);
  }
  canEditCategory(category, user) {
    return this.canReadCategory(category, user) && (user.role === 'admin' || JSON.parse(category.editor_ids).includes(user.id) || (category.visibility === 'all' && Boolean(category.allow_staff_edit)));
  }
  categoryResult(row, user) {
    const result = { ...row, system: Boolean(row.system), allow_staff_edit: Boolean(row.allow_staff_edit), canEdit: this.canEditCategory(row, user), canManage: user.role === 'admin' };
    if (user.role === 'admin') { result.reader_ids = JSON.parse(row.reader_ids); result.editor_ids = JSON.parse(row.editor_ids); }
    else { delete result.reader_ids; delete result.editor_ids; }
    return result;
  }
  readableClause(alias, user) {
    auth(user);
    if (user.role === 'admin') return { sql: '1=1', args: [] };
    return { sql: `(${alias}.visibility='all' OR EXISTS(SELECT 1 FROM json_each(${alias}.reader_ids) WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(${alias}.editor_ids) WHERE value=?))`, args: [user.id, user.id] };
  }
  getCategory(id, user) {
    auth(user);
    const row = this.categoryRow(id);
    if (!this.canReadCategory(row, user)) throw fail('Category not found.', 404);
    return this.categoryResult(row, user);
  }
  listCategories(user, { kind } = {}) {
    const access = this.readableClause('c', user);
    if (kind !== undefined && !['knowledge', 'assets'].includes(kind)) throw fail('Invalid category kind.');
    return this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM knowledge_articles a WHERE a.category_id=c.id) AS article_count,
      (SELECT COUNT(*) FROM native_assets a WHERE a.category_id=c.id) AS asset_count
      FROM knowledge_categories c WHERE ${access.sql}${kind ? ' AND c.kind=?' : ''}
      ORDER BY c.system DESC,c.kind,c.name COLLATE NOCASE,c.id`).all(...access.args, ...(kind ? [kind] : [])).map(row => this.categoryResult(row, user));
  }
  validateMembers(values, label) {
    if (!Array.isArray(values) || values.length > 500 || values.some(id => typeof id !== 'string' || !id)) throw fail(`${label} must be a list of technician accounts.`);
    const unique = [...new Set(values)];
    for (const id of unique) if (!this.desk.user(id)) throw fail('Choose existing technician accounts for category access.');
    return unique;
  }
  categoryInput(data, original) {
    fields(data, ['name', 'description', 'kind', 'visibility', 'reader_ids', 'editor_ids', 'allow_staff_edit', 'version']);
    const result = { ...original };
    if (data.name !== undefined) result.name = text(data.name, 'Category name', 100);
    if (data.description !== undefined) result.description = text(data.description, 'Category description', 2000, true);
    if (data.kind !== undefined) { if (!['knowledge', 'assets'].includes(data.kind)) throw fail('Invalid category kind.'); result.kind = data.kind; }
    if (data.visibility !== undefined) { if (!['all', 'restricted'].includes(data.visibility)) throw fail('Choose all staff or restricted category access.'); result.visibility = data.visibility; }
    for (const field of ['reader_ids', 'editor_ids']) if (data[field] !== undefined) result[field] = JSON.stringify(this.validateMembers(data[field], field === 'reader_ids' ? 'Readers' : 'Editors'));
    if (data.allow_staff_edit !== undefined) { if (typeof data.allow_staff_edit !== 'boolean') throw fail('Staff editing must be true or false.'); result.allow_staff_edit = data.allow_staff_edit ? 1 : 0; }
    if (this.db.prepare('SELECT 1 FROM knowledge_categories WHERE name=? COLLATE NOCASE AND kind=? AND id<>?').get(result.name, result.kind, result.id || '')) throw fail('A category with that name already exists.', 409);
    return result;
  }
  createCategory(data, user) {
    admin(user);
    const id = randomUUID(), time = stamp();
    const values = this.categoryInput(data, { id, name: '', description: '', kind: 'knowledge', visibility: 'all', reader_ids: '[]', editor_ids: '[]', allow_staff_edit: 1 });
    if (!values.name) throw fail('Category name is required.');
    this.db.prepare(`INSERT INTO knowledge_categories (id,name,description,kind,visibility,reader_ids,editor_ids,allow_staff_edit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, values.name, values.description, values.kind, values.visibility, values.reader_ids, values.editor_ids, values.allow_staff_edit, time, time);
    return this.getCategory(id, user);
  }
  updateCategory(id, patch, user, options = {}) {
    admin(user);
    return this.transaction(() => {
      const original = this.categoryRow(id);
      if (!original) throw fail('Category not found.', 404);
      matchesVersion(original, versionOf(patch, options));
      const values = this.categoryInput(patch, original);
      if (values.kind !== original.kind) throw fail('A category kind cannot be changed.');
      this.db.prepare(`UPDATE knowledge_categories SET name=?,description=?,visibility=?,reader_ids=?,editor_ids=?,allow_staff_edit=?,updated_at=?,version=version+1 WHERE id=?`)
        .run(values.name, values.description, values.visibility, values.reader_ids, values.editor_ids, values.allow_staff_edit, stamp(), id);
      return this.getCategory(id, user);
    });
  }
  editableCategory(id, user, kind) {
    const category = this.getCategory(id, user);
    if (!category.canEdit) throw fail('You do not have permission to edit this category.', 403);
    if (kind && category.kind !== kind) throw fail('Choose an asset category.');
    return category;
  }
  articleResult(row, user, { includeHtml = true } = {}) {
    const category = this.categoryResult(this.categoryRow(row.category_id), user);
    const result = { ...row, category, canEdit: category.canEdit, kind: 'knowledge', excerpt: plain(row.html).slice(0, 240) };
    if (!includeHtml) delete result.html;
    return result;
  }
  getArticle(id, user) {
    auth(user);
    const row = this.db.prepare('SELECT * FROM knowledge_articles WHERE id=?').get(id);
    if (!row || !this.canReadCategory(this.categoryRow(row.category_id), user)) throw fail('Article not found.', 404);
    return this.articleResult(row, user);
  }
  listArticles(user, filters = {}) {
    const access = this.readableClause('c', user), page = pagination(filters), clauses = [access.sql], args = [...access.args];
    if (filters.category_id) { this.getCategory(filters.category_id, user); clauses.push('a.category_id=?'); args.push(filters.category_id); }
    if (filters.search) { const term = likeTerm(filters.search); clauses.push("(a.name LIKE ? ESCAPE '\\' OR a.html LIKE ? ESCAPE '\\')"); args.push(`%${term}%`, `%${term}%`); }
    const where = clauses.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_articles a JOIN knowledge_categories c ON c.id=a.category_id WHERE ${where}`).get(...args).count;
    const rows = this.db.prepare(`SELECT a.* FROM knowledge_articles a JOIN knowledge_categories c ON c.id=a.category_id WHERE ${where} ORDER BY a.updated_at DESC,a.id LIMIT ? OFFSET ?`).all(...args, page.limit, page.offset);
    return { articles: rows.map(row => this.articleResult(row, user, { includeHtml: false })), total, ...page };
  }
  createArticle(data, user) {
    auth(user); fields(data, ['name', 'html', 'category_id']);
    const name = text(data.name, 'Article name', 255), html = text(data.html, 'Article content', 300000);
    const category = this.editableCategory(data.category_id || GENERAL_CATEGORY_ID, user);
    const id = randomUUID(), time = stamp();
    this.db.prepare('INSERT INTO knowledge_articles (id,name,html,category_id,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, html, category.id, time, time, user.id, user.id);
    return this.getArticle(id, user);
  }
  updateArticle(id, patch, user, options = {}) {
    auth(user); fields(patch, ['name', 'html', 'category_id', 'version']);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM knowledge_articles WHERE id=?').get(id);
      if (!row || !this.canReadCategory(this.categoryRow(row.category_id), user)) throw fail('Article not found.', 404);
      this.editableCategory(row.category_id, user);
      matchesVersion(row, versionOf(patch, options));
      const category = this.editableCategory(patch.category_id || row.category_id, user);
      const name = patch.name === undefined ? row.name : text(patch.name, 'Article name', 255);
      const html = patch.html === undefined ? row.html : text(patch.html, 'Article content', 300000);
      this.db.prepare('UPDATE knowledge_articles SET name=?,html=?,category_id=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?')
        .run(name, html, category.id, stamp(), user.id, id);
      return this.getArticle(id, user);
    });
  }
  assetRow(idOrRef) { return this.db.prepare('SELECT * FROM native_assets WHERE id=? OR ref=? COLLATE NOCASE ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1').get(idOrRef, idOrRef, idOrRef); }
  assetResult(row, user) {
    const category = this.categoryResult(this.categoryRow(row.category_id), user);
    let owner = null;
    if (row.owner_id) {
      const person = this.assetRow(row.owner_id);
      if (person && this.canReadCategory(this.categoryRow(person.category_id), user)) owner = { id: person.id, ref: person.ref, name: person.name, type: person.type };
    }
    return { ...row, category, canEdit: category.canEdit, owner, owner_restricted: Boolean(row.owner_id && !owner),
      owner_id: row.owner_id && !owner ? null : row.owner_id,
      owner_name: row.owner_id ? (owner?.name || '') : row.owner_name,
      ticket_count: this.db.prepare('SELECT COUNT(*) AS count FROM native_asset_tickets WHERE asset_id=?').get(row.id).count };
  }
  listAssets(user, filters = {}) {
    const access = this.readableClause('c', user), page = pagination(filters), clauses = [access.sql], args = [...access.args];
    if (filters.category_id) { this.getCategory(filters.category_id, user); clauses.push('a.category_id=?'); args.push(filters.category_id); }
    if (filters.type && filters.type !== 'all') { if (!ASSET_TYPES.includes(filters.type)) throw fail('Invalid asset type.'); clauses.push('a.type=?'); args.push(filters.type); }
    if (filters.search) {
      const term = likeTerm(filters.search); clauses.push("(a.ref LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' OR a.serial_number LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\')");
      args.push(...Array(4).fill(`%${term}%`));
    }
    const where = clauses.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM native_assets a JOIN knowledge_categories c ON c.id=a.category_id WHERE ${where}`).get(...args).count;
    const rows = this.db.prepare(`SELECT a.* FROM native_assets a JOIN knowledge_categories c ON c.id=a.category_id WHERE ${where} ORDER BY a.updated_at DESC,a.ref LIMIT ? OFFSET ?`).all(...args, page.limit, page.offset);
    return { assets: rows.map(row => this.assetResult(row, user)), total, ...page };
  }
  getAsset(idOrRef, user) {
    auth(user);
    const row = this.assetRow(idOrRef);
    if (!row || !this.canReadCategory(this.categoryRow(row.category_id), user)) throw fail('Asset not found.', 404);
    const tickets = this.db.prepare(`SELECT t.key,t.subject,t.status,t.priority,t.assignee_id,t.created_at,t.updated_at
      FROM native_asset_tickets n JOIN tickets t ON t.key=n.ticket_key WHERE n.asset_id=? ORDER BY t.updated_at DESC,t.key`).all(row.id)
      .map(ticket => ({ ...ticket, assignee: ticket.assignee_id ? this.desk.user(ticket.assignee_id) : null }));
    return { ...this.assetResult(row, user), tickets, linked_tickets: tickets };
  }
  assetInput(data, original, user) {
    fields(data, ['ref', 'name', 'type', 'category_id', 'owner_id', 'owner_name', 'email', 'department', 'location', 'serial_number', 'manufacturer', 'model', 'status', 'description', 'version']);
    const values = { ...original };
    if (data.ref !== undefined) values.ref = reference(data.ref);
    for (const [field, max] of Object.entries(ASSET_TEXT)) if (data[field] !== undefined) values[field] = text(data[field], field.replaceAll('_', ' '), max, field !== 'name');
    if (data.type !== undefined) { if (!ASSET_TYPES.includes(data.type)) throw fail('Invalid asset type.'); values.type = data.type; }
    if (data.status !== undefined) { if (!ASSET_STATUSES.includes(data.status)) throw fail('Invalid asset status.'); values.status = data.status; }
    if (data.email !== undefined && values.email && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(values.email)) throw fail('Enter a valid email address.');
    if (data.owner_id !== undefined) {
      if (data.owner_id !== null && typeof data.owner_id !== 'string') throw fail('Choose a personnel record or leave the owner empty.');
      if (data.owner_id) {
        const owner = this.getAsset(data.owner_id, user);
        if (owner.type !== 'personnel' || owner.id === original.id) throw fail('Choose a different personnel record as the owner.');
      }
      values.owner_id = data.owner_id || null;
    }
    if (this.db.prepare('SELECT 1 FROM native_assets WHERE ref=? COLLATE NOCASE AND id<>?').get(values.ref, values.id || '')) throw fail('An asset with that reference already exists.', 409);
    return values;
  }
  createAsset(data, user) {
    auth(user);
    fields(data, ['ref', 'name', 'type', 'category_id', 'owner_id', 'owner_name', 'email', 'department', 'location', 'serial_number', 'manufacturer', 'model', 'status', 'description', 'version']);
    const id = randomUUID(), time = stamp();
    const category = this.editableCategory(data.category_id || ASSETS_CATEGORY_ID, user, 'assets');
    const values = this.assetInput(data, { id, ref: '', name: '', type: 'hardware', category_id: category.id, owner_id: null, owner_name: '', email: '', department: '', location: '', serial_number: '', manufacturer: '', model: '', status: 'unverified', description: '' }, user);
    if (!values.ref || !values.name) throw fail('An asset reference and name are required.');
    this.db.prepare(`INSERT INTO native_assets (id,ref,name,type,category_id,owner_id,owner_name,email,department,location,serial_number,manufacturer,model,status,description,created_at,updated_at,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, values.ref, values.name, values.type, category.id, values.owner_id, values.owner_name, values.email, values.department, values.location, values.serial_number, values.manufacturer, values.model, values.status, values.description, time, time, user.id, user.id);
    return this.getAsset(id, user);
  }
  updateAsset(id, patch, user, options = {}) {
    auth(user);
    fields(patch, ['ref', 'name', 'type', 'category_id', 'owner_id', 'owner_name', 'email', 'department', 'location', 'serial_number', 'manufacturer', 'model', 'status', 'description', 'version']);
    return this.transaction(() => {
      const row = this.assetRow(id);
      if (!row || !this.canReadCategory(this.categoryRow(row.category_id), user)) throw fail('Asset not found.', 404);
      this.editableCategory(row.category_id, user, 'assets'); matchesVersion(row, versionOf(patch, options));
      const category = this.editableCategory(patch.category_id || row.category_id, user, 'assets');
      const values = this.assetInput(patch, row, user);
      if (row.type === 'personnel' && values.type !== 'personnel' && this.db.prepare('SELECT 1 FROM native_assets WHERE owner_id=? LIMIT 1').get(row.id)) throw fail('Reassign equipment owned by this person before changing the asset type.', 409);
      this.db.prepare(`UPDATE native_assets SET ref=?,name=?,type=?,category_id=?,owner_id=?,owner_name=?,email=?,department=?,location=?,serial_number=?,manufacturer=?,model=?,status=?,description=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?`)
        .run(values.ref, values.name, values.type, category.id, values.owner_id, values.owner_name, values.email, values.department, values.location, values.serial_number, values.manufacturer, values.model, values.status, values.description, stamp(), user.id, row.id);
      return this.getAsset(row.id, user);
    });
  }
  upsertAutoAsset(value, data = {}) {
    const ref = reference(value);
    const existing = this.assetRow(ref);
    if (existing) return { id: existing.id, ref: existing.ref, name: existing.name, type: existing.type, category_id: existing.category_id };
    const id = randomUUID(), time = stamp(), type = data.type ?? inferType(ref);
    if (!ASSET_TYPES.includes(type)) throw fail('Invalid asset type.');
    if (this.categoryRow(data.category_id || ASSETS_CATEGORY_ID)?.kind !== 'assets') throw fail('Choose an asset category.');
    this.db.prepare(`INSERT INTO native_assets (id,ref,name,type,category_id,status,description,created_at,updated_at)
      VALUES (?,?,?,?,?,'unverified',?,?,?)`).run(id, ref, data.name ? text(data.name, 'Asset name', 200) : ref, type, data.category_id || ASSETS_CATEGORY_ID, data.description ? text(data.description, 'Asset description', 100000, true) : 'Created from a ticket. Complete the ownership and equipment details.', time, time);
    return { id, ref, name: data.name || ref, type, category_id: data.category_id || ASSETS_CATEGORY_ID };
  }
  linkTicket(key, assetIdOrRef, actor) {
    return this.transaction(() => {
    if (!this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(key)) throw fail('Ticket not found.', 404);
    const row = this.assetRow(assetIdOrRef);
    if (!row) throw fail('Asset not found.', 404);
    if (actor) {
      auth(actor);
      const category = this.getCategory(row.category_id, actor);
      if (!category.canEdit) throw fail('You do not have permission to change this asset.', 403);
    }
    const changes = this.db.prepare('INSERT OR IGNORE INTO native_asset_tickets (asset_id,ticket_key,created_at,created_by) VALUES (?,?,?,?)').run(row.id, key, stamp(), actor?.id || null).changes;
    // The API filters these identity-bearing events with the same category ACL
    // as the asset relationship before returning shared ticket activity.
    if (changes) this.desk.event(key, 'asset_link', `Linked asset ${row.ref}`, actor);
    return { linked: true, duplicate: !changes, id: row.id, ref: row.ref };
    });
  }
  ticketAssets(key, user) {
    const access = this.readableClause('c', user);
    return this.db.prepare(`SELECT a.* FROM native_asset_tickets n JOIN native_assets a ON a.id=n.asset_id
      JOIN knowledge_categories c ON c.id=a.category_id WHERE n.ticket_key=? AND ${access.sql} ORDER BY a.ref`).all(key, ...access.args).map(row => this.assetResult(row, user));
  }
  relatedTickets(key, user, limit = 8) {
    const access = this.readableClause('c', user);
    const maximum = Number(limit);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw fail('Invalid related-ticket limit.');
    return this.db.prepare(`SELECT DISTINCT t.key,t.subject,t.status,t.resolution,t.requester FROM native_asset_tickets mine
      JOIN native_assets a ON a.id=mine.asset_id JOIN knowledge_categories c ON c.id=a.category_id
      JOIN native_asset_tickets other ON other.asset_id=mine.asset_id JOIN tickets t ON t.key=other.ticket_key
      WHERE mine.ticket_key=? AND other.ticket_key<>? AND ${access.sql} ORDER BY t.updated_at DESC,t.key LIMIT ?`).all(key, key, ...access.args, maximum);
  }
  addMedia(data, user) {
    auth(user);
    if (!data || Boolean(data.article_id) === Boolean(data.asset_id)) throw fail('Attach media to one article or asset.');
    const parent = data.article_id ? this.getArticle(data.article_id, user) : this.getAsset(data.asset_id, user);
    if (!parent.canEdit) throw fail('You do not have permission to edit this record.', 403);
    const filename = text(data.filename, 'Filename', 200);
    const mime = data.mime;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) throw fail('Choose a supported raster image.', 415);
    if (!(Buffer.isBuffer(data.data) || data.data instanceof Uint8Array) || !data.data.byteLength || data.data.byteLength > 10 * 1024 * 1024) throw fail('Images must contain 1 byte to 10 MiB.', 413);
    const id = randomUUID();
    this.db.prepare('INSERT INTO workspace_media (id,article_id,asset_id,category_id,filename,mime,data,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, data.article_id || null, data.asset_id || null, parent.category_id, filename, mime, Buffer.from(data.data), stamp());
    return { id, article_id: data.article_id || null, asset_id: data.asset_id || null, filename, mime, size: data.data.byteLength, url: `/api/desk/knowledge/media/${id}` };
  }
  getMedia(id, user) {
    auth(user);
    const row = this.db.prepare('SELECT * FROM workspace_media WHERE id=?').get(id);
    if (!row) throw fail('Media not found.', 404);
    try {
      if (row.article_id) this.getArticle(row.article_id, user);
      else if (row.asset_id) this.getAsset(row.asset_id, user);
      else throw fail('Media not found.', 404);
    } catch (e) { if (e.statusCode === 404) throw fail('Media not found.', 404); throw e; }
    return { ...row, data: Buffer.from(row.data) };
  }
  migrateLegacyAssets() {
    // Preserve local references and both directions of ticket history even before
    // an optional one-time legacy document import is run.
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM workspace_migrations WHERE name=?').get('legacy-ticket-assets-v1')) return;
      for (const link of this.db.prepare(`SELECT a.ticket_key,a.ref FROM ticket_assets a JOIN tickets t ON t.key=a.ticket_key`).all()) {
        const asset = this.upsertAutoAsset(link.ref);
        this.db.prepare('INSERT OR IGNORE INTO native_asset_tickets (asset_id,ticket_key,created_at) VALUES (?,?,?)').run(asset.id, link.ticket_key, stamp());
      }
      this.db.prepare('INSERT INTO workspace_migrations (name,completed_at) VALUES (?,?)').run('legacy-ticket-assets-v1', stamp());
    });
  }
}
