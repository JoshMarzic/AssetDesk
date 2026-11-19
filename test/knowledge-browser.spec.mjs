import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { BookStackClient } from '../src/bookstack.js';
import { createApp } from '../src/app.js';

const PASSWORD = 'Knowledge-browser-password-2026';
const EMAIL = 'knowledge-admin@example.test';

// A fake remote BookStack HTTP API, not mocked AssetDesk browser requests.
// The actual client, session API, document authorization and HTML sanitizer run.
function remoteWiki() {
  let sequence = 300, revision = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 1, 12, 0, revision++)).toISOString();
  const books = [{ id: 1, name: 'Assets', description: 'Equipment and ownership.' }, { id: 3, name: 'Tickets', description: 'Ticket documentation.' }, { id: 10, name: 'Knowledge Base', description: 'Practical guides for your support team.' }];
  const chapters = [{ id: 2, book_id: 3, name: 'Open' }, { id: 3, book_id: 3, name: 'In Progress' }, { id: 4, book_id: 3, name: 'Resolved' }, { id: 101, book_id: 10, name: 'Connectivity', description: 'Network and VPN guides.' }, { id: 102, book_id: 10, name: 'Account access', description: 'Identity and account guides.' }];
  const pages = new Map([
    [201, { id: 201, book_id: 10, chapter_id: 101, name: 'Connect to the office VPN', html: '<h2>Before you start</h2><p>Install the supported VPN client.</p><script>window.__knowledgeExecuted=true</script><img src="/uploads/images/gallery/2026/vpn-guide.png" onerror="window.__knowledgeExecuted=true"><p><a href="https://wiki.example.test/link/202">Password recovery guide</a></p>', updated_at: stamp(), tags: [] }],
    [202, { id: 202, book_id: 10, chapter_id: 102, name: 'Recover a locked account', html: '<h2>Verify the requester</h2><p>Confirm identity before resetting access.</p>', updated_at: stamp(), tags: [] }],
    [42, { id: 42, book_id: 1, chapter_id: null, name: 'LAPTOP-1042', html: '<h2>Ownership and equipment</h2><table><tr><th>Owner</th><td>Alex Johnson</td></tr><tr><th>Location</th><td>Office west</td></tr></table>', updated_at: stamp(), tags: [{ name: 'Asset ID', value: 'LAPTOP-1042' }] }],
  ]);
  const calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const list = (values, url) => {
    const count = Number(url.searchParams.get('count') || 100), offset = Number(url.searchParams.get('offset') || 0);
    return { data: values.slice(offset, offset + count), total: values.length };
  };
  async function fetchImpl(input, options = {}) {
    const url = new URL(input), method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path: url.pathname + url.search, method });
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/books' && method === 'GET') return json(list(books, url));
    if (/^\/books\/\d+$/.test(path) && method === 'GET') {
      const book = books.find(item => item.id === Number(path.split('/').at(-1)));
      return book ? json({ ...book, contents: chapters.filter(c => c.book_id === book.id).map(c => ({ ...c, type: 'chapter', pages: [...pages.values()].filter(p => p.chapter_id === c.id) })) }) : json({}, 404);
    }
    if (path === '/shelves' && method === 'GET') return json({ data: [{ id: 1, name: 'IT Help Desk' }], total: 1 });
    if (path === '/shelves/1' && method === 'GET') return json({ id: 1, name: 'IT Help Desk', books: books.filter(b => b.id !== 10) });
    if (path === '/chapters' && method === 'GET') {
      const filter = Number(url.searchParams.get('filter[book_id]'));
      return json(list(chapters.filter(c => !filter || c.book_id === filter), url));
    }
    if (path === '/chapters' && method === 'POST') {
      const chapter = { id: sequence++, ...body, updated_at: stamp() }; chapters.push(chapter); return json(chapter, 201);
    }
    if (/^\/chapters\/\d+$/.test(path) && method === 'GET') {
      const chapter = chapters.find(item => item.id === Number(path.split('/').at(-1)));
      return chapter ? json(chapter) : json({}, 404);
    }
    if (path === '/pages' && method === 'GET') {
      const filter = Number(url.searchParams.get('filter[book_id]'));
      const chapter = Number(url.searchParams.get('filter[chapter_id]'));
      return json(list([...pages.values()].filter(p => (!filter || p.book_id === filter) && (!chapter || p.chapter_id === chapter)), url));
    }
    if (path === '/search/book/10' || /^\/search\/chapter\/\d+$/.test(path)) {
      const term = (url.searchParams.get('query') || '').replace(/\{type:page\}/g, '').replace(/"/g, '').trim().toLowerCase();
      const chapter = path.startsWith('/search/chapter/') ? Number(path.split('/').at(-1)) : null;
      const found = [...pages.values()].filter(p => p.book_id === 10 && (!chapter || p.chapter_id === chapter) && `${p.name} ${p.html}`.toLowerCase().includes(term));
      return json({ data: found.map(p => ({ ...p, type: 'page', preview_html: p.html })), total: found.length });
    }
    if (path === '/pages' && method === 'POST') {
      const chapter = chapters.find(c => c.id === body.chapter_id);
      const page = { id: sequence++, book_id: body.book_id || chapter?.book_id, chapter_id: body.chapter_id ?? null, ...body, tags: [], updated_at: stamp() };
      pages.set(page.id, page); return json(page, 201);
    }
    if (/^\/pages\/\d+$/.test(path)) {
      const page = pages.get(Number(path.split('/').at(-1)));
      if (!page) return json({}, 404);
      if (method === 'GET') return json({ ...page, raw_html: page.html });
      if (method === 'PUT') { Object.assign(page, body, { updated_at: stamp() }); return json(page); }
    }
    throw new Error(`Unexpected fake BookStack request: ${method} ${path}`);
  }
  const client = new BookStackClient({ url: 'https://wiki.example.test', publicUrl: 'https://wiki.example.test', tokenId: 'dummy-knowledge-token-id', tokenSecret: 'dummy-knowledge-token-secret', fetchImpl });
  client.readImage = async () => ({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'), contentType: 'image/png' });
  return { client, pages, calls };
}

async function harness(t, { mobile = false } = {}) {
  const store = new Store(':memory:'), desk = new DeskStore(store);
  await desk.ensureAdmin({ name: 'Jordan Blake', email: EMAIL, password: PASSWORD });
  store.saveTicket({ key: 'HD-KNOWLEDGE01', requester: 'alex@example.test', subject: 'Display troubleshooting', page_id: 77, page_url: 'https://wiki.example.test/link/77' });
  desk.captureEmail('HD-KNOWLEDGE01', { text: 'The display on LAPTOP-1042 flickers.', from: { name: 'Alex Johnson', address: 'alex@example.test' } }, { receiptId: 'knowledge-fixture' });
  desk.addAssets('HD-KNOWLEDGE01', [{ ref: 'LAPTOP-1042', id: 42, url: 'https://wiki.example.test/link/42' }]);
  const remote = remoteWiki();
  const worker = { wake() {}, accept(message) { return store.accept(message); } };
  const config = { inboundToken: 'knowledge-browser-intake-token-123456', adminToken: 'knowledge-browser-admin-token-1234567', bookstack: { url: 'https://wiki.example.test', publicUrl: 'https://wiki.example.test' }, cookieSecure: false };
  const server = createApp({ store, desk, worker, bookstack: remote.client, config }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1024 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.getByLabel('Email address', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('region', { name: 'Ticket queue' }).waitFor();
  return { page, context, origin, remote, desk, errors };
}

test('knowledge articles are browsed, searched, edited and linked inside the existing AssetDesk session', { timeout: 90000 }, async t => {
  const h = await harness(t);
  await h.page.getByRole('button', { name: 'Knowledge base', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Knowledge base', exact: true }).waitFor();
  await h.page.getByRole('button', { name: /^Connect to the office VPN/ }).waitFor();
  await h.page.screenshot({ path: '/tmp/assetdesk-knowledge.png', fullPage: true });
  await h.page.getByRole('button', { name: 'Connectivity', exact: true }).click();
  await h.page.getByRole('button', { name: /^Recover a locked account/ }).waitFor({ state: 'hidden' });
  await h.page.getByRole('button', { name: 'All articles', exact: true }).click();
  await h.page.getByLabel('Search knowledge base', { exact: true }).fill('VPN');
  await h.page.getByRole('button', { name: /^Recover a locked account/ }).waitFor({ state: 'hidden' });
  await h.page.getByRole('button', { name: /^Connect to the office VPN/ }).click();
  await h.page.getByRole('heading', { name: 'Connect to the office VPN', exact: true }).waitFor();
  assert.equal(h.context.pages().length, 1, 'Knowledge navigation must not open another tab.');
  assert.ok(h.page.url().startsWith(`${h.origin}/#knowledge/article/201`));
  assert.equal(await h.page.evaluate(() => window.__knowledgeExecuted), undefined);
  assert.equal(await h.page.locator('[onerror], script:not([src])').count(), 0);
  const image = h.page.locator('img[src*="/api/desk/knowledge/images"]').first();
  await image.waitFor();
  await h.page.waitForFunction(() => document.querySelector('img[src*="/api/desk/knowledge/images"]')?.naturalWidth > 0);
  assert.ok(await image.evaluate(element => element.complete && element.naturalWidth > 0), 'Article images must load through the authenticated same-origin proxy.');
  await h.page.getByRole('link', { name: 'Password recovery guide', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Recover a locked account', exact: true }).waitFor();
  assert.ok(h.page.url().startsWith(`${h.origin}/#knowledge/article/202`));
  await h.page.getByRole('button', { name: 'Back to knowledge base', exact: true }).click();
  await h.page.getByRole('button', { name: 'New article', exact: true }).click();
  await h.page.getByLabel('Article title', { exact: true }).fill('Printer connection checklist');
  await h.page.getByRole('textbox', { name: 'Article body', exact: true }).fill('Check the network cable, printer address, and queue status.');
  await h.page.getByRole('textbox', { name: 'Article body', exact: true }).press('ControlOrMeta+A');
  await h.page.getByRole('button', { name: 'Bold', exact: true }).click();
  await h.page.getByLabel('Article chapter', { exact: true }).selectOption('101');
  await h.page.screenshot({ path: '/tmp/assetdesk-knowledge-editor.png', fullPage: true });
  await h.page.getByRole('button', { name: 'Save article', exact: true }).first().click();
  await h.page.getByRole('heading', { name: 'Printer connection checklist', exact: true }).waitFor();
  const created = [...h.remote.pages.values()].find(page => page.name === 'Printer connection checklist');
  assert.ok(created && created.book_id === 10 && created.chapter_id === 101);
  assert.match(created.html, /<(?:b|strong)>/, 'Rich-text formatting must be saved through the real API.');
  await h.page.getByRole('button', { name: 'Edit article', exact: true }).click();
  await h.page.getByRole('textbox', { name: 'Article body', exact: true }).fill('Check the network cable, printer address, queue status, and current driver.');
  await h.page.getByRole('button', { name: 'Save article', exact: true }).first().click();
  await h.page.getByRole('heading', { name: 'Printer connection checklist', exact: true }).waitFor();
  assert.match(h.remote.pages.get(created.id).html, /current driver/);
  await h.page.getByRole('button', { name: 'Assets', exact: true }).click();
  await h.page.getByRole('button', { name: /Open record/i }).first().click();
  await h.page.getByRole('heading', { name: 'LAPTOP-1042', exact: true }).waitFor();
  await h.page.getByText('Alex Johnson', { exact: true }).waitFor();
  assert.equal(h.context.pages().length, 1);
  assert.ok(h.page.url().includes('#knowledge/article/42'));
  assert.deepEqual(h.errors, []);
});

test('embedded knowledge browsing and article editing fit a mobile viewport', { timeout: 60000 }, async t => {
  const h = await harness(t, { mobile: true });
  await h.page.goto(`${h.origin}/#knowledge`);
  await h.page.getByRole('heading', { name: 'Knowledge base', exact: true }).waitFor();
  assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= 391));
  await h.page.getByRole('button', { name: /^Connect to the office VPN/ }).click();
  await h.page.getByRole('heading', { name: 'Connect to the office VPN', exact: true }).waitFor();
  assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= 391));
  await h.page.getByRole('button', { name: 'Edit article', exact: true }).click();
  await h.page.getByRole('textbox', { name: 'Article body', exact: true }).waitFor();
  assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= 391));
  await h.page.screenshot({ path: '/tmp/assetdesk-knowledge-mobile.png', fullPage: true });
  await h.page.getByRole('button', { name: 'Cancel editing', exact: true }).first().click();
  assert.deepEqual(h.errors, []);
});
