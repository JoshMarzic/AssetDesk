import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { ActionsStore } from '../src/actions-store.js';
import { ActionsRunner } from '../src/actions-runner.js';

async function fixture(t, overrides = {}) {
  const store = new Store(':memory:'), desk = new DeskStore(store);
  const password = 'Runner-test-password-2026';
  const admin = await desk.ensureAdmin({ name: 'Admin', email: 'admin@runner.example', password });
  const owner = await desk.createTechnician({ name: 'Owner', email: 'owner@runner.example', password });
  const assignee = await desk.createTechnician({ name: 'Technician', email: 'tech@runner.example', password });
  const actions = new ActionsStore(desk), sent = [], calls = [];
  const transports = { capabilities: () => ({ email: { configured: true }, approval: { configured: true }, connections: [{ id: 'hr' }], publicUrl: 'https://desk.example.test' }),
    async sendEmail(message) { sent.push(message); return { messageId: message.messageId }; },
    async callApi(config, user) { calls.push({ config, user }); return { status: 201 }; }, ...overrides };
  const runner = new ActionsRunner({ actions, transports, logger: { error() {} } });
  t.after(async () => { await runner.stop(); store.close(); });
  return { store, desk, actions, runner, transports, sent, calls, admin, owner, assignee };
}
const approval = { id: 'approval', type: 'approval', name: 'Approve access', config: { to: 'approver@example.test', subject: 'Approve access', body: 'Please review the access request.', expires_hours: 1 } };
const notification = { id: 'email', type: 'email', name: 'Notify requester', config: { to: 'person@example.test', subject: 'Access approved', body: 'Your request has been approved.' } };
const definition = steps => ({ name: 'Access workflow', description: '', variables: [], steps });
const token = mail => mail.text.match(/\/approve\/([a-f0-9]{80})/)[1];

test('ordered workflows pause for delivered approval and assigned tasks, then resume through email, API and durable delay', async t => {
  const h = await fixture(t);
  const run = h.actions.createRun({ definition: definition([approval, notification,
    { id: 'api', type: 'api', name: 'Provision account', config: { connection: 'hr', method: 'POST', path: '/people', body: '{"approved":true}' } },
    { id: 'task', type: 'task', name: 'Verify access', config: { instructions: 'Verify that the account works.', assignee_email: h.assignee.email } },
    { id: 'wait', type: 'delay', name: 'Wait for propagation', config: { minutes: 15 } },
  ]), values: {} }, h.owner);
  await Promise.all([h.runner.wake(), h.runner.wake()]);
  let current = h.actions.getRun(run.id, h.owner); assert.equal(current.status, 'waiting_approval'); assert.equal(h.sent.length, 1); assert.equal(h.calls.length, 0);
  const approvalToken = token(h.sent[0]);
  assert.ok(!JSON.stringify(current).includes(approvalToken)); assert.ok(!JSON.stringify(current).includes('token_hash'));
  assert.equal(h.actions.resolveApproval(approvalToken).can_decide, true);
  assert.equal(h.actions.getRun(run.id, h.owner).status, 'waiting_approval', 'Viewing a link must never approve it.');
  h.actions.decideApproval(approvalToken, { decision: 'approved', comment: 'Approved for the starter.' });
  assert.throws(() => h.actions.decideApproval(approvalToken, { decision: 'approved' }), error => error.statusCode === 409);
  await h.runner.wake(); current = h.actions.getRun(run.id, h.owner);
  assert.equal(current.status, 'waiting_task'); assert.equal(h.sent.length, 2); assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].config.body, { approved: true });
  assert.throws(() => h.actions.completeTask(run.id, {}, h.owner), error => error.statusCode === 403);
  h.actions.completeTask(run.id, { comment: 'Account verified.' }, h.assignee); await h.runner.wake();
  current = h.actions.getRun(run.id, h.owner); assert.equal(current.status, 'waiting_delay'); assert.ok(current.steps[4].due_at);
  h.actions.resumeDue(new Date(Date.now() + 16 * 60000).toISOString()); await h.runner.wake();
  current = h.actions.getRun(run.id, h.owner); assert.equal(current.status, 'completed'); assert.equal(current.progress.completed, 5);
  assert.equal(current.steps[3].output.completed_by, h.assignee.name);
});

