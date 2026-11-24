import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { AiSettings } from '../src/ai-settings.js';
import { AiService } from '../src/ai-service.js';
import { createDeskRouter } from '../src/desk-routes.js';

const password = 'Related-assets-API-password-2026';
async function fixture(t, { review } = {}) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Related history administrator', email: 'related-admin@example.test', password });
  const tech = await desk.createTechnician({ name: 'Related technician', email: 'related-tech@example.test', password });
  const settings = new AiSettings(store.db, { encryptionKey: 'Related assets stable encryption key for API tests' });
  settings.update({ version: settings.snapshot().version, enabled: true, suggest_related: true, auto_tags: false, auto_location: false,
    auto_assets: false, suggest_fixes: false, auto_reply: true, providers: { openai: { api_key: 'related-assets-test-key-only' } } }, { actor: admin });
  const calls = [], sent = [];
  const providers = { async review(input) {
    calls.push(structuredClone(input));
    if (review) return review(input);
    assert.equal(input.kind, 'related');
    return { recent_tickets: [], asset_issues: [] };
  } };
  const mail = { capabilities: () => ({ email: { configured: true } }), async sendEmail(input) { sent.push(input); } };
  const ai = new AiService({ desk, workspace, settings, providers, mail, logger: { error() {} } });
  const app = express();
  app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: {}, aiSettings: settings, aiProviders: providers, aiService: ai, actionTransports: mail }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await ai.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}),
      ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function login(user = admin) {
    const response = await request('/login', { method: 'POST', body: { email: user.email, password } });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: response.body.csrfToken };
  }
  function ticket(key, hours = 1) {
    store.saveTicket({ key, requester: 'requester@example.test', subject: 'Docking station display flickers', page_id: 0, page_url: '' });
    const created = new Date(Date.now() - hours * 3600000).toISOString();
    store.db.prepare('UPDATE tickets SET created_at=?,updated_at=?,description=? WHERE key=?').run(created, created, 'The display flickers when connected to the docking station.', key);
    return desk.getTicket(key);
  }
  function configure(patch) { return settings.update({ version: settings.snapshot().version, ...patch }, { actor: admin }); }
  return { store, desk, workspace, settings, ai, calls, sent, admin, tech, request, login, ticket, configure };
}

test('a newly linked shared asset queues a nonblocking AI history review once and never sends requester email', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const h = await fixture(t, { review: async input => {
    assert.equal(input.kind, 'related'); entered(); await gate;
    return { recent_tickets: [], asset_issues: [{ asset_id: asset.id, ticket_key: previous.key, reason: 'The same display flicker occurred on this docking station.' }] };
  } });
  const current = h.ticket('HD-LINK-NOW'), previous = h.ticket('HD-LINK-PAST', 60 * 24);
  const asset = h.workspace.createAsset({ ref: 'DOCK-LINK-1', name: 'Shared docking station', type: 'peripheral' }, h.admin);
  h.workspace.linkTicket(previous.key, asset.id, h.admin);
  const session = await h.login();
  const linked = await h.request(`/tickets/${current.key}/assets`, { method: 'POST', session, body: { ref: asset.ref } });
  assert.equal(linked.status, 201); assert.equal(linked.body.queued, true); assert.equal(linked.body.duplicate, false);
  await started;
  const jobs = h.store.db.prepare('SELECT source,is_reply,auto_reply_allowed FROM ai_ticket_jobs WHERE ticket_key=?').all(current.key);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].source, 'review'); assert.equal(jobs[0].is_reply, 1); assert.equal(jobs[0].auto_reply_allowed, 0);
  const duplicate = await h.request(`/tickets/${current.key}/assets`, { method: 'POST', session, body: { ref: asset.ref } });
  assert.equal(duplicate.status, 201); assert.equal(duplicate.body.duplicate, true); assert.equal(duplicate.body.queued, false);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM ai_ticket_jobs').get().count, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0);
  release(); await h.ai.active;
  const state = await h.request(`/tickets/${current.key}/ai`, { session });
  assert.equal(state.status, 200); assert.equal(state.body.status, 'completed');
  assert.equal(state.body.related.status, 'ready');
  assert.equal(state.body.related.asset_issues[0].asset.id, asset.id);
  assert.equal(state.body.related.asset_issues[0].tickets[0].key, previous.key);
  assert.equal(h.sent.length, 0); assert.equal(h.desk.getTicket(current.key).status, current.status);
});

test('disabled matching, disabled AI, and restricted-only asset links do not queue extra provider work', async t => {
  const h = await fixture(t), current = h.ticket('HD-LINK-OFF'), session = await h.login();
  h.configure({ suggest_related: false });
  const first = h.workspace.createAsset({ ref: 'DOCK-OFF-1', name: 'First shared dock', type: 'peripheral' }, h.admin);
  let response = await h.request(`/tickets/${current.key}/assets`, { method: 'POST', session, body: { ref: first.ref } });
  assert.equal(response.status, 201); assert.equal(response.body.queued, false);
  h.configure({ enabled: false, suggest_related: true });
  const second = h.workspace.createAsset({ ref: 'DOCK-OFF-2', name: 'Second shared dock', type: 'peripheral' }, h.admin);
  response = await h.request(`/tickets/${current.key}/assets`, { method: 'POST', session, body: { ref: second.ref } });
  assert.equal(response.status, 201); assert.equal(response.body.queued, false);
  h.configure({ enabled: true });
  const category = h.workspace.createCategory({ name: 'Restricted dock records', kind: 'assets', visibility: 'restricted' }, h.admin);
  const privateAsset = h.workspace.createAsset({ ref: 'DOCK-PRIVATE-1', name: 'Restricted dock', type: 'peripheral', category_id: category.id }, h.admin);
  response = await h.request(`/tickets/${current.key}/assets`, { method: 'POST', session, body: { ref: privateAsset.ref } });
  assert.equal(response.status, 201); assert.equal(response.body.queued, false);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM ai_ticket_jobs').get().count, 0);
  assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0);
});

test('unauthenticated, CSRF-invalid, and category-denied asset links cannot create AI review jobs', async t => {
  const h = await fixture(t), current = h.ticket('HD-LINK-AUTH');
  const asset = h.workspace.createAsset({ ref: 'DOCK-AUTH-1', name: 'Shared dock', type: 'peripheral' }, h.admin);
  const path = `/tickets/${current.key}/assets`, body = { ref: asset.ref };
  assert.equal((await h.request(path, { method: 'POST', body })).status, 401);
  const session = await h.login(h.tech);
  assert.equal((await h.request(path, { method: 'POST', body, session, csrf: false })).status, 403);
  const category = h.workspace.createCategory({ name: 'Restricted hardware history', kind: 'assets', visibility: 'restricted' }, h.admin);
  const hidden = h.workspace.createAsset({ ref: 'DOCK-DENIED-1', name: 'Private dock', type: 'peripheral', category_id: category.id }, h.admin);
  assert.equal((await h.request(path, { method: 'POST', body: { ref: hidden.ref }, session })).status, 404);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM ai_ticket_jobs').get().count, 0);
  assert.equal(h.workspace.ticketAssets(current.key, h.admin).length, 0); assert.equal(h.calls.length, 0);
});
