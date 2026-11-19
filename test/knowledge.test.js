import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createKnowledgeRouter, cleanKnowledgeHtml, imagePath } from '../src/knowledge.js';
import { BookStackClient } from '../src/bookstack.js';

const STAMP = '2026-11-19T10:00:00.000Z';
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
function fakeWiki() {
  let next = 200;
  const calls = [];
  const book = { id: 10, name: 'Knowledge Base', slug: 'knowledge-base', description: 'Shared procedures' };
  const chapters = [{ id: 11, book_id: 10, name: 'Hardware', description: 'Devices' }, { id: 99, book_id: 40, name: 'Private' }];
  const pages = new Map([
    [101, { id: 101, book_id: 10, chapter_id: 11, name: 'Reset the VPN client', slug: 'reset-the-vpn-client', updated_at: STAMP, raw_html: '<h2 id="bkmrk-steps">Steps</h2><p>Restart the VPN client.</p><script>steal()</script><img src="https://wiki.example.test/uploads/images/gallery/2026-11/vpn.png"><a href="https://wiki.example.test/link/102">More</a>' }],
    [102, { id: 102, book_id: 20, chapter_id: 0, name: 'LAPTOP-42', slug: 'laptop-42', updated_at: STAMP, raw_html: '<table><tr><td>Owner</td><td>Ada</td></tr></table>' }],
    [103, { id: 103, book_id: 30, chapter_id: 0, name: 'HD-42', slug: 'hd-42', updated_at: STAMP, raw_html: '<p>Ticket mirror</p>' }],
    [104, { id: 104, book_id: 40, chapter_id: 99, name: 'Private payroll', slug: 'private-payroll', updated_at: STAMP, raw_html: '<p>Not accessible from AssetDesk.</p>' }],
  ]);
  const wiki = {
    calls, pages, publicUrl: 'https://wiki.example.test', url: 'http://bookstack:80',
    pageUrl(id) { return `${this.publicUrl}/link/${id}`; },
    async ensureKnowledgeBook() { calls.push(['knowledge']); return { ...book }; },
    async ensureWorkspace() { return { assetBook: { id: 20, slug: 'assets' }, ticketBook: { id: 30, slug: 'tickets' } }; },
    async getPage(id) { calls.push(['page', id]); const page = pages.get(Number(id)); if (!page) throw Object.assign(new Error('Not found'), { status: 404 }); return { ...page }; },
    async createPage(data) { const page = { ...data, id: next++, book_id: data.chapter_id ? chapters.find(c => c.id === data.chapter_id).book_id : data.book_id, updated_at: STAMP, raw_html: data.html }; pages.set(page.id, page); return page; },
    async updatePage(id, data) { const page = { ...pages.get(id), ...data, raw_html: data.html, updated_at: '2026-11-19T11:00:00.000Z' }; pages.set(id, page); return page; },
    async list(path) {
      calls.push(['list', path]); const url = new URL(path, 'http://wiki'); const id = Number(url.searchParams.get('filter[book_id]'));
      if (url.pathname === '/chapters') return chapters.filter(chapter => chapter.book_id === id);
      if (url.pathname === '/pages') return [...pages.values()].filter(page => page.book_id === id);
      throw new Error(`Unexpected listing ${path}`);
    },
    async request(path, { method = 'GET', body } = {}) {
      calls.push([method, path]); const url = new URL(path, 'http://wiki');
      if (method === 'POST' && url.pathname === '/chapters') { const chapter = { id: next++, ...body }; chapters.push(chapter); return chapter; }
      if (/^\/chapters\/\d+$/.test(url.pathname)) { const chapter = chapters.find(value => value.id === Number(url.pathname.split('/').at(-1))); if (!chapter) throw Object.assign(new Error('Not found'), {status:404}); return chapter; }
      if (url.pathname === '/pages') {
        const id = Number(url.searchParams.get('filter[book_id]')), chapter = Number(url.searchParams.get('filter[chapter_id]')), slug = url.searchParams.get('filter[slug]');
        const all = [...pages.values()].filter(page => page.book_id === id && (!chapter || page.chapter_id === chapter) && (!slug || page.slug === slug));
        const offset = Number(url.searchParams.get('offset')), count = Number(url.searchParams.get('count'));
        return { data: all.slice(offset, offset + count), total: all.length };
      }
      if (url.pathname.startsWith('/search/book/') || url.pathname.startsWith('/search/chapter/')) {
        const chapter = url.pathname.includes('/chapter/'); const id = Number(url.pathname.split('/').at(-1));
        const query = url.searchParams.get('query').replace(' {type:page}', '').toLowerCase();
        const all = [...pages.values()].filter(page => (chapter ? page.chapter_id === id : page.book_id === id) && `${page.name} ${page.raw_html}`.toLowerCase().includes(query));
        return { data: all.map(page => ({ ...page, type: 'page', preview_html: { content: '<p>Restart the <strong>VPN</strong> client.</p>' } })), total: all.length };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    },
    async readImage(path) { calls.push(['image', path]); return { data: PNG, contentType: 'image/png' }; },
  };
  return wiki;
}

async function harness(t, config = {}) {
  const bookstack = fakeWiki();
  const app = express(); app.use(express.json({ limit: '512kb' }));
  app.use((req, _res, next) => { req.deskSession = { user: { id: 'technician-1', name: 'Avery Chen', role: req.get('x-test-role') || 'technician' } }; next(); });
  app.use('/api/desk/knowledge', createKnowledgeRouter({ bookstack, config }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/desk/knowledge`;
  async function request(path = '/', { method = 'GET', body, admin = false } = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body ? {'content-type':'application/json'} : {}), ...(admin ? {'x-test-role':'admin'} : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: value, headers: response.headers };
  }
  return { bookstack, request };
}

test('embedded knowledge lists and searches only the selected knowledge book', async t => {
  const { request, bookstack } = await harness(t);
  const index = await request('/');
  assert.equal(index.status, 200); assert.deepEqual(index.body.articles.map(page => page.id), [101]);
  assert.deepEqual(index.body.chapters.map(chapter => chapter.id), [11]);
  const search = await request('/?search=VPN&chapter_id=11');
  assert.equal(search.status, 200); assert.equal(search.body.articles[0].excerpt, 'Restart the VPN client.');
  assert.ok(bookstack.calls.some(call => call[1]?.startsWith('/search/chapter/11?')));
  assert.equal((await request('/?chapter_id=99')).status, 400);
  assert.equal((await request('/?limit=101')).status, 400);
});

test('article reader strips active HTML and embeds links and referenced images without another login', async t => {
  const { request } = await harness(t);
  const result = await request('/articles/101');
  assert.equal(result.status, 200); assert.equal(result.body.kind, 'knowledge'); assert.equal(result.body.canEdit, true);
  assert.ok(!result.body.html.includes('steal')); assert.ok(!result.body.html.includes('<script'));
  assert.match(result.body.html, /href="#knowledge\/article\/102"/);
  assert.match(result.body.html, /src="\/api\/desk\/knowledge\/images\?article_id=101&amp;path=/);
  assert.match(result.body.html, /id="kb-101-bkmrk-steps"/);
});

test('embedded assets may be edited but ticket mirrors and unrelated books cannot be changed', async t => {
  const { request } = await harness(t);
  const asset = await request('/articles/102'); assert.equal(asset.body.kind, 'asset'); assert.equal(asset.body.canEdit, true);
  const updated = await request('/articles/102', { method: 'PATCH', body: { name: 'LAPTOP-42', html: '<table><tr><td>Owner</td><td>Grace</td></tr></table>', updated_at: asset.body.updated_at, revision: asset.body.revision } });
  assert.equal(updated.status, 200); assert.match(updated.body.html, /Grace/);
  assert.equal((await request('/articles/104')).status, 404);
  const ticket = await request('/articles/103'); assert.equal(ticket.body.canEdit, false);
  assert.equal((await request('/articles/103', {method:'PATCH',body:{name:'Changed',html:'<p>No</p>',updated_at:STAMP}})).status,403);
});

test('article edits detect stale content including changes within the same timestamp', async t => {
  const { request, bookstack } = await harness(t);
  const original = (await request('/articles/101')).body;
  bookstack.pages.get(101).raw_html = '<p>Changed by a teammate in the wiki</p>';
  const edit = await request('/articles/101', { method: 'PATCH', body: { name: original.name, html: '<p>My attempted edit</p>', updated_at: original.updated_at, revision: original.revision } });
  assert.equal(edit.status, 409); assert.match(bookstack.pages.get(101).raw_html, /teammate/);
});

test('reader HTML round-trips stable wiki links, images and anchors through the embedded editor', async t => {
  const { request, bookstack } = await harness(t);
  const original = (await request('/articles/101')).body;
  const saved = await request('/articles/101', { method: 'PATCH', body: { name: original.name, html: original.html, updated_at: original.updated_at, revision: original.revision } });
  assert.equal(saved.status, 200);
  const source = bookstack.pages.get(101).raw_html;
  assert.match(source, /href="https:\/\/wiki.example.test\/link\/102"/);
  assert.match(source, /src="https:\/\/wiki.example.test\/uploads\/images\/gallery\/2026-11\/vpn.png"/);
  assert.match(source, /id="bkmrk-steps"/);
  assert.ok(!source.includes('/api/desk/knowledge/images'));
  assert.match(saved.body.html, /#knowledge\/article\/102/);
});

test('staff create articles while only administrators create knowledge categories', async t => {
  const { request, bookstack } = await harness(t);
  assert.equal((await request('/chapters', {method:'POST',body:{name:'Networking'}})).status,403);
  const chapter = await request('/chapters', {method:'POST',admin:true,body:{name:'Networking',description:'Connection troubleshooting'}});
  assert.equal(chapter.status,201);
  const article = await request('/articles', {method:'POST',body:{name:'Network checklist',html:'<h2>Check connectivity</h2><p>Check the cable.</p>',chapter_id:chapter.body.id}});
  assert.equal(article.status,201); assert.equal(article.body.book_id,10);
  assert.equal((await request('/articles', {method:'POST',body:{name:'Wrong book',html:'<p>Content</p>',chapter_id:99}})).status,400);
  assert.equal((await request('/articles', {method:'POST',body:{name:'Empty',html:'<script>only unsafe content</script>'}})).status,400);
  assert.ok(bookstack.pages.has(article.body.id));
});

test('image proxy serves only raster images actually referenced by an accessible article', async t => {
  const { request, bookstack } = await harness(t);
  const image = await request('/images?article_id=101&path=%2Fuploads%2Fimages%2Fgallery%2F2026-11%2Fvpn.png');
  assert.equal(image.status,200); assert.deepEqual(image.body,PNG); assert.equal(image.headers.get('content-type'),'image/png');
  assert.equal((await request('/images?article_id=104&path=%2Fuploads%2Fimages%2Fgallery%2F2026-11%2Fvpn.png')).status,404);
  assert.equal((await request('/images?article_id=101&path=%2Fuploads%2Fimages%2Fgallery%2Fother.png')).status,404);
  assert.equal((await request('/images?article_id=101&path=https%3A%2F%2Fevil.test%2Fimage.png')).status,400);
  assert.equal((await request('/images?article_id=101&path=%2Fuploads%2Fimages%2F..%2Fsecret.png')).status,400);
  assert.equal(bookstack.calls.filter(call=>call[0]==='image').length,1);
});

test('article writes cannot launder a private wiki image through an allowed knowledge page', async t => {
  const { request, bookstack } = await harness(t);
  const privateImage = '<p>Copied picture</p><img src="https://wiki.example.test/uploads/images/gallery/private-payroll.png">';
  const created = await request('/articles', { method: 'POST', body: { name: 'Attempted image import', html: privateImage } });
  assert.equal(created.status, 400);
  const article = (await request('/articles/101')).body;
  const changed = await request('/articles/101', { method: 'PATCH', body: { name: article.name, html: `${article.html}${privateImage}`, updated_at: article.updated_at, revision: article.revision } });
  assert.equal(changed.status, 400);
  assert.ok(!bookstack.pages.get(101).raw_html.includes('private-payroll'));
  assert.equal((await request('/images?article_id=101&path=%2Fuploads%2Fimages%2Fgallery%2Fprivate-payroll.png')).status,404);
});

test('knowledge HTML rejects forms, scripts, unsafe URLs, external images and DOM-id collisions', () => {
  const wiki = fakeWiki();
  const html = cleanKnowledgeHtml('<h2 id="app">Safe</h2><a href="javascript:alert(1)" onclick="steal()">Unsafe</a><a href="https://external.example/help">External</a><img src="https://evil.example/tracker.png"><iframe src="https://evil.example"></iframe><form><input value="credential"></form><p style="position:fixed" onmouseover="steal()">Text</p>',{bookstack:wiki,articleId:101});
  assert.match(html,/id="kb-101-app"/); assert.ok(!html.includes('javascript:')); assert.ok(!html.includes('onclick')); assert.ok(!html.includes('onmouseover'));
  assert.ok(!html.includes('tracker')); assert.ok(!html.includes('<iframe')); assert.ok(!html.includes('<form')); assert.ok(!html.includes('<input')); assert.ok(!html.includes('style='));
  assert.match(html,/rel="noopener noreferrer"/);
  for (const value of ['/uploads/images/../secret.png','/uploads/images/gallery/%2e%2e/secret.png','https://evil.test/uploads/images/x.png','/uploads/images/x.svg','/uploads/images/x.png?token=secret','/uploads/images/x%252epng']) assert.equal(imagePath(value,wiki),null,value);
});

test('canonical BookStack page links resolve inside AssetDesk instead of requiring another wiki login', async t => {
  const { request,bookstack }=await harness(t);
  bookstack.pages.get(101).raw_html='<p><a href="https://wiki.example.test/books/assets/page/laptop-42">Asset</a></p>';
  assert.match((await request('/articles/101')).body.html,/href="#knowledge\/article\/102"/);
});

test('canonical link resolution targets only referenced slugs and reuses bounded coalesced lookups', async t => {
  const { request, bookstack } = await harness(t);
  bookstack.pages.get(101).raw_html = '<p><a href="https://wiki.example.test/books/assets/page/laptop-42">First</a><a href="https://wiki.example.test/books/assets/page/laptop-42">Again</a><a href="https://wiki.example.test/books/private/page/private-payroll">Private</a></p>';
  const results = await Promise.all([request('/articles/101'), request('/articles/101')]);
  assert.ok(results.every(result => result.status === 200 && result.body.html.includes('#knowledge/article/102')));
  await request('/articles/101');
  const lookups = bookstack.calls.filter(call => call[0] === 'GET' && call[1]?.startsWith('/pages?'));
  assert.equal(lookups.length, 1, 'Concurrent requests and later reads reuse the same slug lookup.');
  const url = new URL(lookups[0][1], 'http://wiki');
  assert.equal(url.searchParams.get('filter[book_id]'), '20');
  assert.equal(url.searchParams.get('filter[slug]'), 'laptop-42');
  assert.equal(url.searchParams.get('count'), '2');
  assert.ok(!bookstack.calls.some(call => call[0] === 'list' && call[1]?.startsWith('/pages')), 'No full book page scans.');
  assert.ok(!results[0].body.html.includes('#knowledge/article/104'));
});

test('canonical lookups cap query fan-out and concurrency even for articles containing many links', async t => {
  const { request, bookstack } = await harness(t);
  let active = 0, maximum = 0, queries = 0;
  const original = bookstack.request.bind(bookstack);
  bookstack.request = async (path, options) => {
    if (path.startsWith('/pages?')) {
      queries++; active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return await original(path, options); }
      finally { active--; }
    }
    return original(path, options);
  };
  bookstack.pages.get(101).raw_html = Array.from({ length: 100 }, (_, index) => `<a href="https://wiki.example.test/books/assets/page/device-${index}">Device ${index}</a>`).join('');
  assert.equal((await request('/articles/101')).status, 200);
  assert.equal(queries, 32);
  assert.ok(maximum <= 3, `Only three lookups may run concurrently; observed ${maximum}.`);
});

test('BookStack knowledge-book initialization is single-flight and scoped image fetch verifies type, bytes and size', async () => {
  const calls=[];
  const client=new BookStackClient({url:'http://bookstack',publicUrl:'https://wiki.example.test',tokenId:'test-id',tokenSecret:'test-secret',fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/api/books'))return new Response(JSON.stringify({data:[{id:10,name:'Knowledge Base'}],total:1}),{headers:{'content-type':'application/json'}});
    return new Response(PNG,{headers:{'content-type':'image/png'}});
  }});
  assert.deepEqual(await Promise.all([client.ensureKnowledgeBook(),client.ensureKnowledgeBook()]),[{id:10,name:'Knowledge Base'},{id:10,name:'Knowledge Base'}]);
  assert.equal(calls.filter(call=>call.url.includes('/api/books')).length,1);
  const image=await client.readImage('/uploads/images/gallery/x.png');assert.deepEqual(image.data,PNG);
  const fetchCall=calls.at(-1);assert.match(fetchCall.url,/\/api\/image-gallery\/url\/data\?url=/);assert.equal(fetchCall.options.redirect,'error');assert.equal(fetchCall.options.headers.Authorization,'Token test-id:test-secret');
  await assert.rejects(client.readImage('/uploads/images/../../secret.png'));
  client.fetch=async()=>new Response('<svg onload="steal()"/>',{headers:{'content-type':'image/svg+xml'}});
  await assert.rejects(client.readImage('/uploads/images/gallery/x.png'),error=>error.status===415);
  client.fetch=async()=>new Response('not an image',{headers:{'content-type':'image/png'}});
  await assert.rejects(client.readImage('/uploads/images/gallery/x.png'),error=>error.status===415);
  client.fetch=async()=>new Response(PNG,{headers:{'content-type':'image/png','content-length':String(11*1024*1024)}});
  await assert.rejects(client.readImage('/uploads/images/gallery/x.png'),error=>error.status===413);
});