test('rejection, expiration and cancellation prevent downstream effects and revoke old approval links', async t => {
  const h = await fixture(t);
  const rejected = h.actions.createRun({ definition: definition([approval, notification]), values: {} }, h.owner);
  await h.runner.wake(); const rejectedToken = token(h.sent[0]);
  h.actions.decideApproval(rejectedToken, { decision: 'rejected', comment: 'Request is not authorized.' }); await h.runner.wake();
  assert.equal(h.actions.getRun(rejected.id, h.owner).status, 'rejected'); assert.equal(h.sent.length, 1);
  const expired = h.actions.createRun({ definition: definition([approval, notification]), values: {} }, h.owner);
  await h.runner.wake(); const expiredToken = token(h.sent[1]);
  h.store.db.prepare('UPDATE action_approvals SET expires_at=? WHERE run_id=?').run('2000-01-01T00:00:00.000Z', expired.id);
  assert.equal(h.actions.resolveApproval(expiredToken).status, 'expired');
  assert.throws(() => h.actions.decideApproval(expiredToken, { decision: 'approved' }), error => error.statusCode === 410);
  h.actions.resumeDue(); assert.equal(h.actions.getRun(expired.id, h.owner).status, 'failed');
  h.actions.retryRun(expired.id, h.owner); await h.runner.wake(); assert.equal(h.sent.length, 3);
  assert.equal(h.actions.resolveApproval(expiredToken).can_decide, false);
  const replacementToken = token(h.sent[2]); assert.notEqual(replacementToken, expiredToken);
  h.actions.cancelRun(expired.id, h.owner);
  assert.equal(h.actions.resolveApproval(replacementToken).can_decide, false);
  assert.throws(() => h.actions.decideApproval(replacementToken, { decision: 'approved' }), error => error.statusCode === 409);
});

test('missing integrations block honestly and uncertain remote attempts require an explicit retry', async t => {
  const h = await fixture(t);
  h.transports.capabilities = () => ({ email: { configured: false }, approval: { configured: false }, connections: [], publicUrl: '' });
  const run = h.actions.createRun({ definition: definition([approval]), values: {} }, h.owner); await h.runner.wake();
  assert.equal(h.actions.getRun(run.id, h.owner).status, 'blocked'); assert.equal(h.sent.length, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM action_approvals').get().count, 0);
  h.transports.capabilities = () => ({ email: { configured: true }, approval: { configured: true }, publicUrl: 'https://desk.example.test' });
  h.transports.sendEmail = async () => { throw Object.assign(new Error('Private upstream detail'), { uncertain: true, safeMessage: 'Delivery confirmation was interrupted. Check before retrying.' }); };
  h.actions.retryRun(run.id, h.owner); await h.runner.wake();
  assert.equal(h.actions.getRun(run.id, h.owner).status, 'needs_attention');
  await h.runner.wake(); assert.equal(h.actions.getRun(run.id, h.owner).steps[0].attempt, 2, 'The scheduler must not automatically retry uncertain attempts.');
  assert.ok(!JSON.stringify(h.actions.getRun(run.id, h.owner)).includes('Private upstream detail'));
});

test('cancelling an in-flight approval prevents a late SMTP result from resurrecting the action', async t => {
  let finish;
  const messages = [];
  const h = await fixture(t, { async sendEmail(message) { messages.push(message); return new Promise(resolve => { finish = () => resolve({ messageId: message.messageId }); }); } });
  const run = h.actions.createRun({ definition: definition([approval]), values: {} }, h.owner);
  const pending = h.runner.wake();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  h.actions.cancelRun(run.id, h.owner); finish(); await pending;
  assert.equal(h.actions.getRun(run.id, h.owner).status, 'cancelled'); assert.equal(h.actions.resolveApproval(token(messages[0])).can_decide, false);
});

test('a disabled creator cannot trigger an external step', async t => {
  const h = await fixture(t), run = h.actions.createRun({ definition: definition([notification]), values: {} }, h.owner);
  await h.desk.updateTechnician(h.owner.id, { active: false }); await h.runner.wake();
  assert.equal(h.actions.getRun(run.id, h.admin).status, 'blocked'); assert.equal(h.sent.length, 0);
});

test('restart preserves waits and marks interrupted external attempts for attention without replay', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'action-restart-')), filename = join(directory, 'desk.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new Store(filename), desk = new DeskStore(first), user = await desk.ensureAdmin({ name: 'Admin', email: 'restart@example.test', password: 'Restart-action-password-2026' }), actions = new ActionsStore(desk);
  const run = actions.createRun({ definition: definition([notification]), values: {} }, user); actions.claimNext(); first.close();
  const reopened = new Store(filename), restoredDesk = new DeskStore(reopened), restored = new ActionsStore(restoredDesk); let sends = 0;
  const runner = new ActionsRunner({ actions: restored, transports: { capabilities: () => ({ email: { configured: true } }), async sendEmail() { sends++; return { messageId: 'unexpected' }; } }, logger: { error() {} } });
  try {
    await runner.start(); const result = restored.getRun(run.id, restoredDesk.user(user.id));
    assert.equal(result.status, 'needs_attention'); assert.equal(sends, 0); assert.match(result.error, /before explicitly retrying/);
  } finally { await runner.stop(); reopened.close(); }
});

