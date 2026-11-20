import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { ActionsStore } from '../src/actions-store.js';
import { ActionsRunner } from '../src/actions-runner.js';
import { WorkflowsStore } from '../src/workflows-store.js';

const PASSWORD = 'Workflow-store-password-2026';
const variable = (key, type = 'text', extra = {}) => ({ key, label: key.replaceAll('_', ' '), type, required: true, ...extra });
const ref = (reference, id, bindings = {}, type = 'template') => ({ id, type, ref_id: reference.id, ref_version: reference.version, name: reference.name, bindings });
async function fixture(t, filename = ':memory:') {
  const store = new Store(filename), desk = new DeskStore(store);
  const admin = await desk.ensureAdmin({ name: 'Workflow administrator', email: 'admin@workflows.example', password: PASSWORD });
  const owner = await desk.createTechnician({ name: 'Workflow owner', email: 'owner@workflows.example', password: PASSWORD });
  const other = await desk.createTechnician({ name: 'Other technician', email: 'other@workflows.example', password: PASSWORD });
  const actions = new ActionsStore(desk), workflows = new WorkflowsStore(actions), sent = [], calls = [], order = [];
  const runner = new ActionsRunner({ actions, transports: {
    capabilities: () => ({ email: { configured: true }, approval: { configured: true }, publicUrl: 'https://desk.example.test' }),
    async sendEmail(message) { sent.push(message); order.push('email:' + message.to); return { messageId: message.messageId }; },
    async callApi(config) { calls.push(config); order.push('api:' + config.connection); return { status: 201 }; },
  }, logger: { error() {} } });
  if (t) t.after(async () => { await runner.stop(); store.close(); });
  return { store, desk, admin, owner, other, actions, workflows, runner, sent, calls, order };
}
function taskTemplate(h, name = 'Prepare equipment', variables = []) {
  return h.actions.createTemplate({ name, description: 'Complete the assigned preparation.', variables, steps: [{ id: 'task', type: 'task', name, config: { instructions: 'Prepare equipment.', assignee_email: '' } }] }, h.owner);
}
function workflow(h, name, steps, variables = [], actor = h.owner) { return h.workflows.createWorkflow({ name, description: 'A reusable sequence.', variables, steps }, actor); }
function approvalToken(message) { return message.text.match(/\/approve\/([a-f0-9]{80})/)[1]; }

