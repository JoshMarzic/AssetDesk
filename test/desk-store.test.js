import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';

function fixture(t) {
  const store = new Store(':memory:');
  const desk = new DeskStore(store);
  t.after(() => store.close());
  return { store, desk };
}
function createTicket(store, key = 'HD-TEST1') {
  return store.saveTicket({ key, requester: 'taylor@example.com', subject: `Issue ${key}`, page_id: 10, page_url: 'https://wiki.example/link/10' });
}
const person = { name: 'Morgan Lee', email: 'morgan@example.com', password: 'test-password-long-123' };
const message = { from: { name: 'Taylor Example', address: 'taylor@example.com' }, text: 'My LAPTOP-42 will not boot.', receivedAt: '2026-11-01T12:00:00.000Z' };

test('migration preserves existing ticket/queue data and initializes legacy email details idempotently', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  createTicket(store);
  const receipt = store.accept({ ...message, messageId: '<legacy@example.com>' });
  store.complete(receipt.id, 'HD-TEST1');
  const first = new DeskStore(store);
  const ticket = first.getTicket('HD-TEST1');
  assert.equal(ticket.description, message.text);
  assert.equal(ticket.requester_name, 'Taylor Example');
  assert.equal(ticket.status, 'open');
  assert.equal(store.ticket(ticket.key).page_id, 10);
  assert.equal(ticket.events.filter(e => e.type === 'created').length, 1);
  const next = new DeskStore(store).getTicket('HD-TEST1');
  assert.equal(next.events.length, ticket.events.length);
  assert.equal(store.receipt(receipt.id).state, 'done');
  assert.equal(Date.parse(ticket.response_due_at) - Date.parse(ticket.created_at), 8 * 3600000);
});

test('technician passwords are hashed, authentication is case insensitive, and ensureAdmin never resets a password', async t => {
  const { desk, store } = fixture(t);
  const admin = await desk.ensureAdmin({ ...person });
  assert.equal(admin.role, 'admin');
  assert.equal(admin.password_hash, undefined);
  const stored = store.db.prepare('SELECT password_hash FROM technicians WHERE id=?').get(admin.id);
  assert.ok(stored.password_hash.startsWith('scrypt$'));
  assert.ok(!stored.password_hash.includes(person.password));
  assert.equal((await desk.verifyUser('MORGAN@example.com', person.password)).id, admin.id);
  assert.equal(await desk.verifyUser(person.email, 'wrong-password'), null);
  assert.equal(await desk.verifyUser('nobody@example.com', person.password), null);
  await desk.ensureAdmin({ name: 'Other Admin', email: 'other@example.com', password: 'completely-new-password' });
  assert.equal(desk.listTechnicians().length, 1);
  assert.equal((await desk.verifyUser(person.email, person.password)).id, admin.id);
  await assert.rejects(desk.createTechnician({ ...person }), e => e.statusCode === 409);
  await assert.rejects(desk.createTechnician({ ...person, email: 'short@example.com', password: 'short' }), /12 to 256/);
});

test('sessions store token hashes, expire, and become invalid on password reset or deactivation', async t => {
  const { desk, store } = fixture(t);
  const user = await desk.createTechnician(person);
  const session = desk.createSession(user.id);
  assert.equal(desk.session(session.token).user.id, user.id);
  const stored = store.db.prepare('SELECT * FROM desk_sessions').get();
  assert.notEqual(stored.token_hash, session.token);
  assert.equal(desk.session('bad-token'), null);
  store.db.prepare('UPDATE desk_sessions SET expires_at=?').run('2020-01-01T00:00:00.000Z');
  assert.equal(desk.session(session.token), null);
  const second = desk.createSession(user.id);
  await desk.updateTechnician(user.id, { password: 'another-password-long' });
  assert.equal(desk.session(second.token), null);
  const third = desk.createSession(user.id);
  await desk.updateTechnician(user.id, { active: false });
  assert.equal(desk.session(third.token), null);
  assert.equal(await desk.verifyUser(person.email, 'another-password-long'), null);
});

