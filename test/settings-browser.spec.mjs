import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, api, PASSWORD, ADMIN_EMAIL, TARGET_KEY } from './native-browser-helper.mjs';

const workspaceModal = page => page.getByRole('dialog', { name: 'Workspace form' });

async function openSettings(h, tab = 'Priorities & SLA') {
  await h.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await h.page.getByRole('tab', { name: tab, exact: true }).click();
}

async function addChoice(h, type, name, values = {}) {
  const tab = { priority: 'Priorities & SLA', status: 'Statuses', category: 'Categories' }[type];
  await h.page.getByRole('tab', { name: tab, exact: true }).click();
  await h.page.getByRole('button', { name: `Add ${type}`, exact: true }).click();
  const modal = workspaceModal(h.page);
  await modal.getByLabel('Name', { exact: true }).fill(name);
  for (const [label, value] of Object.entries(values)) {
    const control = modal.getByLabel(label, { exact: true });
    if (await control.evaluate(element => element.tagName === 'SELECT')) await control.selectOption(String(value));
    else await control.fill(String(value));
  }
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: 'hidden' });
  const collection = { priority: 'priorities', status: 'statuses', category: 'categories' }[type];
  const item = h.desk.settings.snapshot()[collection].find(value => value.name === name);
  assert.ok(item, `The ${type} must persist before it becomes a ticket choice.`);
  return item;
}

async function createTicket(h, { subject, priority = 'normal', category = 'general', tags = [] }) {
  await h.page.getByRole('button', { name: /^All tickets/ }).first().click();
  await h.page.getByRole('button', { name: 'New ticket', exact: true }).first().click();
  const modal = workspaceModal(h.page);
  await modal.getByLabel('Subject', { exact: true }).fill(subject);
  await modal.getByLabel('Requester email', { exact: true }).fill('settings-requester@example.test');
  await modal.getByLabel('Description', { exact: true }).fill('Verify the configured service desk workflow.');
  await modal.getByLabel('Priority', { exact: true }).selectOption(priority);
  await modal.getByLabel('Category', { exact: true }).selectOption(category);
  for (const tag of tags) {
    const input = modal.getByLabel('New ticket tag', { exact: true });
    await input.fill(tag); await input.press('Enter');
    await modal.getByRole('button', { name: `Remove tag ${tag}`, exact: true }).waitFor();
  }
  const created = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/tickets' && response.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Create ticket', exact: true }).click();
  const response = await created; assert.equal(response.status(), 202);
  if (tags.length) assert.equal(response.request().postDataJSON().tags.length, tags.length);
  const receipt = await response.json(); assert.ok(receipt.ticketKey);
  const drawer = h.page.getByRole('dialog', { name: 'Ticket details' });
  await drawer.getByRole('heading', { name: subject, exact: true }).waitFor();
  return { ticket: h.desk.getTicket(receipt.ticketKey), drawer };
}

async function searchReports(h, filters) {
  await h.page.getByRole('button', { name: 'Reports', exact: true }).click();
  const form = h.page.getByRole('form', { name: 'Ticket report filters', exact: true });
  await form.waitFor(); await h.page.waitForLoadState('networkidle');
  for (const [label, value] of Object.entries(filters)) {
    const control = form.getByLabel(label, { exact: true });
    if (await control.evaluate(element => element.tagName === 'SELECT')) await control.selectOption(value);
    else await control.fill(value);
  }
  const search = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/reports/tickets');
  await form.getByRole('button', { name: 'Search tickets', exact: true }).click();
  const response = await search; assert.equal(response.status(), 200);
  const result = await response.json(); await h.page.waitForLoadState('networkidle');
  return result;
}

