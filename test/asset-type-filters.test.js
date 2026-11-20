import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore, ASSET_TYPES, ASSETS_CATEGORY_ID } from '../src/workspace-store.js';
import { createDeskRouter } from '../src/desk-routes.js';

const password = 'Asset type filter password 2026';
async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Asset administrator', email: 'asset-admin@example.test', password });
  const reader = await desk.createTechnician({ name: 'Asset reader', email: 'asset-reader@example.test', password });
  const other = await desk.createTechnician({ name: 'Other reader', email: 'asset-other@example.test', password });
  t.after(() => store.close());
  const asset = (ref, type, more = {}) => workspace.createAsset({ ref, type, name: ref, ...more }, admin);
  return { store, desk, workspace, admin, reader, other, asset };
}
const zeros = () => Object.fromEntries(ASSET_TYPES.map(type => [type, 0]));

test('multiple asset types are filtered before pagination and grouped globally with stable reference order', async t => {
  const h = await fixture(t), expected = [];
  for (const [type, count] of [['personnel', 18], ['pc', 14], ['laptop', 3], ['hardware', 2], ['other', 1]]) {
    for (let index = count; index > 0; index--) expected.push(h.asset(`${type}-${String(index).padStart(3, '0')}`, type));
  }
  const grouped = expected.sort((a, b) => ASSET_TYPES.indexOf(a.type) - ASSET_TYPES.indexOf(b.type) || a.ref.localeCompare(b.ref));
  const first = h.workspace.listAssets(h.other, { sort: 'type', limit: 30 });
  const second = h.workspace.listAssets(h.other, { sort: 'type', limit: 30, offset: 30 });
  assert.equal(first.total, 38); assert.equal(first.assets.length, 30); assert.equal(second.assets.length, 8);
  assert.deepEqual([...first.assets, ...second.assets].map(asset => asset.id), grouped.map(asset => asset.id));
  assert.deepEqual(first.type_counts, { ...zeros(), personnel: 18, pc: 14, laptop: 3, hardware: 2, other: 1 });
  const filtered = h.workspace.listAssets(h.other, { types: 'laptop,pc,pc', sort: 'type', limit: 5, offset: 10 });
  assert.equal(filtered.total, 17);
  assert.deepEqual(filtered.assets.map(asset => asset.id), grouped.filter(asset => ['pc', 'laptop'].includes(asset.type)).slice(10, 15).map(asset => asset.id));
  assert.deepEqual(filtered.type_counts, first.type_counts, 'Facet counts must still show types that can be added.');
  assert.equal(h.workspace.listAssets(h.other, { type: 'personnel' }).total, 18, 'Existing single-type clients remain supported.');
  assert.equal(h.workspace.listAssets(h.other, { types: '' }).total, 38);
  assert.throws(() => h.workspace.listAssets(h.other, { types: ['personnel', 'pc'] }), error => error.statusCode === 400);
});

test('asset facets respect search, category grants, and restricted personnel ownership before selection', async t => {
  const h = await fixture(t);
  const privateCategory = h.workspace.createCategory({ name: 'Private equipment', kind: 'assets', visibility: 'restricted', reader_ids: [h.reader.id], allow_staff_edit: false }, h.admin);
  const otherCategory = h.workspace.createCategory({ name: 'Loan equipment', kind: 'assets', visibility: 'all' }, h.admin);
  const hiddenPerson = h.asset('PERSON-PRIVATE', 'personnel', { name: 'Matching private person', category_id: privateCategory.id });
  h.asset('PC-PRIVATE', 'pc', { name: 'Matching private PC', category_id: privateCategory.id });
  h.asset('PERSON-PUBLIC', 'personnel', { name: 'Matching employee' });
  const visiblePC = h.asset('PC-PUBLIC', 'pc', { name: 'Matching workstation', owner_id: hiddenPerson.id });
  h.asset('LAPTOP-LOAN', 'laptop', { name: 'Matching laptop', category_id: otherCategory.id });
  const filtered = h.workspace.listAssets(h.other, { types: 'personnel', search: 'Matching', category_id: ASSETS_CATEGORY_ID, sort: 'type' });
  assert.equal(filtered.total, 1); assert.deepEqual(filtered.type_counts, { ...zeros(), personnel: 1, pc: 1 });
  assert.equal(filtered.assets[0].ref, 'PERSON-PUBLIC');
  const allowed = h.workspace.listAssets(h.reader, { types: 'personnel,pc', search: 'Matching' });
  assert.equal(allowed.total, 4); assert.deepEqual(allowed.type_counts, { ...zeros(), personnel: 2, pc: 2, laptop: 1 });
  const visible = h.workspace.listAssets(h.other, { types: 'pc' });
  assert.equal(visible.total, 1); assert.equal(visible.assets[0].id, visiblePC.id);
  assert.equal(visible.assets[0].owner_restricted, true); assert.equal(visible.assets[0].owner_id, null);
  assert.doesNotMatch(JSON.stringify(visible), /Matching private|PERSON-PRIVATE|PC-PRIVATE/);
  const absent = h.workspace.listAssets(h.other, { search: 'private', types: 'personnel,pc' });
  assert.equal(absent.total, 0); assert.deepEqual(absent.type_counts, zeros());
  assert.throws(() => h.workspace.listAssets(h.other, { category_id: privateCategory.id, types: 'personnel' }), error => error.statusCode === 404);
});

test('asset HTTP filters require a session, validate scalar selections, and return permission-safe facets', async t => {
  const h = await fixture(t);
  h.asset('PERSON-1', 'personnel'); h.asset('PC-1', 'pc'); h.asset('LAPTOP-1', 'laptop');
  const hidden = h.workspace.createCategory({ name: 'Restricted assets', kind: 'assets', visibility: 'restricted' }, h.admin);
  h.asset('PERSON-HIDDEN', 'personnel', { category_id: hidden.id });
  const app = express(); app.use('/api/desk', createDeskRouter({ store: h.store, desk: h.desk, workspace: h.workspace, worker: {}, config: {} }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  assert.equal((await fetch(origin + '/assets?types=personnel,pc')).status, 401);
  const login = await fetch(origin + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: h.other.email, password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = path => fetch(origin + path, { headers: { Cookie: cookie } });
  const result = await get('/assets?types=personnel,pc&sort=type&limit=1&offset=1');
  assert.equal(result.status, 200);
  const data = await result.json(); assert.equal(data.total, 2); assert.equal(data.assets[0].ref, 'PC-1');
  assert.deepEqual(data.type_counts, { ...zeros(), personnel: 1, pc: 1, laptop: 1 });
  for (const query of ['types=personnel,,pc', 'types=unknown', 'types=personnel&types=pc', 'types=personnel&types=personnel', 'type=pc&types=laptop', 'sort=updated', 'sort=type&sort=type', 'types=pc%27%29%3BSELECT%201', 'offset=-1']) {
    const response = await get('/assets?' + query);
    assert.equal(response.status, 400, `${query}: ${await response.text()}`);
  }
  assert.equal((await get('/assets?type=personnel')).status, 200);
  assert.equal((await get('/assets?type=all&types=personnel')).status, 200);
  assert.equal((await get('/assets?category_id=' + hidden.id + '&types=personnel')).status, 404);
  const empty = await get('/assets?types=pc&search=nonexistent');
  assert.equal(empty.status, 200); assert.deepEqual((await empty.json()).type_counts, zeros());
});
