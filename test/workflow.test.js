import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, receiptId } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { createApp } from '../src/app.js';
import { parseRawEmail } from '../src/email.js';
import { configFromEnv } from '../src/config.js';

function makeBookStack() {
  let nextId = 1;
  return {
    assets: new Map(), tickets: new Map(), replies: new Map(), links: new Map(),
    workspaceCalls: 0,
    async ensureWorkspace() { this.workspaceCalls++; return { assetBook: { id: 10 }, openChapter: { id: 11 } }; },
    async checkHealth() {},
    async ensureAsset(ref) {
      if (!this.assets.has(ref)) this.assets.set(ref, { id: nextId++, url: `https://wiki.example/link/${nextId - 1}`, ref });
      return this.assets.get(ref);
    },
    async ensureTicket(ticket) {
      if (!this.tickets.has(ticket.key)) this.tickets.set(ticket.key, { ...ticket, id: nextId++, url: `https://wiki.example/link/${nextId - 1}` });
      return this.tickets.get(ticket.key);
    },
    async appendReply(ticket, reply) {
      if (!this.replies.has(reply.id)) this.replies.set(reply.id, { ...reply, ticketId: ticket.id });
    },
    async linkTicketToAsset(asset, ticket) { this.links.set(`${asset.id}:${ticket.id}`, { asset, ticket }); },
  };
}

const logger = { error() {} };
const config = {
  inboundToken: 'intake-token-for-tests-123456789012345',
  adminToken: 'admin-token-for-tests-1234567890123456',
};
const rawEmail = ({ id = 'first', from = 'requester@example.com', text = 'My PC-123 is broken.', replyTo = '' } = {}) =>
  `From: ${from}\r\nSubject: Help with PC-123\r\nMessage-ID: <${id}@example.com>\r\n${replyTo ? `In-Reply-To: <${replyTo}@example.com>\r\n` : ''}\r\n${text}`;

