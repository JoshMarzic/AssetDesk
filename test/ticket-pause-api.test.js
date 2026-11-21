import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { createDeskRouter } from '../src/desk-routes.js';

const PASSWORD = 'Pause-api-test-password-2026';
const FUTURE = '2099-05-14T12:00:00.000Z';

async function harness(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Pause administrator', email: 'admin@pause.example', password: PASSWORD });
  const technician = await desk.createTechnician({ name: 'Pause technician', email: 'tech@pause.example', password: PASSWORD });
  const worker = new Worker({ store, desk, workspace, logger: { error() {} } });
  const app = express();
  app.use('/api/desk', createDeskRouter({ desk, workspace, store, worker, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await worker.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie } : {}),
      ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: data, headers: response.headers };
  }
  async function login(user = technician) {
    const response = await request('/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: response.body.csrfToken };
  }
  async function create(session, values = {}) {
    const response = await request('/tickets', { method: 'POST', session, body: {
      subject: 'Scheduled laptop maintenance', requester: 'requester@pause.example', description: 'Perform the requested maintenance when the user is available.', ...values,
    } });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const detail = await request(`/tickets/${response.body.ticketKey}`, { session });
    assert.equal(detail.status, 200);
    return detail.body;
  }
  return { store, desk, workspace, admin, technician, request, login, create };
}

function csvRecords(buffer) {
  const source = buffer.toString('utf8').replace(/^\uFEFF/, ''), records = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(value); value = ''; }
    else if (character === '\r' && source[index + 1] === '\n' && !quoted) {
      row.push(value); records.push(row); row = []; value = ''; index++;
    } else value += character;
  }
  assert.equal(quoted, false);
  const headers = records.shift();
  return records.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
}

test('technicians can create a paused ticket immediately with a timezone-qualified start date and metadata', async t => {
  const h = await harness(t), session = await h.login();
  const ticket = await h.create(session, { paused_until: '2099-05-14T08:00:00-04:00', location: 'East office', tags: ['Scheduled'], priority: 'high', assignee_id: h.technician.id });
  assert.equal(ticket.status, 'paused');
  assert.equal(ticket.status_kind, 'paused');
  assert.equal(ticket.paused_until, FUTURE);
  assert.equal(ticket.location, 'East office');
  assert.deepEqual(ticket.tags, ['Scheduled']);
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.assignee.id, h.technician.id);
  assert.equal(ticket.source, 'manual');
  assert.equal(ticket.resolved_at, null);
  assert.ok(ticket.response_due_at);
  assert.ok(ticket.resolution_due_at);
});

test('pause mutations require a session and CSRF and reject bad dates before creating intake records', async t => {
  const h = await harness(t), session = await h.login();
  const ticket = await h.create(session);
  const body = { version: ticket.version, paused_until: FUTURE };
  assert.equal((await h.request(`/tickets/${ticket.key}`, { method: 'PATCH', body })).status, 401);
  assert.equal((await h.request(`/tickets/${ticket.key}`, { method: 'PATCH', body, session, csrf: false })).status, 403);
  const count = () => ({ tickets: h.store.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count, messages: h.store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count });
  const before = count();
  for (const paused_until of ['', 'tomorrow', '2099-05-14T08:00', '2099-02-30T12:00:00Z', '2020-01-01T12:00:00Z', true, 123, {}, []]) {
    const response = await h.request('/tickets', { method: 'POST', session, body: { subject: 'Invalid scheduled work', requester: 'requester@pause.example', description: 'Test invalid schedule', paused_until } });
    assert.equal(response.status, 400, JSON.stringify(paused_until));
    assert.deepEqual(count(), before, 'Invalid dates must not enqueue or create tickets');
    const update = await h.request(`/tickets/${ticket.key}`, { method: 'PATCH', session, body: { version: ticket.version, paused_until } });
    assert.equal(update.status, 400, JSON.stringify(paused_until));
  }
  assert.equal((await h.request(`/tickets/${ticket.key}`, { session })).body.status, 'open');
  assert.equal((await h.create(session, { paused_until: null })).status, 'open');
});

test('paused tickets leave dashboard and default queues but remain accessible through an explicit filter', async t => {
  const h = await harness(t), session = await h.login();
  const active = await h.create(session, { subject: 'Visible active request', assignee_id: h.technician.id });
  const paused = await h.create(session, { subject: 'Hidden scheduled request', assignee_id: h.technician.id, paused_until: FUTURE });
  for (const suffix of ['', '?view=all', '?view=my', '?view=open']) {
    const result = await h.request('/tickets' + suffix, { session });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.tickets.map(ticket => ticket.key), [active.key], suffix);
    assert.equal(result.body.total, 1);
  }
  for (const suffix of ['?view=paused', '?status=paused', '?view=my&status=paused']) {
    const result = await h.request('/tickets' + suffix, { session });
    assert.equal(result.status, 200, suffix);
    assert.deepEqual(result.body.tickets.map(ticket => ticket.key), [paused.key], suffix);
  }
  const dashboard = await h.request('/dashboard', { session });
  assert.equal(dashboard.body.counts.total, 1);
  assert.equal(dashboard.body.counts.active, 1);
  assert.ok(dashboard.body.activity.every(event => event.ticket_key !== paused.key));
  assert.equal((await h.request(`/tickets/${paused.key}`, { session })).body.status, 'paused');
});

