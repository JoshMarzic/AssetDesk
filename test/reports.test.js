import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { createDeskRouter } from '../src/desk-routes.js';

const PASSWORD = 'Report-test-password-2026';
async function harness(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Report administrator', email: 'admin@reports.example', password: PASSWORD });
  const technician = await desk.createTechnician({ name: 'Morgan Support', email: 'morgan@reports.example', password: PASSWORD });
  const inactive = await desk.createTechnician({ name: 'Former technician', email: 'former@reports.example', password: PASSWORD });
  await desk.updateTechnician(inactive.id, { active: false });
  const app = express();
  app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { session, body } = {}) {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
      ...(session ? { Cookie: session.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: data, headers: response.headers };
  }
  async function login(user = admin) {
    const response = await request('/login', { body: { email: user.email, password: PASSWORD } });
    assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  function ticket(key, values = {}) {
    store.saveTicket({ key, requester: 'requester@reports.example', subject: 'Printer problem', page_id: 99, page_url: 'http://legacy.example/link/99', created_at: '2024-02-29T12:00:00.000Z' });
    const fields = { updated_at: '2024-03-01T08:00:00.000Z', response_due_at: '2024-02-29T14:00:00.000Z', resolution_due_at: '2024-03-02T12:00:00.000Z', description: 'Printer fails to connect.', requester_name: 'Jordan Requester', ...values };
    store.db.prepare(`UPDATE tickets SET ${Object.keys(fields).map(name => `${name}=?`).join(',')} WHERE key=?`).run(...Object.values(fields), key);
  }
  function note(key, body, kind = 'note') {
    const id = `${key}-${store.db.prepare('SELECT COUNT(*) AS count FROM ticket_notes').get().count}`;
    store.db.prepare('INSERT INTO ticket_notes (id,ticket_key,body,kind,actor_name,created_at) VALUES (?,?,?,?,?,?)').run(id, key, body, kind, 'Support', '2024-03-01T00:00:00.000Z');
  }
  async function report(query = {}, session) {
    return request('/reports/tickets?' + new URLSearchParams(query), { session: session || await login() });
  }
  return { store, desk, workspace, admin, technician, inactive, request, login, ticket, note, report };
}

// Parse exported CSV independently, including quoted commas, quotes and line breaks.
function parseCsv(buffer) {
  const source = buffer.toString('utf8').replace(/^\uFEFF/, ''), rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if (char === '\r' && source[index + 1] === '\n' && !quoted) { row.push(value); rows.push(row); row = []; value = ''; index++; }
    else value += char;
  }
  assert.equal(quoted, false, 'CSV quotes must be balanced');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

test('reports and CSV require a session and options preserve safe historical technician choices', async t => {
  const h = await harness(t);
  for (const path of ['/reports/tickets', '/reports/tickets.csv', '/reports/options']) assert.equal((await h.request(path)).status, 401);
  const session = await h.login(h.technician), options = await h.request('/reports/options', { session });
  assert.equal(options.status, 200); assert.equal(options.headers.get('cache-control'), 'no-store');
  assert.ok(options.body.technicians.some(user => user.id === h.inactive.id && !user.active));
  assert.doesNotMatch(JSON.stringify(options.body), /password_hash|scrypt\$|csrf_token|token_hash/);
  h.ticket('HD-HISTORY', { assignee_id: h.inactive.id });
  const report = await h.report({ assignee: h.inactive.id }, session);
  assert.equal(report.status, 200); assert.equal(report.body.total, 1);
  assert.equal(report.body.tickets[0].assignee.name, h.inactive.name);
  assert.ok(!Object.hasOwn(report.body.tickets[0], 'page_url')); assert.ok(!Object.hasOwn(report.body.tickets[0], 'page_id'));
});

test('report filters combine ticket content, type, source, technician, assets, response and counts', async t => {
  const h = await harness(t);
  h.ticket('HD-MATCH', { subject: 'Design workstation is offline', description: 'Cable failure on the desk.', requester: 'alex@reports.example', requester_name: 'Alex Doe', status: 'resolved', priority: 'high', category: 'hardware', source: 'manual', assignee_id: h.technician.id, first_response_at: '2024-02-29T13:00:00.000Z', resolved_at: '2024-03-01T12:00:00.000Z', resolution: 'Replaced the broken cable.' });
  h.ticket('HD-OTHER', { status: 'open', priority: 'normal', category: 'software', source: 'email' });
  h.note('HD-MATCH', 'Investigated dock diagnostics'); h.note('HD-MATCH', 'Customer confirms repair', 'email');
  const asset = h.workspace.createAsset({ ref: 'PC-REPORT', name: 'Design workstation', type: 'pc' }, h.admin);
  h.workspace.linkTicket('HD-MATCH', asset.id, h.admin);
  const report = await h.report({ ticket_key: 'MATCH', subject: 'workstation', description: 'Cable failure', requester: 'Alex', resolution: 'broken cable', note: 'dock diagnostics', status: 'resolved', priority: 'high', category: 'hardware', source: 'manual', assignee: h.technician.id, asset: 'PC-REPORT', asset_type: 'pc', has_assets: 'yes', response_state: 'recorded', resolution_state: 'recorded', response_sla: 'met', resolution_sla: 'met', response_minutes_min: '60', response_minutes_max: '60', resolution_minutes_min: '1440', resolution_minutes_max: '1440', note_count_min: '1', note_count_max: '1', email_count_min: '1', email_count_max: '1', asset_count_min: '1', asset_count_max: '1' });
  assert.equal(report.status, 200, JSON.stringify(report.body)); assert.equal(report.body.total, 1);
  const row = report.body.tickets[0]; assert.equal(row.key, 'HD-MATCH'); assert.equal(row.note_count, 1); assert.equal(row.email_count, 1);
  assert.equal(row.response_minutes, 60); assert.equal(row.resolution_minutes, 1440); assert.equal(row.assets[0].ref, 'PC-REPORT');
  assert.equal((await h.report({ assignee: 'unassigned', response_state: 'unrecorded', resolution_state: 'unrecorded' })).body.tickets[0].key, 'HD-OTHER');
});

test('report dates include both UTC day boundaries and every supported timestamp field', async t => {
  const h = await harness(t);
  for (const [key, created] of [['HD-BEFORE', '2024-02-28T23:59:59.999Z'], ['HD-START', '2024-02-29T00:00:00.000Z'], ['HD-END', '2024-02-29T23:59:59.999Z'], ['HD-AFTER', '2024-03-01T00:00:00.000Z']]) h.ticket(key, { created_at: created });
  const report = await h.report({ date_from: '2024-02-29', date_to: '2024-02-29', sort: 'oldest' });
  assert.equal(report.status, 200); assert.deepEqual(report.body.tickets.map(row => row.key), ['HD-START', 'HD-END']);
  for (const field of ['updated_at', 'first_response_at', 'resolved_at', 'response_due_at', 'resolution_due_at']) {
    h.store.db.prepare(`UPDATE tickets SET ${field}=? WHERE key=?`).run('2025-05-14T23:59:59.999Z', 'HD-AFTER');
    const result = await h.report({ date_field: field, date_from: '2025-05-14', date_to: '2025-05-14' });
    assert.equal(result.status, 200); assert.deepEqual(result.body.tickets.map(row => row.key), ['HD-AFTER'], field);
  }
  h.ticket('HD-LAST-DAY', { created_at: '9999-12-31T23:59:59.999Z' });
  assert.deepEqual((await h.report({ date_from: '9999-12-31', date_to: '9999-12-31' })).body.tickets.map(row => row.key), ['HD-LAST-DAY']);
});

test('content search finds descriptions, requester names, resolutions and notes and treats wildcard characters literally', async t => {
  const h = await harness(t);
  h.ticket('HD-LITERAL', { subject: '100% backup_job', description: 'Driver diagnostic', requester_name: 'Taylor Unique', resolution: 'Reinstalled queue service' });
  h.ticket('HD-OTHER', { subject: '1000 backupXjob' }); h.note('HD-LITERAL', 'Escalation marker');
  for (const term of ['diagnostic', 'Taylor Unique', 'queue service', 'Escalation marker']) {
    const result = await h.report({ search: term }); assert.equal(result.body.total, 1, term); assert.equal(result.body.tickets[0].key, 'HD-LITERAL');
  }
  for (const query of [{ search: '100%' }, { subject: 'backup_job' }, { ticket_key: "' OR 1=1 --" }]) {
    const result = await h.report(query); assert.equal(result.status, 200); assert.equal(result.body.total, query.ticket_key ? 0 : 1);
  }
});

test('report SLA outcomes distinguish pending, overdue, met and breached with duration filters', async t => {
  const h = await harness(t);
  h.ticket('HD-MET', { status: 'resolved', first_response_at: '2024-02-29T13:00:00.000Z', resolved_at: '2024-03-01T12:00:00.000Z' });
  h.ticket('HD-BREACHED', { status: 'resolved', first_response_at: '2024-02-29T15:00:00.000Z', resolved_at: '2024-03-03T12:00:00.000Z' });
  h.ticket('HD-OVERDUE', { status: 'open' });
  h.ticket('HD-PENDING', { status: 'waiting', created_at: '2050-01-01T00:00:00.000Z', response_due_at: '2050-01-02T00:00:00.000Z', resolution_due_at: '2050-01-03T00:00:00.000Z' });
  for (const state of ['met', 'breached', 'overdue', 'pending']) {
    const report = await h.report({ response_sla: state, resolution_sla: state });
    assert.equal(report.status, 200); assert.equal(report.body.total, 1, state); assert.equal(report.body.tickets[0].key, 'HD-' + state.toUpperCase());
    assert.equal(report.body.tickets[0].response_sla, state); assert.equal(report.body.tickets[0].resolution_sla, state);
  }
  const durations = await h.report({ response_minutes_min: '180', resolution_minutes_min: '4320' });
  assert.equal(durations.body.total, 1); assert.equal(durations.body.tickets[0].key, 'HD-BREACHED');
});

test('asset report filters, counts and CSV enforce category visibility', async t => {
  const h = await harness(t), session = await h.login(h.technician), admin = await h.login();
  const category = h.workspace.createCategory({ name: 'Secret inventory', kind: 'assets', visibility: 'restricted', reader_ids: [], editor_ids: [], allow_staff_edit: false }, h.admin);
  const hidden = h.workspace.createAsset({ ref: 'PC-SECRET', name: 'Confidential payroll device', type: 'server', category_id: category.id }, h.admin);
  const visible = h.workspace.createAsset({ ref: 'PC-PUBLIC', name: 'Reception workstation', type: 'pc' }, h.admin);
  h.ticket('HD-HIDDEN-ONLY'); h.ticket('HD-MIXED');
  h.workspace.linkTicket('HD-HIDDEN-ONLY', hidden.id, h.admin); h.workspace.linkTicket('HD-MIXED', hidden.id, h.admin); h.workspace.linkTicket('HD-MIXED', visible.id, h.admin);
  for (const query of [{ asset: 'PC-SECRET' }, { asset: 'Confidential' }, { asset_type: 'server' }, { asset_count_min: '2' }]) assert.equal((await h.report(query, session)).body.total, 0);
  const noAssets = await h.report({ has_assets: 'no' }, session); assert.deepEqual(noAssets.body.tickets.map(row => row.key), ['HD-HIDDEN-ONLY']);
  const oneAsset = await h.report({ has_assets: 'yes', asset_count_min: '1', asset_count_max: '1' }, session); assert.deepEqual(oneAsset.body.tickets.map(row => row.key), ['HD-MIXED']);
  assert.equal(oneAsset.body.tickets[0].assets.length, 1); assert.equal(oneAsset.body.tickets[0].assets[0].ref, 'PC-PUBLIC');
  const csv = await h.request('/reports/tickets.csv', { session }); assert.equal(csv.status, 200);
  assert.doesNotMatch(csv.body.toString(), /PC-SECRET|Confidential payroll|Secret inventory/);
  assert.equal((await h.report({ asset: 'PC-SECRET' }, admin)).body.total, 2);
});

test('CSV exports all matching pages with UTF-8, RFC quoting and spreadsheet-safe text', async t => {
  const h = await harness(t), session = await h.login();
  for (let index = 0; index < 127; index++) h.ticket(`HD-EXPORT-${String(index).padStart(3, '0')}`, { subject: index === 0 ? 'Café, "printer"\r\nneeds repair' : `Export request ${index}` });
  h.ticket('HD-FORMULA', { subject: '=HYPERLINK("https://example.invalid")', requester_name: '\t  +SUM(1,2)', description: '\r\n @SUM(1,2)', resolution: '-2+3' });
  const page = await h.report({ limit: '1', offset: '100' }, session); assert.equal(page.body.tickets.length, 1); assert.equal(page.body.total, 128);
  const csv = await h.request('/reports/tickets.csv?limit=1&offset=100&sort=oldest', { session });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /attachment;.*\.csv/);
  assert.equal(csv.body.subarray(0, 3).toString('hex'), 'efbbbf');
  const rows = parseCsv(csv.body), headers = rows.shift(); assert.equal(rows.length, 128); assert.ok(rows.every(row => row.length === headers.length));
  const cells = rows.flat(); assert.ok(cells.includes('Café, "printer"\r\nneeds repair'));
  for (const formula of ['=HYPERLINK("https://example.invalid")', '\t  +SUM(1,2)', '\r\n @SUM(1,2)', '-2+3']) {
    assert.ok(!cells.includes(formula), 'CSV must not emit an executable formula cell');
    assert.ok(cells.some(value => value.startsWith("'") && value.slice(1) === formula), 'CSV must preserve formula text behind an apostrophe');
  }
  assert.doesNotMatch(headers.join(','), /page_url|password|token/i);
  const filtered = parseCsv((await h.request('/reports/tickets.csv?ticket_key=HD-FORMULA', { session })).body);
  assert.equal(filtered.length, 2, 'Export must use the same filters as the report');
});

