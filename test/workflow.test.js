import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, receiptId } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { createApp } from '../src/app.js';
import { parseRawEmail } from '../src/email.js';
import { configFromEnv } from '../src/config.js';
const config = { inboundToken: 'intake-token-for-tests-123456789012345', adminToken: 'admin-token-for-tests-1234567890123456' };
const rawEmail = ({ id = 'first', from = 'requester@example.com', text = 'My PC-123 is broken.', replyTo = '' } = {}) =>
  `From: ${from}\r\nSubject: Help with PC-123\r\nMessage-ID: <${id}@example.com>\r\n${replyTo ? `In-Reply-To: <${replyTo}@example.com>\r\n` : ''}\r\n${text}`;
async function harness(t, { supportEmails = [] } = {}) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Admin', email: 'admin@example.com', password: 'test-password-at-least-12' });
  const worker = new Worker({ store, desk, workspace, supportEmails, logger: { error() {} } });
  const server = createApp({ store, desk, workspace, worker, config }).listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await worker.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  async function request(path, { method = 'GET', token = config.adminToken, headers = {}, body } = {}) {
    const response = await fetch(url + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });
    return { status: response.status, body: await response.json() };
  }
  async function inbound(input) { const result = await request('/api/inbound/email', { method: 'POST', token: config.inboundToken, headers: { 'content-type': 'message/rfc822' }, body: rawEmail(input) }); await worker.active; return result; }
  return { store, desk, workspace, worker, admin, request, inbound };
}
test('native email intake creates typed assets and both directions of ticket history immediately and once', async t => {
  const h = await harness(t); const first = await h.inbound({ text: 'PC-123 and LAPTOP-22 need support.' });
  assert.equal(first.status, 202); assert.equal(first.body.state, 'done'); assert.ok(first.body.ticketKey);
  const assets = h.workspace.ticketAssets(first.body.ticketKey, h.admin); assert.deepEqual(assets.map(a => a.ref), ['LAPTOP-22', 'PC-123']);
  assert.equal(assets.find(a => a.ref === 'PC-123').type, 'pc');
  const pc = h.workspace.getAsset('PC-123', h.admin); assert.equal(pc.tickets[0].key, first.body.ticketKey);
  const duplicate = await h.inbound({ text: 'PC-123 and LAPTOP-22 need support.' }); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.ticketKey, first.body.ticketKey); assert.equal(duplicate.body.duplicate, true);
  const second = await h.inbound({ id: 'second', text: 'PC-123 needs a replacement screen.' }); assert.notEqual(second.body.ticketKey, first.body.ticketKey); assert.equal(h.workspace.listAssets(h.admin).total, 2); assert.equal(h.workspace.getAsset(pc.id, h.admin).tickets.length, 2);
});
test('requester and support replies retain their ticket while strangers receive a separate ticket', async t => {
  const h = await harness(t, { supportEmails: ['support@example.com'] }); const first = await h.inbound({});
  const a = await h.inbound({ id: 'reply1', replyTo: 'first', text: 'Also check MONITOR-12.' }); assert.equal(a.body.ticketKey, first.body.ticketKey);
  const b = await h.inbound({ id: 'reply2', from: 'support@example.com', replyTo: 'reply1', text: 'Investigating.' }); assert.equal(b.body.ticketKey, first.body.ticketKey);
  const c = await h.inbound({ id: 'reply3', from: 'stranger@example.com', replyTo: 'first', text: 'My own problem.' }); assert.notEqual(c.body.ticketKey, first.body.ticketKey);
  assert.equal(h.desk.getTicket(first.body.ticketKey).notes.length, 2);
  await h.inbound({ id: 'reply1', replyTo: 'first', text: 'Changed duplicate body.' }); assert.equal(h.desk.getTicket(first.body.ticketKey).notes.length, 2);
});
test('native intake enforces tokens and MIME validation without an external integration endpoint', async t => {
  const h = await harness(t); assert.equal((await h.request('/readyz', { token: null })).status, 200);
  assert.equal((await h.request('/api/queue', { token: null })).status, 401);
  assert.equal((await h.request('/api/inbound/email', { method: 'POST', token: config.adminToken, headers: { 'content-type': 'message/rfc822' }, body: rawEmail() })).status, 401);
  assert.equal((await h.request('/api/inbound/email', { method: 'POST', token: config.inboundToken, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 415);
  assert.equal((await h.request('/api/inbound/email', { method: 'POST', token: config.inboundToken, headers: { 'content-type': 'message/rfc822' }, body: 'Subject: Missing sender\r\n\r\nHelp' })).status, 400);
  assert.equal((await h.request('/api/bookstack/health')).status, 404);
});
test('manual bearer intake preserves Unicode and rejects injected headers', async t => {
  const h = await harness(t); const response = await h.request('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'Écran cassé', from: 'Alice <alice@example.com>', text: 'Échec\n<script>alert(1)</script>\nASSET-44' }) });
  assert.equal(response.status, 202); assert.equal(h.desk.getTicket(response.body.ticketKey).subject, 'Écran cassé'); assert.ok(h.desk.getTicket(response.body.ticketKey).description.includes('<script>'));
  for (const body of ['{bad', '{}', JSON.stringify({ subject: 'Bad\r\nX: injected', from: 'a@example.com', text: 'Help' })]) assert.equal((await h.request('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400);
});
test('acceptance is atomic, preserves canonical duplicates and triage, and anchors SLA to arrival', async t => {
  const h = await harness(t); const message = await parseRawEmail(rawEmail({ id: 'atomic' })); message.receivedAt = '2026-10-01T10:00:00Z';
  const accepted = h.worker.accept(message); const ticket = h.desk.getTicket(accepted.ticketKey); assert.equal(ticket.created_at, '2026-10-01T10:00:00.000Z'); assert.equal(ticket.response_due_at, '2026-10-01T18:00:00.000Z');
  h.desk.updateTicket(ticket.key, { priority: 'urgent' }, { actor: h.admin, version: ticket.version });
  const duplicate = h.worker.accept({ ...message, text: 'Changed content', desk: { priority: 'low' } }); assert.equal(duplicate.duplicate, true); assert.equal(h.desk.getTicket(ticket.key).priority, 'urgent'); assert.equal(h.desk.getTicket(ticket.key).description, message.text);
  const invalid = { ...message, messageId: '<invalid@example.com>', assetRefs: ['bad/ref'] }; assert.throws(() => h.worker.accept(invalid)); assert.equal(h.store.receipt(receiptId(invalid)), undefined);
});
test('retained pre-native failed messages recover locally once without another service', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-native-workflow-')); t.after(() => rmSync(directory, { recursive: true, force: true })); const file = join(directory, 'desk.sqlite');
  let store = new Store(file); const message = await parseRawEmail(rawEmail({ id: 'retained', text: 'PC-500 is affected.' })); const receipt = store.accept(message); store.db.prepare("UPDATE messages SET state='failed',last_error='Former wiki unavailable' WHERE id=?").run(receipt.id); store.close();
  store = new Store(file); const desk = new DeskStore(store), workspace = new WorkspaceStore(desk), worker = new Worker({ store, desk, workspace, logger: { error() {} } });
  const admin = await desk.ensureAdmin({ name: 'Admin', email: 'admin@example.com', password: 'test-password-at-least-12' }); worker.start(); await worker.active;
  assert.equal(store.receipt(receipt.id).state, 'done'); const key = store.receipt(receipt.id).ticketKey; assert.equal(workspace.getAsset('PC-500', admin).tickets[0].key, key);
  worker.wake(); await worker.active; assert.equal(desk.listTickets().total, 1); assert.equal(workspace.getAsset('PC-500', admin).tickets.length, 1); await worker.stop(); store.close();
});
test('native configuration requires no wiki credentials or database service', () => {
  const env = { INBOUND_EMAIL_TOKEN: 'a'.repeat(32), ADMIN_TOKEN: 'b'.repeat(32) }; const c = configFromEnv(env); assert.equal(c.bookstack, undefined); assert.equal(c.port, 3000);
  assert.throws(() => configFromEnv({ ...env, PORT: 'bad' })); assert.throws(() => configFromEnv({ ...env, TRUST_PROXY_HOPS: '99' })); assert.throws(() => configFromEnv({ ...env, INBOUND_EMAIL_TOKEN: env.ADMIN_TOKEN }));
});
