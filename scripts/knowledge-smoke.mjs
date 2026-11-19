#!/usr/bin/env node
// Creates labeled knowledge articles in a development stack using only the
// existing AssetDesk session. No separate BookStack browser login is used.
import assert from 'node:assert/strict';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3000';
let cookie, csrf;
async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api/desk${path}`, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${data.error || ''}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (data.csrfToken) csrf = data.csrfToken;
  return data;
}
await request('/login', { method: 'POST', body: { email: process.env.DASHBOARD_ADMIN_EMAIL || 'admin@assetdesk.local', password: process.env.DASHBOARD_ADMIN_PASSWORD } });
const run = Date.now();
const library = await request('/knowledge');
assert.ok(library.book.id);
const chapter = await request('/knowledge/chapters', { method: 'POST', body: { name: `Smoke guides ${run}`, description: 'Labeled development knowledge check.' } });
const created = await request('/knowledge/articles', { method: 'POST', body: {
  name: `Smoke printer troubleshooting ${run}`, chapter_id: chapter.id,
  html: '<h2>Check the connection</h2><p>Confirm the device is powered on.</p><script>window.untrusted=true</script>',
} });
assert.equal(created.kind, 'knowledge');
assert.equal(created.canEdit, true);
assert.ok(created.html.includes('Check the connection'));
assert.ok(!created.html.includes('<script'));
const found = await request(`/knowledge?search=${encodeURIComponent(String(run))}`);
assert.ok(found.articles.some(article => article.id === created.id), 'Search must find the article in the scoped knowledge book');
const linked = await request('/knowledge/articles', { method: 'POST', body: {
  name: `Smoke related guide ${run}`, html: `<p>See <a href="${process.env.BOOKSTACK_PUBLIC_URL || 'http://localhost:6875'}/link/${created.id}">printer troubleshooting</a>.</p>`,
} });
assert.ok(linked.html.includes(`#knowledge/article/${created.id}`));
const updated = await request(`/knowledge/articles/${created.id}`, { method: 'PATCH', body: {
  name: created.name, html: `${created.html}<p>Check completed in the embedded AssetDesk editor.</p>`, updated_at: created.updated_at, revision: created.revision,
} });
assert.ok(updated.html.includes('Check completed'));
const reread = await request(`/knowledge/articles/${created.id}`);
assert.ok(reread.html.includes('Check completed'));
await request('/logout', { method: 'POST', body: {} });
console.log('PASS: embedded knowledge book, chapters, scoped search, article read/create/edit, safe HTML, and same-app internal links with only the AssetDesk login.');
console.log(`Created labeled development articles ${created.id} and ${linked.id}.`);
