import test from 'node:test';
import assert from 'node:assert/strict';
import { BookStackClient, escapeHtml } from '../src/bookstack.js';

function api(handler) {
  const calls = [];
  const client = new BookStackClient({ url: 'http://bookstack', publicUrl: 'https://wiki.example.test', tokenId: 'id', tokenSecret: 'secret', fetchImpl: async (url, options) => {
    const call = { url: new URL(url), method: options.method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers };
    calls.push(call);
    const result = await handler(call);
    return new Response(JSON.stringify(result), { status: 200 });
  } });
  return { client, calls };
}

test('lists all pages using offsets and sends BookStack token authentication', async () => {
  const { client, calls } = api(({ url }) => ({ data: [{ id: Number(url.searchParams.get('offset')) + 1 }], total: url.searchParams.get('offset') === '0' ? 2 : 2 }));
  const result = await client.list('/books');
  assert.equal(result.length, 2);
  assert.equal(calls[1].url.searchParams.get('offset'), '100');
  assert.equal(calls[0].headers.Authorization, 'Token id:secret');
});

test('search pagination uses page numbers, validates tags, and returns stable public links', async () => {
  const { client, calls } = api(({ url }) => {
    if (url.pathname === '/api/pages/12') return { id: 12, name: 'Friendly laptop', tags: [{ name: 'Asset ID', value: 'laptop-001' }] };
    assert.equal(url.searchParams.get('query'), '[Asset ID=LAPTOP-001] {type:page}');
    return { data: [{ id: 12, type: 'page', name: 'Friendly laptop', tags: [{ name: 'Asset ID', value: 'laptop-001' }] }], total: 1 };
  });
  const page = await client.findAsset('LAPTOP-001');
  assert.equal(page.url, 'https://wiki.example.test/link/12');
  assert.equal(calls[0].url.searchParams.get('page'), '1');
});

test('existing exact-title assets receive a stable tag without changing content', async () => {
  const { client, calls } = api(({ url, method, body }) => {
    if (url.pathname === '/api/search') return url.searchParams.get('query').startsWith('[Asset') ? { data: [], total: 0 } : { data: [{ id: 3, name: 'LAPTOP-001', type: 'page' }], total: 1 };
    if (method === 'GET') return { id: 3, raw_html: '<p>Owner: Jill</p>', tags: [{ name: 'Location', value: 'Boston' }] };
    return { id: 3, ...body };
  });
  await client.findAsset('LAPTOP-001');
  const update = calls.find(c => c.method === 'PUT');
  assert.deepEqual(Object.keys(update.body), ['tags']);
  assert.equal(update.body.tags[0].value, 'Boston');
  assert.equal(update.body.tags[1].value, 'LAPTOP-001');
});

test('duplicates are reported rather than silently choosing the wrong asset', async () => {
  const { client } = api(() => ({ data: [1, 2].map(id => ({ id, type: 'page', tags: [{ name: 'Asset ID', value: 'PC-42' }] })), total: 2 }));
  await assert.rejects(client.findAsset('PC-42'), error => /Multiple BookStack pages.*Asset ID/.test(error.safeMessage));
});