test('onboarding executes approval, nested AD/HR/SAP templates, IT notification, and welcome email in order', async t => {
  const h = await fixture(t);
  const approve = h.actions.createTemplate({ name: 'Get approval', variables: [variable('person'), variable('manager', 'email')], steps: [{ id: 'approve', type: 'approval', name: 'Approve {{person}}', config: { to: '{{manager}}', subject: 'Approve {{person}}', body: 'Please approve onboarding for {{person}}.', expires_hours: 24 } }] }, h.owner);
  const accountTemplates = ['ad', 'hr', 'sap'].map(connection => h.actions.createTemplate({ name: 'Create ' + connection.toUpperCase() + ' account', variables: [variable('person'), variable('email', 'email'), variable('count', 'number')], steps: [{ id: 'create', type: 'api', name: 'Create account for {{person}}', config: { connection, method: 'POST', path: '/people/{{person}}', body: '{"name":"{{person}}","email":"{{email}}","count":"{{count}}"}' } }] }, h.owner));
  const setup = workflow(h, 'Setup standard user', accountTemplates.map((template, index) => ref(template, 'account-' + index, { person: '{{person}}', email: '{{email}}', count: '{{count}}' })), [variable('person'), variable('email', 'email'), variable('count', 'number')]);
  const mail = recipient => h.actions.createTemplate({ name: recipient === 'it@example.test' ? 'Notify IT' : 'Welcome employee', variables: [variable('person'), variable('recipient', 'email')], steps: [{ id: 'email', type: 'email', name: 'Send message', config: { to: '{{recipient}}', subject: 'Onboarding for {{person}}', body: 'Standard account setup is complete for {{person}}.' } }] }, h.owner);
  const it = mail('it@example.test'), welcome = mail('employee@example.test');
  const onboarding = workflow(h, 'Employee onboarding', [ref(approve, 'approval', { person: '{{person}}', manager: '{{manager}}' }), ref(setup, 'setup', { person: '{{person}}', email: '{{email}}', count: 2 }, 'workflow'), ref(it, 'notify-it', { person: '{{person}}', recipient: 'it@example.test' }), ref(welcome, 'welcome', { person: '{{person}}', recipient: '{{email}}' })], [variable('person'), variable('manager', 'email'), variable('email', 'email')]);
  const run = h.workflows.createRun({ workflow_id: onboarding.id, workflow_version: onboarding.version, values: { person: 'Renée "Alex" / {{count}}', manager: 'MANAGER@EXAMPLE.TEST', email: 'EMPLOYEE@EXAMPLE.TEST' } }, h.owner);
  assert.equal(run.steps.length, 6); assert.equal(run.workflow.steps.length, 4);
  assert.equal(run.workflow.steps[1].steps.length, 3);
  assert.deepEqual(run.workflow.steps.map(step => [step.start_index, step.end_index]), [[0, 0], [1, 3], [4, 4], [5, 5]]);
  await h.runner.wake(); assert.equal(h.actions.getRun(run.id, h.owner).status, 'waiting_approval');
  assert.deepEqual(h.order, ['email:manager@example.test']);
  h.actions.decideApproval(approvalToken(h.sent[0]), { decision: 'approved' }); await h.runner.wake();
  assert.deepEqual(h.order, ['email:manager@example.test', 'api:ad', 'api:hr', 'api:sap', 'email:it@example.test', 'email:employee@example.test']);
  assert.equal(h.actions.getRun(run.id, h.owner).status, 'completed');
  for (const call of h.calls) {
    assert.deepEqual(call.body, { name: 'Renée "Alex" / {{count}}', email: 'employee@example.test', count: 2 });
    assert.equal(call.path, '/people/Ren%C3%A9e%20%22Alex%22%20%2F%20%7B%7Bcount%7D%7D');
  }
  const rejected = h.workflows.createRun({ workflow_id: onboarding.id, workflow_version: onboarding.version, values: { person: 'Morgan', manager: 'manager@example.test', email: 'morgan@example.test' } }, h.owner);
  await h.runner.wake(); h.actions.decideApproval(approvalToken(h.sent.at(-1)), { decision: 'rejected' }); await h.runner.wake();
  assert.equal(h.actions.getRun(rejected.id, h.owner).status, 'rejected'); assert.equal(h.calls.length, 3);
});

test('repeated templates get independent bindings, typed defaults, and optional empty values', async t => {
  const h = await fixture(t);
  const template = h.actions.createTemplate({ name: 'Create account', variables: [variable('person'), variable('count', 'number', { default: '3' }), variable('optional', 'text', { required: false })], steps: [{ type: 'api', config: { connection: 'hr', method: 'POST', path: '/people', body: '{"person":"{{person}}","count":"{{count}}","optional":"{{optional}}"}' } }] }, h.owner);
  const composed = workflow(h, 'Two independent accounts', [ref(template, 'first', { person: '{{first}}' }), ref(template, 'second', { person: '{{second}}', count: '{{number}}' })], [variable('first'), variable('second'), variable('number', 'number')]);
  const run = h.workflows.createRun({ workflow_id: composed.id, workflow_version: composed.version, values: { first: 'Alex {{second}}', second: 'Morgan', number: -2 } }, h.owner);
  assert.deepEqual(run.steps.map(step => step.config.body), [{ person: 'Alex {{second}}', count: 3, optional: '' }, { person: 'Morgan', count: -2, optional: '' }]);
  assert.notEqual(run.definition.variables[0].key, run.definition.variables[3].key);
  assert.throws(() => h.workflows.createRun({ workflow_id: composed.id, workflow_version: composed.version, values: { first: 'Alex', second: 'Morgan', number: 1, surprise: true } }, h.owner), /Unknown workflow variable/);
});

