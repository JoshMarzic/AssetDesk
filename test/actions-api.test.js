import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { ActionsStore } from '../src/actions-store.js';
import { ActionsRunner } from '../src/actions-runner.js';
import { createDeskRouter } from '../src/desk-routes.js';
import { createApprovalRouter } from '../src/actions-routes.js';

const PASSWORD = 'Actions-api-password-2026';
const taskDefinition = (name = 'API test equipment preparation') => ({ name, description: 'Prepare equipment for an employee.',
  variables: [{ key: 'person_name', label: 'Person', type: 'text', required: true, default: '', description: 'Employee being supported.' }],
  steps: [{ id: 'prepare', type: 'task', name: 'Prepare equipment for {{person_name}}', config: { instructions: 'Prepare a workstation for {{person_name}}.', assignee_email: '' } }] });
const approvalDefinition = (name = 'Access approval') => ({ name, description: 'Ask for approval before completing the request.',
  variables: [{ key: 'person_name', label: 'Person', type: 'text', required: true, default: '', description: '' },
    { key: 'approver_email', label: 'Approver', type: 'email', required: true, default: '', description: '' }],
  steps: [{ id: 'approval', type: 'approval', name: 'Approve access', config: { to: '{{approver_email}}', subject: 'Access request for {{person_name}}', body: 'Please review access for {{person_name}}.', expires_hours: 168 } },
    { id: 'after-approval', type: 'email', name: 'Confirm approved access', config: { to: '{{approver_email}}', subject: 'Request approved', body: 'The access request was approved.' } }] });

async function harness(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Actions administrator', email: 'admin@actions.example', password: PASSWORD });
  const tech = await desk.createTechnician({ name: 'Actions technician', email: 'tech@actions.example', password: PASSWORD });
  const other = await desk.createTechnician({ name: 'Other technician', email: 'other@actions.example', password: PASSWORD });
  const actions = new ActionsStore(desk), sent = [], calls = [];
  const app = express(), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transports = {
    privateSecret: 'Transport secrets must never be serialized', publicUrl: origin,
    capabilities: user => ({ email: { configured: true }, approval: { configured: true }, publicUrl: origin,
      connections: user?.role === 'admin' ? [{ id: 'example', name: 'Example service', baseUrl: 'https://api.example.test/v1', methods: ['GET'] }] : [] }),
    async sendEmail(message) { sent.push(structuredClone(message)); return { messageId: message.messageId }; },
    async callApi(input, user) { calls.push({ input, user: user.id }); return { status: 200 }; },
  };
  const runner = new ActionsRunner({ actions, transports, logger: { error() {} } });
  app.use('/approve', createApprovalRouter({ actions, runner, publicUrl: origin }));
  app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: { cookieSecure: false }, actions, actionRunner: runner, actionTransports: transports }));
  t.after(async () => { await runner.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + '/api/desk' + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}),
      ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}),
    }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function login(user = admin) {
    const response = await request('/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: response.body.csrfToken };
  }
  async function waitFor(id, status) {
    const until = Date.now() + 5000;
    while (Date.now() < until) { const run = actions.getRun(id, admin); if (run.status === status) return run; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(actions.getRun(id, admin).status, status);
  }
  function approvalToken() {
    const match = sent[0]?.text.match(/\/approve\/([A-Za-z0-9_-]+)/);
    assert.ok(match, 'The approval email must contain a private review link'); return match[1];
  }
  async function publicRequest(token, { decision, comment, originHeader = origin, extra = '' } = {}) {
    const form = new URLSearchParams({ decision, ...(comment !== undefined ? { comment } : {}) });
    return fetch(origin + '/approve/' + token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(originHeader !== undefined ? { Origin: originHeader } : {}) }, body: form.toString() + extra });
  }
  return { store, desk, workspace, actions, runner, transports, admin, tech, other, sent, calls, origin, request, login, waitFor, approvalToken, publicRequest };
}

