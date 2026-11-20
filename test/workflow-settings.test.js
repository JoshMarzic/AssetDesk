import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { createDeskRouter } from '../src/desk-routes.js';

function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store);
  t.after(() => store.close());
  function choice(type, input) {
    const before = new Set(desk.settings.snapshot()[type].map(row => row.id));
    const result = desk.settings.create(type, input, { version: desk.settings.snapshot().version });
    return result[type].find(row => !before.has(row.id));
  }
  function ticket(key, created = '2026-01-01T00:00:00.000Z') {
    store.saveTicket({ key, subject: 'Workflow test', requester: 'requester@example.test', page_id: 0, page_url: '', created_at: created });
    return desk.getTicket(key);
  }
  return { store, desk, choice, ticket };
}

test('configured priorities and categories drive ticket intake, SLA, sorting and active dashboard counts', t => {
  const h = fixture(t);
  const priority = h.choice('priorities', { name: 'Critical outage', rank: 8, response_hours: 0.25, resolution_hours: 3 });
  const category = h.choice('categories', { name: 'Facilities' });
  const status = h.choice('statuses', { name: 'Awaiting supplier', kind: 'active' });
  h.ticket('HD-CUSTOM'); h.ticket('HD-DEFAULT');
  let ticket = h.desk.captureEmail('HD-CUSTOM', { text: 'A custom classification.', from: { address: 'requester@example.test' }, desk: { priority: priority.id, category: category.id } }, { receiptId: 'custom-intake', source: 'manual' });
  assert.equal(ticket.priority, priority.id); assert.equal(ticket.category, category.id);
  assert.equal(Date.parse(ticket.response_due_at) - Date.parse(ticket.created_at), 15 * 60_000);
  assert.equal(Date.parse(ticket.resolution_due_at) - Date.parse(ticket.created_at), 3 * 3_600_000);
  ticket = h.desk.updateTicket(ticket.key, { status: status.id }, { version: ticket.version });
  assert.equal(ticket.status_kind, 'active'); assert.equal(ticket.status_name, status.name);
  assert.equal(ticket.priority_name, priority.name); assert.equal(ticket.priority_rank, 8); assert.equal(ticket.category_name, category.name);
  assert.equal(h.desk.listTickets({ sort: 'priority', limit: 1 }).tickets[0].key, ticket.key);
  assert.equal(h.desk.listTickets({ view: 'open', status: status.id }).total, 1);
  assert.equal(h.desk.listTickets({ view: 'unassigned', status: status.id }).total, 1);
  assert.equal(h.desk.listTickets({ view: 'overdue', status: status.id }).total, 1);
  assert.equal(h.desk.dashboard().stats.active, 2); assert.equal(h.desk.dashboard().stats.overdue, 2);
  assert.equal(h.desk.dashboard().sla.targetsHours[priority.id].response, 0.25);
});

test('custom status kinds enforce resolution and closing while preserving deadlines on reopen', t => {
  const h = fixture(t);
  const resolved = h.choice('statuses', { name: 'Completed by technician', kind: 'resolved' });
  const closed = h.choice('statuses', { name: 'Confirmed complete', kind: 'closed' });
  const active = h.choice('statuses', { name: 'Waiting for approval', kind: 'active' });
  let ticket = h.ticket('HD-STATE'); const deadlines = [ticket.response_due_at, ticket.resolution_due_at];
  assert.throws(() => h.desk.updateTicket(ticket.key, { status: closed.id }, { version: ticket.version }), /transition/);
  assert.throws(() => h.desk.updateTicket(ticket.key, { status: resolved.id }, { version: ticket.version }), /resolution summary/);
  ticket = h.desk.updateTicket(ticket.key, { status: resolved.id, resolution: 'Replaced the failed part.' }, { version: ticket.version });
  const resolvedAt = ticket.resolved_at;
  assert.equal(h.desk.dashboard().stats.active, 0); assert.equal(h.desk.listTickets({ view: 'resolved' }).total, 1);
  ticket = h.desk.updateTicket(ticket.key, { status: closed.id }, { version: ticket.version });
  assert.equal(ticket.resolved_at, resolvedAt);
  assert.throws(() => h.desk.updateTicket(ticket.key, { status: resolved.id }, { version: ticket.version }), /transition/);
  ticket = h.desk.updateTicket(ticket.key, { status: active.id }, { version: ticket.version });
  assert.equal(ticket.resolved_at, null); assert.deepEqual([ticket.response_due_at, ticket.resolution_due_at], deadlines);
  assert.equal(h.desk.dashboard().stats.active, 1);
});