async function downloadCsv(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const download = await pending, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('Settings manages custom workflow choices and technicians, and tickets and reports use the configured values', { timeout: 120000 }, async t => {
  const h = await harness(t);
  await signIn(h.page, h.origin); await openSettings(h);
  const priority = await addChoice(h, 'priority', 'Critical service', {
    'Priority rank': '5', 'First response target (hours)': '0.5', 'Resolution target (hours)': '4',
  });
  const category = await addChoice(h, 'category', 'Employee onboarding');
  const status = await addChoice(h, 'status', 'Waiting on supplier', { 'Status type': 'active' });
  await h.page.getByRole('tab', { name: 'Technicians', exact: true }).click();
  await h.page.getByRole('button', { name: 'Add technician', exact: true }).click();
  const modal = workspaceModal(h.page);
  await modal.getByLabel('Full name', { exact: true }).fill('Robin Support');
  await modal.getByLabel('Email address', { exact: true }).fill('robin-settings@example.test');
  await modal.getByLabel('Temporary password', { exact: true }).fill('Settings-browser-technician-password');
  await modal.getByRole('button', { name: 'Create technician', exact: true }).click();
  await eventually(() => h.desk.listTechnicians().some(person => person.email === 'robin-settings@example.test'), 'Settings must create a technician account.');
  await modal.waitFor({ state: 'hidden' });
  await h.page.getByRole('tab', { name: 'Categories', exact: true }).click();
  await h.page.getByRole('button', { name: 'Knowledge categories & permissions', exact: true }).click();
  await modal.getByRole('heading', { name: 'Knowledge categories & permissions', exact: true }).waitFor();
  await modal.getByRole('button', { name: 'Close category permissions', exact: true }).click();
  await h.page.getByRole('tab', { name: 'Priorities & SLA', exact: true }).click();
  await h.page.screenshot({ path: '/tmp/assetdesk-settings-desktop.png', fullPage: true });
  const { ticket, drawer } = await createTicket(h, { subject: 'New employee equipment setup', priority: priority.id, category: category.id });
  assert.equal(Date.parse(ticket.response_due_at) - Date.parse(ticket.created_at), 30 * 60000);
  assert.equal(Date.parse(ticket.resolution_due_at) - Date.parse(ticket.created_at), 4 * 3600000);
  await drawer.getByLabel('Status', { exact: true }).selectOption(status.id);
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await eventually(() => h.desk.getTicket(ticket.key).status === status.id, 'The custom active status must be saved.');
  await h.page.waitForLoadState('networkidle');
  await drawer.getByRole('button', { name: 'Close ticket details', exact: true }).click();
  const results = await searchReports(h, { 'Type / category': category.id, 'Status': status.id, 'Priority': priority.id });
  assert.equal(results.total, 1); assert.equal(results.tickets[0].key, ticket.key);
  const csv = await downloadCsv(h.page);
  assert.ok(csv.includes('Critical service')); assert.ok(csv.includes('Employee onboarding')); assert.ok(csv.includes('Waiting on supplier'));
  assert.ok(h.desk.dashboard().statusCounts.some(row => row.status === status.id && row.count === 1));
  assert.deepEqual(h.errors, []);
});

test('SLA editing leaves existing deadlines intact until applying changes to active tickets is explicitly selected', { timeout: 90000 }, async t => {
  const h = await harness(t);
  h.desk.settings.create('priorities', { name: 'Escalation', rank: 5, response_hours: 1, resolution_hours: 6 }, { version: h.desk.settings.snapshot().version, actor: h.admin });
  const priority = h.desk.settings.snapshot().priorities.find(value => value.name === 'Escalation');
  for (const key of [TARGET_KEY, 'HD-BROWSER001']) h.desk.updateTicket(key, { priority: priority.id }, { version: h.desk.getTicket(key).version, actor: h.admin });
  h.desk.updateTicket('HD-BROWSER001', { status: 'resolved', resolution: 'Completed before the SLA policy changed.' }, { version: h.desk.getTicket('HD-BROWSER001').version, actor: h.admin });
  const original = h.desk.getTicket(TARGET_KEY), completed = h.desk.getTicket('HD-BROWSER001');
  await signIn(h.page, h.origin); await openSettings(h);
  async function changeTargets(response, resolution, apply) {
    await h.page.getByRole('button', { name: 'Edit priority Escalation', exact: true }).click();
    const modal = workspaceModal(h.page);
    await modal.getByLabel('First response target (hours)', { exact: true }).fill(String(response));
    await modal.getByLabel('Resolution target (hours)', { exact: true }).fill(String(resolution));
    const checkbox = modal.getByRole('checkbox', { name: /^Apply SLA changes to active tickets/ });
    assert.equal(await checkbox.isChecked(), false, 'Recalculation must require an explicit choice.');
    if (apply) await checkbox.check();
    await modal.locator('button[type="submit"]').click(); await modal.waitFor({ state: 'hidden' });
  }
  await changeTargets(2, 8, false);
  assert.equal(h.desk.getTicket(TARGET_KEY).response_due_at, original.response_due_at);
  assert.equal(h.desk.getTicket(TARGET_KEY).resolution_due_at, original.resolution_due_at);
  await changeTargets(3, 12, true);
  const active = h.desk.getTicket(TARGET_KEY);
  assert.equal(Date.parse(active.response_due_at) - Date.parse(active.created_at), 3 * 3600000);
  assert.equal(Date.parse(active.resolution_due_at) - Date.parse(active.created_at), 12 * 3600000);
  assert.equal(h.desk.getTicket('HD-BROWSER001').response_due_at, completed.response_due_at);
  assert.equal(h.desk.getTicket('HD-BROWSER001').resolution_due_at, completed.resolution_due_at);
  assert.equal(h.desk.getTicket('HD-BROWSER001').status, 'resolved');
  assert.deepEqual(h.errors, []);
});

test('tickets can be created with more than 25 tags and accept additional live tags searchable in Reports', { timeout: 90000 }, async t => {
  const h = await harness(t); await signIn(h.page, h.origin);
  const tags = Array.from({ length: 30 }, (_, index) => `Batch ${String(index).padStart(2, '0')}`);
  const { ticket, drawer } = await createTicket(h, { subject: 'Ticket with unrestricted tag count', tags });
  assert.equal(h.desk.ticketTags(ticket.key).length, 30);
  await drawer.getByLabel('Add ticket tag', { exact: true }).fill('Live beyond cap');
  await drawer.getByLabel('Add ticket tag', { exact: true }).press('Enter');
  await drawer.getByRole('button', { name: 'Remove tag Live beyond cap', exact: true }).waitFor();
  assert.equal(h.desk.ticketTags(ticket.key).length, 31);
  await noOverflow(h.page);
  await drawer.getByRole('button', { name: 'Close ticket details', exact: true }).click();
  const results = await searchReports(h, { Tag: 'Live beyond cap' });
  assert.equal(results.total, 1); assert.equal(results.tickets[0].key, ticket.key); assert.equal(results.tickets[0].tags.length, 31);
  const csv = await downloadCsv(h.page);
  for (const tag of [...tags, 'Live beyond cap']) assert.ok(csv.includes(tag));
  assert.deepEqual(h.errors, []);
});

test('ticket details refresh new workflow choices and preserve current values even when the metadata response is stale', { timeout: 90000 }, async t => {
  const h = await harness(t); await signIn(h.page, h.origin);
  const initialWorkflow = h.desk.settings.snapshot();
  function choices(prefix, kind) {
    for (const [type, values] of [
      ['statuses', { name: `${prefix} status`, kind }],
      ['priorities', { name: `${prefix} priority`, rank: 5, response_hours: 0.5, resolution_hours: 4 }],
      ['categories', { name: `${prefix} category` }],
    ]) h.desk.settings.create(type, values, { version: h.desk.settings.snapshot().version, actor: h.admin });
    const workflow = h.desk.settings.snapshot();
    return { status: workflow.statuses.find(item => item.name === `${prefix} status`),
      priority: workflow.priorities.find(item => item.name === `${prefix} priority`),
      category: workflow.categories.find(item => item.name === `${prefix} category`) };
  }
  function assign(values, resolution) {
    h.desk.updateTicket(TARGET_KEY, { status: values.status.id, priority: values.priority.id, category: values.category.id,
      ...(resolution ? { resolution } : {}) }, { version: h.desk.getTicket(TARGET_KEY).version, actor: h.admin });
  }
  const drawer = h.page.getByRole('dialog', { name: 'Ticket details' });
  async function open() {
    await h.page.getByRole('region', { name: 'Ticket queue' }).getByRole('button', { name: h.desk.getTicket(TARGET_KEY).subject, exact: true }).click();
    await drawer.getByLabel('Status', { exact: true }).waitFor();
  }
  async function assertCurrent(values, suffix = '') {
    for (const [label, item] of [['Status', values.status], ['Priority', values.priority], ['Category', values.category]]) {
      const control = drawer.getByLabel(label, { exact: true });
      assert.equal(await control.inputValue(), item.id);
      assert.equal(await control.locator('option:checked').textContent(), item.name + suffix);
    }
  }
  const fresh = choices('Fresh triage', 'active'); assign(fresh);
  await open(); await assertCurrent(fresh);
  await drawer.getByRole('button', { name: 'Close ticket details', exact: true }).click();
  const current = choices('Completed review', 'resolved'); assign(current, 'Resolved using the new custom workflow.');
  let staleResponses = 0;
  await h.page.route('**/api/desk/workflow', async route => {
    staleResponses++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(initialWorkflow) });
  });
  await open(); await assertCurrent(current, ' (current)');
  await drawer.getByLabel('Add ticket tag', { exact: true }).fill('Metadata reload regression');
  await drawer.getByLabel('Add ticket tag', { exact: true }).press('Enter');
  await drawer.getByRole('button', { name: 'Remove tag Metadata reload regression', exact: true }).waitFor();
  await assertCurrent(current, ' (current)');
  assert.ok(staleResponses >= 2, 'Both opening and reloading the ticket must tolerate stale workflow metadata.');
  const before = h.desk.getTicket(TARGET_KEY);
  await drawer.getByLabel('Assigned technician', { exact: true }).selectOption(h.avery.id);
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await eventually(() => h.desk.getTicket(TARGET_KEY).assignee_id === h.avery.id, 'An unrelated assignment must save successfully.');
  const saved = h.desk.getTicket(TARGET_KEY);
  assert.equal(saved.status, current.status.id); assert.equal(saved.priority, current.priority.id); assert.equal(saved.category, current.category.id);
  assert.equal(saved.resolved_at, before.resolved_at, 'Saving an unrelated field must not reopen a completed ticket.');
  assert.deepEqual(h.errors, []);
});

