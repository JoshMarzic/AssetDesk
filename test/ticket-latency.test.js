import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { Worker } from '../src/worker.js';

const config = { inboundToken: 'latency-intake-test-token-123456789', adminToken: 'latency-admin-test-token-1234567890', bookstack: { url: 'https://wiki.example.test', publicUrl: 'https://wiki.example.test' } };
const logger = { error() {} };
function message(id = 'original', overrides = {}) {
  return { messageId: `<${id}@example.test>`, from: { name: 'Taylor Example', address: 'taylor@example.test' },
    subject: 'PC-12 will not boot', text: 'My PC-12 will not boot.', assetRefs: ['PC-12'],
    receivedAt: '2026-11-01T10:00:00.000Z', references: [], inReplyTo: null, ...overrides };
}
function remote() {
  let sequence = 10;
  return {
    tickets: new Map(), assets: new Map(), replies: new Map(), links: new Set(), metadata: new Map(),
    workspaceCalls: 0, assetCalls: 0,
    async ensureWorkspace() { this.workspaceCalls++; return { ticketBook: { id: 1 }, assetBook: { id: 2 }, openChapter: { id: 3 } }; },
    async checkHealth() {},
    async ensureTicket(input) {
      if (!this.tickets.has(input.key)) this.tickets.set(input.key, { ...input, id: sequence++, url: `https://wiki.example.test/link/${sequence - 1}` });
      return this.tickets.get(input.key);
    },
    async ensureAsset(ref) {
      this.assetCalls++;
      if (!this.assets.has(ref)) this.assets.set(ref, { id: sequence++, ref, url: `https://wiki.example.test/link/${sequence - 1}` });
      return this.assets.get(ref);
    },
    async findAsset(ref) { return this.assets.get(ref) || null; },
    async linkTicketToAsset(asset, ticket) { this.links.add(`${asset.id}:${ticket.id}`); },
    async linkAssetToTicket(ticket, asset) { this.links.add(`${asset.id}:${ticket.id}`); },
    async appendReply(ticket, reply) { this.replies.set(reply.id, { ...reply, ticketId: ticket.id }); },
    async syncTicketMetadata(ticket) { assert.ok(ticket.page_id > 0); this.metadata.set(ticket.key, { ...ticket }); },
  };
}
function fixture(t, options = {}) {
  const store = new Store(options.filename || ':memory:');
  const desk = new DeskStore(store);
  const bookstack = options.bookstack || remote();
  const worker = new Worker({ store, desk, bookstack, supportEmails: ['support@example.test'], logger });
  t.after(async () => { await worker.stop(); store.close(); });
  return { store, desk, worker, bookstack };
}

test('a durable ticket exists before any BookStack request and remains editable during an outage', async t => {
  const h = fixture(t);
  h.bookstack.ensureWorkspace = async () => { throw new Error('Remote service is offline'); };
  const receipt = h.worker.accept(message());
  assert.equal(h.bookstack.workspaceCalls, 0);
  const initial = h.desk.getTicket(receipt.ticketKey);
  assert.equal(initial.page_id, 0);
  assert.equal(initial.page_url, '');
  assert.equal(initial.description, 'My PC-12 will not boot.');
  assert.equal(initial.created_at, message().receivedAt);
  assert.equal(initial.sync.pending, true);
  assert.equal(receipt.state, 'pending');
  await h.worker.wake();
  assert.equal(h.store.receipt(receipt.id).state, 'pending');
  const current = h.desk.getTicket(receipt.ticketKey);
  assert.equal(current.sync.pending, true);
  assert.match(current.sync.error, /Processing failed/);
  const updated = h.desk.updateTicket(current.key, { priority: 'urgent', status: 'in_progress' }, { version: current.version });
  assert.equal(updated.priority, 'urgent');
  assert.equal(updated.status, 'in_progress');
});

