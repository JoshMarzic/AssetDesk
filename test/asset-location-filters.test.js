import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore, ASSET_TYPES, ASSETS_CATEGORY_ID } from '../src/workspace-store.js';
import { createDeskRouter } from '../src/desk-routes.js';

const password = 'Asset location filter password 2026';
const selected = (...locations) => JSON.stringify(locations);
const zeros = () => Object.fromEntries(ASSET_TYPES.map(type => [type, 0]));
async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Location administrator', email: 'locations-admin@example.test', password });
  const reader = await desk.createTechnician({ name: 'Location reader', email: 'locations-reader@example.test', password });
  const other = await desk.createTechnician({ name: 'Other location reader', email: 'locations-other@example.test', password });
  t.after(() => store.close());
  let serial = 0;
  const asset = (type, location = '', more = {}) => workspace.createAsset({ ref: `LOCATION-${String(++serial).padStart(4, '0')}`, name: 'Matching asset ' + serial, type, location, ...more }, admin);
  return { store, desk, workspace, admin, reader, other, asset };
}

test('location ranking uses full matching inventory, deterministic ties, and grouped pagination rather than the current page', async t => {
  const h = await fixture(t), assets = [];
  for (const [location, count] of [['Main office', 12], ['Remote', 9], ['alpha', 4], ['Alpha', 4], ['Beta', 4], ['R&D, "Annex" & Zürich', 3], ['Warehouse', 2], ['South', 1], ['', 20]]) {
    for (let index = 0; index < count; index++) assets.push(h.asset(index % 2 ? 'personnel' : 'pc', location));
  }
  const first = h.workspace.listAssets(h.other, { sort: 'type', limit: 30 });
  const second = h.workspace.listAssets(h.other, { sort: 'type', limit: 30, offset: 30 });
  assert.equal(first.total, 59); assert.equal(first.assets.length, 30); assert.equal(second.assets.length, 29);
  assert.deepEqual(second.location_counts, first.location_counts);
  assert.deepEqual(first.location_counts.filter(item => item.location).slice(0, 5), [
    { location: 'Main office', count: 12 }, { location: 'Remote', count: 9 },
    { location: 'Alpha', count: 4 }, { location: 'alpha', count: 4 }, { location: 'Beta', count: 4 },
  ]);
  assert.equal(first.location_counts.find(item => item.location === '').count, 20);
  const expected = assets.sort((a, b) => ASSET_TYPES.indexOf(a.type) - ASSET_TYPES.indexOf(b.type) || a.ref.localeCompare(b.ref));
  assert.deepEqual([...first.assets, ...second.assets].map(asset => asset.id), expected.map(asset => asset.id));
  const filtered = h.workspace.listAssets(h.other, { locations: selected('Remote', 'Main office', 'Remote'), sort: 'type', limit: 5, offset: 10 });
  assert.equal(filtered.total, 21);
  assert.deepEqual(filtered.assets.map(asset => asset.id), expected.filter(asset => ['Remote', 'Main office'].includes(asset.location)).slice(10, 15).map(asset => asset.id));
  assert.deepEqual(filtered.location_counts, first.location_counts, 'Selecting a location must not remove the other choices.');
});

test('location and type facets cross-filter while retaining category, search, and personnel privacy constraints', async t => {
  const h = await fixture(t);
  const restricted = h.workspace.createCategory({ name: 'Private locations', kind: 'assets', visibility: 'restricted', reader_ids: [h.reader.id], allow_staff_edit: false }, h.admin);
  const loans = h.workspace.createCategory({ name: 'Loans', kind: 'assets', visibility: 'all' }, h.admin);
  const hiddenPerson = h.asset('personnel', 'Private people office', { name: 'Matching hidden personnel', category_id: restricted.id });
  for (let index = 0; index < 6; index++) h.asset('pc', 'Secret bunker', { name: 'Matching private PC', category_id: restricted.id });
  for (let index = 0; index < 3; index++) h.asset('pc', 'HQ');
  h.asset('pc', 'HQ', { owner_id: hiddenPerson.id });
  h.asset('personnel', 'HQ'); h.asset('personnel', 'Remote');
  h.asset('pc', 'Remote'); h.asset('pc', 'Remote'); h.asset('laptop', 'Remote'); h.asset('other');
  h.asset('laptop', 'Remote', { name: 'Matching loan laptop', category_id: loans.id });
  const filters = { types: 'pc', locations: selected('HQ'), search: 'Matching', category_id: ASSETS_CATEGORY_ID };
  const result = h.workspace.listAssets(h.other, filters);
  assert.equal(result.total, 4);
  assert.deepEqual(result.type_counts, { ...zeros(), personnel: 1, pc: 4 });
  assert.deepEqual(result.location_counts, [{ location: 'HQ', count: 4 }, { location: 'Remote', count: 2 }]);
  assert.ok(result.assets.some(asset => asset.owner_restricted && asset.owner_id === null));
  assert.doesNotMatch(JSON.stringify(result), /Secret bunker|Private people office|Matching hidden personnel|Matching private PC/);
  const all = h.workspace.listAssets(h.other);
  assert.deepEqual(all.location_counts, [{ location: 'HQ', count: 5 }, { location: 'Remote', count: 5 }, { location: '', count: 1 }]);
  assert.equal(h.workspace.listAssets(h.reader).location_counts.find(item => item.location === 'Secret bunker').count, 6);
  const unknown = h.workspace.listAssets(h.other, { types: 'pc', locations: selected('Secret bunker') });
  assert.equal(unknown.total, 0); assert.deepEqual(unknown.type_counts, zeros());
  assert.deepEqual(unknown.location_counts, [{ location: 'HQ', count: 4 }, { location: 'Remote', count: 2 }]);
  const loan = h.workspace.listAssets(h.other, { types: 'laptop', locations: selected('Remote'), category_id: loans.id, search: 'loan' });
  assert.equal(loan.total, 1); assert.deepEqual(loan.type_counts, { ...zeros(), laptop: 1 });
  assert.deepEqual(loan.location_counts, [{ location: 'Remote', count: 1 }]);
  assert.throws(() => h.workspace.listAssets(h.other, { category_id: restricted.id, locations: selected('Secret bunker') }), error => error.statusCode === 404);
});

