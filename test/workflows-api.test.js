import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { ActionsStore } from '../src/actions-store.js';
import { ActionsRunner } from '../src/actions-runner.js';
import { WorkflowsStore } from '../src/workflows-store.js';
import { createDeskRouter } from '../src/desk-routes.js';
import { createApprovalRouter } from '../src/actions-routes.js';

const PASSWORD = 'Workflows-api-password-2026';
const variable = (key, type = 'text', required = true) => ({ key, label: key.replaceAll('_', ' '), type, required, default: '', description: '' });
const ref = (source, type = 'template', bindings = {}, name = source.name) => ({ id: crypto.randomUUID(), type, ref_id: source.id, ref_version: source.version, name, bindings });
const task = (name = 'Prepare equipment') => ({ name, description: 'Perform the standard equipment preparation.', variables: [variable('person')], steps: [{ id: 'prepare', name, type: 'task', config: { instructions: 'Prepare equipment for {{person}}.', assignee_email: '' } }] });
const definition = (name, steps, variables = [variable('person')]) => ({ name, description: 'A reusable sequential workflow.', variables, steps });

async function harness(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Workflow administrator', email: 'admin@workflow.example', password: PASSWORD });
  const owner = await desk.createTechnician({ name: 'Workflow owner', email: 'owner@workflow.example', password: PASSWORD });
  const other = await desk.createTechnician({ name: 'Other technician', email: 'other@workflow.example', password: PASSWORD });
  const actions = new ActionsStore(desk), workflows = new WorkflowsStore(actions), trace = [], messages = [], calls = [];
  const app = express(), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transports = {
    capabilities: () => ({ email: { configured: true }, approval: { configured: true }, publicUrl: origin, connections: [] }),
    async sendEmail(input) { messages.push(structuredClone(input)); trace.push('email:' + input.to); return { messageId: input.messageId }; },
    async callApi(input, user) { calls.push({ input: structuredClone(input), user: user.id }); trace.push('api:' + input.connection); return { status: 201 }; },
  };
  const runner = new ActionsRunner({ actions, transports, logger: { error() {} } });
  app.use('/approve', createApprovalRouter({ actions, runner, publicUrl: origin }));
  app.use('/api/desk', createDeskRouter({ desk, store, workspace, worker: {}, config: { cookieSecure: false }, actions, workflows, actionRunner: runner, actionTransports: transports }));
  t.after(async () => { await runner.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(origin + '/api/desk' + path, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function login(user = admin) {
    const response = await request('/login', { method: 'POST', body: { email: user.email, password: PASSWORD } });
    assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: response.body.csrfToken };
  }
  async function create(input, session) {
    const response = await request('/actions/workflows', { method: 'POST', body: input, session });
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  async function start(workflow, values, session) {
    const response = await request('/actions/workflows/' + workflow.id + '/runs', { method: 'POST', body: { workflow_version: workflow.version, values }, session });
    assert.equal(response.status, 202, JSON.stringify(response.body)); return response.body;
  }
  async function waitFor(id, status) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const run = actions.getRun(id, admin); if (run.status === status) return run;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(actions.getRun(id, admin).status, status);
  }
  async function decide(message, decision) {
    const token = message.text.match(/\/approve\/([A-Za-z0-9_-]+)/)?.[1]; assert.ok(token);
    return fetch(origin + '/approve/' + token, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision }) });
  }
  return { store, desk, actions, workflows, transports, runner, admin, owner, other, trace, messages, calls, request, login, create, start, waitFor, decide };
}