test('archived choices remain usable for history and unchanged fields, but cannot be newly assigned', t => {
  const h = fixture(t);
  const priority = h.choice('priorities', { name: 'Project work', rank: 1, response_hours: 24, resolution_hours: 168 });
  const category = h.choice('categories', { name: 'Office move' });
  const status = h.choice('statuses', { name: 'Awaiting move date', kind: 'active' });
  let ticket = h.ticket('HD-ARCHIVED'); h.ticket('HD-NEW');
  ticket = h.desk.updateTicket(ticket.key, { priority: priority.id, category: category.id, status: status.id }, { version: ticket.version });
  for (const [type, record] of [['priorities', priority], ['categories', category], ['statuses', status]]) h.desk.settings.update(type, record.id, { active: false }, { version: h.desk.settings.snapshot().version });
  ticket = h.desk.updateTicket(ticket.key, { priority: priority.id, category: category.id, status: status.id, subject: 'Keep historical choices' }, { version: ticket.version });
  assert.equal(ticket.subject, 'Keep historical choices');
  assert.equal(h.desk.listTickets({ priority: priority.id, category: category.id, status: status.id }).total, 1);
  assert.equal(h.desk.listTickets({ view: 'open', status: status.id }).total, 1);
  for (const [field, value] of [['priority', priority.id], ['category', category.id], ['status', status.id]]) {
    const fresh = h.desk.getTicket('HD-NEW');
    assert.throws(() => h.desk.updateTicket(fresh.key, { [field]: value }, { version: fresh.version }), /active/);
  }
});

test('requester email replies reopen custom terminal statuses using the configured lifecycle kind', t => {
  const h = fixture(t);
  const completed = h.choice('statuses', { name: 'Customer accepted', kind: 'closed' });
  let ticket = h.ticket('HD-REPLY');
  ticket = h.desk.updateTicket(ticket.key, { status: 'resolved', resolution: 'Fixed.' }, { version: ticket.version });
  ticket = h.desk.updateTicket(ticket.key, { status: completed.id }, { version: ticket.version });
  const due = ticket.resolution_due_at;
  ticket = h.desk.captureEmail(ticket.key, { text: 'The problem came back.', from: { address: 'requester@example.test' } }, { receiptId: 'custom-reply', isReply: true });
  assert.equal(ticket.status, 'open'); assert.equal(ticket.resolved_at, null); assert.equal(ticket.resolution_due_at, due);
});

test('authenticated workflow metadata and manual intake accept configured choices through the API', async t => {
  const h = fixture(t), workspace = new WorkspaceStore(h.desk), worker = new Worker({ store: h.store, desk: h.desk, workspace, logger: { error() {} } });
  const priority = h.choice('priorities', { name: 'Customer escalation', rank: 7, response_hours: 0.5, resolution_hours: 4 });
  const category = h.choice('categories', { name: 'Customer systems' });
  const password = 'Workflow-settings-password-2026';
  const user = await h.desk.createTechnician({ name: 'Technician', email: 'tech@example.test', password });
  const app = express(); app.use('/api/desk', createDeskRouter({ desk: h.desk, store: h.store, workspace, worker, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await worker.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  assert.equal((await fetch(origin + '/workflow')).status, 401);
  const login = await fetch(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  const metadata = await fetch(origin + '/workflow', { headers: { Cookie: cookie } });
  assert.equal(metadata.status, 200); assert.ok((await metadata.json()).priorities.some(row => row.id === priority.id));
  const create = await fetch(origin + '/tickets', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: 'Custom ticket', requester: 'requester@example.test', description: 'A configured workflow.', priority: priority.id, category: category.id }) });
  assert.equal(create.status, 202); const receipt = await create.json();
  assert.equal(h.desk.getTicket(receipt.ticketKey).priority, priority.id);
  assert.equal(h.desk.getTicket(receipt.ticketKey).category, category.id);
});