test('Actions endpoints require a session and mutation CSRF, and metadata omits transport secrets', async t => {
  const h = await harness(t);
  for (const path of ['/actions/types', '/actions/templates', '/actions/runs']) assert.equal((await h.request(path)).status, 401);
  const session = await h.login(h.tech);
  const types = await h.request('/actions/types', { session }); assert.equal(types.status, 200);
  assert.equal(types.headers.get('cache-control'), 'no-store');
  for (const kind of ['approval', 'email', 'api', 'task', 'delay']) assert.ok(types.body.types.some(item => (item.type || item.id) === kind));
  assert.deepEqual(types.body.capabilities.connections, []);
  assert.doesNotMatch(JSON.stringify(types.body), /Transport secrets|privateSecret|password|Authorization/);
  assert.equal((await h.request('/actions/templates', { method: 'POST', session, csrf: false, body: taskDefinition() })).status, 403);
  assert.equal((await h.request('/actions/runs', { method: 'POST', session, csrf: false, body: { definition: taskDefinition(), values: { person_name: 'Alex' } } })).status, 403);
});

test('Template ownership and optimistic versions protect standardized workflows, while run snapshots are independent', async t => {
  const h = await harness(t), owner = await h.login(h.tech), other = await h.login(h.other);
  const created = await h.request('/actions/templates', { method: 'POST', session: owner, body: taskDefinition('Standard workstation handover') });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const template = created.body;
  assert.equal(h.sent.length, 0, 'Saving a template must not execute its steps');
  const forbidden = await h.request('/actions/templates/' + template.id, { method: 'PATCH', session: other, body: { version: template.version, name: 'Changed by someone else' } });
  assert.equal(forbidden.status, 403);
  const started = await h.request('/actions/runs', { method: 'POST', session: owner, body: { template_id: template.id, template_version: template.version, values: { person_name: 'Alex' } } });
  assert.equal(started.status, 202); await h.waitFor(started.body.id, 'waiting_task');
  const changed = await h.request('/actions/templates/' + template.id, { method: 'PATCH', session: owner, body: { version: template.version, name: 'Revised workstation handover' } });
  assert.equal(changed.status, 200);
  assert.equal((await h.request('/actions/templates/' + template.id, { method: 'PATCH', session: owner, body: { version: template.version, name: 'Stale change' } })).status, 409);
  const run = await h.request('/actions/runs/' + started.body.id, { session: owner }); assert.equal(run.status, 200);
  assert.equal(run.body.definition.name, 'Standard workstation handover'); assert.match(run.body.steps[0].config.instructions, /Alex/);
  assert.equal((await h.request('/actions/runs/' + run.body.id + '/cancel', { method: 'POST', session: other, body: {} })).status, 403);
  const complete = await h.request('/actions/runs/' + run.body.id + '/complete-task', { method: 'POST', session: owner, body: { comment: 'Equipment checked and handed over.' } });
  assert.equal(complete.status, 200); await h.waitFor(run.body.id, 'completed');
});

test('Actions validation rejects unsupported fields, invalid pagination, missing variables and stale template starts', async t => {
  const h = await harness(t), session = await h.login();
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'status=unknown', 'limit=2&limit=3', 'unsupported=1']) assert.equal((await h.request('/actions/runs?' + query, { session })).status, 400);
  assert.equal((await h.request('/actions/templates?unsupported=1', { session })).status, 400);
  assert.equal((await h.request('/actions/templates', { method: 'POST', session, body: { ...taskDefinition(), unknown: true } })).status, 400);
  assert.equal((await h.request('/actions/runs', { method: 'POST', session, body: { definition: taskDefinition(), values: {} } })).status, 400);
  const template = (await h.request('/actions/templates', { method: 'POST', session, body: taskDefinition() })).body;
  assert.equal((await h.request('/actions/runs', { method: 'POST', session, body: { template_id: template.id, template_version: template.version + 1, values: { person_name: 'Alex' } } })).status, 409);
  assert.equal((await h.request('/actions/templates/' + template.id, { method: 'PATCH', session, body: { version: template.version } })).status, 400);
});

