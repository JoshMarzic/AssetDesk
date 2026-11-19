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
  assert.equal(ticket.page_id, 10);
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

test('asset links are reusable and list filters and dashboard totals reflect stored work', async t => {
  const { desk, store } = fixture(t);
  createTicket(store, 'HD-FIRST'); createTicket(store, 'HD-SECOND');
  const tech = await desk.createTechnician(person);
  let ticket = desk.getTicket('HD-FIRST');
  ticket = desk.updateTicket(ticket.key, { assignee_id: tech.id, priority: 'high' }, { version: ticket.version });
  desk.addAssets(ticket.key, [{ ref: 'LAPTOP-42', id: 3, url: 'https://wiki.example/link/3' }]);
  desk.addAssets('HD-SECOND', [{ ref: 'LAPTOP-42', id: 3, url: 'https://wiki.example/link/3' }]);
  assert.equal(desk.listAssets().length, 1);
  assert.equal(desk.listAssets()[0].ticket_count, 2);
  store.db.prepare('UPDATE tickets SET response_due_at=? WHERE key=?').run('2020-01-01T00:00:00.000Z', ticket.key);
  assert.equal(desk.listTickets({ view: 'overdue' }).total, 1);
  assert.equal(desk.listTickets({ view: 'unassigned' }).total, 1);
  assert.equal(desk.listTickets({ assignee: tech.id, priority: 'high' }).total, 1);
  assert.equal(desk.listTickets({ search: 'FIRST' }).total, 1);
  assert.equal(desk.listTickets({ search: '%' }).total, 0);
  assert.equal(desk.getTicket(ticket.key).is_overdue, true);
  const dashboard = desk.dashboard();
  assert.equal(dashboard.stats.open, 2);
  assert.equal(dashboard.stats.unassigned, 1);
  assert.equal(dashboard.stats.overdue, 1);
  assert.equal(dashboard.workload[0].active_tickets, 1);
  assert.equal(dashboard.workload[0].overdue_tickets, 1);
  assert.ok(dashboard.activity.some(e => e.ticket_key === ticket.key));
});

test('metadata synchronization retains newer versions and retries safely after remote failure', t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  let ticket = desk.captureEmail('HD-TEST1', message, { receiptId: 'initial' });
  const oldVersion = ticket.version;
  assert.equal(desk.pendingSync().length, 1);
  ticket = desk.updateTicket(ticket.key, { priority: 'urgent' }, { version: ticket.version });
  assert.equal(desk.markSynced(ticket.key, oldVersion), false);
  desk.failSync(ticket.key, new Error('private upstream response'));
  assert.equal(desk.pendingSync().length, 0);
  assert.ok(!desk.getTicket(ticket.key).sync.error.includes('private'));
  const pending = desk.pendingSync(Date.now() + 10000);
  assert.equal(pending[0].priority, 'urgent');
  assert.equal(desk.markSynced(ticket.key, ticket.version), true);
  assert.equal(desk.getTicket(ticket.key).sync.pending, false);
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
  assert.equal(desk.pendingSync().length, 1);
  store.close();
});

