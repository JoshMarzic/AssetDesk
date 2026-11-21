import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DeskStore, normalizePausedUntil } from '../src/desk-store.js';
import { TicketScheduler } from '../src/ticket-scheduler.js';

const actor = { id: 'pause-technician', name: 'Pause technician' };
const CLOCK = '2035-05-01T12:00:00.000Z';
function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store);
  t.after(() => store.close());
  function ticket(key = 'HD-PAUSE') {
    store.saveTicket({ key, requester: 'requester@example.test', subject: `Scheduled work ${key}`, page_id: 0, page_url: '' });
    return desk.getTicket(key);
  }
  function update(current, patch) { return desk.updateTicket(current.key, patch, { version: current.version, actor }); }
  return { store, desk, ticket, update };
}
function frozenClock(t) { t.mock.timers.enable({ apis: ['Date'], now: new Date(CLOCK) }); }

test('pause date validation canonicalizes explicit timezones and rejects invalid, elapsed, or out-of-range dates', () => {
  const timestamp = Date.parse(CLOCK);
  assert.equal(normalizePausedUntil('2035-05-01T09:30-04:00', { timestamp }), '2035-05-01T13:30:00.000Z');
  assert.equal(normalizePausedUntil('2036-02-29T13:00:00Z', { timestamp }), '2036-02-29T13:00:00.000Z');
  assert.equal(normalizePausedUntil(null, { timestamp }), null);
  for (const value of ['', undefined, 123, true, '2035-05-01', '2035-05-01T14:00', '2035-02-29T13:00Z',
    '2036-02-30T13:00Z', '2035-05-01T24:00Z', '2035-05-01T13:60Z', '2035-05-01T13:00:60Z',
    '2035-05-01T13:00+24:00', CLOCK, '2020-01-01T00:00:00Z', '9999-12-31T23:59:59-23:00']) {
    assert.throws(() => normalizePausedUntil(value, { timestamp }), error => error.statusCode === 400, String(value));
  }
});

test('upgrading an old status CHECK preserves custom options and rekeys a custom paused collision without stranding its tickets', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.db.exec(`
    ALTER TABLE tickets ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
    CREATE TABLE ticket_statuses (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('active','resolved','closed')),
      active INTEGER NOT NULL DEFAULT 1, system INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO ticket_statuses VALUES('open','Inbox','active',1,1),('paused','Paused','active',0,0),('paused-legacy','Old completion','closed',0,0);
    CREATE TABLE ticket_workflow_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO ticket_workflow_meta VALUES(1,9);
  `);
  store.saveTicket({ key: 'HD-LEGACY', requester: 'old@example.test', subject: 'Existing custom lifecycle', page_id: 0, page_url: '' });
  store.db.prepare("UPDATE tickets SET status='paused' WHERE key='HD-LEGACY'").run();
  const desk = new DeskStore(store), snapshot = desk.settings.snapshot();
  assert.equal(snapshot.version, 10);
  assert.deepEqual(desk.settings.get('statuses', 'paused-legacy-1'), { id: 'paused-legacy-1', name: 'Paused', kind: 'active', active: false, system: false });
  assert.equal(desk.getTicket('HD-LEGACY').status, 'paused-legacy-1');
  assert.equal(desk.listTickets().total, 1);
  assert.equal(desk.settings.get('statuses', 'open').name, 'Inbox');
  assert.deepEqual(desk.settings.get('statuses', 'paused'), { id: 'paused', name: 'Paused (scheduled)', kind: 'paused', active: true, system: true });
  assert.deepEqual(new DeskStore(store).settings.snapshot(), snapshot, 'Restart must not repeat migration or consume another settings version');
  assert.throws(() => desk.settings.update('statuses', 'paused', { active: false }, { version: snapshot.version }), error => error.statusCode === 400);
  assert.throws(() => desk.settings.create('statuses', { name: 'Another scheduled status', kind: 'paused' }, { version: snapshot.version }), error => error.statusCode === 400);
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='tickets_scheduled_pause'").get());
});

test('scheduling pauses an unresolved ticket while retaining its original SLA dates, tags, and location', t => {
  frozenClock(t); const h = fixture(t);
  let current = h.ticket();
  current = h.update(current, { location: 'New York office', priority: 'high' });
  current = h.desk.addTicketTag(current.key, 'scheduled maintenance', actor);
  const due = [current.response_due_at, current.resolution_due_at];
  const paused = h.update(current, { paused_until: '2035-05-02T09:30-04:00' });
  assert.equal(paused.status, 'paused'); assert.equal(paused.status_kind, 'paused');
  assert.equal(paused.paused_until, '2035-05-02T13:30:00.000Z');
  assert.equal(paused.version, current.version + 1); assert.equal(paused.resolution, '');
  assert.equal(paused.resolved_at, null); assert.equal(paused.location, 'New York office');
  assert.deepEqual(paused.tags, ['scheduled maintenance']);
  assert.deepEqual([paused.response_due_at, paused.resolution_due_at], due);
  assert.equal(paused.events.filter(event => event.type === 'pause').length, 1);
  assert.equal(paused.events.at(-1).actor_name, actor.name);
});

