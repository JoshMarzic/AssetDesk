import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, PASSWORD } from './native-browser-helper.mjs';

const north = 'North headquarters';
const west = 'West Campus';
const special = 'São Paulo, "Ops" & R&D';
const remote = 'Remote office';
const expectedTop = [north, west, 'East campus', 'Bravo lab', 'Charlie lab'];
const locationPanel = h => h.page.getByRole('region', { name: 'Show asset locations', exact: true });
const locationButton = (h, location) => locationPanel(h).getByRole('button', { name: 'Show location ' + location, exact: true });
const assetRefs = h => h.page.locator('#main-content .asset-card .asset-ref').allTextContents();
const quickLocations = h => locationPanel(h).locator('[data-asset-location-quick]').evaluateAll(buttons => buttons.map(button => button.dataset.assetLocationValue));

function clearFixtureLocations(h) {
  for (const asset of h.workspace.listAssets(h.admin, { limit: 100 }).assets) h.workspace.updateAsset(asset.id, { location: '', version: asset.version }, h.admin);
}
function rankedInventory(h) {
  clearFixtureLocations(h);
  let sequence = 0;
  const asset = (location, type, name, category_id = h.assetCategory.id) => h.workspace.createAsset({ ref: 'LOC-' + String(++sequence).padStart(3, '0'), name, type, location, category_id }, h.admin);
  for (const [location, people, equipment] of [[north, 3, 5], [west, 2, 4], ['East campus', 1, 3], ['Bravo lab', 0, 3], ['Charlie lab', 0, 3], [remote, 0, 2], [special, 0, 1]]) {
    for (let index = 0; index < people; index++) asset(location, 'personnel', `${location} employee ${index + 1}`);
    for (let index = 0; index < equipment; index++) asset(location, 'pc', `${location} workstation ${index + 1}`);
  }
  return asset;
}
async function navigateAssets(h) {
  if (await h.page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await h.page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await h.page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: 'Assets', exact: true }).click();
  await locationPanel(h).waitFor();
}
async function openAssets(h) { await signIn(h.page, h.origin); await navigateAssets(h); }
async function changeAssets(h, action) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/assets' && response.request().method() === 'GET');
  await action(); const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  const body = await response.json();
  await eventually(async () => JSON.stringify(await assetRefs(h)) === JSON.stringify(body.assets.map(asset => asset.ref)), 'The asset page must show the exact server-filtered location result.');
  return { body, url: new URL(response.url()) };
}
async function openMoreLocations(h) {
  const details = h.page.locator('#asset-more-locations');
  if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
  return details;
}
async function countOn(button) { return Number((await button.innerText()).match(/(\d+)\s*$/)?.[1]); }

test('Assets shows only the five most-used named locations, with ranked counts and remaining choices below', { timeout: 90000 }, async t => {
  const h = await harness(t); rankedInventory(h);
  await openAssets(h);
  assert.equal(await locationPanel(h).evaluate(node => node.previousElementSibling?.getAttribute('aria-label')), 'Show asset types');
  assert.deepEqual(await quickLocations(h), expectedTop);
  assert.equal(await countOn(locationButton(h, north)), 8);
  assert.equal(await countOn(locationButton(h, west)), 6);
  assert.equal(await locationButton(h, remote).isVisible(), false);
  assert.equal(await locationButton(h, special).isVisible(), false);
  let result = await changeAssets(h, () => locationButton(h, north).click());
  assert.deepEqual(JSON.parse(result.url.searchParams.get('locations')), [north]);
  assert.equal(result.body.total, 8); assert.ok(result.body.assets.every(asset => asset.location === north));
  result = await changeAssets(h, () => locationButton(h, west).click());
  assert.deepEqual(new Set(JSON.parse(result.url.searchParams.get('locations'))), new Set([north, west]));
  assert.equal(result.body.total, 14);
  assert.deepEqual(await quickLocations(h), expectedTop, 'Selecting a location must not hide other available location choices.');
  await h.page.screenshot({ path: '/tmp/assetdesk-assets-locations.png', fullPage: true });
  result = await changeAssets(h, () => h.page.getByRole('button', { name: 'Show Personnel', exact: true }).click());
  assert.equal(result.body.total, 5); assert.ok(result.body.assets.every(asset => asset.type === 'personnel' && [north, west].includes(asset.location)));
  assert.deepEqual(await quickLocations(h), [north, west, 'East campus']);
  await changeAssets(h, () => h.page.getByRole('button', { name: 'All types', exact: true }).click());
  await changeAssets(h, () => locationPanel(h).getByRole('button', { name: 'All locations', exact: true }).click());
  await openMoreLocations(h);
  result = await changeAssets(h, () => locationButton(h, special).click());
  assert.deepEqual(JSON.parse(result.url.searchParams.get('locations')), [special]);
  assert.equal(result.body.total, 1); assert.equal(result.body.assets[0].location, special);
  result = await changeAssets(h, () => locationPanel(h).getByRole('button', { name: 'Show assets without a location', exact: true }).click());
  assert.deepEqual(new Set(JSON.parse(result.url.searchParams.get('locations'))), new Set([special, '']));
  assert.equal(result.body.total, 7); assert.ok(result.body.assets.every(asset => [special, ''].includes(asset.location)));
  assert.equal(await h.page.locator('#main-content img').count(), 0);
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});

