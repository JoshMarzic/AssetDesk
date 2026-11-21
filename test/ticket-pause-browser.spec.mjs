import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, TARGET_KEY } from './native-browser-helper.mjs';

const subject = 'Laptop display flickers on LAPTOP-1042';
const drawerFor = h => h.page.getByRole('dialog', { name: 'Ticket details', exact: true });
const queueFor = h => h.page.getByRole('region', { name: 'Ticket queue', exact: true });
const pauseField = scope => scope.getByLabel('Start or delay until', { exact: true });
const nextYear = new Date().getUTCFullYear() + 1;
const localDate = `${nextYear}-11-20T09:30`;
const utcDate = `${nextYear}-11-20T14:30:00.000Z`;

async function openTicket(h, key = TARGET_KEY) {
  await h.page.goto(`${h.origin}/#tickets/${key}`);
  const drawer = drawerFor(h);
  await pauseField(drawer).waitFor();
  return drawer;
}

async function saveTicket(h, drawer) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === `/api/desk/tickets/${TARGET_KEY}` && response.request().method() === 'PATCH');
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  await h.page.waitForLoadState('networkidle');
  return response.json();
}

async function chooseView(h, name) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/tickets' && response.request().method() === 'GET');
  await queueFor(h).getByRole('tab', { name, exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  await h.page.waitForLoadState('networkidle');
}

test('a local pause date saves in UTC and hides tickets from the dashboard until Paused is selected', { timeout: 60000 }, async t => {
  const h = await harness(t, { timezoneId: 'America/New_York' });
  await signIn(h.page, h.origin);
  const drawer = await openTicket(h);
  assert.equal(await pauseField(drawer).getAttribute('type'), 'datetime-local');
  await pauseField(drawer).fill(localDate);
  assert.equal(await drawer.getByLabel('Status', { exact: true }).inputValue(), 'paused', 'Selecting a future start must select Paused without a second status change.');
  await saveTicket(h, drawer);
  const ticket = h.desk.getTicket(TARGET_KEY);
  assert.equal(ticket.status, 'paused');
  assert.equal(ticket.paused_until, utcDate, 'The local date picker must serialize the browser timezone into UTC.');
  assert.equal(await pauseField(drawer).inputValue(), localDate, 'Saved UTC dates must display back in the same local timezone.');
  assert.equal(await drawer.getByLabel('Resolution summary', { exact: true }).isVisible(), false, 'Pausing does not require a resolution.');
  await drawer.getByRole('button', { name: 'Close ticket details', exact: true }).click();
  await h.page.goto(h.origin + '/#overview');
  await queueFor(h).waitFor();
  await eventually(async () => await queueFor(h).getByRole('button', { name: subject, exact: true }).count() === 0, 'The default dashboard must hide paused tickets.');
  assert.equal(await h.page.locator('.activity-list').getByRole('button', { name: subject, exact: true }).count(), 0, 'Dashboard recent activity must not bring a paused ticket back into view.');
  await chooseView(h, 'Paused');
  await queueFor(h).getByRole('button', { name: subject, exact: true }).waitFor();
  await chooseView(h, 'All tickets');
  assert.equal(await queueFor(h).getByRole('button', { name: subject, exact: true }).count(), 0);
  await queueFor(h).getByRole('button', { name: 'Filters', exact: true }).click();
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/tickets' && new URL(response.url()).searchParams.get('status') === 'paused');
  await queueFor(h).getByLabel('Status', { exact: true }).selectOption('paused');
  assert.equal((await pending).status(), 200);
  await queueFor(h).getByRole('button', { name: subject, exact: true }).waitFor();
  await noOverflow(h.page);
  assert.deepEqual(h.errors, []);
});

test('a newly created ticket can start paused instead of briefly appearing as active work', { timeout: 60000 }, async t => {
  const h = await harness(t, { timezoneId: 'America/New_York' });
  await signIn(h.page, h.origin);
  await h.page.getByRole('button', { name: 'New ticket', exact: true }).first().click();
  const modal = h.page.getByRole('dialog', { name: 'Workspace form', exact: true });
  const newSubject = 'Prepare a workstation on the scheduled start date';
  await modal.getByLabel('Subject', { exact: true }).fill(newSubject);
  await modal.getByLabel('Requester email', { exact: true }).fill('new.starter@example.test');
  await modal.getByLabel('Description', { exact: true }).fill('Schedule the workstation preparation for the employee start date.');
  await pauseField(modal).fill(localDate);
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/tickets' && response.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Create ticket', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 202, await response.text());
  const receipt = await response.json();
  await drawerFor(h).getByRole('heading', { name: newSubject, exact: true }).waitFor();
  const ticket = h.desk.getTicket(receipt.ticketKey);
  assert.equal(ticket.status, 'paused'); assert.equal(ticket.paused_until, utcDate);
  assert.equal(await drawerFor(h).getByLabel('Status', { exact: true }).inputValue(), 'paused');
  await drawerFor(h).getByRole('button', { name: 'Close ticket details', exact: true }).click();
  await h.page.waitForLoadState('networkidle');
  assert.equal(await queueFor(h).getByRole('button', { name: newSubject, exact: true }).count(), 0);
  await chooseView(h, 'Paused');
  await queueFor(h).getByRole('button', { name: newSubject, exact: true }).waitFor();
  assert.deepEqual(h.errors, []);
});