test('HTTP ticket creation responds while BookStack is blocked, with the ticket already durably queryable', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-fast-'));
  const store = new Store(join(directory, 'desk.sqlite'));
  const desk = new DeskStore(store);
  await desk.ensureAdmin({ name: 'Desk Admin', email: 'admin@example.test', password: 'latency-test-password-123' });
  const bookstack = remote();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  bookstack.ensureWorkspace = async () => { bookstack.workspaceCalls++; await gate; return { assetBook: { id: 2 }, openChapter: { id: 3 } }; };
  const worker = new Worker({ store, desk, bookstack, logger });
  const {createApp} = await import('../src/app.js');
  const server = createApp({ store, desk, worker, bookstack, config }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { release(); await worker.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/desk/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password: 'latency-test-password-123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  const start = performance.now();
  const response = await fetch(`${base}/api/desk/tickets`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ subject: 'A fast local ticket', requester: 'taylor@example.test', description: 'Wiki outages must not block work.', priority: 'high', category: 'software' }) });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  t.diagnostic(`Durable HTTP acceptance took ${(performance.now() - start).toFixed(1)} ms while BookStack was deliberately blocked.`);
  assert.ok(accepted.ticketKey);
  assert.equal(desk.getTicket(accepted.ticketKey).subject, 'A fast local ticket');
  assert.equal(desk.getTicket(accepted.ticketKey).page_id, 0);
  const view = await fetch(`${base}/api/desk/tickets/${accepted.ticketKey}`, { headers: { cookie } });
  assert.equal(view.status, 200);
  assert.equal((await view.json()).priority, 'high');
  assert.equal(bookstack.tickets.size, 0);
  release(); await worker.active;
  assert.ok(desk.getTicket(accepted.ticketKey).page_id > 0);
});

test('local receipt binding threads replies during a wiki outage without duplicate notes or lost triage', async t => {
  const h = fixture(t);
  const first = h.worker.accept(message());
  let ticket = h.desk.getTicket(first.ticketKey);
  ticket = h.desk.updateTicket(ticket.key, { priority: 'urgent', status: 'resolved', resolution: 'Fixed before wiki recovered.' }, { version: ticket.version });
  const reply = h.worker.accept(message('reply', { inReplyTo: message().messageId, text: 'The issue returned.', assetRefs: [] }));
  assert.equal(reply.ticketKey, first.ticketKey);
  ticket = h.desk.getTicket(first.ticketKey);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.priority, 'urgent');
  assert.equal(ticket.notes.length, 1);
  const duplicate = h.worker.accept(message('reply', { inReplyTo: message().messageId, text: 'Changed duplicate content must be ignored.' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.desk.getTicket(first.ticketKey).notes.length, 1);
  assert.equal(h.desk.getTicket(first.ticketKey).notes[0].body, 'The issue returned.');
  assert.equal(h.desk.listTickets().total, 1);
  await h.worker.wake();
  assert.equal(h.bookstack.tickets.size, 1);
  assert.equal(h.bookstack.replies.size, 1);
  assert.equal(h.bookstack.metadata.get(first.ticketKey).priority, 'urgent');
  assert.equal(h.store.receipt(reply.id).state, 'done');
});

test('a reply can bind an accepted pre-upgrade parent before that parent has a local ticket', t => {
  const h = fixture(t);
  const parent = h.store.accept(message());
  assert.equal(parent.ticketKey, null);
  const reply = h.worker.accept(message('upgrade-reply', { inReplyTo: message().messageId, text: 'Any update?', assetRefs: [] }));
  assert.equal(reply.ticketKey, h.store.receipt(parent.id).ticketKey);
  assert.equal(h.desk.listTickets().total, 1);
  assert.equal(h.desk.getTicket(reply.ticketKey).notes.length, 1);
  assert.equal(h.bookstack.workspaceCalls, 0);
});

test('persisted local tickets and pending mirror work recover after an interrupted process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-pending-'));
  const filename = join(directory, 'desk.sqlite');
  let store = new Store(filename), desk = new DeskStore(store);
  const firstWorker = new Worker({ store, desk, bookstack: remote(), logger });
  const receipt = firstWorker.accept(message());
  const before = desk.getTicket(receipt.ticketKey);
  assert.equal(store.next().id, receipt.id);
  store.close();
  store = new Store(filename); desk = new DeskStore(store);
  const bookstack = remote(), worker = new Worker({ store, desk, bookstack, logger });
  t.after(async () => { await worker.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(desk.getTicket(receipt.ticketKey).description, before.description);
  assert.equal(store.receipt(receipt.id).state, 'pending');
  await worker.wake();
  assert.equal(store.receipt(receipt.id).state, 'done');
  assert.equal(desk.getTicket(receipt.ticketKey).events.filter(event => event.type === 'created').length, 1);
  assert.equal(bookstack.tickets.size, 1);
  assert.ok(desk.getTicket(receipt.ticketKey).page_id > 0);
});