test('administration cannot remove the last active administrator', async t => {
  const { desk } = fixture(t);
  const admin = await desk.ensureAdmin(person);
  await assert.rejects(desk.updateTechnician(admin.id, { active: false }), e => e.statusCode === 409);
  await assert.rejects(desk.updateTechnician(admin.id, { role: 'technician' }), e => e.statusCode === 409);
  await desk.createTechnician({ ...person, email: 'second@example.com', role: 'admin' });
  assert.equal((await desk.updateTechnician(admin.id, { role: 'technician' })).role, 'technician');
});

test('assignment persists technician ownership and optimistic versions reject stale saves atomically', async t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  const user = await desk.createTechnician(person);
  const original = desk.getTicket('HD-TEST1');
  const assigned = desk.updateTicket(original.key, { assignee_id: user.id, status: 'in_progress' }, { actor: user, version: original.version });
  assert.equal(assigned.assignee.id, user.id);
  assert.equal(assigned.status, 'in_progress');
  assert.ok(assigned.events.some(e => e.type === 'assignment' && e.actor_name === user.name));
  assert.throws(() => desk.updateTicket(original.key, { priority: 'urgent' }, { actor: user, version: original.version }), e => e.statusCode === 409);
  assert.equal(desk.getTicket(original.key).priority, 'normal');
  await desk.updateTechnician(user.id, { active: false });
  const updated = desk.updateTicket(original.key, { assignee_id: user.id, priority: 'high', status: 'resolved', resolution: 'Completed work before technician departure.' }, { version: assigned.version });
  assert.equal(updated.assignee.id, user.id);
  assert.equal(updated.assignee.active, false);
  assert.equal(updated.status, 'resolved');
  createTicket(store, 'HD-UNASSIGNED');
  const unassigned = desk.getTicket('HD-UNASSIGNED');
  assert.throws(() => desk.updateTicket(unassigned.key, { assignee_id: user.id }, { version: unassigned.version }), /active technician/);
  assert.equal(desk.listTickets({ assignee: user.id }).total, 1);
});

test('resolution requires a summary, closing requires resolution, and reopening retains elapsed deadlines', t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  let ticket = desk.getTicket('HD-TEST1');
  assert.throws(() => desk.updateTicket(ticket.key, { status: 'closed' }, { version: ticket.version }), /transition/);
  assert.throws(() => desk.updateTicket(ticket.key, { status: 'resolved' }, { version: ticket.version }), /resolution summary/);
  ticket = desk.updateTicket(ticket.key, { status: 'resolved', resolution: 'Replaced the failed battery.' }, { version: ticket.version });
  assert.ok(ticket.resolved_at);
  assert.equal(ticket.resolution, 'Replaced the failed battery.');
  ticket = desk.updateTicket(ticket.key, { status: 'closed' }, { version: ticket.version });
  const originalDeadline = ticket.resolution_due_at;
  ticket = desk.updateTicket(ticket.key, { status: 'open' }, { version: ticket.version });
  assert.equal(ticket.resolved_at, null);
  assert.equal(ticket.resolution_due_at, originalDeadline);
});

test('priority SLA changes are anchored to creation and internal notes never count as a customer response', t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  let ticket = desk.getTicket('HD-TEST1');
  ticket = desk.updateTicket(ticket.key, { priority: 'urgent' }, { version: ticket.version });
  assert.equal(Date.parse(ticket.response_due_at) - Date.parse(ticket.created_at), 3600000);
  assert.equal(Date.parse(ticket.resolution_due_at) - Date.parse(ticket.created_at), 8 * 3600000);
  ticket = desk.addNote(ticket.key, { body: '<script>untrusted text</script>', actor: { name: 'Operator' } });
  assert.equal(ticket.notes[0].body, '<script>untrusted text</script>');
  assert.equal(ticket.notes[0].kind, 'note');
  assert.equal(ticket.first_response_at, null);
  ticket = desk.updateTicket(ticket.key, { first_response: true }, { version: ticket.version });
  assert.ok(ticket.first_response_at);
});

