import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore, normalizeTicketTag } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { createDeskRouter } from '../src/desk-routes.js';

const PASSWORD = 'Ticket-tags-test-password-2026';
function save(store, key = 'HD-TAGS') { store.saveTicket({ key, requester: 'person@tags.example', subject: 'Workstation issue', page_id: 0, page_url: '' }); }
async function harness(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Tag administrator', email: 'admin@tags.example', password: PASSWORD });
  const tech = await desk.createTechnician({ name: 'Tag technician', email: 'tech@tags.example', password: PASSWORD });
  const worker = new Worker({ store, desk, workspace, logger: { error() {} } });
  const app = express(); app.use('/api/desk', createDeskRouter({ store, desk, workspace, worker, config: { cookieSecure: false } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.stop(); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const res = await fetch(origin + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  }
  async function login(user = tech) { const result = await fetch(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PASSWORD }) }); const body = await result.json(); return { cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken }; }
  return { store, desk, workspace, worker, admin, tech, request, login };
}

test('ticket tag migration preserves existing records and tags survive a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-tags-')), filename = join(directory, 'desk.sqlite');
  let store = new Store(filename);
  try {
    save(store); const desk = new DeskStore(store);
    assert.deepEqual(desk.getTicket('HD-TAGS').tags, []);
    desk.addTicketTag('HD-TAGS', 'Needs follow-up');
    store.close(); store = new Store(filename);
    const reopened = new DeskStore(store);
    assert.equal(reopened.getTicket('HD-TAGS').subject, 'Workstation issue');
    assert.deepEqual(reopened.getTicket('HD-TAGS').tags, ['Needs follow-up']);
    assert.deepEqual(reopened.listTickets().tickets[0].tags, ['Needs follow-up']);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('tags normalize Unicode and whitespace, reuse display names and apply idempotent versioned audit changes', async t => {
  const h = await harness(t); save(h.store); save(h.store, 'HD-SECOND');
  const initial = h.desk.getTicket('HD-TAGS');
  let ticket = h.desk.addTicketTag('HD-TAGS', '  ＶＩＰ  ', h.tech);
  ticket = h.desk.addTicketTag('HD-TAGS', ' Needs   follow-up ', h.tech);
  assert.deepEqual(ticket.tags, ['Needs follow-up', 'VIP']);
  assert.equal(ticket.version, initial.version + 2);
  assert.equal(ticket.events.filter(event => event.type === 'tag').length, 2);
  const duplicate = h.desk.addTicketTag('HD-TAGS', 'vip', h.admin);
  assert.equal(duplicate.version, ticket.version); assert.equal(duplicate.events.length, ticket.events.length);
  assert.equal(h.desk.addTicketTag('HD-SECOND', 'vIp', h.admin).tags[0], 'VIP');
  assert.deepEqual(h.desk.listTags({ search: 'ＶＩＰ' }), [{ name: 'VIP', ticket_count: 2 }]);
  const removed = h.desk.removeTicketTag('HD-TAGS', 'VIP', h.tech);
  assert.deepEqual(removed.tags, ['Needs follow-up']); assert.equal(removed.version, ticket.version + 1);
  assert.equal(h.desk.removeTicketTag('HD-TAGS', 'vip', h.tech).version, removed.version);
  assert.equal(removed.events.at(-1).actor_name, h.tech.name);
  assert.match(removed.events.at(-1).body, /Removed tag: VIP/);
});

test('tag validation rejects invalid names, bounds Unicode characters and enforces the per-ticket limit atomically', async t => {
  const h = await harness(t); save(h.store);
  for (const value of [null, undefined, 4, {}, [], '', '   ', 'bad\nname', 'bad\tname', 'bad\u0085name', 'a'.repeat(51)]) assert.throws(() => h.desk.addTicketTag('HD-TAGS', value), error => error.statusCode === 400);
  const unicode = '😀'.repeat(50); assert.equal(normalizeTicketTag(unicode).name, unicode);
  for (let index = 0; index < 25; index++) h.desk.addTicketTag('HD-TAGS', `Tag ${index}`);
  const full = h.desk.getTicket('HD-TAGS');
  assert.throws(() => h.desk.addTicketTag('HD-TAGS', 'overflow'), error => error.statusCode === 400);
  assert.equal(h.desk.getTicket('HD-TAGS').version, full.version); assert.equal(h.desk.ticketTags('HD-TAGS').length, 25);
  assert.equal(h.desk.addTicketTag('HD-TAGS', 'tag 0').version, full.version);
  h.desk.removeTicketTag('HD-TAGS', 'tag 0'); h.desk.addTicketTag('HD-TAGS', unicode);
  assert.equal(h.desk.ticketTags('HD-TAGS').length, 25);
  assert.throws(() => h.desk.addTicketTag('HD-MISSING', 'new'), error => error.statusCode === 404);
  assert.throws(() => h.desk.removeTicketTag('HD-MISSING', 'new'), error => error.statusCode === 404);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS count FROM ticket_tags WHERE ticket_key='HD-MISSING'").get().count, 0);
});

test('tag routes require authentication and CSRF while technicians can add, remove and discover safely', async t => {
  const h = await harness(t); save(h.store);
  assert.equal((await h.request('/tags')).status, 401);
  assert.equal((await h.request('/tickets/HD-TAGS/tags', { method: 'POST', body: { tag: 'Security' } })).status, 401);
  const session = await h.login();
  for (const method of ['POST', 'DELETE']) assert.equal((await h.request('/tickets/HD-TAGS/tags', { method, body: { tag: 'Security' }, session, csrf: false })).status, 403);
  const added = await h.request('/tickets/HD-TAGS/tags', { method: 'POST', body: { tag: 'Security' }, session });
  assert.equal(added.status, 201); assert.deepEqual(added.body.tags, ['Security']); assert.ok(Array.isArray(added.body.assets));
  assert.deepEqual((await h.request('/tickets/HD-TAGS', { session })).body.tags, ['Security']);
  assert.deepEqual((await h.request('/tickets', { session })).body.tickets[0].tags, ['Security']);
  assert.deepEqual((await h.request('/tags?search=sec&limit=1', { session })).body.tags, [{ name: 'Security', ticket_count: 1 }]);
  assert.equal((await h.request('/tickets/HD-TAGS/tags', { method: 'POST', body: { tag: 'x', admin: true }, session })).status, 400);
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'search=a&search=b', 'unknown=x']) assert.equal((await h.request('/tags?' + query, { session })).status, 400);
  h.desk.addTicketTag('HD-TAGS', '100%_ready');
  assert.deepEqual((await h.request('/tags?search=%25_', { session })).body.tags, [{ name: '100%_ready', ticket_count: 1 }]);
  assert.equal((await h.request('/tickets/HD-TAGS/tags', { method: 'DELETE', body: { tag: 'SECURITY' }, session })).status, 200);
  assert.ok(!(await h.request('/tickets/HD-TAGS', { session })).body.tags.includes('Security'));
});