test('legacy asset recovery queues existing references, backs off, and clears only recovered links', t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  desk.captureEmail('HD-TEST1', { ...message, assetRefs: ['LAPTOP-42', 'PC-18'] }, { receiptId: 'legacy-assets' });
  assert.equal(desk.pendingAssetRecovery().length, 2);
  desk.deferAssetRecovery('HD-TEST1', 'PC-18');
  assert.deepEqual(desk.pendingAssetRecovery().map(a => a.ref), ['LAPTOP-42']);
  desk.addAssets('HD-TEST1', [{ ref: 'LAPTOP-42', id: 3, url: 'https://wiki.example/link/3' }]);
  assert.equal(desk.pendingAssetRecovery().length, 0);
  assert.deepEqual(desk.pendingAssetRecovery(Date.now() + 300001).map(a => a.ref), ['PC-18']);
  assert.equal(desk.getTicket('HD-TEST1').assets[0].ref, 'LAPTOP-42');
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

test('related tickets derive from the requester or shared asset without returning unrelated tickets or self', t => {
  const { desk, store } = fixture(t);
  for (const key of ['HD-BASE', 'HD-SAME-REQUESTER', 'HD-SHARED-ASSET', 'HD-UNRELATED']) createTicket(store, key);
  store.db.prepare('UPDATE tickets SET requester=? WHERE key=?').run('other@example.com', 'HD-SHARED-ASSET');
  store.db.prepare('UPDATE tickets SET requester=? WHERE key=?').run('unrelated@example.com', 'HD-UNRELATED');
  const asset = { ref: 'LAPTOP-42', id: 8, url: 'https://wiki.example/link/8' };
  desk.addAssets('HD-BASE', [asset]);
  desk.addAssets('HD-SHARED-ASSET', [asset]);
  let related = desk.getTicket('HD-BASE').related_tickets;
  assert.deepEqual(related.map(row => row.key), ['HD-SHARED-ASSET', 'HD-SAME-REQUESTER']);
  assert.ok(related.every(row => row.key !== 'HD-BASE' && row.key !== 'HD-UNRELATED'));
  const other = desk.getTicket('HD-SAME-REQUESTER');
  desk.updateTicket(other.key, { status: 'resolved', resolution: 'Reinstalled the display driver.' }, { version: other.version });
  related = desk.getTicket('HD-BASE').related_tickets;
  assert.equal(related.find(row => row.key === other.key).resolution, 'Reinstalled the display driver.');
  for (let i = 0; i < 12; i++) createTicket(store, `HD-EXTRA-${i}`);
  assert.equal(desk.getTicket('HD-BASE').related_tickets.length, 8);
});

test('manual asset links normalize and deduplicate, retry safely, and persist audit attribution on completion', t => {
  const { desk, store } = fixture(t);
  createTicket(store);
  const actor = { id: 'operator-id', name: 'Morgan Lee' };
  assert.deepEqual(desk.queueAssetLink('HD-TEST1', ' laptop-42 ', actor), { queued: true, ref: 'LAPTOP-42' });
  desk.queueAssetLink('HD-TEST1', 'LAPTOP-42', actor);
  assert.equal(desk.pendingAssetLinks().length, 1);
  assert.deepEqual(desk.pendingAssetLinks()[0].actor, actor);
  desk.failAssetLink('HD-TEST1', 'LAPTOP-42', new Error('private upstream body'));
  assert.equal(desk.pendingAssetLinks().length, 0);
  const failed = desk.getTicket('HD-TEST1').pending_asset_links[0];
  assert.equal(failed.attempts, 1);
  assert.ok(!failed.error.includes('private upstream'));
  assert.equal(desk.pendingAssetLinks(Date.now() + 10000).length, 1);
  const version = desk.getTicket('HD-TEST1').version;
  let ticket = desk.completeAssetLink('HD-TEST1', 'LAPTOP-42', { id: 3, url: 'https://wiki.example/link/3' });
  assert.equal(ticket.version, version + 1);
  assert.equal(ticket.pending_asset_links.length, 0);
  assert.equal(ticket.assets[0].ref, 'LAPTOP-42');
  assert.equal(ticket.events.filter(e => e.type === 'asset_link').length, 1);
  assert.equal(ticket.events.find(e => e.type === 'asset_link').actor_name, actor.name);
  ticket = desk.completeAssetLink('HD-TEST1', 'LAPTOP-42', { id: 3, url: 'https://wiki.example/link/3' });
  assert.equal(ticket.version, version + 1);
  assert.deepEqual(desk.queueAssetLink('HD-TEST1', 'laptop-42', actor), { queued: false, linked: true, ref: 'LAPTOP-42' });
  for (const invalid of ['', '../unsafe/path', '<script>', 'id with spaces', 'A'.repeat(65)]) assert.throws(() => desk.queueAssetLink('HD-TEST1', invalid, actor), e => e.statusCode === 400);
  assert.throws(() => desk.queueAssetLink('missing', 'PC-42', actor), e => e.statusCode === 404);
});

test('manual asset link queues survive database reopen with retry details intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'assetdesk-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'desk.sqlite');
  let store = new Store(filename), desk = new DeskStore(store);
  createTicket(store);
  desk.queueAssetLink('HD-TEST1', 'PC-27', { id: 'staff-id', name: 'Technician' });
  desk.failAssetLink('HD-TEST1', 'PC-27', { safeMessage: 'BookStack API is unavailable.' });
  store.close();
  store = new Store(filename); desk = new DeskStore(store);
  assert.equal(desk.getTicket('HD-TEST1').pending_asset_links[0].error, 'BookStack API is unavailable.');
  assert.deepEqual(desk.pendingAssetLinks(Date.now() + 10000)[0], { key: 'HD-TEST1', ref: 'PC-27', actor: { id: 'staff-id', name: 'Technician' } });
  store.close();
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