test('email capture is idempotent, honors initial triage, and only requester replies reopen resolved tickets', async t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  const user = await desk.createTechnician(person);
  let ticket = desk.captureEmail('HD-TEST1', { ...message, desk: { priority: 'high', category: 'hardware', assignee_id: user.id } }, { receiptId: 'initial', source: 'manual' });
  assert.equal(ticket.description, message.text);
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.category, 'hardware');
  assert.equal(ticket.source, 'manual');
  assert.equal(ticket.assignee.id, user.id);
  const duplicate = desk.captureEmail(ticket.key, message, { receiptId: 'initial' });
  assert.equal(duplicate.version, ticket.version);
  ticket = desk.updateTicket(ticket.key, { status: 'resolved', resolution: 'Fixed.' }, { version: ticket.version });
  ticket = desk.captureEmail(ticket.key, message, { receiptId: 'support-reply', isReply: true, reopen: false });
  assert.equal(ticket.status, 'resolved');
  ticket = desk.captureEmail(ticket.key, message, { receiptId: 'requester-reply', isReply: true, reopen: true });
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.notes.length, 2);
  assert.ok(ticket.events.some(e => /Reopened/.test(e.body)));
});

test('workflow data and active sessions survive reopening the persistent database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'assetdesk-desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'desk.sqlite');
  let store = new Store(filename), desk = new DeskStore(store);
  createTicket(store);
  const user = await desk.ensureAdmin(person);
  const session = desk.createSession(user.id);
  let ticket = desk.getTicket('HD-TEST1');
  desk.updateTicket(ticket.key, { assignee_id: user.id, status: 'in_progress' }, { actor: user, version: ticket.version });
  store.close();
  store = new Store(filename); desk = new DeskStore(store);
  assert.equal(desk.getTicket(ticket.key).assignee.id, user.id);
  assert.equal(desk.getTicket(ticket.key).status, 'in_progress');
  assert.equal(desk.session(session.token).user.id, user.id);
  assert.ok(desk.getTicket(ticket.key).events.some(event => event.type === 'assignment'));
  store.close();
});

test('saved responses seed once, preserve placeholder text, validate edits, and support archiving', t => {
  const { desk, store } = fixture(t);
  const defaults = desk.listResponses();
  assert.deepEqual(defaults.map(r => r.title), ['Request more information', 'Resolution confirmation', 'Troubleshooting update']);
  assert.ok(defaults.every(r => r.active && r.body.includes('{{requester}}') && r.body.includes('{{technician}}') && r.body.includes('{{ticket_id}}') && r.body.includes('{{subject}}')));
  const response = desk.createResponse({ title: 'Password reset steps', body: 'Hi {{requester}}, steps for {{ticket_id}} follow.' }, { id: 'admin-id', name: 'Admin' });
  assert.equal(response.active, true);
  assert.ok(response.updated_at);
  const archived = desk.updateResponse(response.id, { title: 'Archived reset', active: false }, { id: 'admin-id', name: 'Admin' });
  assert.equal(archived.active, false);
  assert.equal(desk.listResponses().length, 3);
  assert.equal(desk.listResponses({ includeInactive: true }).length, 4);
  desk.updateResponse(defaults[0].id, { body: 'Customized content {{requester}}' }, { name: 'Admin' });
  const reopened = new DeskStore(store);
  assert.equal(reopened.listResponses().find(r => r.id === defaults[0].id).body, 'Customized content {{requester}}');
  assert.equal(reopened.listResponses().length, 3);
  assert.throws(() => desk.createResponse({ title: 'x'.repeat(101), body: 'Valid' }), /100 characters/);
  assert.throws(() => desk.createResponse({ title: 'Valid', body: 'x'.repeat(10001) }), /10000 characters/);
  assert.throws(() => desk.updateResponse(response.id, { active: 'false' }), /true or false/);
  assert.throws(() => desk.updateResponse('missing', { active: false }), e => e.statusCode === 404);
});