test('auxiliary wiki queues wait for a valid remote page and then process normally', async t => {
  const h = fixture(t);
  const receipt = h.worker.accept(message());
  h.desk.queueAssetLink(receipt.ticketKey, 'MONITOR-20', { name: 'Desk Admin' });
  assert.deepEqual(h.desk.pendingAssetLinks(), []);
  assert.deepEqual(h.desk.pendingAssetRecovery(), []);
  assert.deepEqual(h.desk.pendingSync(), []);
  await h.worker.wake();
  const ticket = h.desk.getTicket(receipt.ticketKey);
  assert.ok(ticket.assets.some(asset => asset.ref === 'MONITOR-20'));
  assert.equal(ticket.pending_asset_links.length, 0);
  assert.equal(ticket.sync.pending, false);
  assert.ok(h.bookstack.metadata.get(receipt.ticketKey).page_id > 0);
});

test('duplicate acceptance uses the original durable body rather than replacing it with redelivered content', t => {
  const h = fixture(t);
  const first = h.worker.accept(message());
  const duplicate = h.worker.accept(message('original', { subject: 'Replacement', text: 'Replacement' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ticketKey, first.ticketKey);
  assert.equal(h.desk.getTicket(first.ticketKey).subject, message().subject);
  assert.equal(h.desk.getTicket(first.ticketKey).description, message().text);
});

test('failed local validation rolls back acceptance and ticket creation as one durable transaction', t => {
  const h = fixture(t);
  assert.throws(() => h.worker.accept(message('invalid', { desk: { priority: 'invalid' } })), /priority or category/);
  assert.equal(h.desk.listTickets().total, 0);
  assert.deepEqual(h.store.counts(), []);
  assert.equal(h.worker.accept(message('invalid')).duplicate, false);
});

test('asset resolution is bounded, preserves input order, and reuses IDs for subsequent tickets', async t => {
  const h = fixture(t);
  let active = 0, maximum = 0, releases = [];
  const original = h.bookstack.ensureAsset.bind(h.bookstack);
  h.bookstack.ensureAsset = async ref => {
    active++; maximum = Math.max(maximum, active);
    if (releases.length < 3) await new Promise(resolve => releases.push(resolve));
    const asset = await original(ref); active--; return asset;
  };
  const refs = ['PC-1', 'PC-2', 'PC-3', 'PC-4', 'PC-5'];
  const first = h.worker.accept(message('many-assets', { assetRefs: refs }));
  const draining = h.worker.wake();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 3);
  assert.equal(maximum, 3);
  assert.equal(h.desk.getTicket(first.ticketKey).page_id, 0);
  for (const release of releases) release();
  await draining;
  assert.deepEqual(h.bookstack.tickets.get(first.ticketKey).assets.map(asset => asset.ref), refs);
  assert.equal(h.bookstack.assetCalls, 5);
  h.worker.accept(message('cached-asset', { assetRefs: ['PC-1'] }));
  await h.worker.wake();
  assert.equal(h.bookstack.assetCalls, 5);
  assert.ok(maximum <= 3);
});


test('startup restores every queued local ticket while the wiki is blocked, including more than one recovery batch', { timeout: 10000 }, async t => {
  const store=new Store(':memory:'), desk=new DeskStore(store), bookstack=remote();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  bookstack.ensureWorkspace=async()=>{await gate;return {assetBook:{id:2},openChapter:{id:3}};};
  const worker=new Worker({store,desk,bookstack,logger});
  t.after(async()=>{release();await worker.stop();store.close();});
  const accepted=Array.from({length:205},(_,index)=>store.accept(message(`legacy-${index}`,{assetRefs:[]})));
  worker.start();
  await worker.localRecovery;
  assert.equal(desk.listTickets().total,205);
  assert.ok(accepted.every(receipt=>store.receipt(receipt.id).ticketKey));
  assert.equal(bookstack.tickets.size,0);
});
