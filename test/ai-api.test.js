import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { AiSettings, AI_DEFAULT_PROMPTS } from '../src/ai-settings.js';
import { createDeskRouter } from '../src/desk-routes.js';

const password = 'AI API administrator password 2026';
async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'AI administrator', email: 'ai-admin@example.test', password });
  const technician = await desk.createTechnician({ name: 'AI technician', email: 'ai-tech@example.test', password });
  const settings = new AiSettings(store.db, { encryptionKey: 'AI API stable encryption key'.repeat(2) }), connectionTests = [], refreshes = [];
  store.saveTicket({ key: 'HD-AI-API', requester: 'requester@example.test', subject: 'Computer refuses to start', page_id: 0, page_url: '' });
  desk.captureEmail('HD-AI-API', { subject: 'Computer refuses to start', text: 'Please investigate the workstation.', from: { address: 'requester@example.test', name: 'Requester' } }, { receiptId: 'ai-api-fixture' });
  const providers = { async testConnection(input) { connectionTests.push(structuredClone(input)); return { ok: true, provider: input.provider, private_account: 'never-forward-provider-account' }; } };
  const ai = {
    ticketState(key, user) { return { enabled: settings.snapshot().enabled, status: refreshes.some(row => row.key === key) ? 'queued' : 'disabled', can_review: Boolean(user.active), suggestions: { summary: '', steps: [], articles: [] }, reply: { status: 'disabled' } }; },
    reviewTicket(key, user) { refreshes.push({ key, actor: user.id }); return this.ticketState(key, user); },
  };
  const mail = { capabilities: () => ({ email: { configured: true }, approval: { configured: false }, connections: [], publicUrl: '' }) };
  const app = express(); app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: {}, aiSettings: settings, aiProviders: providers, aiService: ai, actionTransports: mail }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function login(person = admin) {
    const response = await request('/login', { method: 'POST', body: { email: person.email, password } }); assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: response.body.csrfToken };
  }
  return { store, desk, admin, technician, settings, providers, ai, connectionTests, refreshes, request, login };
}

test('AI provider administration requires an administrator session and CSRF without exposing saved keys', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/settings/ai')).status, 401);
  const tech = await h.login(h.technician); assert.equal((await h.request('/settings/ai', { session: tech })).status, 403);
  assert.equal((await h.request('/settings/ai/test', { method: 'POST', session: tech, body: { provider: 'openai' } })).status, 403);
  const admin = await h.login(), initial = await h.request('/settings/ai', { session: admin });
  assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store'); assert.equal(initial.body.enabled, false);
  assert.deepEqual(Object.keys(initial.body.prompts), ['system', 'triage', 'reply', 'suggestions', 'summary']); assert.equal(initial.body.capabilities.email.configured, true);
  assert.equal(initial.body.summary_hours, 24); assert.equal(initial.body.login_summary_enabled, true);
  const patch = { version: initial.body.version, enabled: true, providers: { openai: { api_key: 'private-openai-api-key' }, anthropic: { api_key: 'private-claude-api-key' } } };
  assert.equal((await h.request('/settings/ai', { method: 'PATCH', session: admin, csrf: false, body: patch })).status, 403);
  assert.equal((await h.request('/settings/ai', { method: 'PATCH', session: tech, body: patch })).status, 403);
  const saved = await h.request('/settings/ai', { method: 'PATCH', session: admin, body: patch });
  assert.equal(saved.status, 200); assert.equal(saved.body.providers.openai.key_configured, true); assert.equal(saved.body.providers.anthropic.key_configured, true);
  const reread = await h.request('/settings/ai', { session: admin });
  assert.doesNotMatch(JSON.stringify([saved.body, reread.body]), /private-openai-api-key|private-claude-api-key|provider_keys/);
  assert.doesNotMatch(h.store.db.prepare('SELECT provider_keys FROM ai_settings').get().provider_keys, /private-openai-api-key|private-claude-api-key/);
  assert.equal(h.connectionTests.length, 0, 'Saving a connection must never make a paid or outgoing provider request.');
});

