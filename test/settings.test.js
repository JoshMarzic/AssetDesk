import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { WorkflowSettings } from '../src/workflow-settings.js';
import { createDeskRouter } from '../src/desk-routes.js';

const PASSWORD = 'Settings-test-password-2026';
function context(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store);
  desk.settings ||= new WorkflowSettings(store.db);
  t.after(() => store.close());
  return { store, desk, settings: desk.settings };
}
function create(settings, type, values) { return settings.create(type, values, { version: settings.snapshot().version }); }
function update(settings, type, id, values) { return settings.update(type, id, values, { version: settings.snapshot().version }); }

test('workflow settings initialize compatible defaults once and preserve changes across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-settings-')), filename = join(directory, 'desk.sqlite');
  let store = new Store(filename);
  try {
    let settings = new WorkflowSettings(store.db);
    assert.deepEqual(settings.snapshot().statuses.map(value => value.id), ['open', 'in_progress', 'waiting', 'resolved', 'closed']);
    assert.equal(settings.get('priorities', 'normal').response_hours, 8);
    assert.equal(settings.get('priorities', 'urgent').resolution_hours, 8);
    update(settings, 'priorities', 'normal', { name: 'Standard support', response_hours: 3, resolution_hours: 30 });
    const added = create(settings, 'categories', { name: 'Facilities' }).categories.find(value => value.name === 'Facilities');
    const saved = settings.snapshot();
    store.close(); store = new Store(filename); settings = new WorkflowSettings(store.db);
    assert.deepEqual(settings.snapshot(), saved);
    assert.equal(settings.get('categories', added.id).system, false);
    assert.equal(settings.sla('2026-01-01T00:00:00.000Z', 'normal').response_due_at, '2026-01-01T03:00:00.000Z');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('custom workflow choices keep stable IDs, allow archiving and preserve historical selection', t => {
  const { settings } = context(t);
  const added = create(settings, 'statuses', { name: 'Awaiting customer', kind: 'active' }).statuses.find(value => value.name === 'Awaiting customer');
  assert.match(added.id, /^[a-z][a-z0-9-]*$/); assert.equal(settings.statusKind(added.id), 'active');
  update(settings, 'statuses', added.id, { name: 'Waiting for requester', active: false });
  assert.equal(settings.get('statuses', added.id).name, 'Waiting for requester');
  assert.equal(settings.get('statuses', added.id).active, false);
  assert.throws(() => settings.validateChoice('statuses', added.id), error => error.statusCode === 400);
  assert.equal(settings.validateChoice('statuses', added.id, { allowInactiveId: added.id }).id, added.id);
  assert.throws(() => update(settings, 'statuses', added.id, { kind: 'resolved' }), error => error.statusCode === 400);
  create(settings, 'statuses', { name: 'Completed verification', kind: 'resolved' });
  const priority = create(settings, 'priorities', { name: 'Critical', rank: 5, response_hours: 0.25, resolution_hours: 2 }).priorities.find(value => value.name === 'Critical');
  assert.equal(settings.snapshot().priorities[0].id, priority.id);
  assert.deepEqual(settings.sla('2026-01-01T00:00:00.000Z', priority.id), { response_due_at: '2026-01-01T00:15:00.000Z', resolution_due_at: '2026-01-01T02:00:00.000Z' });
  update(settings, 'priorities', priority.id, { active: false });
  assert.equal(settings.get('priorities', priority.id).active, false);
  assert.equal(settings.sla('2026-01-01T00:00:00.000Z', priority.id).response_due_at, '2026-01-01T00:15:00.000Z');
});

test('settings reject invalid values, duplicate names, stale writes and changes to protected defaults atomically', t => {
  const { settings } = context(t);
  const original = settings.snapshot();
  const invalidPriorities = [
    { name: 'Bad rank', rank: 0, response_hours: 1, resolution_hours: 2 },
    { name: 'Bad fraction', rank: 1.5, response_hours: 1, resolution_hours: 2 },
    { name: 'Bad deadline', rank: 3, response_hours: 5, resolution_hours: 1 },
    { name: 'Zero response', rank: 3, response_hours: 0, resolution_hours: 1 },
    { name: 'Infinite response', rank: 3, response_hours: Infinity, resolution_hours: 87600 },
    { name: 'Huge target', rank: 3, response_hours: 1, resolution_hours: 87601 },
  ];
  for (const values of invalidPriorities) assert.throws(() => create(settings, 'priorities', values), error => error.statusCode === 400);
  for (const value of ['', ' ', 'x'.repeat(101), 'Bad\nname', 'Bad\u0085name', null]) assert.throws(() => create(settings, 'categories', { name: value }), error => error.statusCode === 400);
  assert.throws(() => create(settings, 'statuses', { name: 'Mystery', kind: 'invisible' }), error => error.statusCode === 400);
  assert.throws(() => create(settings, 'categories', { name: 'General' }), error => error.statusCode === 409);
  assert.throws(() => create(settings, 'categories', { name: 'ＧＥＮＥＲＡＬ' }), error => error.statusCode === 409);
  assert.throws(() => update(settings, 'priorities', 'normal', { active: false }), error => error.statusCode === 400);
  assert.throws(() => update(settings, 'categories', 'general', { active: 'false' }), error => error.statusCode === 400);
  assert.throws(() => settings.update('categories', 'general', { name: 'Different' }, {}), error => error.statusCode === 400);
  assert.deepEqual(settings.snapshot(), original, 'Failed mutations must not consume a revision or change options');
  create(settings, 'categories', { name: 'Facilities' });
  assert.throws(() => settings.update('categories', 'general', { name: 'Different' }, { version: original.version }), error => error.statusCode === 409);
});

test('SLA edits preserve existing deadlines unless an explicit active-ticket recalculation is requested', t => {
  const { store, desk, settings } = context(t);
  const created = '2026-01-01T00:00:00.000Z';
  for (const key of ['HD-ACTIVE', 'HD-RESOLVED', 'HD-OTHER']) store.saveTicket({ key, requester: 'person@example.test', subject: 'Existing request', page_id: 0, page_url: '', created_at: created });
  desk.initializeRows();
  store.db.prepare("UPDATE tickets SET status='resolved',resolved_at='2026-01-02T00:00:00.000Z',resolution='Completed',first_response_at='2026-01-01T01:00:00.000Z' WHERE key='HD-RESOLVED'").run();
  store.db.prepare("UPDATE tickets SET priority='high' WHERE key='HD-OTHER'").run();
  const active = desk.getTicket('HD-ACTIVE'), resolved = desk.getTicket('HD-RESOLVED'), other = desk.getTicket('HD-OTHER');
  update(settings, 'priorities', 'normal', { response_hours: 4, resolution_hours: 48 });
  assert.equal(desk.getTicket('HD-ACTIVE').response_due_at, active.response_due_at);
  const actor = { id: 'settings-admin', name: 'Settings administrator', role: 'admin' };
  const changed = settings.update('priorities', 'normal', { response_hours: 0.5, resolution_hours: 12, recalculate_open_tickets: true }, { version: settings.snapshot().version, actor });
  assert.equal(changed.affected_tickets, 1);
  const recalculated = desk.getTicket('HD-ACTIVE');
  assert.equal(recalculated.response_due_at, '2026-01-01T00:30:00.000Z');
  assert.equal(recalculated.resolution_due_at, '2026-01-01T12:00:00.000Z');
  assert.equal(recalculated.created_at, created); assert.equal(recalculated.version, active.version + 1);
  assert.equal(recalculated.events.at(-1).actor_name, actor.name); assert.equal(recalculated.events.at(-1).type, 'sla');
  assert.equal(desk.getTicket('HD-RESOLVED').response_due_at, resolved.response_due_at);
  assert.equal(desk.getTicket('HD-RESOLVED').resolution_due_at, resolved.resolution_due_at);
  assert.equal(desk.getTicket('HD-RESOLVED').version, resolved.version);
  assert.equal(desk.getTicket('HD-OTHER').resolution_due_at, other.resolution_due_at);
});

test('SLA recalculation failure rolls back settings, ticket deadlines and the settings revision together', t => {
  const { store, desk, settings } = context(t);
  store.saveTicket({ key: 'HD-FIRST', requester: 'person@example.test', subject: 'Valid request', page_id: 0, page_url: '', created_at: '2026-01-01T00:00:00.000Z' });
  desk.initializeRows();
  store.saveTicket({ key: 'HD-BROKEN', requester: 'person@example.test', subject: 'Corrupted old date', page_id: 0, page_url: '', created_at: 'not-a-date' });
  store.db.prepare("UPDATE tickets SET created_at='not-a-date' WHERE key='HD-BROKEN'").run();
  const before = settings.snapshot(), deadline = store.db.prepare("SELECT response_due_at FROM tickets WHERE key='HD-FIRST'").get().response_due_at;
  assert.throws(() => update(settings, 'priorities', 'normal', { response_hours: 1, resolution_hours: 2, recalculate_open_tickets: true }), error => error.statusCode === 400);
  assert.deepEqual(settings.snapshot(), before);
  assert.equal(store.db.prepare("SELECT response_due_at FROM tickets WHERE key='HD-FIRST'").get().response_due_at, deadline);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM ticket_events WHERE type='sla'").get().count, 0);
});

test('settings API requires an administrator and CSRF, while authenticated technicians can read workflow choices', async t => {
  const { store, desk } = context(t), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Settings administrator', email: 'admin@settings.example', password: PASSWORD });
  const tech = await desk.createTechnician({ name: 'Settings technician', email: 'tech@settings.example', password: PASSWORD });
  const app = express(); app.use('/api/desk', createDeskRouter({ store, desk, workspace, worker: {}, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + path, { method, headers: { ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function login(user) {
    const response = await fetch(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PASSWORD }) });
    const value = await response.json(); return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: value.csrfToken };
  }
  assert.equal((await request('/settings')).status, 401);
  const technician = await login(tech), administrator = await login(admin);
  assert.equal((await request('/settings', { session: technician })).status, 403);
  const workflow = await request('/workflow', { session: technician }); assert.equal(workflow.status, 200); assert.ok(workflow.body.statuses.length >= 5);
  const initial = await request('/settings', { session: administrator }); assert.equal(initial.status, 200);
  const values = { name: 'Facilities API', version: initial.body.version };
  assert.equal((await request('/settings/categories', { method: 'POST', session: technician, body: values })).status, 403);
  assert.equal((await request('/settings/categories', { method: 'POST', session: administrator, body: values, csrf: false })).status, 403);
  const created = await request('/settings/categories', { method: 'POST', session: administrator, body: values }); assert.equal(created.status, 201);
  const category = created.body.categories.find(value => value.name === values.name); assert.ok(category);
  const patched = await request('/settings/categories/' + category.id, { method: 'PATCH', session: administrator, body: { name: 'Building support', version: created.body.version } }); assert.equal(patched.status, 200);
  assert.ok(patched.body.categories.some(value => value.id === category.id && value.name === 'Building support'));
  assert.equal((await request('/settings/categories/' + category.id, { method: 'PATCH', session: administrator, body: { name: 'Stale edit', version: created.body.version } })).status, 409);
});