test('reports reject invalid dates, ranges, numeric filters, enums and duplicate query values', async t => {
  const h = await harness(t), session = await h.login();
  const invalidQueries = ['date_from=2023-02-29', 'date_to=2024-02-30', 'date_from=2024-03-01&date_to=2024-02-29', 'date_field=page_url', 'date_from=2024-02-29T12%3A00%3A00Z', 'status=unknown', 'priority=extreme', 'category=other', 'source=chat', 'response_sla=unsafe', 'resolution_state=maybe', 'has_assets=maybe', 'asset_type=unsafe', 'limit=0', 'limit=101', 'offset=-1', 'note_count_min=1.5', 'asset_count_max=-1', 'response_minutes_min=NaN', 'resolution_minutes_min=4&resolution_minutes_max=3', 'sort=DROP%20TABLE', 'status=open&status=closed'];
  for (const query of invalidQueries) {
    const result = await h.request('/reports/tickets?' + query, { session }); assert.equal(result.status, 400, query);
    const csv = await h.request('/reports/tickets.csv?' + query, { session }); assert.equal(csv.status, 400, 'CSV: ' + query);
  }
  const empty = await h.request('/reports/tickets.csv?ticket_key=NO-MATCH', { session });
  assert.equal(empty.status, 200); assert.equal(parseCsv(empty.body).length, 1, 'An empty export retains its header');
});