test('an open paused ticket resumes itself while keeping unsaved technician work and its current save version', { timeout: 60000 }, async t => {
  const h = await harness(t, { timezoneId: 'America/New_York' });
  await signIn(h.page, h.origin);
  const initial = h.desk.getTicket(TARGET_KEY);
  h.desk.updateTicket(TARGET_KEY, { paused_until: new Date(Date.now() + 7000).toISOString() }, { actor: h.admin, version: initial.version });
  const drawer = await openTicket(h);
  assert.equal(await drawer.getByLabel('Status', { exact: true }).inputValue(), 'paused');
  const draft = 'Keep this unsaved note while the scheduled work becomes active.';
  await drawer.getByLabel('Internal note', { exact: true }).fill(draft);
  await drawer.getByLabel('Priority', { exact: true }).selectOption('urgent');
  await eventually(async () => await drawer.getByLabel('Status', { exact: true }).inputValue() === 'in_progress', 'The visible drawer must show automatic In progress resumption without a manual refresh or AI polling.');
  assert.equal(await pauseField(drawer).inputValue(), '');
  assert.equal(await drawer.getByLabel('Internal note', { exact: true }).inputValue(), draft);
  assert.equal(await drawer.getByLabel('Priority', { exact: true }).inputValue(), 'urgent');
  let ticket = h.desk.getTicket(TARGET_KEY);
  assert.equal(ticket.status, 'in_progress'); assert.equal(ticket.paused_until, null);
  assert.equal(ticket.priority, initial.priority, 'The priority edit must remain a draft during resumption.');
  assert.equal(ticket.notes.some(note => note.body === draft), false);
  await saveTicket(h, drawer);
  ticket = h.desk.getTicket(TARGET_KEY);
  assert.equal(ticket.status, 'in_progress'); assert.equal(ticket.priority, 'urgent');
  assert.equal(ticket.paused_until, null, 'Saving a separate draft after automatic resumption must not restore the old pause.');
  await h.page.screenshot({ path: '/tmp/assetdesk-ticket-pause-resumed.png', fullPage: true });
  assert.deepEqual(h.errors, []);
});

test('a deliberate unsaved reschedule survives the original pause ending and can be saved afterward', { timeout: 60000 }, async t => {
  const h = await harness(t, { timezoneId: 'America/New_York' });
  await signIn(h.page, h.origin);
  const initial = h.desk.getTicket(TARGET_KEY);
  h.desk.updateTicket(TARGET_KEY, { paused_until: new Date(Date.now() + 7000).toISOString() }, { actor: h.admin, version: initial.version });
  const drawer = await openTicket(h);
  await pauseField(drawer).fill(localDate);
  await drawer.getByLabel('Internal note', { exact: true }).fill('Draft: move this work to the planned start date.');
  await drawer.locator('.ticket-activity').getByText(/^Scheduled pause ended; ticket moved to In progress/).waitFor({ timeout: 15000 });
  assert.equal(h.desk.getTicket(TARGET_KEY).status, 'in_progress', 'The original server schedule must expire before the new draft is saved.');
  assert.equal(await pauseField(drawer).inputValue(), localDate);
  assert.equal(await drawer.getByLabel('Status', { exact: true }).inputValue(), 'paused', 'A newly edited schedule must remain a deliberate Paused draft after the old schedule expires.');
  assert.equal(await drawer.getByLabel('Internal note', { exact: true }).inputValue(), 'Draft: move this work to the planned start date.');
  await saveTicket(h, drawer);
  const ticket = h.desk.getTicket(TARGET_KEY);
  assert.equal(ticket.status, 'paused'); assert.equal(ticket.paused_until, utcDate);
  assert.deepEqual(h.errors, []);
});

test('mobile technicians can reschedule and clear a pause using the ticket properties', { timeout: 60000 }, async t => {
  const h = await harness(t, { mobile: true, timezoneId: 'America/New_York' });
  await signIn(h.page, h.origin);
  const drawer = await openTicket(h);
  await pauseField(drawer).fill(localDate);
  await saveTicket(h, drawer);
  await pauseField(drawer).fill(`${nextYear}-11-21T10:15`);
  await saveTicket(h, drawer);
  assert.equal(h.desk.getTicket(TARGET_KEY).paused_until, `${nextYear}-11-21T15:15:00.000Z`);
  await noOverflow(h.page);
  await h.page.screenshot({ path: '/tmp/assetdesk-ticket-pause-mobile.png', fullPage: true });
  await pauseField(drawer).fill('');
  assert.equal(await drawer.getByLabel('Status', { exact: true }).inputValue(), 'in_progress');
  await saveTicket(h, drawer);
  const ticket = h.desk.getTicket(TARGET_KEY);
  assert.equal(ticket.status, 'in_progress'); assert.equal(ticket.paused_until, null);
  await noOverflow(h.page);
  assert.deepEqual(h.errors, []);
});