test('paused tickets disappear from default lists, activity and metrics but remain directly and explicitly accessible', t => {
  frozenClock(t); const h = fixture(t), paused = h.update(h.ticket(), { paused_until: '2035-05-02T12:00Z' });
  const active = h.ticket('HD-ACTIVE');
  h.desk.event(active.key, 'note', 'Visible activity', actor);
  assert.equal(h.desk.getTicket(paused.key).status, 'paused');
  assert.deepEqual(h.desk.listTickets().tickets.map(ticket => ticket.key), [active.key]);
  assert.equal(h.desk.listTickets({ search: paused.key }).total, 0);
  assert.equal(h.desk.listTickets({ view: 'paused' }).tickets[0].key, paused.key);
  for (const view of ['all', 'open', 'unassigned', 'overdue', 'resolved']) {
    assert.equal(h.desk.listTickets({ status: 'paused', view }).total, 1, `Explicit paused filter overrides ${view} lifecycle`);
  }
  assert.throws(() => h.desk.listTickets({ status: 'paused', view: 'invented' }), error => error.statusCode === 400);
  const dashboard = h.desk.dashboard();
  assert.equal(dashboard.counts.total, 1); assert.equal(dashboard.counts.active, 1);
  assert.equal(dashboard.counts.unassigned, 1); assert.equal(dashboard.counts.awaitingResponse, 1);
  assert.ok(dashboard.activity.every(event => event.ticket_key !== paused.key));
  assert.ok(dashboard.statusCounts.every(row => row.status !== 'paused'));
});

test('rescheduling replaces the previous deadline and automatic resumption happens once at the latest date', t => {
  frozenClock(t); const h = fixture(t);
  let current = h.update(h.ticket(), { paused_until: '2035-05-01T13:00Z' });
  current = h.update(current, { paused_until: '2035-05-01T15:00Z' });
  const version = current.version, due = [current.response_due_at, current.resolution_due_at];
  assert.equal(h.desk.resumeDueTickets('2035-05-01T13:00:00.000Z'), 0);
  assert.equal(h.desk.getTicket(current.key).status, 'paused');
  assert.equal(h.desk.resumeDueTickets('2035-05-01T15:00:00.000Z'), 1);
  current = h.desk.getTicket(current.key);
  assert.equal(current.status, 'in_progress'); assert.equal(current.paused_until, null);
  assert.equal(current.version, version + 1); assert.equal(current.updated_at, '2035-05-01T15:00:00.000Z');
  assert.deepEqual([current.response_due_at, current.resolution_due_at], due);
  assert.equal(h.desk.resumeDueTickets('2035-05-02T12:00:00.000Z'), 0);
  assert.equal(h.desk.getTicket(current.key).events.filter(event => /Scheduled pause ended/.test(event.body)).length, 1);
  assert.ok(h.desk.listTickets().tickets.some(ticket => ticket.key === current.key));
});

test('clearing a pause resumes immediately and manually changing lifecycle cannot be overwritten by an old deadline', t => {
  frozenClock(t); const h = fixture(t);
  let current = h.update(h.ticket(), { paused_until: '2035-05-02T12:00Z' });
  current = h.update(current, { paused_until: null });
  assert.equal(current.status, 'in_progress'); assert.equal(current.paused_until, null);
  current = h.update(current, { paused_until: '2035-05-02T12:00Z' });
  current = h.update(current, { status: 'resolved', resolution: 'Work completed ahead of schedule.' });
  assert.equal(current.paused_until, null); assert.equal(current.status, 'resolved');
  assert.equal(h.desk.resumeDueTickets('2035-05-03T00:00Z'), 0);
  assert.equal(h.desk.getTicket(current.key).status, 'resolved');
});

test('invalid schedule combinations and stale edits leave ticket fields and audit history unchanged', t => {
  frozenClock(t); const h = fixture(t), original = h.ticket();
  for (const patch of [{ paused_until: CLOCK }, { paused_until: '2035-02-30T13:00Z' }, { status: 'paused' },
    { paused_until: '2035-05-02T12:00Z', status: 'in_progress' }, { paused_until: null, status: 'paused' }]) {
    assert.throws(() => h.update(original, patch), error => error.statusCode === 400);
    assert.deepEqual(h.desk.getTicket(original.key), original);
  }
  const scheduled = h.update(original, { paused_until: '2035-05-02T12:00Z' });
  assert.throws(() => h.update(original, { paused_until: '2035-05-03T12:00Z', location: 'Stale location' }), error => error.statusCode === 409);
  assert.deepEqual(h.desk.getTicket(original.key), scheduled);
  assert.throws(() => h.update(scheduled, { status: 'closed' }), /transition/);
  assert.throws(() => h.update(scheduled, { status: 'resolved' }), /resolution summary/);
});

