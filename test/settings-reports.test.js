import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { createDeskRouter } from '../src/desk-routes.js';

async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const password = 'Settings-report-password-2026';
  const admin = await desk.ensureAdmin({ name: 'Report administrator', email: 'settings-reports@example.test', password });
  const app = express();
  app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  const login = await fetch(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(path, filters = {}) {
    const response = await fetch(origin + path + '?' + new URLSearchParams(filters), { headers: { Cookie: cookie } });
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
  }
  function create(type, data) {
    const result = desk.settings.create(type, data, { version: desk.settings.snapshot().version, actor: admin });
    return result[type].find(record => record.name === data.name);
  }
  function update(type, id, data) { return desk.settings.update(type, id, data, { version: desk.settings.snapshot().version, actor: admin }); }
  function ticket(key, priority = 'normal', category = 'general') {
    const created = '2020-01-01T12:00:00.000Z';
    store.saveTicket({ key, subject: 'Workflow report fixture', requester: 'requester@example.test', page_id: 0, page_url: '', created_at: created });
    desk.captureEmail(key, { from: { address: 'requester@example.test', name: 'Requester' }, text: 'Check the equipment.', receivedAt: created,
      desk: { priority, category } }, { receiptId: 'receipt-' + key, source: 'manual' });
  }
  return { desk, admin, request, create, update, ticket };
}

test('Reports filters, priority sorting, SLA outcomes and CSV labels use configured workflow choices', async t => {
  const h = await fixture(t);
  const priority = h.create('priorities', { name: 'Critical customer', rank: 9, response_hours: 0.25, resolution_hours: 2 });
  const category = h.create('categories', { name: 'Facilities support' });
  const status = h.create('statuses', { name: 'Vendor investigation', kind: 'active' });
  h.ticket('HD-CUSTOM-REPORT', priority.id, category.id); h.ticket('HD-DEFAULT-REPORT', 'urgent');
  h.desk.updateTicket('HD-CUSTOM-REPORT', { status: status.id }, { version: h.desk.getTicket('HD-CUSTOM-REPORT').version, actor: h.admin });
  const filters = { priority: priority.id, category: category.id, status: status.id, response_sla: 'overdue' };
  const report = await h.request('/reports/tickets', filters);
  assert.equal(report.status, 200, JSON.stringify(report.body)); assert.equal(report.body.total, 1);
  const row = report.body.tickets[0];
  assert.equal(row.status_kind, 'active'); assert.equal(row.priority_rank, 9);
  assert.equal(row.status_name, status.name); assert.equal(row.priority_name, priority.name); assert.equal(row.category_name, category.name);
  assert.equal((await h.request('/reports/tickets', { sort: 'priority' })).body.tickets[0].key, 'HD-CUSTOM-REPORT');
  const csv = await h.request('/reports/tickets.csv', filters); assert.equal(csv.status, 200);
  for (const label of ['Status name', 'Priority name', 'Category name', status.name, priority.name, category.name]) assert.ok(csv.body.includes('"' + label + '"'));
  const resolved = h.create('statuses', { name: 'Customer confirmed', kind: 'resolved' });
  h.desk.updateTicket('HD-CUSTOM-REPORT', { status: resolved.id, resolution: 'Confirmed working.' }, { version: h.desk.getTicket('HD-CUSTOM-REPORT').version, actor: h.admin });
  assert.equal((await h.request('/reports/tickets', { status: resolved.id, response_sla: 'overdue' })).body.total, 0, 'Custom terminal statuses must not be treated as active overdue requests');
});

test('Archived workflow choices remain searchable and renamed labels appear without replacing ticket identifiers', async t => {
  const h = await fixture(t);
  const priority = h.create('priorities', { name: 'Project priority', rank: 7, response_hours: 3, resolution_hours: 10 });
  const category = h.create('categories', { name: 'Project support' });
  const status = h.create('statuses', { name: 'Project queue', kind: 'active' });
  h.ticket('HD-ARCHIVED-WORKFLOW', priority.id, category.id);
  h.desk.updateTicket('HD-ARCHIVED-WORKFLOW', { status: status.id }, { version: h.desk.getTicket('HD-ARCHIVED-WORKFLOW').version, actor: h.admin });
  h.update('priorities', priority.id, { name: 'Retired project priority', active: false });
  h.update('categories', category.id, { active: false }); h.update('statuses', status.id, { active: false });
  const report = await h.request('/reports/tickets', { priority: priority.id, category: category.id, status: status.id });
  assert.equal(report.status, 200); assert.equal(report.body.total, 1);
  assert.equal(report.body.tickets[0].priority, priority.id); assert.equal(report.body.tickets[0].priority_name, 'Retired project priority');
  const options = await h.request('/reports/options'); assert.equal(options.status, 200);
  assert.ok(options.body.workflow.priorities.some(record => record.id === priority.id && !record.active));
});