test('parallel tag additions preserve other technicians tags and make old property versions conflict', async t => {
  const h = await harness(t); save(h.store); const initial = h.desk.getTicket('HD-TAGS');
  const [techSession, adminSession] = await Promise.all([h.login(), h.login(h.admin)]);
  const responses = await Promise.all(['Triage', 'VIP', 'Security', 'Triage'].map((tag, index) => h.request('/tickets/HD-TAGS/tags', { method: 'POST', body: { tag }, session: index % 2 ? adminSession : techSession })));
  assert.ok(responses.every(response => response.status === 201));
  const ticket = h.desk.getTicket('HD-TAGS'); assert.deepEqual(ticket.tags, ['Security', 'Triage', 'VIP']);
  assert.equal(ticket.version, initial.version + 3); assert.equal(ticket.events.filter(event => event.type === 'tag').length, 3);
  const stale = await h.request('/tickets/HD-TAGS', { method: 'PATCH', session: techSession, body: { version: initial.version, priority: 'high' } });
  assert.equal(stale.status, 409); assert.equal(h.desk.getTicket('HD-TAGS').priority, 'normal');
});

test('manual creation accepts initial tags atomically and invalid tag lists create no ticket or receipt', async t => {
  const h = await harness(t), session = await h.login();
  const body = { subject: 'Tagged workstation request', requester: 'requester@tags.example', description: 'Please investigate.', tags: ['Triage', 'triage', ' Needs follow-up '] };
  const created = await h.request('/tickets', { method: 'POST', session, body });
  assert.equal(created.status, 202); assert.equal(created.body.state, 'done');
  const ticket = (await h.request('/tickets/' + created.body.ticketKey, { session })).body;
  assert.deepEqual(ticket.tags, ['Needs follow-up', 'Triage']); assert.equal(ticket.source, 'manual');
  const counts = () => [h.store.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count, h.store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count];
  const before = counts();
  for (const tags of [null, 'not an array', ['valid', 'bad\nvalue'], Array(26).fill('tag')]) assert.equal((await h.request('/tickets', { method: 'POST', session, body: { ...body, tags } })).status, 400);
  assert.deepEqual(counts(), before);
  const add = h.desk.addTicketTag.bind(h.desk); let attempts = 0;
  h.desk.addTicketTag = (...args) => { if (++attempts === 2) throw new Error('Simulated persistence failure'); return add(...args); };
  const failed = await h.request('/tickets', { method: 'POST', session, body: { ...body, tags: ['First', 'Second'] } });
  assert.equal(failed.status, 500); assert.deepEqual(counts(), before);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS count FROM ticket_tags WHERE name='First'").get().count, 0);
});