test('Location names and counts follow permissions, category and search, while selected zero-match choices remain removable', { timeout: 90000 }, async t => {
  const h = await harness(t), asset = rankedInventory(h);
  const hidden = 'Confidential payroll wing';
  for (let index = 0; index < 12; index++) asset(hidden, 'pc', `Private equipment ${index}`, h.privateAssetCategory.id);
  const loan = h.workspace.createCategory({ name: 'Loan inventory', kind: 'assets', visibility: 'all', allow_staff_edit: true }, h.admin);
  asset('Loan desk', 'personnel', 'Loan employee', loan.id); asset('Loan desk', 'pc', 'Loan workstation 1', loan.id); asset('Loan desk', 'pc', 'Loan workstation 2', loan.id);
  await openAssets(h);
  assert.equal((await quickLocations(h))[0], hidden);
  await changeAssets(h, () => locationButton(h, hidden).click());
  await h.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await h.page.getByLabel('Email address', { exact: true }).fill(h.casey.email);
  await h.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await h.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await h.page.getByRole('button', { name: 'Close ticket summary', exact: true }).click();
  await h.page.getByRole('complementary', { name: 'Main navigation' }).waitFor(); await navigateAssets(h);
  assert.equal(await locationPanel(h).getByRole('button', { name: 'All locations', exact: true }).getAttribute('aria-pressed'), 'true');
  await openMoreLocations(h);
  assert.doesNotMatch(await h.page.locator('#main-content').innerText(), /Confidential payroll wing|Private equipment|Restricted payroll/);
  assert.equal(await countOn(locationPanel(h).getByRole('button', { name: 'All locations', exact: true })), 34);
  await changeAssets(h, () => h.page.getByLabel('Knowledge category', { exact: true }).selectOption(loan.id));
  assert.deepEqual(await quickLocations(h), ['Loan desk']); assert.equal(await countOn(locationButton(h, 'Loan desk')), 3);
  await changeAssets(h, () => locationButton(h, 'Loan desk').click());
  await h.page.getByLabel('Search assets', { exact: true }).fill('Loan employee');
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  assert.equal(await countOn(locationButton(h, 'Loan desk')), 1);
  await h.page.getByRole('button', { name: 'Loan employee', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Loan employee', exact: true }).waitFor();
  const back = await changeAssets(h, () => h.page.getByRole('button', { name: 'Back to assets', exact: true }).click());
  assert.deepEqual(JSON.parse(back.url.searchParams.get('locations')), ['Loan desk']);
  assert.equal(await h.page.getByLabel('Knowledge category', { exact: true }).inputValue(), loan.id);
  assert.equal(await h.page.getByLabel('Search assets', { exact: true }).inputValue(), 'Loan employee');
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Clear filters', exact: true }).click());
  await openMoreLocations(h);
  await changeAssets(h, () => locationButton(h, remote).click());
  const empty = await changeAssets(h, () => h.page.getByRole('button', { name: 'Show Personnel', exact: true }).click());
  assert.equal(empty.body.total, 0);
  await openMoreLocations(h);
  assert.equal(await locationButton(h, remote).getAttribute('aria-pressed'), 'true');
  assert.equal(await countOn(locationButton(h, remote)), 0);
  let releaseRequest, interceptedRequest;
  const requestGate = new Promise(resolve => { releaseRequest = resolve; });
  const intercepted = new Promise(resolve => { interceptedRequest = resolve; });
  const holdAssets = async route => { interceptedRequest(); await requestGate; await route.continue(); };
  await h.page.route('**/api/desk/assets?**', holdAssets);
  let restored;
  try {
    restored = await changeAssets(h, async () => {
      await locationPanel(h).getByRole('button', { name: 'All locations', exact: true }).click();
      await intercepted;
      // Clearing the selection removes the zero-count row from current state,
      // while its old menu remains visible until the next response arrives.
      await h.page.getByLabel('Find a location', { exact: true }).fill('Remote');
      assert.equal(await locationButton(h, remote).isVisible(), true);
      assert.deepEqual(h.errors, [], 'Searching a still-visible menu must use the rows rendered with that menu.');
      releaseRequest();
    });
  } finally { releaseRequest(); await h.page.unroute('**/api/desk/assets?**', holdAssets); }
  assert.ok(restored.body.total > 0); assert.ok(restored.body.assets.every(asset => asset.type === 'personnel'));
  assert.equal(await h.page.getByRole('button', { name: 'Show Personnel', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.errors, []);
});

test('Location totals cover every page and location/type changes reset grouped pagination while record navigation preserves it', { timeout: 90000 }, async t => {
  const h = await harness(t); clearFixtureLocations(h);
  for (let index = 0; index < 33; index++) h.workspace.createAsset({ ref: 'BULK-PERSON-' + String(index).padStart(3, '0'), name: 'Bulk employee ' + index, type: 'personnel', location: 'Main warehouse' }, h.admin);
  for (let index = 0; index < 3; index++) h.workspace.createAsset({ ref: 'BULK-PC-' + index, name: 'Bulk workstation ' + index, type: 'pc', location: 'Main warehouse' }, h.admin);
  h.workspace.createAsset({ ref: 'BRANCH-PC', name: 'Branch workstation', type: 'pc', location: 'Branch office' }, h.admin);
  await openAssets(h);
  let result = await changeAssets(h, () => locationButton(h, 'Main warehouse').click());
  assert.equal(result.body.total, 36); assert.equal(result.body.assets.length, 30);
  assert.equal(await countOn(locationButton(h, 'Main warehouse')), 36);
  result = await changeAssets(h, () => h.page.getByRole('button', { name: 'Next assets', exact: true }).click());
  assert.equal(result.url.searchParams.get('offset'), '30'); assert.equal(result.body.assets.length, 6);
  assert.equal(await countOn(locationButton(h, 'Main warehouse')), 36);
  const refs = await assetRefs(h);
  await h.page.getByRole('button', { name: 'Bulk workstation 0', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Bulk workstation 0', exact: true }).waitFor();
  result = await changeAssets(h, () => h.page.getByRole('button', { name: 'Back to assets', exact: true }).click());
  assert.equal(result.url.searchParams.get('offset'), '30'); assert.deepEqual(await assetRefs(h), refs);
  assert.equal(await locationButton(h, 'Main warehouse').getAttribute('aria-pressed'), 'true');
  result = await changeAssets(h, () => h.page.getByRole('button', { name: 'Show Personnel', exact: true }).click());
  assert.equal(result.url.searchParams.get('offset'), '0'); assert.equal(result.body.total, 33);
  assert.equal(await countOn(locationButton(h, 'Main warehouse')), 33);
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Next assets', exact: true }).click());
  result = await changeAssets(h, () => locationPanel(h).getByRole('button', { name: 'All locations', exact: true }).click());
  assert.equal(result.url.searchParams.get('offset'), '0');
  assert.equal(result.url.searchParams.has('locations'), false);
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});

test('Mobile location buttons and the searchable overflow menu work with keyboard input without clipping long names', { timeout: 90000 }, async t => {
  const h = await harness(t, { mobile: true }), asset = rankedInventory(h);
  asset('An unusually long campus name with several buildings and a reception and service desk', 'pc', 'Long-name location workstation');
  await openAssets(h); await noOverflow(h.page);
  await openMoreLocations(h);
  const search = h.page.getByLabel('Find a location', { exact: true });
  await search.fill('São');
  await locationButton(h, special).waitFor();
  assert.equal(await locationButton(h, remote).isVisible(), false);
  await locationButton(h, special).focus();
  let result = await changeAssets(h, () => h.page.keyboard.press('Space'));
  assert.deepEqual(JSON.parse(result.url.searchParams.get('locations')), [special]); assert.equal(result.body.total, 1);
  await search.fill('');
  await locationPanel(h).getByRole('button', { name: 'All locations', exact: true }).focus();
  await changeAssets(h, () => h.page.keyboard.press('Enter'));
  await locationButton(h, north).focus(); await changeAssets(h, () => h.page.keyboard.press('Space'));
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Show Hardware', exact: true }).click());
  assert.ok((await assetRefs(h)).length > 0);
  await h.page.getByLabel('Search assets', { exact: true }).fill('A location query without matching assets');
  result = await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  assert.equal(result.body.total, 0); await noOverflow(h.page);
  await openMoreLocations(h);
  assert.equal(await locationButton(h, north).getAttribute('aria-pressed'), 'true');
  await h.page.getByLabel('Search assets', { exact: true }).fill('');
  await changeAssets(h, () => h.page.getByRole('button', { name: 'Search', exact: true }).click());
  await noOverflow(h.page); await h.page.screenshot({ path: '/tmp/assetdesk-assets-locations-mobile.png', fullPage: true });
  assert.deepEqual(h.errors, []);
});
