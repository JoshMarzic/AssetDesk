import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, PASSWORD } from './native-browser-helper.mjs';

const equipmentTypes = ['pc', 'laptop', 'server', 'printer', 'network', 'peripheral', 'hardware'];
const allTypes = ['personnel', ...equipmentTypes, 'other'];
const toggle = (h, name) => h.page.getByRole('button', { name: 'Show ' + name, exact: true });
const groupTypes = h => h.page.locator('[data-asset-group]').evaluateAll(nodes => nodes.map(node => node.dataset.assetGroup));
const assetRefs = h => h.page.locator('#main-content .asset-card .asset-ref').allTextContents();

function completeInventory(h) {
  for (const [type, ref, name] of [
    ['server', 'SRV-12', 'Application server'], ['printer', 'PRINTER-12', 'Reception printer'],
    ['network', 'SW-12', 'Office network switch'], ['hardware', 'HARDWARE-12', 'Equipment cabinet'],
    ['other', 'OTHER-12', 'Software entitlement record'],
  ]) h.workspace.createAsset({ ref, name, type, category_id: h.assetCategory.id }, h.admin);
}

async function navigateAssets(h) {
  if (await h.page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await h.page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await h.page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: 'Assets', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Assets', exact: true }).waitFor();
  await h.page.getByRole('button', { name: 'All types', exact: true }).waitFor();
}

async function openAssets(h, email) {
  await signIn(h.page, h.origin, email);
  await navigateAssets(h);
}

async function changeAssets(h, action) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/assets' && response.request().method() === 'GET');
  await action();
  const response = await pending; assert.equal(response.status(), 200, await response.text());
  const body = await response.json();
  await eventually(async () => JSON.stringify(await assetRefs(h)) === JSON.stringify(body.assets.map(asset => asset.ref)), 'The grouped inventory must show the exact server-filtered result page.');
  return { body, url: new URL(response.url()) };
}

async function assertCount(h, name, expected) {
  const text = await toggle(h, name).innerText();
  assert.equal(Number(text.match(/\d+/)?.[0]), expected, `The ${name} button count must use the current accessible search scope.`);
}

test('Assets groups inventory by type and combines Personnel with all hardware or individual equipment types', { timeout: 90000 }, async t => {
  const h = await harness(t); completeInventory(h);
  await openAssets(h);
  assert.deepEqual(await groupTypes(h), allTypes);
  assert.equal(await h.page.getByRole('button', { name: 'All types', exact: true }).getAttribute('aria-pressed'), 'true');
  let result = await changeAssets(h, () => toggle(h, 'Personnel').click());
  assert.equal(result.url.searchParams.get('types'), 'personnel');
  assert.equal(result.url.searchParams.get('sort'), 'type');
  assert.deepEqual(await groupTypes(h), ['personnel']);
  assert.ok(result.body.assets.every(asset => asset.type === 'personnel'));
  result = await changeAssets(h, () => toggle(h, 'Hardware').click());
  assert.deepEqual(new Set(result.url.searchParams.get('types').split(',')), new Set(['personnel', ...equipmentTypes]));
  assert.deepEqual(await groupTypes(h), ['personnel', ...equipmentTypes]);
  assert.equal(await toggle(h, 'Hardware').getAttribute('aria-pressed'), 'true');
  await h.page.screenshot({ path: '/tmp/assetdesk-assets-grouped.png', fullPage: true });
  result = await changeAssets(h, () => toggle(h, 'Personnel').click());
  assert.deepEqual(await groupTypes(h), equipmentTypes);
  assert.ok(result.body.assets.every(asset => equipmentTypes.includes(asset.type)));
  await changeAssets(h, () => toggle(h, 'Hardware').click());
  assert.deepEqual(await groupTypes(h), allTypes, 'Removing the final explicit selection restores All types.');
  await changeAssets(h, () => toggle(h, 'Personnel').click());
  await h.page.locator('details').filter({ has: h.page.locator('summary', { hasText: 'Hardware types' }) }).locator('summary').click();
  result = await changeAssets(h, () => toggle(h, 'PCs').click());
  assert.deepEqual(new Set(result.url.searchParams.get('types').split(',')), new Set(['personnel', 'pc']));
  assert.deepEqual(await groupTypes(h), ['personnel', 'pc']);
  assert.equal(await toggle(h, 'Hardware').getAttribute('aria-pressed'), 'mixed');
  assert.equal(await toggle(h, 'PCs').getAttribute('aria-pressed'), 'true');
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});

