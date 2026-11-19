import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore, GENERAL_CATEGORY_ID, ASSETS_CATEGORY_ID } from '../src/workspace-store.js';

async function fixture(t, filename = ':memory:') {
  const store = new Store(filename), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Administrator', email: 'admin@example.test', password: 'Admin test password 2026' });
  const reader = await desk.createTechnician({ name: 'Allowed Reader', email: 'reader@example.test', password: 'Reader test password 2026' });
  const other = await desk.createTechnician({ name: 'Other Technician', email: 'other@example.test', password: 'Other test password 2026' });
  t.after(() => { try { store.close(); } catch {} });
  function ticket(key, subject = 'Equipment support', requester = 'requester@example.test') {
    store.saveTicket({ key, subject, requester, page_id: 0, page_url: '' });
    desk.captureEmail(key, { text: 'Please investigate the device.', from: { address: requester }, receivedAt: new Date().toISOString() }, { receiptId: `receipt-${key}` });
    return desk.getTicket(key);
  }
  return { store, desk, workspace, admin, reader, other, ticket };
}
const denied = (action, status = 404) => assert.throws(action, error => error.statusCode === status);

test('native workspace has an Assets knowledge area alongside General guides', async t => {
  const { workspace, admin, reader } = await fixture(t);
  const categories = workspace.listCategories(reader);
  assert.deepEqual(new Set(categories.map(c => c.id)), new Set([GENERAL_CATEGORY_ID, ASSETS_CATEGORY_ID]));
  const assets = categories.find(c => c.id === ASSETS_CATEGORY_ID);
  assert.equal(assets.kind, 'assets'); assert.equal(assets.canEdit, true);
  const guide = workspace.createArticle({ name: 'Equipment handover', html: '<p>Record ownership on the asset.</p>', category_id: assets.id }, reader);
  assert.equal(workspace.listArticles(reader, { category_id: assets.id }).articles[0].id, guide.id);
  denied(() => workspace.updateCategory(assets.id, { kind: 'knowledge' }, admin, { version: assets.version }), 400);
});

test('restricted categories protect article reads, search results, excerpts and counts', async t => {
  const { workspace, admin, reader, other } = await fixture(t);
  const privateCategory = workspace.createCategory({ name: 'Personnel private', visibility: 'restricted', reader_ids: [reader.id], allow_staff_edit: false }, admin);
  const secret = workspace.createArticle({ name: 'Confidential onboarding', html: '<p>Private salary process.</p>', category_id: privateCategory.id }, admin);
  workspace.createArticle({ name: 'Public printer setup', html: '<p>Install the driver.</p>' }, admin);
  assert.equal(workspace.listArticles(reader, { search: 'salary' }).total, 1);
  assert.equal(workspace.listArticles(other, { search: 'salary' }).total, 0);
  assert.equal(workspace.listArticles(other).total, 1);
  assert.ok(!workspace.listCategories(other).some(c => c.id === privateCategory.id));
  denied(() => workspace.getCategory(privateCategory.id, other));
  denied(() => workspace.getArticle(secret.id, other));
  denied(() => workspace.listArticles(other, { category_id: privateCategory.id }));
  assert.equal(workspace.getArticle(secret.id, reader).html, secret.html);
  assert.equal(workspace.getArticle(secret.id, reader).canEdit, false);
  assert.equal(workspace.getCategory(privateCategory.id, reader).reader_ids, undefined);
});

