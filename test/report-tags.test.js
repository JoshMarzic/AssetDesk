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
  const password = 'Report-tags-password-2026';
  const user = await desk.ensureAdmin({ name: 'Tag reporter', email: 'tags@example.test', password });
  const app = express();
  app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  const login = await fetch(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(path, filters = {}) {
    const response = await fetch(origin + path + '?' + new URLSearchParams(filters), { headers: { Cookie: cookie } });
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
  }
  function ticket(key, tags, priority = 'high') {
    store.saveTicket({ key, subject: 'Workstation issue', requester: 'person@example.test', page_id: 0, page_url: '', created_at: '2026-10-04T12:00:00.000Z' });
    store.db.prepare('UPDATE tickets SET priority=? WHERE key=?').run(priority, key);
    for (const tag of tags) desk.addTicketTag(key, tag, user);
  }
  return { desk, request, ticket };
}

test('Reports searches normalized tags, combines exact tag filters and exports the ticket tags safely', async t => {
  const h = await fixture(t);
  h.ticket('HD-TAG-EXACT', ['Café, review']);
  h.ticket('HD-TAG-PREFIX', ['Café, reviewer']);
  h.ticket('HD-TAG-OTHER', ['Unrelated'], 'normal');
  const exact = await h.request('/reports/tickets', { tag: '  CAFÉ,   review  ', priority: 'high' });
  assert.equal(exact.status, 200); assert.equal(exact.body.total, 1);
  assert.equal(exact.body.tickets[0].key, 'HD-TAG-EXACT');
  assert.deepEqual(exact.body.tickets[0].tags, ['Café, review']);
  const partial = await h.request('/reports/tickets', { search: 'CAFÉ, REV' });
  assert.equal(partial.status, 200); assert.equal(partial.body.total, 2);
  assert.equal((await h.request('/reports/tickets', { tag: 'review' })).body.total, 0, 'A dedicated tag filter matches the whole tag');
  const csv = await h.request('/reports/tickets.csv', { tag: 'café, review' });
  assert.equal(csv.status, 200); assert.match(csv.body, /"Tags"\r\n/);
  assert.match(csv.body, /"Café, review"\r\n/); assert.ok(csv.body.includes('HD-TAG-EXACT'));
  assert.ok(!csv.body.includes('HD-TAG-PREFIX'));
  h.ticket('HD-TAG-FORMULA', ['=SUM(1,2)']);
  const formula = await h.request('/reports/tickets.csv', { tag: '=SUM(1,2)' });
  assert.equal(formula.status, 200); assert.match(formula.body, /"'=SUM\(1,2\)"\r\n/);
  assert.equal((await h.request('/reports/tickets', { tag: 'x'.repeat(51) })).status, 400);
});

test('Tag-filtered CSV exports every match beyond the report page and treats tag wildcards literally', async t => {
  const h = await fixture(t);
  for (let index = 0; index < 31; index++) h.ticket(`HD-TAG-PAGE-${String(index).padStart(2, '0')}`, ['100%_ready']);
  h.ticket('HD-TAG-NOT-EXACT', ['100X_ready']);
  const page = await h.request('/reports/tickets', { tag: '100%_ready', limit: '1', offset: '25' });
  assert.equal(page.status, 200); assert.equal(page.body.total, 31); assert.equal(page.body.tickets.length, 1);
  const search = await h.request('/reports/tickets', { search: '100%_' });
  assert.equal(search.body.total, 31);
  const csv = await h.request('/reports/tickets.csv', { tag: '100%_ready', limit: '1', offset: '25' });
  assert.equal(csv.status, 200);
  assert.equal((csv.body.match(/"HD-TAG-PAGE-\d+"/g) || []).length, 31);
  assert.ok(!csv.body.includes('HD-TAG-NOT-EXACT'));
});