test('ticket creation escapes email content and links its assets', async () => {
  const { client, calls } = api(({ method, body }) => method === 'POST' ? { id: 5, ...body } : { data: [], total: 0 });
  await client.ensureTicket({ key: 'HD-123', subject: '<img src=x>', requester: { name: 'Alice', address: 'alice@example.test' }, text: '<script>steal()</script>', assets: [{ ref: 'PC-42', id: 9 }], receivedAt: '2026-10-29T12:00:00Z' }, { openChapter: { id: 1 } });
  const payload = calls.find(c => c.method === 'POST').body;
  assert.equal(payload.chapter_id, 1);
  assert.match(payload.html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(payload.html, /<script>/);
  assert.match(payload.html, /href="https:\/\/wiki.example.test\/link\/9"/);
  assert.ok(payload.tags.some(t => t.name === 'Ticket ID' && t.value === 'HD-123'));
  assert.ok(payload.tags.some(t => t.name === 'Affected asset' && t.value === 'PC-42'));
});

test('new assets include editable ownership, equipment, lifecycle and related-ticket sections', async () => {
  const { client, calls } = api(({ method, body }) => method === 'POST' ? { id: 3, ...body } : { data: [], total: 0 });
  await client.ensureAsset('PC-42', { assetBook: { id: 2 } });
  const payload = calls.find(c => c.method === 'POST').body;
  assert.equal(payload.book_id, 2);
  for (const expected of ['Owner / assigned user', 'Serial number', 'Warranty expiry', 'Related tickets']) assert.ok(payload.html.includes(expected));
});

test('asset backlinks preserve user content and are idempotent', async () => {
  let page = { id: 3, raw_html: '<p>Owner: Jill &amp; Mark</p>' };
  const { client, calls } = api(({ method, body }) => method === 'GET' ? page : (page = { ...page, raw_html: body.html }));
  const ticket = { key: 'HD-123', id: 5, subject: 'Screen broken' };
  await client.linkTicketToAsset(page, ticket);
  await client.linkTicketToAsset(page, ticket);
  assert.match(page.raw_html, /^<p>Owner: Jill &amp; Mark<\/p>/);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

test('email replies preserve markdown and do not duplicate when delivery is retried', async () => {
  let page = { id: 3, raw_html: '<p>Work performed</p>', markdown: '# Work performed', editor: 'markdown' };
  const { client, calls } = api(({ method, body }) => method === 'GET' ? page : (page = { ...page, markdown: body.markdown }));
  const reply = { id: '<message@example.test>', from: { address: 'alice@example.test' }, text: '<b>Thanks</b>', receivedAt: '2026-10-29T12:00:00Z' };
  await client.appendReply(page, reply);
  await client.appendReply(page, reply);
  assert.match(page.markdown, /^# Work performed/);
  assert.match(page.markdown, /&lt;b&gt;Thanks&lt;\/b&gt;/);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});

test('API failures expose status without credentials or untrusted response body', async () => {
  const client = new BookStackClient({ url: 'http://bookstack', tokenId: 'secret-id', tokenSecret: 'secret-token', fetchImpl: async () => new Response('secret-token', { status: 403 }) });
  await assert.rejects(client.list('/pages'), error => error.status === 403 && error.safeMessage.includes('HTTP 403') && error.safeMessage.includes('lacks permission') && !error.safeMessage.includes('secret-token'));
});

test('connection errors supply a safe diagnostic without underlying fetch details', async () => {
  const client = new BookStackClient({ url: 'http://private-wiki.example.test', tokenId: 'secret-id', tokenSecret: 'secret-token', fetchImpl: async () => { throw new Error('private-wiki.example.test secret-token connection failure'); } });
  await assert.rejects(client.list('/pages'), error => /connection failed/.test(error.safeMessage) && !error.safeMessage.includes('private-wiki') && !error.safeMessage.includes('secret-token'));
});

test('invalid JSON responses provide a safe diagnostic rather than parser details', async () => {
  const client = new BookStackClient({ url: 'http://bookstack', tokenId: 'id', tokenSecret: 'secret', fetchImpl: async () => new Response('private-upstream-details') });
  await assert.rejects(client.list('/pages'), error => /invalid JSON/.test(error.safeMessage) && !error.safeMessage.includes('private-upstream-details'));
});

test('workspace bootstrap adds the help desk books without removing other shelf books', async () => {
  const { client, calls } = api(({ url, method, body }) => {
    if (url.pathname === '/api/books') return { data: [{ id: 2, name: 'Tickets' }, { id: 3, name: 'Assets' }], total: 2 };
    if (url.pathname === '/api/shelves') return { data: [{ id: 1, name: 'IT Help Desk' }], total: 1 };
    if (url.pathname === '/api/shelves/1') return method === 'GET' ? { id: 1, books: [{ id: 8 }] } : { id: 1, ...body };
    if (url.pathname === '/api/chapters') return method === 'GET' ? { data: [], total: 0 } : { id: calls.length, ...body };
    throw new Error('Unexpected request');
  });
  const workspace = await client.ensureWorkspace();
  assert.equal(workspace.openChapter.name, 'Open');
  assert.ok(workspace.chapters.Resolved);
  assert.deepEqual(calls.find(c => c.method === 'PUT').body.books, [8, 2, 3]);
});

test('HTML escaping covers text and attribute delimiters', () => {
  assert.equal(escapeHtml('<a "x" & \'y\'>'), '&lt;a &quot;x&quot; &amp; &#39;y&#39;&gt;');
});

test('health checks make fresh book requests after workspace setup is cached', async () => {
  const { client, calls } = api(({ url }) => {
    if (url.pathname === '/api/books/2') return { id: 2 };
    if (url.pathname === '/api/books/3') return { id: 3 };
    throw new Error('Unexpected request');
  });
  client.workspacePromise = Promise.resolve({ ticketBook: { id: 2 }, assetBook: { id: 3 } });
  await client.checkHealth();
  await client.checkHealth();
  assert.deepEqual(calls.map(c => c.url.pathname), ['/api/books/2', '/api/books/3', '/api/books/2', '/api/books/3']);
});

test('concurrent callers share a single workspace setup and failures permit retry', async () => {
  const { client } = api(() => ({}));
  let count = 0;
  client.createWorkspace = async () => { count++; await new Promise(resolve => setImmediate(resolve)); return { ready: true }; };
  const [first, second] = await Promise.all([client.ensureWorkspace(), client.ensureWorkspace()]);
  assert.equal(count, 1);
  assert.equal(first, second);
  client.workspacePromise = null;
  client.createWorkspace = async () => { throw new Error('Temporary API failure'); };
  await assert.rejects(client.ensureWorkspace(), /Temporary API failure/);
  assert.equal(client.workspacePromise, null);
});