test('category edits are administrative, optimistic, and editors have explicit read access', async t => {
  const { workspace, admin, reader, other } = await fixture(t);
  denied(() => workspace.createCategory({ name: 'Unauthorized' }, reader), 403);
  let category = workspace.createCategory({ name: 'Infrastructure', visibility: 'restricted', editor_ids: [reader.id], allow_staff_edit: false }, admin);
  assert.equal(workspace.getCategory(category.id, reader).canEdit, true);
  const article = workspace.createArticle({ name: 'Network recovery', html: '<p>Restart the switch.</p>', category_id: category.id }, reader);
  assert.equal(workspace.getArticle(article.id, reader).created_by, reader.id);
  denied(() => workspace.updateCategory(category.id, { name: 'Changed' }, reader, { version: 1 }), 403);
  category = workspace.updateCategory(category.id, { reader_ids: [other.id], editor_ids: [] }, admin, { version: category.version });
  denied(() => workspace.updateCategory(category.id, { name: 'Stale' }, admin, { version: 1 }), 409);
  denied(() => workspace.getArticle(article.id, reader));
  assert.equal(workspace.getArticle(article.id, other).canEdit, false);
  denied(() => workspace.updateArticle(article.id, { html: '<p>Not authorized</p>' }, other, { version: article.version }), 403);
});

test('moving articles checks both category permissions and rejects stale writes', async t => {
  const { workspace, admin, reader } = await fixture(t);
  const privateCategory = workspace.createCategory({ name: 'Admin-only', visibility: 'restricted', allow_staff_edit: false }, admin);
  let article = workspace.createArticle({ name: 'A useful guide', html: '<p>Initial version.</p>' }, reader);
  denied(() => workspace.updateArticle(article.id, { category_id: privateCategory.id }, reader, { version: article.version }));
  article = workspace.updateArticle(article.id, { html: '<p>Updated version.</p>' }, reader, { version: article.version });
  denied(() => workspace.updateArticle(article.id, { html: '<p>Stale version.</p>' }, reader, { version: 1 }), 409);
  workspace.updateArticle(article.id, { category_id: privateCategory.id }, admin, { version: article.version });
  denied(() => workspace.getArticle(article.id, reader));
});

test('media access follows current article permissions and parent moves instead of stale upload metadata', async t => {
  const { workspace, admin, reader, other } = await fixture(t);
  let category = workspace.createCategory({ name: 'Restricted diagrams', visibility: 'restricted', editor_ids: [reader.id] }, admin);
  const article = workspace.createArticle({ name: 'Network diagram', html: '<p>Diagram below.</p>', category_id: category.id }, reader);
  const uploaded = workspace.addMedia({ article_id: article.id, filename: 'diagram.png', mime: 'image/png', data: Buffer.from('fixture image bytes') }, reader);
  assert.ok(Buffer.isBuffer(workspace.getMedia(uploaded.id, reader).data));
  denied(() => workspace.getMedia(uploaded.id, other));
  denied(() => workspace.addMedia({ article_id: article.id, filename: 'x.png', mime: 'image/png', data: Buffer.from('bytes') }, other));
  category = workspace.updateCategory(category.id, { reader_ids: [], editor_ids: [] }, admin, { version: category.version });
  denied(() => workspace.getMedia(uploaded.id, reader));
  let moved = workspace.updateArticle(article.id, { category_id: GENERAL_CATEGORY_ID }, admin, { version: article.version });
  assert.ok(workspace.getMedia(uploaded.id, other).data.length);
  moved = workspace.updateArticle(article.id, { category_id: category.id }, admin, { version: moved.version });
  denied(() => workspace.getMedia(uploaded.id, other));
  denied(() => workspace.addMedia({ filename: 'orphan.png', mime: 'image/png', data: Buffer.from('bytes') }, admin), 400);
  denied(() => workspace.addMedia({ article_id: article.id, filename: 'x.svg', mime: 'image/svg+xml', data: Buffer.from('<svg/>') }, admin), 415);
});