test('Asset type counts follow category permissions and search, and a new login clears the previous user’s selections', { timeout: 90000 }, async t => {
  const h = await harness(t);
  const lab = h.workspace.createCategory({ name: 'Lab inventory', kind: 'assets', visibility: 'all', allow_staff_edit: true }, h.admin);
  h.workspace.createAsset({ ref: 'PERSON-LAB', name: 'Lab colleague', type: 'personnel', category_id: lab.id }, h.admin);
  h.workspace.createAsset({ ref: 'PC-LAB', name: 'Lab workstation', type: 'pc', category_id: lab.id }, h.admin);
  for (let index = 0; index < 3; index++) h.workspace.createAsset({ ref: 'PERSON-HIDDEN-' + index, name: 'Hidden payroll employee ' + index, type: 'personnel', category_id: h.privateAssetCategory.id }, h.admin);
  await openAssets(h);
  await changeAssets(h, () => toggle(h, 'Personnel').click());
  assert.equal(await toggle(h, 'Personnel').getAttribute('aria-pressed'), 'true');
  await h.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await h.page.getByLabel('Email address', { exact: true }).fill(h.casey.email);
  await h.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await h.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await h.page.getByRole('complementary', { name: 'Main navigation' }).waitFor();
  await navigateAssets(h);
  assert.equal(await h.page.getByRole('button', { name: 'All types', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await toggle(h, 'Personnel').getAttribute('aria-pressed'), 'false');
  await assertCount(h, 'Personnel', 2); await assertCount(h, 'Hardware', 4); await assertCount(h, 'Other', 0);
  assert.doesNotMatch(await h.page.locator('#main-content').innerText(), /Hidden payroll|Restricted employee|Restricted payroll|PERSON-PRIVATE|PC-PRIVATE/);
  const categories = await h.page.getByLabel('Knowledge category', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value));
  assert.ok(!categories.includes(h.privateAssetCategory.id));
  await h.page.getByLabel('Search assets', { exact: true }).fill('SERIAL-1042');
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  assert.deepEqual(await groupTypes(h), ['laptop']);
  await assertCount(h, 'Personnel', 0); await assertCount(h, 'Hardware', 1);
  await changeAssets(h, () => toggle(h, 'Personnel').click());
  assert.deepEqual(await assetRefs(h), []);
  await assertCount(h, 'Hardware', 1);
  await changeAssets(h, () => toggle(h, 'Hardware').click());
  assert.deepEqual(await groupTypes(h), ['laptop']);
  await h.page.getByLabel('Search assets', { exact: true }).fill('');
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  await changeAssets(h, () => h.page.getByLabel('Knowledge category', { exact: true }).selectOption(lab.id));
  assert.deepEqual(await groupTypes(h), ['personnel', 'pc']);
  await assertCount(h, 'Personnel', 1); await assertCount(h, 'Hardware', 1);
  await changeAssets(h, () => toggle(h, 'Hardware').click());
  await h.page.getByRole('button', { name: 'Lab colleague', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Lab colleague', exact: true }).waitFor();
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Back to assets', exact: true }).click());
  assert.equal(await h.page.getByLabel('Knowledge category', { exact: true }).inputValue(), lab.id);
  assert.equal(await toggle(h, 'Personnel').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await assetRefs(h), ['PERSON-LAB']);
  assert.deepEqual(h.errors, []);
});

test('Grouped multi-type pagination filters all records on the server and preserves the selected page around asset details', { timeout: 90000 }, async t => {
  const h = await harness(t);
  for (let index = 0; index < 33; index++) h.workspace.createAsset({ ref: 'PERSON-BULK-' + String(index).padStart(3, '0'), name: 'Inventory employee ' + index, type: 'personnel', category_id: h.assetCategory.id }, h.admin);
  await openAssets(h);
  await changeAssets(h, () => toggle(h, 'Personnel').click());
  await h.page.locator('summary').filter({ hasText: 'Hardware types' }).click();
  await changeAssets(h, () => toggle(h, 'PCs').click());
  assert.equal((await assetRefs(h)).length, 30);
  assert.deepEqual(await groupTypes(h), ['personnel']);
  const second = await changeAssets(h, () => h.page.getByRole('button', { name: 'Next assets', exact: true }).click());
  assert.equal(second.body.total, 37); assert.equal(second.url.searchParams.get('offset'), '30');
  assert.equal(second.body.assets.length, 7); assert.deepEqual(await groupTypes(h), ['personnel', 'pc']);
  const refs = await assetRefs(h);
  await h.page.getByRole('button', { name: 'Shared support workstation', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Shared support workstation', exact: true }).waitFor();
  const back = await changeAssets(h, () => h.page.getByRole('button', { name: 'Back to assets', exact: true }).click());
  assert.equal(back.url.searchParams.get('offset'), '30'); assert.deepEqual(await assetRefs(h), refs);
  assert.equal(await toggle(h, 'Personnel').getAttribute('aria-pressed'), 'true');
  assert.equal(await h.page.getByRole('button', { name: 'Next assets', exact: true }).isDisabled(), true);
  const reset = await changeAssets(h, () => toggle(h, 'Hardware').click());
  assert.equal(reset.url.searchParams.get('offset'), '0');
  assert.equal(reset.body.total, 39); assert.equal((await assetRefs(h)).length, 30);
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});

test('Mobile asset type buttons work with the keyboard, wrap without overflow, and recover from empty filtered searches', { timeout: 90000 }, async t => {
  const h = await harness(t, { mobile: true }); completeInventory(h);
  await openAssets(h);
  await toggle(h, 'Personnel').focus();
  await changeAssets(h, () => h.page.keyboard.press('Space'));
  assert.deepEqual(await groupTypes(h), ['personnel']);
  await toggle(h, 'Hardware').focus();
  await changeAssets(h, () => h.page.keyboard.press('Enter'));
  assert.deepEqual(await groupTypes(h), ['personnel', ...equipmentTypes]);
  await h.page.locator('summary').filter({ hasText: 'Hardware types' }).click();
  await noOverflow(h.page);
  await h.page.getByLabel('Search assets', { exact: true }).fill('No matching asset anywhere');
  const empty = await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  assert.equal(empty.body.total, 0); assert.equal((await assetRefs(h)).length, 0);
  assert.equal(await toggle(h, 'Personnel').getAttribute('aria-pressed'), 'true');
  assert.equal(await toggle(h, 'Hardware').getAttribute('aria-pressed'), 'true');
  await noOverflow(h.page);
  await h.page.getByLabel('Search assets', { exact: true }).fill('');
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  assert.deepEqual(await groupTypes(h), ['personnel', ...equipmentTypes]);
  await noOverflow(h.page); await h.page.screenshot({ path: '/tmp/assetdesk-assets-mobile.png', fullPage: true });
  assert.deepEqual(h.errors, []);
});
