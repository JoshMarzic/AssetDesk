import express from 'express';
import { once } from 'node:events';
import { ASSET_TYPES } from './workspace-store.js';
import { normalizeTicketTag } from './desk-store.js';

const ENUMS = Object.freeze({
  source: ['email', 'manual'], asset_type: ASSET_TYPES, has_assets: ['yes', 'no'],
  date_field: ['created_at', 'updated_at', 'first_response_at', 'resolved_at', 'response_due_at', 'resolution_due_at', 'paused_until'],
  response_state: ['recorded', 'unrecorded'], resolution_state: ['recorded', 'unrecorded'],
  response_sla: ['pending', 'overdue', 'met', 'breached'], resolution_sla: ['pending', 'overdue', 'met', 'breached'],
  sort: ['newest', 'oldest', 'updated', 'priority', 'due', 'requester'],
});
const TEXT_FILTERS = ['search', 'ticket_key', 'subject', 'description', 'requester', 'location', 'resolution', 'note', 'asset', 'tag'];
const NUMBER_FILTERS = ['response_minutes', 'resolution_minutes', 'note_count', 'email_count', 'asset_count'];
const CHOICES = { status: 'statuses', priority: 'priorities', category: 'categories' };
const ALLOWED = new Set([...TEXT_FILTERS, ...Object.keys(ENUMS), ...Object.keys(CHOICES), 'assignee', 'date_from', 'date_to', 'limit', 'offset', ...NUMBER_FILTERS.flatMap(name => [`${name}_min`, `${name}_max`])]);
const SORTS = Object.freeze({
  newest: 'r.created_at DESC,r.key', oldest: 'r.created_at ASC,r.key', updated: 'r.updated_at DESC,r.key',
  priority: 'r.priority_rank DESC,r.created_at DESC,r.key',
  due: 'CASE WHEN r.first_response_at IS NULL AND r.response_due_at<r.resolution_due_at THEN r.response_due_at ELSE r.resolution_due_at END ASC,r.key',
  requester: 'r.requester COLLATE NOCASE,r.key',
});
const invalid = message => Object.assign(new Error(message), { statusCode: 400, safeMessage: message });
const term = value => `%${value.replace(/[\\%_]/g, char => `\\${char}`)}%`;
const like = field => `${field} LIKE ? ESCAPE '\\'`;