test('personnel and hardware are native asset records with ownership and versioned details', async t => {
  const { workspace, admin } = await fixture(t);
  const person = workspace.createAsset({ ref: 'person-42', name: 'Morgan Quinn', type: 'personnel', email: 'morgan@example.test', department: 'Finance', status: 'active' }, admin);
  let pc = workspace.createAsset({ ref: 'pc-1042', name: 'Morgan workstation', type: 'pc', owner_id: person.id, serial_number: 'SN-1042', location: 'Floor 2', manufacturer: 'Example', model: 'Workstation', status: 'active' }, admin);
  assert.equal(pc.ref, 'PC-1042'); assert.equal(pc.owner.name, 'Morgan Quinn'); assert.equal(pc.owner_id, person.id);
  assert.equal(workspace.listAssets(admin, { type: 'personnel' }).assets[0].id, person.id);
  assert.equal(workspace.listAssets(admin, { search: 'SN-1042' }).total, 1);
  pc = workspace.updateAsset(pc.id, { location: 'Floor 3', description: 'Assigned for finance reporting.' }, admin, { version: pc.version });
  assert.equal(pc.location, 'Floor 3'); assert.equal(pc.owner_id, person.id);
  denied(() => workspace.updateAsset(pc.id, { location: 'Stale' }, admin, { version: 1 }), 409);
  denied(() => workspace.updateAsset(person.id, { type: 'hardware' }, admin, { version: person.version }), 409);
  denied(() => workspace.createAsset({ ref: 'PC-1042', name: 'Duplicate' }, admin), 409);
  denied(() => workspace.createAsset({ ref: 'BAD REF', name: 'Invalid' }, admin), 400);
});

test('personnel identifiers and names do not leak through readable equipment ownership', async t => {
  const { workspace, admin, other } = await fixture(t);
  const privateCategory = workspace.createCategory({ name: 'People', kind: 'assets', visibility: 'restricted', allow_staff_edit: false }, admin);
  const person = workspace.createAsset({ ref: 'person-1', name: 'Restricted Person', type: 'personnel', category_id: privateCategory.id }, admin);
  const pc = workspace.createAsset({ ref: 'PC-1', name: 'Shared workstation', type: 'pc', owner_id: person.id }, admin);
  const visible = workspace.getAsset(pc.id, other);
  assert.equal(visible.owner, null); assert.equal(visible.owner_id, null); assert.equal(visible.owner_name, '');
  assert.equal(workspace.listAssets(other, { search: 'Restricted Person' }).total, 0);
  assert.equal(workspace.listAssets(other, { type: 'personnel' }).total, 0);
  denied(() => workspace.getAsset(person.id, other));
});

test('ticket and asset history is linked in both directions without duplicate audit records', async t => {
  const { workspace, admin, reader, desk, ticket } = await fixture(t);
  ticket('HD-123', 'Screen flickers'); ticket('HD-456', 'Dock issue');
  const asset = workspace.createAsset({ ref: 'ABC', name: 'Main workstation', type: 'pc' }, admin);
  assert.equal(workspace.linkTicket('HD-123', asset.id, reader).duplicate, false);
  assert.equal(workspace.linkTicket('HD-123', asset.id, reader).duplicate, true);
  workspace.linkTicket('HD-456', asset.ref, reader);
  assert.deepEqual(new Set(workspace.getAsset(asset.id, reader).tickets.map(t => t.key)), new Set(['HD-123', 'HD-456']));
  assert.equal(workspace.ticketAssets('HD-123', reader)[0].ref, 'ABC');
  assert.equal(workspace.relatedTickets('HD-123', reader)[0].key, 'HD-456');
  assert.equal(desk.getTicket('HD-123').events.filter(e => e.type === 'asset_link').length, 1);
});