test('workflow endpoints enforce session, CSRF, ownership, input validation, and optimistic versions', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/actions/workflows')).status, 401);
  const session = await h.login(h.owner), other = await h.login(h.other);
  const template = h.actions.createTemplate(task(), h.owner), input = definition('Equipment handover', [ref(template, 'template', { person: '{{person}}' })]);
  assert.equal((await h.request('/actions/workflows', { method: 'POST', session, csrf: false, body: input })).status, 403);
  assert.equal((await h.request('/actions/workflows', { method: 'POST', session, body: { ...input, unsupported: true } })).status, 400);
  const saved = await h.create(input, session);
  assert.equal(saved.name, input.name); assert.equal(saved.description, input.description); assert.equal(saved.canEdit, true);
  assert.deepEqual(h.trace, [], 'Saving a workflow must never execute its templates.');
  const listed = await h.request('/actions/workflows', { session: other });
  assert.equal(listed.status, 200); assert.equal(listed.body.workflows.find(item => item.id === saved.id).canEdit, false);
  assert.equal((await h.request('/actions/workflows/' + saved.id, { method: 'PATCH', session: other, body: { version: saved.version, name: 'Unauthorized edit' } })).status, 403);
  assert.equal((await h.request('/actions/workflows/' + saved.id, { method: 'PATCH', session, csrf: false, body: { version: saved.version, name: 'Unverified edit' } })).status, 403);
  for (const body of [{ version: saved.version }, { version: '1', name: 'Invalid version' }, { name: 'Missing version' }, { version: saved.version, command: 'not supported' }]) {
    assert.equal((await h.request('/actions/workflows/' + saved.id, { method: 'PATCH', session, body })).status, 400);
  }
  const changed = await h.request('/actions/workflows/' + saved.id, { method: 'PATCH', session, body: { version: saved.version, description: 'Updated handover instructions.' } });
  assert.equal(changed.status, 200); assert.equal(changed.body.version, saved.version + 1);
  assert.equal((await h.request('/actions/workflows/' + saved.id, { method: 'PATCH', session, body: { version: saved.version, name: 'Stale edit' } })).status, 409);
  assert.equal((await h.request('/actions/workflows?unsupported=1', { session })).status, 400);
  assert.equal((await h.request('/actions/workflows/' + saved.id + '?unsupported=1', { session })).status, 400);
  assert.equal((await h.request('/actions/workflows/missing-id', { session })).status, 404);
  assert.equal((await h.request('/actions/workflows/' + saved.id + '/runs', { method: 'POST', session, csrf: false, body: { workflow_version: changed.body.version, values: { person: 'Alex' } } })).status, 403);
});

async function onboarding(h, session) {
  const approval = h.actions.createTemplate({ name: 'Get approval', description: 'Ask the future manager to approve onboarding.', variables: [variable('person'), variable('manager', 'email')],
    steps: [{ id: 'approval', type: 'approval', name: 'Approve onboarding', config: { to: '{{manager}}', subject: 'Onboarding approval for {{person}}', body: 'Please approve onboarding for {{person}}.', expires_hours: 24 } }] }, h.owner);
  const accounts = ['ad', 'hr', 'sap'].map(connection => h.actions.createTemplate({ name: 'Create ' + connection.toUpperCase() + ' account', description: 'Create a standard employee account.', variables: [variable('person'), variable('quantity', 'number')],
    steps: [{ id: 'create', type: 'api', name: 'Create account', config: { connection, method: 'POST', path: '/accounts', body: '{"person":"{{person}}","quantity":"{{quantity}}"}' } }] }, h.owner));
  const setup = await h.create(definition('Setup standard user', accounts.map(source => ref(source, 'template', { person: '{{person}}', quantity: '{{quantity}}' })), [variable('person'), variable('quantity', 'number')]), session);
  const notify = h.actions.createTemplate({ name: 'Notify IT', description: 'Send account setup instructions to IT.', variables: [variable('person')],
    steps: [{ id: 'notify', type: 'email', name: 'Notify IT', config: { to: 'it@example.test', subject: 'Accounts ready for {{person}}', body: 'AD, HR, and SAP account requests succeeded for {{person}}. Complete the device handover.' } }] }, h.owner);
  const welcome = h.actions.createTemplate({ name: 'Welcome employee', description: 'Send the employee onboarding instructions.', variables: [variable('person'), variable('new_user', 'email')],
    steps: [{ id: 'welcome', type: 'email', name: 'Welcome employee', config: { to: '{{new_user}}', subject: 'Welcome {{person}}', body: 'Welcome {{person}}. Please contact IT for your equipment handover.' } }] }, h.owner);
  const workflow = await h.create(definition('Employee onboarding', [
    ref(approval, 'template', { person: '{{person}}', manager: '{{manager}}' }),
    ref(setup, 'workflow', { person: '{{person}}', quantity: '{{quantity}}' }),
    ref(notify, 'template', { person: '{{person}}' }),
    ref(welcome, 'template', { person: '{{person}}', new_user: '{{new_user}}' }),
  ], [variable('person'), variable('manager', 'email'), variable('quantity', 'number'), variable('new_user', 'email')]), session);
  return { workflow, setup, accounts, approval };
}
const employee = { person: 'Renée "Alex"', manager: 'manager@example.test', quantity: '2', new_user: 'new.user@example.test' };