test('owners and administrators manage workflows with optimistic versions and archive visibility', async t => {
  const h = await fixture(t), template = taskTemplate(h), original = workflow(h, 'Reusable setup', [ref(template, 'prepare')]);
  assert.equal(original.canEdit, true); assert.equal(h.workflows.getWorkflow(original.id, h.other).canEdit, false);
  assert.throws(() => h.workflows.updateWorkflow(original.id, { version: original.version, name: 'Unauthorized' }, h.other), error => error.statusCode === 403);
  const changed = h.workflows.updateWorkflow(original.id, { version: original.version, name: 'Revised setup' }, h.owner);
  assert.equal(changed.version, 2);
  assert.throws(() => h.workflows.updateWorkflow(original.id, { version: original.version, name: 'Stale' }, h.owner), error => error.statusCode === 409);
  assert.throws(() => h.workflows.createRun({ workflow_id: original.id, workflow_version: original.version, values: {} }, h.owner), error => error.statusCode === 409);
  h.workflows.updateWorkflow(original.id, { version: changed.version, active: false }, h.admin);
  assert.equal(h.workflows.listWorkflows(h.other).length, 0);
  assert.throws(() => h.workflows.getWorkflow(original.id, h.other), error => error.statusCode === 404);
  assert.equal(h.workflows.getWorkflow(original.id, h.owner).active, false);
  assert.throws(() => h.workflows.createRun({ workflow_id: original.id, workflow_version: 3, values: {} }, h.owner), error => error.statusCode === 409);
  assert.throws(() => h.workflows.listWorkflows(null), error => error.statusCode === 401);
});

test('changed or archived dependencies block new runs without altering existing snapshots', async t => {
  const h = await fixture(t), template = taskTemplate(h), nested = workflow(h, 'Nested setup', [ref(template, 'prepare')]), parent = workflow(h, 'Onboarding', [ref(nested, 'nested', {}, 'workflow')]);
  const run = h.workflows.createRun({ workflow_id: parent.id, workflow_version: parent.version, values: {} }, h.owner);
  const before = h.workflows.getRunComposition(run.id, h.owner);
  const updated = h.actions.updateTemplate(template.id, { version: template.version, name: 'Changed task', steps: [{ id: 'task', type: 'task', name: 'Changed operation', config: { instructions: 'Entirely changed instructions.', assignee_email: '' } }] }, h.owner);
  assert.throws(() => h.workflows.createRun({ workflow_id: parent.id, workflow_version: parent.version, values: {} }, h.owner), error => error.statusCode === 409 && /refresh/.test(error.message));
  assert.deepEqual(h.workflows.getRunComposition(run.id, h.owner), before);
  assert.equal(h.actions.getRun(run.id, h.owner).steps[0].name, 'Prepare equipment');
  const refreshed = h.workflows.updateWorkflow(nested.id, { version: nested.version, steps: [ref(updated, 'prepare')] }, h.owner);
  const refreshedParent = h.workflows.updateWorkflow(parent.id, { version: parent.version, steps: [ref(refreshed, 'nested', {}, 'workflow')] }, h.owner);
  const next = h.workflows.createRun({ workflow_id: parent.id, workflow_version: refreshedParent.version, values: {} }, h.owner);
  assert.equal(next.steps[0].name, 'Changed operation');
  h.actions.updateTemplate(updated.id, { version: updated.version, active: false }, h.owner);
  assert.throws(() => h.workflows.createRun({ workflow_id: parent.id, workflow_version: refreshedParent.version, values: {} }, h.owner), error => error.statusCode === 409);
  assert.doesNotThrow(() => h.workflows.updateWorkflow(parent.id, { version: refreshedParent.version, active: false }, h.owner), 'A stale workflow must still be archivable.');
});

