import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow } from './native-browser-helper.mjs';

const DAY = '2026-10-04';

function seedTicket(h, key, fields = {}) {
  const defaults = { subject: 'Report Ω workstation outage', requester: 'reporter@example.test', requester_name: 'Report requester',
    description: 'First line\nSecond "quoted" line, Ω.', category: 'hardware', priority: 'high', status: 'open', source: 'manual',
    assignee_id: h.avery.id, created_at: `${DAY}T12:00:00.000Z` };
  const row = { ...defaults, ...fields };
  h.store.saveTicket({ key, requester: row.requester, subject: row.subject, page_id: 0, page_url: '', created_at: row.created_at });
  h.desk.captureEmail(key, { text: row.description, from: { address: row.requester, name: row.requester_name }, receivedAt: row.created_at,
    desk: { priority: row.priority, category: row.category, assignee_id: row.assignee_id } }, { receiptId: `report-fixture-${key}`, source: row.source });
  h.store.db.prepare('UPDATE tickets SET status=?,created_at=?,updated_at=? WHERE key=?').run(row.status, row.created_at, row.created_at, key);
  return { key, ...row };
}

async function openReports(h) {
  await signIn(h.page, h.origin);
  const navigation = h.page.getByRole('complementary', { name: 'Main navigation' });
  const order = await navigation.locator('.nav-item').allTextContents();
  assert.equal(order.findIndex(value => value.trim() === 'Reports'), order.findIndex(value => value.trim() === 'Actions') + 1);
  if (await h.page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) {
    await h.page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  }
  await navigation.getByRole('button', { name: 'Reports', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Reports', exact: true }).waitFor();
  await h.page.getByRole('table', { name: 'Report tickets', exact: true }).waitFor();
  return h.page.getByRole('form', { name: 'Ticket report filters', exact: true });
}

async function submitSearch(h, form) {
  const response = h.page.waitForResponse(result => new URL(result.url()).pathname === '/api/desk/reports/tickets' && result.request().method() === 'GET');
  await form.getByRole('button', { name: 'Search tickets', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 200);
  const body = await result.json();
  await h.page.waitForLoadState('networkidle');
  return body;
}

function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (row.length || value) { row.push(value); rows.push(row); }
  assert.equal(quoted, false, 'Export must contain valid quoted CSV fields.');
  return rows;
}

async function downloadCsv(h) {
  const pending = h.page.waitForEvent('download');
  await h.page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.csv$/i);
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');
  assert.ok(csv.startsWith('\uFEFF'), 'Export should open as UTF-8 in spreadsheet applications.');
  return parseCsv(csv);
}

test('Reports combines ticket metrics and inclusive submission dates while preserving the search around ticket details', { timeout: 90000 }, async t => {
  const h = await harness(t);
  const match = seedTicket(h, 'HD-RPT-MATCH', { created_at: `${DAY}T23:59:59.999Z` });
  seedTicket(h, 'HD-RPT-BEFORE', { created_at: '2026-10-03T23:59:59.999Z' });
  seedTicket(h, 'HD-RPT-AFTER', { created_at: '2026-10-05T00:00:00.000Z' });
  seedTicket(h, 'HD-RPT-TYPE', { category: 'software' });
  seedTicket(h, 'HD-RPT-STATUS', { status: 'waiting' });
  seedTicket(h, 'HD-RPT-TECH', { assignee_id: h.casey.id });
  seedTicket(h, 'HD-RPT-SOURCE', { source: 'email' });
  seedTicket(h, 'HD-RPT-PRIORITY', { priority: 'normal' });
  for (const ticket of h.store.db.prepare("SELECT key FROM tickets WHERE key LIKE 'HD-RPT-%'").all()) {
    h.workspace.linkTicket(ticket.key, h.laptop.id, h.admin);
  }
  const form = await openReports(h);
  await form.getByLabel('Search tickets', { exact: true }).fill('Report Ω');
  await form.getByLabel('Date field', { exact: true }).selectOption('created_at');
  await form.getByLabel('From date (UTC)', { exact: true }).fill(DAY);
  await form.getByLabel('Through date (UTC)', { exact: true }).fill(DAY);
  await form.getByLabel('Type / category', { exact: true }).selectOption('hardware');
  await form.getByLabel('Status', { exact: true }).selectOption('open');
  await form.getByLabel('Priority', { exact: true }).selectOption('high');
  await form.getByLabel('Technician', { exact: true }).selectOption(h.avery.id);
  await form.getByLabel('Source', { exact: true }).selectOption('manual');
  await form.getByLabel('Linked asset', { exact: true }).fill(h.laptop.ref);
  const results = await submitSearch(h, form);
  assert.equal(results.total, 1); assert.equal(results.tickets[0].key, match.key);
  const table = h.page.getByRole('table', { name: 'Report tickets', exact: true });
  assert.equal(await table.locator('tbody tr').count(), 1);
  await h.page.screenshot({ path: '/tmp/assetdesk-reports-desktop.png', fullPage: true });
  await table.getByRole('button', { name: match.subject, exact: true }).click();
  const drawer = h.page.getByRole('dialog', { name: 'Ticket details', exact: true });
  await drawer.getByRole('heading', { name: match.subject, exact: true }).waitFor();
  await drawer.getByRole('button', { name: 'Close ticket details', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(new URL(h.page.url()).hash, '#reports');
  assert.equal(await form.getByLabel('From date (UTC)', { exact: true }).inputValue(), DAY);
  assert.equal(await form.getByLabel('Technician', { exact: true }).inputValue(), h.avery.id);
  const csv = await downloadCsv(h);
  assert.equal(csv.length, 2); assert.ok(csv[1].includes(match.key));
  assert.deepEqual(h.errors, []);
});

test('CSV downloads every applied match across pages and preserves quoted Unicode text while drafts, empty results and failures stay clear', { timeout: 90000 }, async t => {
  const h = await harness(t);
  const records = Array.from({ length: 32 }, (_, index) => seedTicket(h, `HD-RPT-CSV-${String(index).padStart(2, '0')}`,
    { subject: `=SUM(1,2) Report Ω "quoted" ${String(index).padStart(2, '0')}` }));
  const form = await openReports(h);
  await form.getByLabel('Search tickets', { exact: true }).fill('Report Ω');
  await h.page.getByLabel('Results per page', { exact: true }).selectOption('25');
  await h.page.waitForLoadState('networkidle');
  const results = await submitSearch(h, form); assert.equal(results.total, 32);
  const table = h.page.getByRole('table', { name: 'Report tickets', exact: true });
  assert.equal(await table.locator('tbody tr').count(), 25);
  const firstSubject = await table.locator('tbody tr').first().textContent();
  await h.page.getByRole('button', { name: 'Next report page', exact: true }).click();
  await eventually(async () => await table.locator('tbody tr').first().textContent() !== firstSubject, 'The next page must show a different matching ticket.');
  await form.getByLabel('Search tickets', { exact: true }).fill('Unsubmitted draft with no matching ticket');
  const csv = await downloadCsv(h);
  assert.equal(csv.length, records.length + 1, 'CSV must include all matches, including rows outside the current page.');
  const body = csv.slice(1);
  assert.ok(records.every(record => body.some(row => row.includes(record.key))), 'Every matching ticket must be exported once.');
  assert.ok(body.some(row => row.includes("'" + records[0].subject)), 'Spreadsheet formulas must be neutralized without losing quoted Unicode text.');
  assert.ok(body.some(row => row.includes(records[0].description)), 'Embedded newlines and commas must remain within one description field.');
  const empty = await submitSearch(h, form); assert.equal(empty.total, 0);
  await h.page.getByText('No tickets match this search.', { exact: true }).waitFor();
  await form.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await h.page.waitForLoadState('networkidle');
  await table.waitFor();
  assert.equal(await form.getByLabel('Search tickets', { exact: true }).inputValue(), '');
  await h.page.route('**/api/desk/reports/tickets?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Reports are temporarily unavailable.' }) }), { times: 1 });
  await form.getByRole('button', { name: 'Search tickets', exact: true }).click();
  await h.page.getByText('Reports are temporarily unavailable.', { exact: true }).waitFor();
  assert.deepEqual(h.errors, []);
});

test('Reports search and advanced metrics fit mobile and restore through the native route', { timeout: 60000 }, async t => {
  const h = await harness(t, { mobile: true });
  seedTicket(h, 'HD-RPT-MOBILE');
  const form = await openReports(h);
  await noOverflow(h.page);
  await form.locator('summary').filter({ hasText: 'Advanced filters' }).click();
  await form.getByLabel('Ticket ID', { exact: true }).fill('HD-RPT-MOBILE');
  await form.getByLabel('Asset type', { exact: true }).selectOption('laptop');
  await form.getByLabel('Asset type', { exact: true }).selectOption('');
  await form.getByLabel('Response SLA', { exact: true }).selectOption('overdue');
  const results = await submitSearch(h, form); assert.equal(results.total, 1);
  await noOverflow(h.page);
  await h.page.screenshot({ path: '/tmp/assetdesk-reports-mobile.png', fullPage: true });
  await h.page.reload();
  await h.page.getByRole('heading', { name: 'Reports', exact: true }).waitFor();
  await h.page.getByRole('table', { name: 'Report tickets', exact: true }).waitFor();
  assert.equal(new URL(h.page.url()).hash, '#reports');
  await noOverflow(h.page);
  assert.deepEqual(h.errors, []);
});
