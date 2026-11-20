import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { ActionsStore, validateActionDefinition, resolveActionValues, renderActionSteps } from '../src/actions-store.js';

const PASSWORD = 'Action-store-password-2026';
async function fixture(t, filename = ':memory:') {
  const store = new Store(filename), desk = new DeskStore(store);
  const admin = await desk.ensureAdmin({ name: 'Administrator', email: 'admin@actions.example', password: PASSWORD });
  const owner = await desk.createTechnician({ name: 'Owner', email: 'owner@actions.example', password: PASSWORD });
  const other = await desk.createTechnician({ name: 'Other technician', email: 'other@actions.example', password: PASSWORD });
  const actions = new ActionsStore(desk);
  if (t) t.after(() => store.close());
  return { store, desk, admin, owner, other, actions };
}
const task = (assignee = '') => ({ name: 'Equipment preparation', description: 'Prepare a workstation.', variables: [], steps: [{ id: 'prepare', type: 'task', name: 'Prepare equipment', config: { instructions: 'Install approved software and record the handover.', assignee_email: assignee } }] });

test('definitions validate declared variables and safely render typed JSON, Unicode, and encoded paths', async t => {
  const h = await fixture(t);
  const definition = validateActionDefinition({ name: 'New employee', description: '', variables: [
    { key: 'person', label: 'Employee', type: 'text', required: true },
    { key: 'count', label: 'Quantity', type: 'number', required: true },
    { key: 'constructor', label: 'Literal constructor value', type: 'text', required: true },
  ], steps: [{ id: 'provision', type: 'api', name: 'Prepare {{person}}', config: { connection: 'hr', method: 'POST', path: '/people/{{person}}', body: '{"name":"{{person}}","quantity":"{{count}}","literal":"{{constructor}}"}' } }] });
  const values = resolveActionValues(definition, { person: 'Renée "Alex"', count: '2', constructor: 'own value' });
  const rendered = renderActionSteps(definition, values, h.owner, h.desk)[0];
  assert.equal(rendered.name, 'Prepare Renée "Alex"');
  assert.equal(rendered.config.path, '/people/Ren%C3%A9e%20%22Alex%22');
  assert.deepEqual(rendered.config.body, { name: 'Renée "Alex"', quantity: 2, literal: 'own value' });
  assert.throws(() => resolveActionValues(definition, { person: 'Alex', count: 1 }), /Literal constructor value is required/);
  assert.throws(() => resolveActionValues(definition, { person: 'Alex', count: 1, constructor: 'fine', surprise: 'ignored?' }), /Unknown workflow variable/);
  assert.throws(() => validateActionDefinition({ ...task(), steps: [{ id: 'bad', type: 'task', config: { instructions: '{{missing}}' } }] }), /Declare the variable missing/);
  assert.throws(() => validateActionDefinition({ ...task(), variables: [{ key: '__proto__', label: 'Bad', type: 'text' }] }), /Variable keys/);
  assert.throws(() => validateActionDefinition({ ...task(), steps: [{ id: 'api', type: 'api', config: { connection: 'hr', method: 'POST', path: '/%2e%2e/private', body: '{}' } }] }), /traverse/);
  const traversal = { ...definition, steps: [{ ...definition.steps[0], config: { ...definition.steps[0].config, path: '/{{person}}' } }] };
  assert.throws(() => renderActionSteps(traversal, { ...values, person: '../private' }, h.owner, h.desk), /traverse/);
  assert.throws(() => validateActionDefinition({ ...task(), steps: [{ id: 'mail', type: 'email', config: { to: 'person@example.test\r\nBcc:other@example.test', subject: 'Request', body: 'Review.' } }] }), /Recipient/);
  const expanded = validateActionDefinition({ name: 'Bounded expansion', variables: [{ key: 'detail', type: 'text', required: true }], steps: [{ type: 'api', config: { connection: 'hr', method: 'POST', path: '/people', body: JSON.stringify({ text: '{{detail}}'.repeat(500) }) } }] });
  assert.throws(() => renderActionSteps(expanded, { detail: 'x'.repeat(4000) }, h.owner, h.desk), /at most one megabyte/);
});