test('cycles, excessive nesting and expansion, unknown bindings, and malformed references are rejected', async t => {
  const h = await fixture(t), template = taskTemplate(h), leaf = workflow(h, 'Leaf', [ref(template, 'task')]);
  assert.throws(() => h.workflows.updateWorkflow(leaf.id, { version: leaf.version, steps: [ref(leaf, 'self', {}, 'workflow')] }, h.owner), /circular/);
  const parent = workflow(h, 'Parent', [ref(leaf, 'leaf', {}, 'workflow')]);
  assert.throws(() => h.workflows.updateWorkflow(leaf.id, { version: leaf.version, steps: [ref(parent, 'parent', {}, 'workflow')] }, h.owner), /circular/);
  let deepest = parent;
  for (let level = 0; level < 3; level++) deepest = workflow(h, 'Depth ' + level, [ref(deepest, 'nested', {}, 'workflow')]);
  assert.throws(() => workflow(h, 'Too deep', [ref(deepest, 'nested', {}, 'workflow')]), /five levels/);
  const many = h.actions.createTemplate({ name: 'Many tasks', variables: [], steps: Array.from({ length: 26 }, (_, index) => ({ id: 'task-' + index, type: 'task', config: { instructions: 'Do the work.', assignee_email: '' } })) }, h.owner);
  assert.throws(() => workflow(h, 'Too many operations', [ref(many, 'one'), ref(many, 'two')]), /50 executable/);
  assert.throws(() => workflow(h, 'Unknown binding', [ref(template, 'task', { unknown: 'value' })]), /binding/);
  assert.throws(() => h.workflows.createWorkflow({ name: 'Invalid token', variables: [variable('person')], steps: [{ ...ref(template, 'task'), name: '{{not_declared}}' }] }, h.owner), /Declare/);
  assert.throws(() => workflow(h, 'Unknown reference', [{ id: 'missing', type: 'template', ref_id: 'missing', ref_version: 1, bindings: {} }]), error => error.statusCode === 404);
  assert.throws(() => workflow(h, 'Wrong kind', [{ ...ref(template, 'task'), type: 'shell', command: 'anything' }]), /valid workflow step|Choose/);
});

test('run creation rolls back both the action and its composition if saving metadata fails', async t => {
  const h = await fixture(t), template = taskTemplate(h), composed = workflow(h, 'Atomic setup', [ref(template, 'prepare')]);
  const before = h.actions.listRuns(h.owner).total;
  h.store.db.exec("CREATE TRIGGER reject_workflow_snapshot BEFORE INSERT ON action_workflow_runs BEGIN SELECT RAISE(FAIL, 'simulated metadata write failure'); END;");
  assert.throws(() => h.workflows.createRun({ workflow_id: composed.id, workflow_version: composed.version, values: {} }, h.owner), /simulated/);
  assert.equal(h.actions.listRuns(h.owner).total, before);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM action_workflow_runs').get().count, 0);
});

test('workflow definitions, immutable composition, and pending task state survive reopening the database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-workflows-')), filename = join(directory, 'desk.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await fixture(null, filename), template = taskTemplate(first), composed = workflow(first, 'Persistent workflow', [ref(template, 'prepare')]);
  const run = first.workflows.createRun({ workflow_id: composed.id, workflow_version: composed.version, values: {} }, first.owner);
  await first.runner.wake(); assert.equal(first.actions.getRun(run.id, first.owner).status, 'waiting_task');
  const snapshot = first.workflows.getRunComposition(run.id, first.owner);
  await first.runner.stop(); first.store.close();
  const store = new Store(filename), desk = new DeskStore(store), actions = new ActionsStore(desk), workflows = new WorkflowsStore(actions), owner = desk.user(first.owner.id);
  try {
    assert.equal(workflows.listWorkflows(owner).length, 1);
    assert.deepEqual(workflows.getRunComposition(run.id, owner), snapshot);
    assert.equal(actions.getRun(run.id, owner).status, 'waiting_task');
    workflows.updateWorkflow(composed.id, { version: composed.version, name: 'New title' }, owner);
    assert.equal(workflows.getRunComposition(run.id, owner).name, 'Persistent workflow');
    assert.equal(actions.completeTask(run.id, { comment: 'Completed after reopen.' }, owner).status, 'completed');
    const direct = actions.createRun({ template_id: template.id, template_version: template.version, values: {} }, owner);
    assert.equal(workflows.getRunComposition(direct.id, owner), null);
  } finally { store.close(); }
});