async function harness(t, { filename = ':memory:', supportEmails = [] } = {}) {
  const store = new Store(filename);
  const bookstack = makeBookStack();
  const worker = new Worker({ store, bookstack, supportEmails, logger });
  const server = createApp({ store, worker, bookstack, config }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await worker.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  async function request(path, { method = 'GET', token = config.adminToken, headers = {}, body } = {}) {
    const response = await fetch(`${url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function inbound(input) {
    const response = await request('/api/inbound/email', {
      method: 'POST', token: config.inboundToken,
      headers: { 'content-type': 'message/rfc822' }, body: rawEmail(input),
    });
    await worker.active;
    return response;
  }
  return { store, bookstack, worker, request, inbound };
}

test('HTTP intake creates a ticket and assets, reuses existing assets, and deduplicates delivery', async t => {
  const { store, bookstack, inbound, request } = await harness(t);
  const first = await inbound({ text: 'PC-123 and LAPTOP-22 are not working.' });
  assert.equal(first.status, 202);
  assert.equal(store.receipt(first.body.id).state, 'done');
  assert.deepEqual([...bookstack.assets.keys()], ['PC-123', 'LAPTOP-22']);
  assert.equal(bookstack.tickets.size, 1);
  assert.equal(bookstack.links.size, 2);
  const ticket = [...bookstack.tickets.values()][0];
  assert.equal(ticket.requester.address, 'requester@example.com');
  assert.deepEqual(ticket.assets.map(asset => asset.ref), ['PC-123', 'LAPTOP-22']);

  const duplicate = await inbound({ text: 'PC-123 and LAPTOP-22 are not working.' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.id, first.body.id);
  assert.equal(bookstack.tickets.size, 1);
  const second = await inbound({ id: 'another', text: 'PC-123 still has issues.' });
  assert.equal(second.status, 202);
  assert.equal(bookstack.assets.size, 2);
  assert.equal(bookstack.tickets.size, 2);
  assert.equal(bookstack.links.size, 3);

  const receipt = await request(first.body.statusUrl);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.ticket.page_id, ticket.id);
  assert.equal((await request(`/api/tickets/${ticket.key}`)).body.page_id, ticket.id);
  assert.equal((await request('/api/queue')).body.counts[0].count, 2);
});

test('reply threading accepts the original requester and configured support, while other senders get separate tickets', async t => {
  const { bookstack, store, inbound } = await harness(t, { supportEmails: ['technician@example.com'] });
  const original = await inbound({});
  const originalKey = store.receipt(original.body.id).ticketKey;
  const requesterReply = await inbound({ id: 'requester-reply', replyTo: 'first', text: 'Also check ASSET-25.' });
  assert.equal(store.receipt(requesterReply.body.id).ticketKey, originalKey);
  assert.equal(bookstack.tickets.size, 1);
  assert.equal(bookstack.replies.size, 1);
  assert.ok(bookstack.assets.has('ASSET-25'));
  assert.equal(bookstack.links.size, 2);

  const supportReply = await inbound({ id: 'support-reply', from: 'technician@example.com', replyTo: 'requester-reply', text: 'I am investigating.' });
  assert.equal(store.receipt(supportReply.body.id).ticketKey, originalKey);
  assert.equal(bookstack.replies.size, 2);
  const stranger = await inbound({ id: 'stranger', from: 'other@example.com', replyTo: 'first', text: 'My separate issue.' });
  assert.notEqual(store.receipt(stranger.body.id).ticketKey, originalKey);
  assert.equal(bookstack.tickets.size, 2);
  assert.equal(bookstack.replies.size, 2);
});

test('API enforces separate intake and admin authorization and rejects malformed requests', async t => {
  const { request, store } = await harness(t);
  assert.equal((await request('/healthz', { token: null })).status, 200);
  assert.equal((await request('/api/queue', { token: null })).status, 401);
  assert.equal((await request('/api/queue', { token: config.inboundToken })).status, 401);
  assert.equal((await request('/api/inbound/email', { method: 'POST', body: rawEmail() })).status, 401);
  assert.equal((await request('/api/inbound/email', { method: 'POST', token: config.inboundToken, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 415);
  assert.equal((await request('/api/inbound/email', { method: 'POST', token: config.inboundToken, headers: { 'content-type': 'message/rfc822' }, body: 'Subject: Missing sender\r\n\r\nHelp' })).status, 400);
  for (const body of ['{invalid', '{}', JSON.stringify({ subject: 'Header\r\nInjection: test', from: 'a@example.com', text: 'Help' }), JSON.stringify({ subject: 'Help', from: 'not-an-email', text: 'Help' })]) {
    assert.equal((await request('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400);
  }
  assert.equal((await request('/api/receipts/nonexistent')).status, 404);
  assert.equal((await request('/api/tickets/nonexistent')).status, 404);
  assert.equal((await request('/api/receipts/nonexistent/retry', { method: 'POST' })).status, 409);
  assert.deepEqual(store.counts(), []);
});

test('manual tickets support Unicode and preserve text without header injection', async t => {
  const { request, worker, bookstack } = await harness(t);
  const response = await request('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'Écran cassé', from: 'Alice <alice@example.com>', text: 'Échec\n<script>alert(1)</script>\nASSET-44' }) });
  assert.equal(response.status, 202);
  await worker.active;
  const ticket = [...bookstack.tickets.values()][0];
  assert.equal(ticket.subject, 'Écran cassé');
  assert.equal(ticket.text, 'Échec\n<script>alert(1)</script>\nASSET-44');
  assert.deepEqual(ticket.assets.map(asset => asset.ref), ['ASSET-44']);
});

test('readiness reflects BookStack failure without exposing upstream credentials or details', async t => {
  const { bookstack, request } = await harness(t);
  assert.equal((await request('/readyz', { token: null })).status, 200);
  assert.equal(bookstack.workspaceCalls, 0, 'readiness does not create books, shelves, or chapters');
  bookstack.checkHealth = async () => { throw new Error('https://secret-token@internal.example/private'); };
  const response = await request('/readyz', { token: null });
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(response.body), /secret-token|internal\.example/);
});

test('accepted messages and processing claims recover after a restart; retrying a partial ticket does not duplicate it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-workflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'queue.sqlite');
  let store = new Store(filename);
  const message = await parseRawEmail(rawEmail());
  const receipt = store.accept(message);
  assert.equal(store.next().id, receipt.id);
  store.close();
  store = new Store(filename);
  assert.equal(store.receipt(receipt.id).state, 'pending');
  const bookstack = makeBookStack();
  const worker = new Worker({ store, bookstack, logger });
  const originalLink = bookstack.linkTicketToAsset.bind(bookstack);
  let failOnce = true;
  bookstack.linkTicketToAsset = async (...args) => {
    await originalLink(...args);
    if (failOnce) { failOnce = false; throw new Error('Response lost after BookStack persisted the link'); }
  };
  await worker.wake();
  assert.equal(store.receipt(receipt.id).state, 'pending');
  assert.equal(bookstack.tickets.size, 1);
  assert.equal(bookstack.links.size, 1);
  assert.equal(store.next(), null, 'retry waits for its backoff deadline');
  const row = store.next(Date.now() + 1_000_000);
  assert.equal(row.attempts, 3, 'attempt count includes the interrupted claim');
  await worker.process(row);
  assert.equal(store.receipt(receipt.id).state, 'done');
  assert.equal(bookstack.tickets.size, 1);
  assert.equal(bookstack.links.size, 1);
  assert.equal(store.accept(message).duplicate, true);
  await worker.stop();
  store.close();
});

test('retry after a persisted reply and a lost API response does not append the reply twice', async () => {
  const store = new Store(':memory:');
  const bookstack = makeBookStack();
  const worker = new Worker({ store, bookstack, logger });
  try {
    const original = store.accept(await parseRawEmail(rawEmail()));
    await worker.wake();
    const reply = store.accept(await parseRawEmail(rawEmail({ id: 'retry-reply', replyTo: 'first', text: 'Please check PC-123 again.' })));
    const originalAppend = bookstack.appendReply.bind(bookstack);
    let failOnce = true;
    bookstack.appendReply = async (...args) => {
      await originalAppend(...args);
      if (failOnce) { failOnce = false; throw new Error('Reply persisted, but response was lost'); }
    };
    await worker.wake();
    assert.equal(store.receipt(reply.id).state, 'pending');
    assert.equal(bookstack.replies.size, 1);
    await worker.process(store.next(Date.now() + 1_000_000));
    assert.equal(store.receipt(reply.id).state, 'done');
    assert.equal(store.receipt(reply.id).ticketKey, store.receipt(original.id).ticketKey);
    assert.equal(bookstack.replies.size, 1);
    assert.equal(bookstack.tickets.size, 1);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('messages accepted in the same millisecond retain insertion order', async () => {
  const store = new Store(':memory:');
  try {
    // Select IDs whose lexical order opposes arrival order, so a hash tie-breaker
    // cannot accidentally pass as FIFO.
    const messages = await Promise.all(Array.from({ length: 4 }, (_, index) => parseRawEmail(rawEmail({ id: `fifo-${index}` }))));
    const receipts = messages.map(message => ({ message, id: receiptId(message) }));
    receipts.sort((a, b) => b.id.localeCompare(a.id));
    const accepted = receipts.map(({ message }) => store.accept(message));
    store.db.prepare('UPDATE messages SET created_at=?').run('2026-10-29T12:00:00.000Z');
    assert.deepEqual(accepted.map(() => store.next().id), accepted.map(receipt => receipt.id));
  } finally { store.close(); }
});

test('reply waits for a referenced ticket whose first processing attempt is still retrying', async () => {
  const store = new Store(':memory:');
  const bookstack = makeBookStack();
  const worker = new Worker({ store, bookstack, logger });
  try {
    const original = store.accept(await parseRawEmail(rawEmail()));
    const originalLink = bookstack.linkTicketToAsset.bind(bookstack);
    let failOnce = true;
    bookstack.linkTicketToAsset = async (...args) => {
      if (failOnce) { failOnce = false; throw new Error('Backlink failed'); }
      await originalLink(...args);
    };
    await worker.wake();
    assert.equal(store.receipt(original.id).state, 'pending');
    const reply = store.accept(await parseRawEmail(rawEmail({ id: 'reply-during-retry', replyTo: 'first', text: 'Any update?' })));
    await worker.wake();
    assert.equal(store.receipt(reply.id).state, 'pending', 'reply is deferred until the parent ticket is processed');
    assert.equal(bookstack.tickets.size, 1, 'deferred reply must not create a second ticket');
    assert.equal(bookstack.replies.size, 0);
    await worker.process(store.next(Date.now() + 1_000_000));
    assert.equal(store.receipt(original.id).state, 'done');
    await worker.process(store.next(Date.now() + 1_000_000));
    assert.equal(store.receipt(reply.id).state, 'done');
    assert.equal(store.receipt(reply.id).ticketKey, store.receipt(original.id).ticketKey);
    assert.equal(bookstack.tickets.size, 1);
    assert.equal(bookstack.replies.size, 1);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('failed messages become retryable after eight attempts and operational errors do not leak raw failures', async () => {
  const store = new Store(':memory:');
  try {
    const receipt = store.accept(await parseRawEmail(rawEmail()));
    for (let attempt = 1; attempt <= 8; attempt++) {
      const row = store.next(Date.now() + 10_000_000);
      assert.equal(row.attempts, attempt);
      store.fail(row, new Error('Secret token: do-not-leak'));
    }
    assert.equal(store.receipt(receipt.id).state, 'failed');
    assert.doesNotMatch(store.receipt(receipt.id).error, /do-not-leak/);
    assert.equal(store.retry(receipt.id), true);
    assert.equal(store.receipt(receipt.id).attempts, 0);
    assert.equal(store.retry(receipt.id), false);
    const worker = new Worker({ store, bookstack: makeBookStack(), logger });
    await worker.wake();
    assert.equal(store.receipt(receipt.id).state, 'done');
    await worker.stop();
  } finally { store.close(); }
});

test('configuration validates credentials, URL schemes and service port', () => {
  const env = { BOOKSTACK_URL: 'https://wiki.example', BOOKSTACK_TOKEN_ID: 'id', BOOKSTACK_TOKEN_SECRET: 'secret', INBOUND_EMAIL_TOKEN: 'i'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32) };
  assert.equal(configFromEnv(env).port, 3000);
  for (const override of [{ ADMIN_TOKEN: '' }, { ADMIN_TOKEN: 'short' }, { ADMIN_TOKEN: env.INBOUND_EMAIL_TOKEN }, { BOOKSTACK_URL: 'file:///etc/passwd' }, { BOOKSTACK_URL: 'https://token@wiki.example' }, { BOOKSTACK_URL: 'https://wiki.example/?token=secret' }, { PORT: '0' }, { PORT: '3000.5' }]) {
    assert.throws(() => configFromEnv({ ...env, ...override }));
  }
});
