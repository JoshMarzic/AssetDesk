import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { AiSettings } from '../src/ai-settings.js';
import { createDeskRouter } from '../src/desk-routes.js';

const password = 'Summary-API-test-password-2035';
async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Summary administrator', email: 'summary-admin@example.test', password });
  const technician = await desk.createTechnician({ name: 'Summary technician', email: 'summary-tech@example.test', password });
  const settings = new AiSettings(desk.db, { encryptionKey: 'summary-API-encryption-key-long-enough-2035' });
  const calls = [], providers = { async review(input) {
    calls.push(structuredClone(input));
    return { summary: 'A recent ticket needs support attention.', highlights: [{ ticket_key: input.context.tickets[0].ticket_key, text: 'Review the recent VPN request.' }] };
  } };
  store.saveTicket({ key: 'HD-SUMMARY-API', subject: 'VPN access needs assistance', requester: 'requester@example.test', page_id: 0, page_url: '' });
  desk.captureEmail('HD-SUMMARY-API', { text: 'Please investigate the VPN connection.', from: { address: 'requester@example.test' } }, { receiptId: 'summary-api-fixture' });
  const app = express();
  app.use('/api/desk', createDeskRouter({ store, desk, workspace, worker: {}, config: {}, aiSettings: settings, aiProviders: providers,
    aiService: { ticketState() { return {}; } }, actionTransports: { capabilities() { return { email: { configured: false } }; } } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}),
      ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function login(user = admin) {
    const result = await request('/login', { method: 'POST', body: { email: user.email, password } });
    assert.equal(result.status, 200);
    return { cookie: result.headers.get('set-cookie').split(';')[0], csrfToken: result.body.csrfToken };
  }
  const configure = patch => settings.update({ version: settings.snapshot().version, enabled: true, providers: { openai: { api_key: 'summary-api-private-openai' }, anthropic: { api_key: 'summary-api-private-claude' } }, ...patch }, { actor: admin });
  const summary = session => request('/login-summary', { method: 'POST', session, body: {} });
  return { store, desk, settings, admin, technician, providers, calls, request, login, configure, summary };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('login summary API requires a valid session, CSRF, and an empty request rather than client-selected prompts or hours', async t => {
  const h = await fixture(t);
  assert.equal((await h.summary()).status, 401);
  const session = await h.login(h.technician);
  assert.equal((await h.request('/login-summary', { method: 'POST', session, csrf: false, body: {} })).status, 403);
  for (const body of [{ hours: 720 }, { prompt: 'Untrusted browser instruction' }, { apiKey: 'client-supplied-private-key' }, [], null]) {
    const response = await h.request('/login-summary', { method: 'POST', session, body });
    assert.equal(response.status, 400); assert.doesNotMatch(JSON.stringify(response.body), /client-supplied-private-key|Untrusted browser instruction/);
  }
  assert.equal((await h.request('/login-summary?hours=6', { method: 'POST', session, body: {} })).status, 400);
  assert.equal((await h.request('/login-summary', { session })).status, 404);
  assert.equal(h.calls.length, 0);
});

test('administrators and technicians receive no-key placeholders with real ticket counts without receiving settings or credentials', async t => {
  const h = await fixture(t);
  for (const user of [h.admin, h.technician]) {
    const session = await h.login(user), response = await h.summary(session);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.body.status, 'placeholder'); assert.equal(response.body.reason, 'unconfigured');
    assert.equal(response.body.hours, 24); assert.equal(response.body.metrics.total, 1); assert.equal(response.body.highlights.length, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /provider_keys|api_key|prompts|encryption-key/);
  }
  assert.equal(h.calls.length, 0);
  h.configure({ login_summary_enabled: false });
  const disabled = await h.summary(await h.login());
  assert.equal(disabled.status, 200); assert.equal(disabled.body.status, 'disabled'); assert.equal(h.calls.length, 0);
});

test('configured hours and prompt drive selected-provider summaries that technicians can read while settings stay administrator-only', async t => {
  const h = await fixture(t);
  h.configure({ provider: 'anthropic', summary_hours: 6, prompts: { summary: 'Summarize the support shift for six hours.' } });
  const session = await h.login(h.technician), result = await h.summary(session);
  assert.equal(result.status, 200); assert.equal(result.body.status, 'ready'); assert.equal(result.body.hours, 6);
  assert.equal(Date.parse(result.body.to) - Date.parse(result.body.from), 6 * 3600000);
  assert.deepEqual(result.body.highlights, [{ ticket_key: 'HD-SUMMARY-API', text: 'Review the recent VPN request.' }]);
  assert.equal(h.calls[0].provider, 'anthropic'); assert.equal(h.calls[0].apiKey, 'summary-api-private-claude');
  assert.equal(h.calls[0].prompt, 'Summarize the support shift for six hours.');
  assert.doesNotMatch(JSON.stringify(result.body), /summary-api-private-|Summarize the support shift/);
  assert.equal((await h.request('/settings/ai', { session })).status, 403);
  assert.equal((await h.request('/settings/ai', { method: 'PATCH', session, body: { version: h.settings.snapshot().version, summary_hours: 12 } })).status, 403);
});

test('login completes separately from a pending summary provider request and the summary remains independently dismissible by its client', async t => {
  const h = await fixture(t), gate = deferred(), entered = deferred();
  h.configure({});
  h.providers.review = async () => { entered.resolve(); await gate.promise; return { summary: 'Summary prepared after authentication.', highlights: [] }; };
  const first = await h.login();
  let finished = false;
  const pending = h.summary(first).then(result => { finished = true; return result; });
  await entered.promise;
  const second = await h.login(h.technician);
  assert.ok(second.csrfToken); assert.equal(finished, false, 'Signing in must not await summary generation.');
  gate.resolve(); const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.body.status, 'ready');
});

test('provider failure returns a safe placeholder without mutating tickets, notes, or accepted mail', async t => {
  const h = await fixture(t); h.configure({});
  h.providers.review = async () => { throw Object.assign(new Error('private remote body summary-api-private-openai'), { safeMessage: 'private-account-response' }); };
  const before = h.desk.getTicket('HD-SUMMARY-API'), mailCount = h.store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  const result = await h.summary(await h.login());
  assert.equal(result.status, 200); assert.equal(result.body.status, 'placeholder'); assert.equal(result.body.reason, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result.body), /private remote body|summary-api-private-openai|private-account-response/);
  assert.deepEqual(h.desk.getTicket('HD-SUMMARY-API'), before);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, mailCount);
});

test('deactivating a technician while summary inference is pending rejects the completed response without returning its AI text', async t => {
  const h = await fixture(t), gate = deferred(), entered = deferred(); h.configure({});
  h.providers.review = async () => { entered.resolve(); await gate.promise; return { summary: 'Sensitive summary from an old authorization.', highlights: [] }; };
  const pending = h.summary(await h.login(h.technician)); await entered.promise;
  h.store.db.prepare('UPDATE technicians SET active=0 WHERE id=?').run(h.technician.id); gate.resolve();
  const result = await pending;
  assert.equal(result.status, 401); assert.doesNotMatch(JSON.stringify(result.body), /Sensitive summary|old authorization/);
});