test('initial email capture preserves triage edited while remote ticket creation was retrying', async t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  const user = await desk.createTechnician(person);
  let ticket = desk.getTicket('HD-TEST1');
  ticket = desk.updateTicket(ticket.key, { priority: 'urgent', category: 'network', assignee_id: user.id }, { actor: user, version: ticket.version });
  const captured = desk.captureEmail(ticket.key, message, { receiptId: 'late-initial-capture' });
  assert.equal(captured.priority, 'urgent');
  assert.equal(captured.category, 'network');
  assert.equal(captured.assignee.id, user.id);
  assert.equal(captured.response_due_at, ticket.response_due_at);
  assert.equal(captured.description, message.text);
});

test('password hashing cannot resurrect an account or restore a role changed concurrently', async t => {
  const { desk } = fixture(t);
  const admin = await desk.ensureAdmin(person);
  await desk.createTechnician({ ...person, email: 'second-admin@example.com', role: 'admin' });
  const passwordChange = desk.updateTechnician(admin.id, { password: 'new-long-dummy-password' });
  await desk.updateTechnician(admin.id, { active: false, role: 'technician', name: 'Deactivated account' });
  await passwordChange;
  const actual = desk.user(admin.id);
  assert.equal(actual.active, false);
  assert.equal(actual.role, 'technician');
  assert.equal(actual.name, 'Deactivated account');
  assert.equal(await desk.verifyUser(person.email, 'new-long-dummy-password'), null);
});

test('ticket sorting applies before pagination with a strict SQL ordering whitelist', t => {
  const { desk, store } = fixture(t);
  for (const key of ['HD-OLD', 'HD-MIDDLE', 'HD-NEW']) createTicket(store, key);
  store.db.prepare('UPDATE tickets SET created_at=? WHERE key=?').run('2026-10-01T00:00:00.000Z', 'HD-OLD');
  store.db.prepare('UPDATE tickets SET created_at=? WHERE key=?').run('2026-10-02T00:00:00.000Z', 'HD-MIDDLE');
  store.db.prepare('UPDATE tickets SET created_at=? WHERE key=?').run('2026-10-03T00:00:00.000Z', 'HD-NEW');
  let old = desk.getTicket('HD-OLD');
  desk.updateTicket(old.key, { priority: 'urgent' }, { version: old.version });
  assert.equal(desk.listTickets({ sort: 'newest', limit: 1 }).tickets[0].key, 'HD-NEW');
  assert.equal(desk.listTickets({ sort: 'oldest', limit: 1 }).tickets[0].key, 'HD-OLD');
  assert.equal(desk.listTickets({ sort: 'priority', limit: 1 }).tickets[0].key, 'HD-OLD');
  assert.equal(desk.listTickets({ sort: 'due', limit: 1 }).tickets[0].key, 'HD-OLD');
  assert.equal(desk.listTickets({ sort: 'newest', limit: 1, offset: 1 }).tickets[0].key, 'HD-MIDDLE');
  assert.throws(() => desk.listTickets({ sort: 'created_at; DROP TABLE tickets' }), /Invalid ticket sort/);
});

test('one-time legacy migration anchors SLA to original arrival without resetting workflow on restart', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  createTicket(store);
  const initialMessage = { ...message, messageId: '<delayed-arrival@example.com>', receivedAt: '2026-10-01T10:00:00.000Z' };
  const receipt = store.accept(initialMessage);
  store.complete(receipt.id, 'HD-TEST1');
  let desk = new DeskStore(store);
  let ticket = desk.getTicket('HD-TEST1');
  assert.equal(ticket.created_at, initialMessage.receivedAt);
  assert.equal(ticket.response_due_at, '2026-10-01T18:00:00.000Z');
  ticket = desk.updateTicket(ticket.key, { priority: 'high', status: 'in_progress' }, { version: ticket.version });
  desk = new DeskStore(store);
  assert.equal(desk.getTicket(ticket.key).priority, 'high');
  assert.equal(desk.getTicket(ticket.key).status, 'in_progress');
  assert.equal(desk.getTicket(ticket.key).response_due_at, '2026-10-01T12:00:00.000Z');
});