test('Approval GET is read-only, content is escaped, explicit one-time approval resumes the remaining workflow', async t => {
  const h = await harness(t), session = await h.login(h.tech);
  const unsafe = '<img src=x onerror=alert(1)>';
  const started = await h.request('/actions/runs', { method: 'POST', session, body: { definition: approvalDefinition('Approve <private> access'), values: { person_name: unsafe, approver_email: 'manager@example.test' } } });
  assert.equal(started.status, 202, JSON.stringify(started.body)); const run = await h.waitFor(started.body.id, 'waiting_approval');
  assert.equal(h.sent.length, 1); const token = h.approvalToken();
  for (let index = 0; index < 2; index++) {
    const review = await fetch(h.origin + '/approve/' + token); assert.equal(review.status, 200);
    assert.equal(review.headers.get('referrer-policy'), 'strict-origin'); assert.equal(review.headers.get('cache-control'), 'no-store');
    assert.match(review.headers.get('content-security-policy'), /script-src 'none'/); assert.match(review.headers.get('x-robots-tag'), /noindex/);
    const text = await review.text(); assert.ok(text.includes('&lt;img src=x onerror=alert(1)&gt;')); assert.ok(!text.includes('<img src=x'));
    assert.match(text, /Approve request/); assert.match(text, /method="post"/);
  }
  assert.equal(h.actions.getRun(run.id, h.admin).status, 'waiting_approval'); assert.equal(h.sent.length, 1);
  const detail = await h.request('/actions/runs/' + run.id, { session });
  assert.ok(!JSON.stringify(detail.body).includes(token)); assert.doesNotMatch(JSON.stringify(detail.body), /token_hash/);
  const approved = await h.publicRequest(token, { decision: 'approved', comment: 'Approved for this request.' });
  assert.equal(approved.status, 200); assert.match(await approved.text(), /Your approval has been recorded/);
  await h.waitFor(run.id, 'completed'); assert.equal(h.sent.length, 2);
  assert.equal((await h.publicRequest(token, { decision: 'approved' })).status, 409);
  await h.runner.wake(); assert.equal(h.sent.length, 2, 'Replaying a decision must not repeat downstream delivery');
});

test('Rejected, cancelled, tampered and cross-origin approval requests cannot continue a workflow', async t => {
  const h = await harness(t), session = await h.login();
  const started = await h.request('/actions/runs', { method: 'POST', session, body: { definition: approvalDefinition(), values: { person_name: 'Alex', approver_email: 'manager@example.test' } } });
  await h.waitFor(started.body.id, 'waiting_approval'); const token = h.approvalToken();
  assert.equal((await h.publicRequest(token, { decision: 'approved', originHeader: 'https://attacker.example' })).status, 403);
  assert.equal(h.actions.getRun(started.body.id, h.admin).status, 'waiting_approval');
  assert.equal((await h.publicRequest(token, { decision: 'approved', extra: '&decision=rejected' })).status, 400);
  assert.equal((await fetch(h.origin + '/approve/' + token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'))).status, 404);
  const rejected = await h.publicRequest(token, { decision: 'rejected', comment: 'Insufficient justification.' }); assert.equal(rejected.status, 200);
  await h.waitFor(started.body.id, 'rejected'); assert.equal(h.sent.length, 1);
  const second = await h.request('/actions/runs', { method: 'POST', session, body: { definition: approvalDefinition(), values: { person_name: 'Morgan', approver_email: 'manager@example.test' } } });
  await h.waitFor(second.body.id, 'waiting_approval'); const secondToken = h.sent[1].text.match(/\/approve\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await h.request('/actions/runs/' + second.body.id + '/cancel', { method: 'POST', session, body: {} })).status, 200);
  assert.equal((await h.publicRequest(secondToken, { decision: 'approved' })).status, 409);
  assert.equal(h.actions.getRun(second.body.id, h.admin).status, 'cancelled'); assert.equal(h.sent.length, 2);
});

test('Expired approval links remain read-only and cannot authorize a later workflow step', async t => {
  const h = await harness(t), session = await h.login();
  const started = await h.request('/actions/runs', { method: 'POST', session, body: { definition: approvalDefinition(), values: { person_name: 'Alex', approver_email: 'manager@example.test' } } });
  assert.equal(started.status, 202); await h.waitFor(started.body.id, 'waiting_approval'); const token = h.approvalToken();
  h.store.db.prepare('UPDATE action_approvals SET expires_at=? WHERE run_id=?').run('2000-01-01T00:00:00.000Z', started.body.id);
  const page = await fetch(h.origin + '/approve/' + token); assert.equal(page.status, 200);
  const content = await page.text(); assert.match(content, /Approval expired/); assert.ok(!content.includes('value="approved"'));
  assert.equal(h.actions.getRun(started.body.id, h.admin).status, 'waiting_approval', 'Reviewing an expired link must not itself mutate the workflow');
  const decision = await h.publicRequest(token, { decision: 'approved' }); assert.equal(decision.status, 410);
  await h.runner.wake(); assert.equal(h.actions.getRun(started.body.id, h.admin).status, 'failed');
  assert.equal(h.sent.length, 1, 'An expired approval must not send the downstream confirmation');
});