test('an approved workflow executes nested AD, HR, SAP, IT notification, and welcome steps in order with an immutable composition', async t => {
  const h = await harness(t), session = await h.login(h.owner), { workflow, accounts } = await onboarding(h, session);
  const run = await h.start(workflow, employee, session);
  assert.equal(run.workflow.name, 'Employee onboarding'); assert.equal(run.workflow.version, workflow.version);
  assert.deepEqual(run.workflow.steps.map(step => step.name), ['Get approval', 'Setup standard user', 'Notify IT', 'Welcome employee']);
  assert.deepEqual(run.workflow.steps.map(step => [step.start_index, step.end_index]), [[0, 0], [1, 3], [4, 4], [5, 5]]);
  assert.deepEqual(run.workflow.steps[1].steps.map(step => step.name), ['Create AD account', 'Create HR account', 'Create SAP account']);
  await h.waitFor(run.id, 'waiting_approval'); assert.deepEqual(h.trace, ['email:manager@example.test']);
  const original = JSON.stringify(run.workflow);
  h.actions.updateTemplate(accounts[0].id, { version: accounts[0].version, name: 'Changed AD template', steps: [{ ...accounts[0].steps[0], config: { ...accounts[0].steps[0].config, path: '/new-accounts' } }] }, h.owner);
  const detail = await h.request('/actions/runs/' + run.id, { session });
  assert.equal(detail.status, 200); assert.equal(JSON.stringify(detail.body.workflow), original);
  const listed = await h.request('/actions/runs', { session }); assert.equal(JSON.stringify(listed.body.runs.find(item => item.id === run.id).workflow), original);
  const decision = await h.decide(h.messages[0], 'approved'); assert.equal(decision.status, 200);
  await h.waitFor(run.id, 'completed');
  assert.deepEqual(h.trace, ['email:manager@example.test', 'api:ad', 'api:hr', 'api:sap', 'email:it@example.test', 'email:new.user@example.test']);
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) { assert.deepEqual(call.input.body, { person: 'Renée "Alex"', quantity: 2 }); assert.equal(call.input.path, '/accounts'); assert.equal(call.user, h.owner.id); }
  const completed = await h.request('/actions/runs/' + run.id, { session }); assert.equal(JSON.stringify(completed.body.workflow), original);
  assert.equal(completed.body.progress.completed, 6);
  assert.doesNotMatch(JSON.stringify(completed.body.workflow), /token_hash|private single-use token|Authorization/);
});

test('rejection or cancellation of the first approval prevents every nested and following operation', async t => {
  const h = await harness(t), session = await h.login(h.owner), { workflow } = await onboarding(h, session);
  const rejected = await h.start(workflow, employee, session);
  await h.waitFor(rejected.id, 'waiting_approval'); assert.equal((await h.decide(h.messages[0], 'rejected')).status, 200);
  await h.waitFor(rejected.id, 'rejected'); assert.deepEqual(h.trace, ['email:manager@example.test']);
  const cancelled = await h.start(workflow, employee, session); await h.waitFor(cancelled.id, 'waiting_approval');
  const response = await h.request('/actions/runs/' + cancelled.id + '/cancel', { method: 'POST', session, body: {} });
  assert.equal(response.status, 200); assert.equal(response.body.workflow.id, workflow.id); assert.equal(response.body.status, 'cancelled');
  assert.equal((await h.decide(h.messages[1], 'approved')).status, 409);
  await h.runner.wake(); assert.equal(h.calls.length, 0); assert.equal(h.messages.length, 2);
});