test('restricted asset categories hide records, backlinks and related-asset discovery', async t => {
  const { workspace, admin, reader, other, ticket } = await fixture(t);
  ticket('HD-PRIVATE-1'); ticket('HD-PRIVATE-2');
  const category = workspace.createCategory({ name: 'Restricted servers', kind: 'assets', visibility: 'restricted', reader_ids: [reader.id], allow_staff_edit: false }, admin);
  const asset = workspace.createAsset({ ref: 'SRV-99', name: 'Payroll server', type: 'server', category_id: category.id }, admin);
  workspace.linkTicket('HD-PRIVATE-1', asset.id); workspace.linkTicket('HD-PRIVATE-2', asset.id);
  assert.equal(workspace.ticketAssets('HD-PRIVATE-1', reader).length, 1);
  assert.equal(workspace.ticketAssets('HD-PRIVATE-1', other).length, 0);
  assert.equal(workspace.relatedTickets('HD-PRIVATE-1', other).length, 0);
  assert.equal(workspace.listAssets(other).total, 0);
  denied(() => workspace.getAsset(asset.ref, other));
  denied(() => workspace.linkTicket('HD-PRIVATE-1', asset.id, other));
  denied(() => workspace.linkTicket('HD-PRIVATE-1', asset.id, reader), 403);
});

test('automatic email assets infer record types and never overwrite maintained details', async t => {
  const { workspace, admin } = await fixture(t);
  const original = workspace.upsertAutoAsset('laptop-200');
  assert.equal(original.type, 'laptop');
  const edited = workspace.updateAsset(original.id, { name: 'Executive laptop', owner_name: 'Taylor', location: 'HQ' }, admin, { version: 1 });
  const reused = workspace.upsertAutoAsset('LAPTOP-200', { name: 'Do not replace' });
  assert.equal(reused.id, original.id);
  assert.equal(workspace.getAsset(reused.id, admin).name, edited.name);
  assert.equal(workspace.upsertAutoAsset('PERSON-2').type, 'personnel');
  assert.equal(workspace.upsertAutoAsset('PC-3').type, 'pc');
  assert.equal(workspace.upsertAutoAsset('PRINTER-4').type, 'printer');
});

test('one-time legacy asset migration preserves ticket links without recreating renamed references', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-native-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  let store = new Store(filename), desk = new DeskStore(store);
  store.saveTicket({ key: 'HD-LEGACY', requester: 'legacy@example.test', subject: 'Old ticket', page_id: 12, page_url: 'http://wiki/link/12' });
  store.db.prepare('INSERT INTO ticket_assets (ticket_key,ref,page_id,url) VALUES (?,?,?,?)').run('HD-LEGACY', 'PC-OLD', 44, 'http://wiki/link/44');
  let workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Admin', email: 'legacy-admin@example.test', password: 'Legacy admin password 2026' });
  const imported = workspace.getAsset('PC-OLD', admin);
  assert.equal(imported.tickets[0].key, 'HD-LEGACY');
  workspace.updateAsset(imported.id, { ref: 'PC-NEW' }, admin, { version: imported.version });
  store.close();
  store = new Store(filename); desk = new DeskStore(store); workspace = new WorkspaceStore(desk);
  t.after(() => store.close());
  assert.equal(workspace.listAssets(admin).total, 1);
  assert.equal(workspace.getAsset('PC-NEW', admin).tickets[0].key, 'HD-LEGACY');
  denied(() => workspace.getAsset('PC-OLD', admin));
});

test('media authorization follows asset category changes and prevents parentless data access', async t => {
  const { workspace, admin, reader } = await fixture(t);
  const asset = workspace.createAsset({ ref: 'PC-IMG', name: 'Hardware photo', type: 'pc' }, admin);
  const image = workspace.addMedia({ asset_id: asset.id, filename: 'hardware.jpg', mime: 'image/jpeg', data: Buffer.from('image fixture') }, admin);
  assert.ok(workspace.getMedia(image.id, reader).data.length);
  const category = workspace.createCategory({ name: 'Sensitive hardware', kind: 'assets', visibility: 'restricted' }, admin);
  workspace.updateAsset(asset.id, { category_id: category.id }, admin, { version: asset.version });
  denied(() => workspace.getMedia(image.id, reader));
  workspace.db.prepare('UPDATE workspace_media SET asset_id=NULL WHERE id=?').run(image.id);
  denied(() => workspace.getMedia(image.id, admin));
});