test('approval and scheduled waits survive a database restart without sending a second approval email', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'action-waits-')), filename = join(directory, 'desk.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new Store(filename), desk = new DeskStore(first), user = await desk.ensureAdmin({ name: 'Admin', email: 'waits@example.test', password: 'Durable-wait-password-2026' }), actions = new ActionsStore(desk), sent = [];
  const firstRunner = new ActionsRunner({ actions, transports: { capabilities: () => ({ email: { configured: true }, approval: { configured: true }, publicUrl: 'https://desk.example.test' }), async sendEmail(message) { sent.push(message); return { messageId: message.messageId }; } } });
  const approvalRun = actions.createRun({ definition: definition([approval]), values: {} }, user);
  const delayRun = actions.createRun({ definition: definition([{ id: 'wait', type: 'delay', config: { minutes: 15 } }]), values: {} }, user);
  let approvalToken, due;
  try {
    await firstRunner.wake(); approvalToken = token(sent[0]); due = actions.getRun(delayRun.id, user).steps[0].due_at;
    assert.equal(actions.getRun(approvalRun.id, user).status, 'waiting_approval'); assert.equal(actions.getRun(delayRun.id, user).status, 'waiting_delay');
  } finally { await firstRunner.stop(); first.close(); }
  const reopened = new Store(filename), restoredDesk = new DeskStore(reopened), restored = new ActionsStore(restoredDesk); let sends = 0;
  const secondRunner = new ActionsRunner({ actions: restored, transports: { capabilities: () => ({ email: { configured: true }, approval: { configured: true }, publicUrl: 'https://desk.example.test' }), async sendEmail() { sends++; return { messageId: 'unexpected' }; } } });
  try {
    await secondRunner.start(); const actor = restoredDesk.user(user.id);
    assert.equal(restored.resolveApproval(approvalToken).can_decide, true); assert.equal(restored.getRun(delayRun.id, actor).steps[0].due_at, due); assert.equal(sends, 0);
    restored.decideApproval(approvalToken, { decision: 'approved' }); await secondRunner.wake(); assert.equal(restored.getRun(approvalRun.id, actor).status, 'completed');
    reopened.db.prepare('UPDATE action_run_steps SET due_at=? WHERE run_id=?').run('2000-01-01T00:00:00.000Z', delayRun.id); await secondRunner.wake(); assert.equal(restored.getRun(delayRun.id, actor).status, 'completed'); assert.equal(sends, 0);
  } finally { await secondRunner.stop(); reopened.close(); }
});