test('templates seed once, use ownership and optimistic versions, and never mutate a started run', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-actions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'desk.sqlite'), h = await fixture(null, filename);
  let original;
  try {
    assert.equal(h.actions.listTemplates(h.owner).length, 2);
    original = h.actions.createTemplate(task(), h.owner);
    const run = h.actions.createRun({ template_id: original.id, template_version: original.version, values: {} }, h.owner);
    assert.equal(run.definition.steps[0].config.instructions, task().steps[0].config.instructions);
    assert.throws(() => h.actions.updateTemplate(original.id, { version: original.version, name: 'Unauthorized' }, h.other), error => error.statusCode === 403);
    const changed = h.actions.updateTemplate(original.id, { version: original.version, name: 'Revised equipment process', steps: [{ ...task().steps[0], config: { instructions: 'New instructions.' } }] }, h.owner);
    assert.equal(changed.version, original.version + 1);
    assert.throws(() => h.actions.updateTemplate(original.id, { version: original.version, name: 'Stale overwrite' }, h.owner), error => error.statusCode === 409);
    assert.throws(() => h.actions.createRun({ template_id: original.id, template_version: original.version, values: {} }, h.owner), error => error.statusCode === 409);
    assert.equal(h.actions.getRun(run.id, h.owner).definition.name, 'Equipment preparation');
    assert.equal(h.actions.getRun(run.id, h.owner).definition.steps[0].config.instructions, task().steps[0].config.instructions);
    h.actions.updateTemplate(original.id, { version: changed.version, active: false }, h.owner);
    assert.throws(() => h.actions.getTemplate(original.id, h.other), error => error.statusCode === 404);
  } finally { h.store.close(); }
  const reopened = new Store(filename);
  try {
    const desk = new DeskStore(reopened), actions = new ActionsStore(desk), owner = desk.user(h.owner.id);
    assert.equal(actions.listTemplates(owner).length, 3, 'Restart must not duplicate seeded templates.');
    const restored = actions.getTemplate(original.id, owner);
    assert.equal(restored.active, false); assert.equal(restored.name, 'Revised equipment process');
  } finally { reopened.close(); }
});

test('action creation validates ticket links and assignees, while cancellation guards late step callbacks', async t => {
  const h = await fixture(t);
  assert.throws(() => h.actions.createRun({ definition: task(), values: {}, ticket_key: 'HD-MISSING' }, h.owner), error => error.statusCode === 404);
  assert.throws(() => h.actions.createRun({ definition: task('outside@example.test'), values: {} }, h.owner), /active AssetDesk technician/);
  const run = h.actions.createRun({ definition: task(), values: {} }, h.owner);
  const claimed = h.actions.claimNext();
  assert.equal(claimed.run.id, run.id);
  assert.throws(() => h.actions.cancelRun(run.id, h.other), error => error.statusCode === 403);
  h.actions.cancelRun(run.id, h.owner);
  assert.equal(h.actions.advanceStep(run.id, claimed.step.step_index, claimed.step.claim_token, { done: true }), false);
  assert.equal(h.actions.getRun(run.id, h.admin).status, 'cancelled');
  assert.throws(() => h.actions.retryRun(run.id, h.owner), error => error.statusCode === 409);
  assert.throws(() => h.actions.getRun(run.id, null), error => error.statusCode === 401);
  const approval = h.actions.listTemplates(h.owner).find(template => template.id === 'template-access-approval');
  const detailed = h.actions.createRun({ template_id: approval.id, template_version: approval.version, values: { person_name: 'Alex', request_details: 'Several paragraphs of approval details.\n'.repeat(30), approver_email: 'approver@example.test' } }, h.owner);
  assert.equal(detailed.steps[0].name, 'Approve request for Alex');
  assert.ok(detailed.steps[0].config.body.length > 1000);
});