function date(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(`Choose a valid ${name} date.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(`Choose a valid ${name} date.`);
  return parsed;
}

export function reportFilters(query, workflow) {
  const filters = { date_field: 'created_at', sort: 'newest', limit: 25, offset: 0 };
  for (const [name, input] of Object.entries(query)) {
    if (!ALLOWED.has(name)) throw invalid(`Unsupported report filter: ${name}.`);
    if (typeof input !== 'string' || input.length > 500 || /[\x00-\x1f\x7f]/.test(input)) throw invalid(`Invalid ${name} filter.`);
    const value = input.trim();
    if (!value) continue;
    if (CHOICES[name]) {
      if (!workflow?.[CHOICES[name]]?.some(option => option.id === value)) throw invalid(`Invalid ${name} filter.`);
      filters[name] = value;
    } else if (ENUMS[name]) {
      if (!ENUMS[name].includes(value)) throw invalid(`Invalid ${name} filter.`);
      filters[name] = value;
    } else if (name === 'limit' || name === 'offset') {
      if (!/^\d{1,7}$/.test(value)) throw invalid(`Invalid ${name}.`);
      filters[name] = Number(value);
    } else if (NUMBER_FILTERS.some(field => name === `${field}_min` || name === `${field}_max`)) {
      const count = /^(?:note|email|asset)_count_/.test(name);
      if (!(count ? /^\d{1,9}$/ : /^\d{1,9}(?:\.\d{1,4})?$/).test(value)) throw invalid(`Invalid ${name} filter.`);
      filters[name] = Number(value);
    } else if (name === 'tag') {
      filters.tag = normalizeTicketTag(value).normalized;
    } else if (name === 'assignee') {
      if (value !== 'unassigned' && !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw invalid('Invalid technician filter.');
      filters[name] = value;
    } else filters[name] = value;
  }
  if (filters.limit < 1 || filters.limit > 100 || filters.offset > 1_000_000) throw invalid('Invalid report pagination.');
  for (const name of ['date_from', 'date_to']) if (filters[name]) date(filters[name], name === 'date_from' ? 'start' : 'end');
  if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) throw invalid('The start date must be on or before the end date.');
  for (const name of NUMBER_FILTERS) if (filters[`${name}_min`] !== undefined && filters[`${name}_max`] !== undefined && filters[`${name}_min`] > filters[`${name}_max`]) throw invalid(`The minimum ${name} must not exceed its maximum.`);
  return filters;
}

function queryReport(workspace, user, filters, timestamp) {
  const access = workspace.readableClause('c', user);
  // Both export and the paged preview use exactly this query. Asset information
  // enters the report only after applying the current category grants.
  const cte = `WITH visible_assets AS (
    SELECT n.ticket_key,a.id,a.ref,a.name,a.type FROM native_asset_tickets n
    JOIN native_assets a ON a.id=n.asset_id JOIN knowledge_categories c ON c.id=a.category_id WHERE ${access.sql}
  ), asset_counts AS (SELECT ticket_key,COUNT(*) AS asset_count FROM visible_assets GROUP BY ticket_key),
  note_counts AS (SELECT ticket_key,SUM(kind='note') AS note_count,SUM(kind='email') AS email_count FROM ticket_notes GROUP BY ticket_key),
  clock AS (SELECT ? AS timestamp), report_rows AS (
    SELECT t.*,u.name AS assigned_name,u.email AS assigned_email,u.role AS assigned_role,u.active AS assigned_active,
      COALESCE(s.kind,'active') AS status_kind,COALESCE(p.rank,0) AS priority_rank,
      COALESCE(s.name,t.status) AS status_name,COALESCE(p.name,t.priority) AS priority_name,COALESCE(tc.name,t.category) AS category_name,
      COALESCE(ac.asset_count,0) AS asset_count,COALESCE(nc.note_count,0) AS note_count,COALESCE(nc.email_count,0) AS email_count,
      CASE WHEN t.first_response_at IS NOT NULL THEN ROUND((julianday(t.first_response_at)-julianday(t.created_at))*1440,4) END AS response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN ROUND((julianday(t.resolved_at)-julianday(t.created_at))*1440,4) END AS resolution_minutes,
      CASE WHEN t.first_response_at IS NOT NULL THEN CASE WHEN julianday(t.first_response_at)<=julianday(t.response_due_at) THEN 'met' ELSE 'breached' END
        WHEN COALESCE(s.kind,'active')='active' AND julianday(t.response_due_at)<julianday(clock.timestamp) THEN 'overdue' ELSE 'pending' END AS response_sla,
      CASE WHEN t.resolved_at IS NOT NULL THEN CASE WHEN julianday(t.resolved_at)<=julianday(t.resolution_due_at) THEN 'met' ELSE 'breached' END
        WHEN COALESCE(s.kind,'active')='active' AND julianday(t.resolution_due_at)<julianday(clock.timestamp) THEN 'overdue' ELSE 'pending' END AS resolution_sla
    FROM tickets t LEFT JOIN technicians u ON u.id=t.assignee_id LEFT JOIN asset_counts ac ON ac.ticket_key=t.key
      LEFT JOIN note_counts nc ON nc.ticket_key=t.key
      LEFT JOIN ticket_statuses s ON s.id=t.status LEFT JOIN ticket_priorities p ON p.id=t.priority
      LEFT JOIN ticket_categories tc ON tc.id=t.category CROSS JOIN clock
  )`;
  const args = [...access.args, timestamp], clauses = [];
  for (const name of ['status', 'priority', 'category', 'source', 'response_sla', 'resolution_sla']) if (filters[name]) { clauses.push(`r.${name}=?`); args.push(filters[name]); }
  for (const name of ['ticket_key', 'subject', 'description', 'location', 'resolution']) if (filters[name]) { clauses.push(like(`r.${name === 'ticket_key' ? 'key' : name}`)); args.push(term(filters[name])); }
  if (filters.requester) { clauses.push(`(${like('r.requester')} OR ${like('r.requester_name')})`); args.push(term(filters.requester), term(filters.requester)); }
  if (filters.note) { clauses.push(`EXISTS(SELECT 1 FROM ticket_notes n WHERE n.ticket_key=r.key AND ${like('n.body')})`); args.push(term(filters.note)); }
  if (filters.tag) { clauses.push('EXISTS(SELECT 1 FROM ticket_tags tt WHERE tt.ticket_key=r.key AND tt.normalized=?)'); args.push(filters.tag); }
  if (filters.search) {
    const fields = ['r.key','r.subject','r.description','r.requester','r.requester_name','r.location','r.resolution','r.assigned_name','r.assigned_email'];
    clauses.push(`(${fields.map(like).join(' OR ')} OR EXISTS(SELECT 1 FROM ticket_notes n WHERE n.ticket_key=r.key AND ${like('n.body')}) OR EXISTS(SELECT 1 FROM visible_assets a WHERE a.ticket_key=r.key AND (${like('a.ref')} OR ${like('a.name')})) OR EXISTS(SELECT 1 FROM ticket_tags tt WHERE tt.ticket_key=r.key AND ${like('tt.normalized')}))`);
    args.push(...Array(fields.length + 3).fill(term(filters.search)));
    args.push(term(filters.search.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase()));
  }
  if (filters.assignee === 'unassigned') clauses.push('r.assignee_id IS NULL');
  else if (filters.assignee) { clauses.push('r.assignee_id=?'); args.push(filters.assignee); }
  if (filters.has_assets) clauses.push(`r.asset_count${filters.has_assets === 'yes' ? '>0' : '=0'}`);
  if (filters.asset || filters.asset_type) {
    const parts = ['a.ticket_key=r.key'];
    if (filters.asset) { parts.push(`(${like('a.ref')} OR ${like('a.name')})`); args.push(term(filters.asset), term(filters.asset)); }
    if (filters.asset_type) { parts.push('a.type=?'); args.push(filters.asset_type); }
    clauses.push(`EXISTS(SELECT 1 FROM visible_assets a WHERE ${parts.join(' AND ')})`);
  }
  for (const name of ['response_state', 'resolution_state']) if (filters[name]) clauses.push(`r.${name === 'response_state' ? 'first_response_at' : 'resolved_at'} IS ${filters[name] === 'recorded' ? 'NOT ' : ''}NULL`);
  if (filters.date_from) { clauses.push(`julianday(r.${filters.date_field})>=julianday(?)`); args.push(`${filters.date_from}T00:00:00.000Z`); }
  if (filters.date_to) { clauses.push(`julianday(r.${filters.date_field})<julianday(?)+1`); args.push(`${filters.date_to}T00:00:00.000Z`); }
  for (const name of NUMBER_FILTERS) for (const suffix of ['min','max']) if (filters[`${name}_${suffix}`] !== undefined) { clauses.push(`r.${name}${suffix === 'min' ? '>=' : '<='}?`); args.push(filters[`${name}_${suffix}`]); }
  const select = `FROM report_rows r${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`;
  return { cte, select, args, order: SORTS[filters.sort], access };
}

function presenter(desk, workspace, user) {
  const access = workspace.readableClause('c', user);
  const assets = desk.db.prepare(`SELECT a.id,a.ref,a.name,a.type FROM native_asset_tickets n JOIN native_assets a ON a.id=n.asset_id
    JOIN knowledge_categories c ON c.id=a.category_id WHERE n.ticket_key=? AND ${access.sql} ORDER BY a.ref COLLATE NOCASE,a.id`);
  return row => {
    const { page_id, page_url, assigned_name, assigned_email, assigned_role, assigned_active, ...ticket } = row;
    return { ...ticket, assignee: row.assignee_id && assigned_name ? { id: row.assignee_id, name: assigned_name, email: assigned_email, role: assigned_role, active: Boolean(assigned_active) } : null,
      assets: assets.all(row.key, ...access.args), tags: desk.ticketTags(row.key), is_overdue: row.response_sla === 'overdue' || row.resolution_sla === 'overdue' };
  };
}

const CSV_COLUMNS = [
  ['Ticket ID', t => t.key], ['Subject', t => t.subject], ['Description', t => t.description],
  ['Requester name', t => t.requester_name], ['Requester email', t => t.requester], ['Status', t => t.status],
  ['Location', t => t.location],
  ['Priority', t => t.priority], ['Type / category', t => t.category], ['Source', t => t.source],
  ['Technician', t => t.assignee?.name], ['Technician email', t => t.assignee?.email],
  ['Submitted at (UTC)', t => t.created_at], ['Updated at (UTC)', t => t.updated_at],
  ['First response at (UTC)', t => t.first_response_at], ['Resolved at (UTC)', t => t.resolved_at],
  ['Paused until (UTC)', t => t.paused_until],
  ['Response due at (UTC)', t => t.response_due_at], ['Resolution due at (UTC)', t => t.resolution_due_at],
  ['Response SLA', t => t.response_sla], ['Resolution SLA', t => t.resolution_sla],
  ['Response time (minutes)', t => t.response_minutes], ['Resolution time (minutes)', t => t.resolution_minutes],
  ['Resolution', t => t.resolution], ['Internal notes', t => t.note_count], ['Email replies', t => t.email_count],
  ['Linked assets', t => t.assets.map(a => a.ref).join('; ')], ['Asset names', t => t.assets.map(a => a.name).join('; ')],
  ['Asset types', t => t.assets.map(a => a.type).join('; ')], ['Visible asset count', t => t.asset_count],
  ['Tags', t => t.tags.join('; ')],
  ['Status name', t => t.status_name], ['Priority name', t => t.priority_name], ['Category name', t => t.category_name],
];

export function csvCell(input) {
  let value = input === null || input === undefined ? '' : String(input);
  // An apostrophe keeps spreadsheet programs from evaluating user text as a
  // formula, even when tabs, newlines or Unicode spacing precede the operator.
  if (/^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}
const csvRow = values => values.map(csvCell).join(',') + '\r\n';

export function createReportsRouter({ desk, workspace }) {
  const router = express.Router();
  router.get('/options', (_req, res) => res.json({ technicians: desk.listTechnicians(), date_fields: ENUMS.date_field, workflow: desk.settings.snapshot() }));
  router.get('/tickets', (req, res) => {
    const filters = reportFilters(req.query, desk.settings.snapshot());
    desk.initializeRows();
    desk.resumeDueTickets();
    const query = queryReport(workspace, req.deskSession.user, filters, new Date().toISOString());
    const total = desk.db.prepare(`${query.cte} SELECT COUNT(*) AS total ${query.select}`).get(...query.args).total;
    const rows = desk.db.prepare(`${query.cte} SELECT r.* ${query.select} ORDER BY ${query.order} LIMIT ? OFFSET ?`).all(...query.args, filters.limit, filters.offset);
    const present = presenter(desk, workspace, req.deskSession.user);
    res.json({ tickets: rows.map(present), total, limit: filters.limit, offset: filters.offset });
  });
  router.get('/tickets.csv', async (req, res, next) => {
    let iterator;
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once('close', disconnected);
    try {
      const filters = reportFilters(req.query, desk.settings.snapshot());
      desk.initializeRows();
      desk.resumeDueTickets();
      const query = queryReport(workspace, req.deskSession.user, filters, new Date().toISOString());
      const statement = desk.db.prepare(`${query.cte} SELECT r.* ${query.select} ORDER BY ${query.order}`);
      const present = presenter(desk, workspace, req.deskSession.user);
      // Prepare and start the SQLite iterator before sending headers so invalid
      // filters/queries still produce a normal JSON error response.
      iterator = statement.iterate(...query.args);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="assetdesk-tickets-${new Date().toISOString().slice(0,10)}.csv"`);
      const write = async value => {
        if (res.destroyed) return false;
        if (!res.write(value)) await once(res, 'drain', { signal: controller.signal });
        return !res.destroyed;
      };
      if (!await write('\uFEFF' + csvRow(CSV_COLUMNS.map(([name]) => name)))) return;
      let processed = 0;
      for (const row of iterator) {
        const ticket = present(row);
        if (!await write(csvRow(CSV_COLUMNS.map(([, get]) => get(ticket))))) return;
        if (++processed % 100 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy(); else next(error);
    } finally { iterator?.return?.(); res.removeListener('close', disconnected); }
  });
  return router;
}