test('a due transition commits before a stale editor receives a version conflict', t => {
  frozenClock(t); const h = fixture(t);
  const scheduled = h.update(h.ticket(), { paused_until: '2035-05-01T12:01Z' });
  t.mock.timers.tick(60_000);
  assert.throws(() => h.update(scheduled, { subject: 'Stale subject' }), error => error.statusCode === 409);
  const resumed = h.desk.getTicket(scheduled.key);
  assert.equal(resumed.status, 'in_progress'); assert.equal(resumed.version, scheduled.version + 1);
  assert.equal(resumed.subject, scheduled.subject);
  assert.equal(resumed.events.filter(event => /Scheduled pause ended/.test(event.body)).length, 1);
});

test('manual intake captures its initial pause and requester email updates do not resume it early', t => {
  frozenClock(t); const h = fixture(t), initial = h.ticket();
  const message = { from: { address: 'requester@example.test', name: 'Requester' }, text: 'Please do this tomorrow.', receivedAt: CLOCK,
    desk: { actor, paused_until: '2035-05-02T12:00Z', location: 'London' } };
  let current = h.desk.captureEmail(initial.key, message, { receiptId: 'initial-manual', source: 'manual' });
  assert.equal(current.status, 'paused'); assert.equal(current.source, 'manual'); assert.equal(current.location, 'London');
  const version = current.version, until = current.paused_until;
  current = h.desk.captureEmail(initial.key, { ...message, text: 'Here is a detail for tomorrow.' }, { receiptId: 'requester-reply', isReply: true });
  assert.equal(current.status, 'paused'); assert.equal(current.paused_until, until);
  assert.equal(current.version, version + 1); assert.equal(current.notes.at(-1).kind, 'email');
  assert.equal(current.events.filter(event => /Reopened/.test(event.body)).length, 0);
  const same = h.desk.captureEmail(initial.key, message, { receiptId: 'requester-reply', isReply: true });
  assert.equal(same.version, current.version); assert.equal(same.notes.length, 1);
});

test('recovered intake whose valid schedule elapsed during downtime resumes rather than failing recovery', t => {
  frozenClock(t); const h = fixture(t), current = h.ticket();
  h.desk.captureEmail(current.key, { from: { address: 'requester@example.test' }, text: 'Accepted before downtime.', receivedAt: '2035-04-29T12:00Z',
    desk: { paused_until: '2035-04-30T12:00Z' } }, { receiptId: 'recovered-pause', source: 'manual', includeDetails: false });
  assert.equal(h.store.db.prepare('SELECT status FROM tickets WHERE key=?').get(current.key).status, 'paused');
  const scheduler = new TicketScheduler({ desk: h.desk }); t.after(() => scheduler.stop());
  scheduler.start();
  const resumed = h.desk.getTicket(current.key);
  assert.equal(resumed.status, 'in_progress'); assert.equal(resumed.paused_until, null);
  assert.equal(resumed.events.filter(event => /Scheduled pause ended/.test(event.body)).length, 1);
});

test('durable scheduled pauses survive restart and scheduler startup catches missed dates without duplicate timers or events', t => {
  frozenClock(t);
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-pause-')), filename = join(directory, 'desk.sqlite');
  let store = new Store(filename), scheduler;
  t.after(() => { scheduler?.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  let desk = new DeskStore(store);
  store.saveTicket({ key: 'HD-RESTART', requester: 'requester@example.test', subject: 'Durable schedule', page_id: 0, page_url: '' });
  const initial = desk.getTicket('HD-RESTART');
  const paused = desk.updateTicket(initial.key, { paused_until: '2035-05-01T13:00Z' }, { version: initial.version, actor });
  store.close(); t.mock.timers.tick(3_600_000);
  store = new Store(filename); desk = new DeskStore(store);
  assert.equal(store.db.prepare('SELECT status FROM tickets WHERE key=?').get(initial.key).status, 'paused');
  scheduler = new TicketScheduler({ desk, intervalMs: 20 }); scheduler.start();
  const timer = scheduler.timer; scheduler.start(); assert.equal(scheduler.timer, timer);
  const resumed = desk.getTicket(initial.key);
  assert.equal(resumed.status, 'in_progress'); assert.equal(resumed.version, paused.version + 1);
  assert.equal(resumed.events.filter(event => /Scheduled pause ended/.test(event.body)).length, 1);
  scheduler.stop(); assert.equal(scheduler.timer, null);
  assert.equal(scheduler.tick(), 0);
});

test('scheduler retries failed scans while logging only a fixed operational message', () => {
  let calls = 0; const errors = [];
  const scheduler = new TicketScheduler({ desk: { resumeDueTickets() { if (++calls === 1) throw new Error('Private database path'); return 1; } }, logger: { error: message => errors.push(message) } });
  assert.equal(scheduler.tick(), 0); assert.equal(scheduler.tick(), 1);
  assert.equal(errors.length, 1); assert.ok(!errors[0].includes('Private'));
});
