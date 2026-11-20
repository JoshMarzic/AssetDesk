import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, TARGET_KEY } from './native-browser-helper.mjs';

async function openTicket(h, key = TARGET_KEY) {
  if (new URL(h.page.url()).hash === `#tickets/${key}`) {
    await h.page.getByRole('region', { name: 'Ticket queue' }).getByRole('button', { name: h.desk.getTicket(key).subject, exact: true }).click();
  } else await h.page.goto(`${h.origin}/#tickets/${key}`);
  const drawer = h.page.getByRole('dialog', { name: 'Ticket details' });
  await drawer.getByLabel('Add ticket tag', { exact: true }).waitFor();
  return drawer;
}

async function enterTag(h, scope, label, value) {
  const input = scope.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
  await h.page.waitForLoadState('networkidle');
}

async function reportSearch(h, form) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/reports/tickets' && response.request().method() === 'GET');
  await form.getByRole('button', { name: 'Search tickets', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const data = await response.json();
  await h.page.waitForLoadState('networkidle');
  return data;
}

function parseCsv(source) {
  source = source.replace(/^\uFEFF/, '');
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if (char === '\r' && source[i + 1] === '\n' && !quoted) { row.push(value); rows.push(row); row = []; value = ''; i++; }
    else value += char;
  }
  assert.equal(quoted, false);
  if (row.length || value) { row.push(value); rows.push(row); }
  return rows;
}

test('ticket tags save on Enter, normalize duplicates and preserve unsaved technician work', { timeout: 90000 }, async t => {
  const h = await harness(t);
  await signIn(h.page, h.origin);
  const drawer = await openTicket(h);
  await drawer.getByLabel('Internal note', { exact: true }).fill('Draft: contact the requester before replacing hardware.');
  await drawer.getByLabel('Priority', { exact: true }).selectOption('urgent');
  const before = h.desk.getTicket(TARGET_KEY);
  h.desk.updateTicket(TARGET_KEY, { assignee_id: h.casey.id }, { actor: h.avery, version: before.version });
  await enterTag(h, drawer, 'Add ticket tag', 'Needs follow-up');
  await drawer.getByRole('button', { name: 'Remove tag Needs follow-up', exact: true }).waitFor();
  assert.deepEqual(h.desk.ticketTags(TARGET_KEY), ['Needs follow-up']);
  assert.equal(h.desk.getTicket(TARGET_KEY).priority, before.priority, 'Enter in Tags must not submit the ticket update form.');
  assert.equal(h.desk.getTicket(TARGET_KEY).notes.length, before.notes.length, 'Enter in Tags must not post the note draft.');
  assert.equal(await drawer.getByLabel('Internal note', { exact: true }).inputValue(), 'Draft: contact the requester before replacing hardware.');
  assert.equal(await drawer.getByLabel('Assigned technician', { exact: true }).inputValue(), h.casey.id, 'Tag saves must adopt a teammate’s changes to fields the user has not edited.');
  assert.equal(await drawer.getByLabel('Priority', { exact: true }).inputValue(), 'urgent');
  await drawer.getByLabel('Assigned technician', { exact: true }).selectOption(h.avery.id);
  await enterTag(h, drawer, 'Add ticket tag', '  NEEDS   FOLLOW-UP  ');
  assert.deepEqual(h.desk.ticketTags(TARGET_KEY), ['Needs follow-up']);
  assert.equal(await drawer.getByRole('button', { name: 'Remove tag Needs follow-up', exact: true }).count(), 1);
  assert.equal(await drawer.getByLabel('Assigned technician', { exact: true }).inputValue(), h.avery.id, 'An intentionally edited assignment must remain a local draft until Save changes.');
  await enterTag(h, drawer, 'Add ticket tag', 'VIP');
  await drawer.getByRole('button', { name: 'Remove tag VIP', exact: true }).waitFor();
  await h.page.screenshot({ path: '/tmp/assetdesk-ticket-tags-desktop.png', fullPage: true });
  const unsafe = '<img src=x onerror=alert(1)>';
  const dialogs = [];
  h.page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await enterTag(h, drawer, 'Add ticket tag', unsafe);
  await drawer.getByRole('button', { name: `Remove tag ${unsafe}`, exact: true }).waitFor();
  assert.equal(await drawer.locator('img[onerror]').count(), 0);
  assert.deepEqual(dialogs, []);
  await drawer.getByRole('button', { name: `Remove tag ${unsafe}`, exact: true }).click();
  await eventually(() => !h.desk.ticketTags(TARGET_KEY).includes(unsafe), 'Tags must be removable without submitting other ticket fields.');
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await eventually(() => h.desk.getTicket(TARGET_KEY).priority === 'urgent' && h.desk.getTicket(TARGET_KEY).assignee_id === h.avery.id, 'Tag updates must refresh the version used to save pending triage.');
  await h.page.waitForLoadState('networkidle');
  await drawer.getByRole('button', { name: 'Remove tag Needs follow-up', exact: true }).click();
  await eventually(() => !h.desk.ticketTags(TARGET_KEY).includes('Needs follow-up'), 'Removing a chip must persist immediately.');
  await h.page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await openTicket(h);
  await drawer.getByRole('button', { name: 'Remove tag VIP', exact: true }).waitFor();
  assert.equal(await drawer.getByRole('button', { name: 'Remove tag Needs follow-up', exact: true }).count(), 0);
  assert.deepEqual(h.desk.ticketTags(TARGET_KEY), ['VIP']);
  assert.deepEqual(h.errors, []);
});