test('pause updates enforce optimistic conflicts, allow rescheduling and resume early on date clearing or manual status changes', async t => {
  const h = await harness(t), session = await h.login();
  const ticket = await h.create(session);
  const patch = async (version, values) => h.request(`/tickets/${ticket.key}`, { method: 'PATCH', session, body: { version, ...values } });
  let response = await patch(ticket.version, { paused_until: FUTURE });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'paused');
  assert.equal(response.body.resolved_at, null);
  assert.equal((await patch(ticket.version, { paused_until: '2099-05-15T12:00:00Z' })).status, 409);
  let current = response.body;
  response = await patch(current.version, { status: 'paused', paused_until: '2099-05-15T12:00:00Z' });
  assert.equal(response.status, 200);
  assert.equal(response.body.paused_until, '2099-05-15T12:00:00.000Z');
  response = await patch(response.body.version, { paused_until: null });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'in_progress');
  assert.equal(response.body.paused_until, null);
  current = response.body;
  assert.equal((await patch(current.version, { status: 'paused' })).status, 400, 'Paused without a date must not create a stranded ticket');
  assert.equal((await patch(current.version, { status: 'resolved', paused_until: FUTURE, resolution: 'Done' })).status, 400);
  response = await patch(current.version, { paused_until: FUTURE });
  assert.equal(response.status, 200);
  response = await patch(response.body.version, { status: 'waiting' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'waiting');
  assert.equal(response.body.paused_until, null);
  assert.equal(response.body.response_due_at, ticket.response_due_at, 'Scheduling preserves the configured SLA target');
});

test('reports retain paused tickets and search and export their UTC resume dates', async t => {
  const h = await harness(t), session = await h.login();
  await h.create(session, { subject: 'Regular support request' });
  const first = await h.create(session, { paused_until: '2099-05-14T00:00:00Z' });
  const last = await h.create(session, { paused_until: '2099-05-14T23:59:59.999Z' });
  await h.create(session, { paused_until: '2099-05-15T00:00:00Z' });
  const options = await h.request('/reports/options', { session });
  assert.ok(options.body.date_fields.includes('paused_until'));
  assert.ok(options.body.workflow.statuses.some(status => status.id === 'paused' && status.kind === 'paused'));
  const all = await h.request('/reports/tickets', { session });
  assert.equal(all.body.total, 4, 'Report history includes scheduled work');
  const query = '?status=paused&date_field=paused_until&date_from=2099-05-14&date_to=2099-05-14';
  const filtered = await h.request('/reports/tickets' + query, { session });
  assert.equal(filtered.status, 200);
  assert.deepEqual(new Set(filtered.body.tickets.map(ticket => ticket.key)), new Set([first.key, last.key]));
  assert.ok(filtered.body.tickets.every(ticket => !ticket.is_overdue));
  const csv = await h.request('/reports/tickets.csv' + query, { session });
  assert.equal(csv.status, 200);
  const records = csvRecords(csv.body);
  assert.deepEqual(new Set(records.map(row => row['Ticket ID'])), new Set([first.key, last.key]));
  assert.deepEqual(new Set(records.map(row => row['Paused until (UTC)'])), new Set(['2099-05-14T00:00:00.000Z', '2099-05-14T23:59:59.999Z']));
  assert.ok(records.every(row => row.Status === 'paused'));
});

test('report reads resume overdue schedules even without a running background scheduler', async t => {
  const h = await harness(t), session = await h.login();
  const ticket = await h.create(session, { paused_until: FUTURE });
  h.store.db.prepare('UPDATE tickets SET paused_until=? WHERE key=?').run('2020-01-01T00:00:00.000Z', ticket.key);
  const csv = await h.request('/reports/tickets.csv?status=in_progress', { session });
  assert.equal(csv.status, 200);
  const records = csvRecords(csv.body);
  assert.equal(records.length, 1);
  assert.equal(records[0]['Ticket ID'], ticket.key);
  assert.equal(records[0].Status, 'in_progress');
  assert.equal(records[0]['Paused until (UTC)'], '');
  const current = await h.request(`/tickets/${ticket.key}`, { session });
  assert.equal(current.body.status, 'in_progress');
  assert.equal(current.body.paused_until, null);
  assert.equal(current.body.version, ticket.version + 1);
});