test('retry and manual task responses retain workflow composition and creator controls', async t => {
  const h = await harness(t), session = await h.login(h.owner), other = await h.login(h.other);
  const api = h.actions.createTemplate({ name: 'Provision account', description: 'Provision a standard account.', variables: [variable('person')],
    steps: [{ id: 'provision', type: 'api', name: 'Provision account', config: { connection: 'directory', method: 'POST', path: '/accounts', body: '{"person":"{{person}}"}' } }] }, h.owner);
  const manual = h.actions.createTemplate(task('Check account and hand over equipment'), h.owner);
  const workflow = await h.create(definition('Provision and hand over', [ref(api, 'template', { person: '{{person}}' }), ref(manual, 'template', { person: '{{person}}' })]), session);
  let attempts = 0;
  h.transports.callApi = async () => { if (++attempts === 1) throw Object.assign(new Error('private connection failure'), { safeMessage: 'The connection needs configuration.', blocked: true }); return { status: 201 }; };
  const run = await h.start(workflow, { person: 'Alex' }, session); await h.waitFor(run.id, 'blocked');
  assert.equal((await h.request('/actions/runs/' + run.id + '/retry', { method: 'POST', session: other, body: {} })).status, 403);
  const retry = await h.request('/actions/runs/' + run.id + '/retry', { method: 'POST', session, body: {} });
  assert.equal(retry.status, 200); assert.equal(retry.body.workflow.id, workflow.id); await h.waitFor(run.id, 'waiting_task');
  const complete = await h.request('/actions/runs/' + run.id + '/complete-task', { method: 'POST', session, body: { comment: 'Checked the account and handed over the equipment.' } });
  assert.equal(complete.status, 200); assert.equal(complete.body.workflow.id, workflow.id);
  await h.waitFor(run.id, 'completed'); assert.equal(attempts, 2);
});

test('stale or archived references and invalid workflow run requests cannot create partial runs', async t => {
  const h = await harness(t), session = await h.login(h.owner);
  const template = h.actions.createTemplate(task(), h.owner), workflow = await h.create(definition('Handover', [ref(template, 'template', { person: '{{person}}' })]), session);
  const before = h.actions.listRuns(h.owner).total;
  for (const body of [{ values: { person: 'Alex' } }, { workflow_version: '1', values: { person: 'Alex' } }, { workflow_version: workflow.version, values: {} }, { workflow_version: workflow.version, values: { person: 'Alex' }, command: 'unsupported' }]) {
    assert.equal((await h.request('/actions/workflows/' + workflow.id + '/runs', { method: 'POST', session, body })).status, 400);
  }
  assert.equal((await h.request('/actions/workflows/' + workflow.id + '/runs', { method: 'POST', session, body: { workflow_version: workflow.version + 1, values: { person: 'Alex' } } })).status, 409);
  const changed = h.actions.updateTemplate(template.id, { version: template.version, description: 'Changed standard handover.' }, h.owner);
  const stale = await h.request('/actions/workflows/' + workflow.id + '/runs', { method: 'POST', session, body: { workflow_version: workflow.version, values: { person: 'Alex' } } });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /chang|version|refresh|reload/i);
  assert.equal(h.actions.listRuns(h.owner).total, before);
  const refreshed = await h.request('/actions/workflows/' + workflow.id, { method: 'PATCH', session, body: { version: workflow.version, steps: [ref(changed, 'template', { person: '{{person}}' })] } });
  assert.equal(refreshed.status, 200);
  const archived = await h.request('/actions/workflows/' + workflow.id, { method: 'PATCH', session, body: { version: refreshed.body.version, active: false } }); assert.equal(archived.status, 200);
  const unavailable = await h.request('/actions/workflows/' + workflow.id + '/runs', { method: 'POST', session, body: { workflow_version: archived.body.version, values: { person: 'Alex' } } });
  assert.ok([400, 404, 409].includes(unavailable.status), JSON.stringify(unavailable.body)); assert.equal(h.actions.listRuns(h.owner).total, before);
});