test('new ticket tags support Enter and reuse, then Reports searches and exports the exact tag', { timeout: 90000 }, async t => {
  const h = await harness(t);
  h.desk.addTicketTag('HD-BROWSER001', 'VIP', h.admin);
  await signIn(h.page, h.origin);
  await h.page.getByRole('button', { name: 'New ticket', exact: true }).first().click();
  const modal = h.page.getByRole('dialog', { name: 'Workspace form' });
  await modal.getByLabel('Subject', { exact: true }).fill('Prepare a tagged new-starter workstation');
  await modal.getByLabel('Requester email', { exact: true }).fill('starter@example.test');
  await modal.getByLabel('Description', { exact: true }).fill('Prepare the equipment and confirm the handover.');
  const count = h.store.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count;
  await modal.getByLabel('New ticket tag', { exact: true }).fill('vi');
  await modal.locator('#new-ticket-tag-suggestions option[value="VIP"]').waitFor({ state: 'attached' });
  await enterTag(h, modal, 'New ticket tag', 'VIP');
  await modal.getByRole('button', { name: 'Remove tag VIP', exact: true }).waitFor();
  await enterTag(h, modal, 'New ticket tag', 'Onboarding, café');
  await modal.getByRole('button', { name: 'Remove tag Onboarding, café', exact: true }).waitFor();
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count, count, 'Entering tags must not create the ticket before Create ticket is selected.');
  assert.ok(await modal.isVisible());
  const created = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/tickets' && response.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Create ticket', exact: true }).click();
  const accepted = await created; assert.equal(accepted.status(), 202);
  const receipt = await accepted.json(); assert.ok(receipt.ticketKey);
  const drawer = h.page.getByRole('dialog', { name: 'Ticket details' });
  await drawer.getByRole('heading', { name: 'Prepare a tagged new-starter workstation', exact: true }).waitFor();
  assert.deepEqual(h.desk.ticketTags(receipt.ticketKey), ['Onboarding, café', 'VIP']);
  await h.page.keyboard.press('Escape');
  await h.page.getByRole('button', { name: 'Reports', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Reports', exact: true }).waitFor();
  const form = h.page.getByRole('form', { name: 'Ticket report filters', exact: true });
  await form.getByLabel('Tag', { exact: true }).fill('  ONBOARDING, CAFÉ  ');
  await form.getByLabel('Type / category', { exact: true }).selectOption('general');
  let results = await reportSearch(h, form);
  assert.equal(results.total, 1); assert.equal(results.tickets[0].key, receipt.ticketKey);
  assert.deepEqual(results.tickets[0].tags, ['Onboarding, café', 'VIP']);
  const pending = h.page.waitForEvent('download');
  await h.page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const download = await pending; const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const rows = parseCsv(Buffer.concat(chunks).toString('utf8'));
  assert.equal(rows.length, 2); assert.equal(rows[1][rows[0].indexOf('Ticket ID')], receipt.ticketKey);
  const tags = rows[1][rows[0].indexOf('Tags')]; assert.ok(tags.includes('Onboarding, café')); assert.ok(tags.includes('VIP'));
  await form.getByLabel('Tag', { exact: true }).fill('');
  await form.getByLabel('Search tickets', { exact: true }).fill('café');
  results = await reportSearch(h, form);
  assert.equal(results.total, 1); assert.equal(results.tickets[0].key, receipt.ticketKey);
  assert.deepEqual(h.errors, []);
});

test('ticket tag entry and removal fit mobile', { timeout: 60000 }, async t => {
  const h = await harness(t, { mobile: true });
  await signIn(h.page, h.origin);
  const drawer = await openTicket(h);
  await enterTag(h, drawer, 'Add ticket tag', 'Remote support');
  await drawer.getByRole('button', { name: 'Remove tag Remote support', exact: true }).waitFor();
  assert.deepEqual(h.desk.ticketTags(TARGET_KEY), ['Remote support']);
  await noOverflow(h.page);
  await h.page.screenshot({ path: '/tmp/assetdesk-ticket-tags-mobile.png', fullPage: true });
  await drawer.getByRole('button', { name: 'Remove tag Remote support', exact: true }).click();
  await eventually(() => h.desk.ticketTags(TARGET_KEY).length === 0, 'Mobile users must be able to remove a saved tag.');
  await noOverflow(h.page);
  assert.deepEqual(h.errors, []);
});