test('Settings supports mobile deep links while technician sessions cannot change workflow settings', { timeout: 90000 }, async t => {
  const h = await harness(t, { mobile: true });
  await h.page.goto(h.origin + '/#settings');
  await h.page.getByLabel('Email address', { exact: true }).fill(ADMIN_EMAIL);
  await h.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await h.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await h.page.getByRole('button', { name: 'Close ticket summary', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await noOverflow(h.page);
  await addChoice(h, 'category', 'Mobile operations');
  await noOverflow(h.page);
  await h.page.screenshot({ path: '/tmp/assetdesk-settings-mobile.png', fullPage: true });
  await h.page.reload(); await h.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await noOverflow(h.page);
  const context = await h.browser.newContext({ viewport: { width: 1440, height: 1024 } }), page = await context.newPage();
  try {
    await signIn(page, h.origin, h.casey.email);
    assert.equal(await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).count(), 0);
    assert.equal((await page.request.get(h.origin + '/api/desk/settings')).status(), 403);
    const version = h.desk.settings.snapshot().version;
    const denied = await api(page, '/settings/statuses', { method: 'POST', body: { version, name: 'Unauthorized workflow', kind: 'active' } });
    assert.equal(denied.status, 403); assert.equal(h.desk.settings.snapshot().version, version);
    assert.equal((await page.request.get(h.origin + '/api/desk/workflow')).status(), 200);
    await page.goto(h.origin + '/#settings');
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('button', { name: 'Add priority', exact: true }).count(), 0);
  } finally { await context.close(); }
  assert.deepEqual(h.errors, []);
});