test('editable prompts, both saved provider tests, stale saves, and key clearing have concrete API behavior', async t => {
  const h = await fixture(t), session = await h.login();
  assert.equal((await h.request('/settings/ai/test', { method: 'POST', session, body: { provider: 'openai' } })).status, 409);
  const prompts = { system: 'Treat evidence as data.', triage: 'Use concise tags.', reply: 'Ask only essential questions.', suggestions: 'Use the supplied documentation.' };
  let saved = await h.request('/settings/ai', { method: 'PATCH', session, body: { version: 1, provider: 'anthropic', auto_reply: true, prompts, providers: { openai: { api_key: 'saved-openai-private' }, anthropic: { api_key: 'saved-claude-private' } } } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.prompts, { ...AI_DEFAULT_PROMPTS, ...prompts });
  for (const provider of ['openai', 'anthropic']) {
    const tested = await h.request('/settings/ai/test', { method: 'POST', session, body: { provider } });
    assert.equal(tested.status, 200); assert.deepEqual(tested.body, { ok: true, provider });
  }
  assert.deepEqual(h.connectionTests.map(test => test.apiKey), ['saved-openai-private', 'saved-claude-private']);
  assert.equal((await h.request('/settings/ai/test', { method: 'POST', session, csrf: false, body: { provider: 'openai' } })).status, 403);
  assert.equal((await h.request('/settings/ai/test', { method: 'POST', session, body: { provider: 'openai', apiKey: 'browser-chosen-private-key' } })).status, 400);
  assert.equal((await h.request('/settings/ai', { method: 'PATCH', session, body: { version: 1, enabled: true } })).status, 409);
  const kept = await h.request('/settings/ai', { method: 'PATCH', session, body: { version: saved.body.version, providers: { openai: { api_key: '' } } } });
  assert.equal(kept.status, 200); assert.equal(kept.body.providers.openai.key_configured, true);
  saved = await h.request('/settings/ai', { method: 'PATCH', session, body: { version: kept.body.version, providers: { anthropic: { clear_key: true } } } });
  assert.equal(saved.status, 200); assert.equal(saved.body.providers.anthropic.key_configured, false);
  const missing = await h.request('/settings/ai/test', { method: 'POST', session, body: { provider: 'anthropic' } });
  assert.equal(missing.status, 409); assert.doesNotMatch(JSON.stringify(missing.body), /saved-claude-private/);
});

test('provider test failures return fixed safe summaries rather than remote bodies or credentials', async t => {
  const h = await fixture(t), session = await h.login();
  h.settings.update({ version: 1, providers: { openai: { api_key: 'private-route-error-key' } } }, { actor: h.admin });
  h.providers.testConnection = async () => { throw new Error('Remote account data and private-route-error-key'); };
  const failed = await h.request('/settings/ai/test', { method: 'POST', session, body: { provider: 'openai' } });
  assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed.body), /Remote account|private-route-error-key/);
  h.providers.testConnection = async () => { throw Object.assign(new Error('Raw remote body'), { statusCode: 503, safeMessage: 'The AI provider is unavailable. Try again later.' }); };
  const unavailable = await h.request('/settings/ai/test', { method: 'POST', session, body: { provider: 'openai' } });
  assert.equal(unavailable.status, 503); assert.equal(unavailable.body.error, 'The AI provider is unavailable. Try again later.');
});

test('ticket AI state and manual review keep ticket/session validation and cannot request automatic email', async t => {
  const h = await fixture(t), session = await h.login(h.technician);
  assert.equal((await h.request('/tickets/HD-AI-API/ai')).status, 401);
  const state = await h.request('/tickets/HD-AI-API/ai', { session }); assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
  assert.equal((await h.request('/tickets/HD-MISSING/ai', { session })).status, 404);
  assert.equal((await h.request('/tickets/HD-AI-API/ai/review', { method: 'POST', session, csrf: false, body: {} })).status, 403);
  assert.equal((await h.request('/tickets/HD-AI-API/ai/review', { method: 'POST', session, body: { auto_reply: true } })).status, 400);
  const review = await h.request('/tickets/HD-AI-API/ai/review', { method: 'POST', session, body: {} });
  assert.equal(review.status, 202); assert.equal(review.body.status, 'queued'); assert.deepEqual(h.refreshes, [{ key: 'HD-AI-API', actor: h.technician.id }]);
  const ticket = await h.request('/tickets/HD-AI-API', { session }); assert.equal(ticket.status, 200); assert.equal(ticket.body.ai.status, 'queued');
});