test('exact location filters support punctuation, Unicode, long names, and a distinct unset bucket', async t => {
  const h = await fixture(t);
  const names = ['R&D, "Annex" & Zürich / Floor [3]', 'North\nWing', 'Ж'.repeat(300), 'No location set'];
  const records = names.map(location => h.asset('pc', location));
  const empty = h.asset('personnel'), legacy = h.asset('personnel');
  h.store.db.prepare('UPDATE native_assets SET location=? WHERE id=?').run(' \t\r\n ', legacy.id);
  for (const [index, location] of names.entries()) {
    const result = h.workspace.listAssets(h.other, { locations: selected(location) });
    assert.equal(result.total, 1); assert.equal(result.assets[0].id, records[index].id);
  }
  const unset = h.workspace.listAssets(h.other, { locations: selected('') });
  assert.equal(unset.total, 2); assert.deepEqual(new Set(unset.assets.map(asset => asset.id)), new Set([empty.id, legacy.id]));
  assert.equal(unset.location_counts.find(item => item.location === '').count, 2);
  assert.equal(h.workspace.listAssets(h.other, { locations: selected(' \t ') }).total, 2);
  assert.equal(h.workspace.listAssets(h.other, { locations: selected() }).total, 6);
  assert.equal(h.workspace.listAssets(h.other, { locations: selected("'); DROP TABLE native_assets;--") }).total, 0);
  assert.equal(h.workspace.listAssets(h.other).total, 6);
});

test('HTTP location filters require authentication and reject malformed scalar JSON without disclosing private locations', async t => {
  const h = await fixture(t), special = 'R&D, "Annex" & Zürich';
  h.asset('pc', special); h.asset('personnel', 'Main office');
  const restricted = h.workspace.createCategory({ name: 'Private category', kind: 'assets', visibility: 'restricted' }, h.admin);
  h.asset('pc', 'Private endpoint location', { category_id: restricted.id });
  const app = express(); app.use('/api/desk', createDeskRouter({ store: h.store, desk: h.desk, workspace: h.workspace, worker: {}, config: {} }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/desk`;
  assert.equal((await fetch(base + '/assets?locations=%5B%5D')).status, 401);
  const login = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: h.other.email, password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = query => fetch(base + '/assets?' + query, { headers: { Cookie: cookie } });
  const response = await get(new URLSearchParams({ locations: selected(special), types: 'pc', sort: 'type', limit: '1' }));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.total, 1); assert.equal(result.assets[0].location, special);
  assert.deepEqual(result.location_counts, [{ location: special, count: 1 }]);
  assert.doesNotMatch(JSON.stringify(result), /Private endpoint location/);
  const invalid = ['', 'not-json', '{}', 'null', '"Main office"', '[1]', '[true]', '[{}]', selected('x'.repeat(301)), selected('\0'), JSON.stringify(Array(101).fill('HQ')), JSON.stringify(Array(100).fill('x'.repeat(100)))];
  for (const locations of invalid) {
    const bad = await get(new URLSearchParams({ locations }));
    assert.equal(bad.status, 400, `${locations.slice(0, 30)}: ${await bad.text()}`);
  }
  assert.equal((await get('locations=%5B%5D&locations=%5B%5D')).status, 400);
  const unknown = await get(new URLSearchParams({ locations: selected('Private endpoint location') }));
  assert.equal(unknown.status, 200); const absent = await unknown.json(); assert.equal(absent.total, 0);
  assert.doesNotMatch(JSON.stringify(absent), /Private endpoint location/);
  assert.equal((await get(new URLSearchParams({ locations: '[]' }))).status, 200);
  assert.equal((await get('type=personnel')).status, 200);
});
