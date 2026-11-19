import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { Worker } from '../src/worker.js';
import { createApp } from '../src/app.js';

const PASSWORD = 'Browser-test-password-2026';
const ADMIN_EMAIL = 'admin@example.test';
const TARGET_KEY = 'HD-BROWSER002';

function fakeBookStack() {
  let sequence = 100;
  const assets = new Map([['MONITOR-55', {id:55,ref:'MONITOR-55',url:'https://wiki.example.test/link/55'}]]), tickets = new Map();
  return {
    async ensureWorkspace() { return { assetBook: { id: 1 }, openChapter: { id: 2 } }; },
    async checkHealth() {},
    async findAsset(ref) { return assets.get(ref) || null; },
    async ensureAsset(ref) {
      if (!assets.has(ref)) assets.set(ref, { id: sequence++, url: `https://wiki.example.test/link/${sequence - 1}`, ref });
      return assets.get(ref);
    },
    async ensureTicket(ticket) {
      if (!tickets.has(ticket.key)) tickets.set(ticket.key, { ...ticket, id: sequence++, url: `https://wiki.example.test/link/${sequence - 1}` });
      return tickets.get(ticket.key);
    },
    async appendReply() {},
    async linkTicketToAsset() {},
    async linkAssetToTicket() {},
    async syncTicketMetadata() {},
  };
}

async function harness(t, { mobile = false } = {}) {
  const store = new Store(':memory:');
  const desk = new DeskStore(store);
  const admin = await desk.ensureAdmin({ name: 'Jordan Blake', email: ADMIN_EMAIL, password: PASSWORD });
  const responseTemplate = desk.createResponse({ title: 'Display troubleshooting', body: 'Hi {{requester}}, {{technician}} is investigating {{ticket_id}}: {{subject}}.' }, admin);
  const avery = await desk.createTechnician({ name: 'Avery Chen', email: 'avery@example.test', password: PASSWORD, role: 'technician' });
  const casey = await desk.createTechnician({ name: 'Casey Morgan', email: 'casey@example.test', password: PASSWORD, role: 'technician' });
  const fixtures = [
    { key: 'HD-BROWSER001', subject: 'VPN access fails after password change', priority: 'urgent', category: 'network', assignee: avery, hours: 12, name: 'Sam Rivera', requester: 'sam@example.test', description: 'The VPN client refuses my new password. I cannot reach the shared project folders.' },
    { key: TARGET_KEY, subject: 'Laptop display flickers on LAPTOP-1042', priority: 'high', category: 'hardware', assignee: null, hours: 30, name: 'Alex Johnson', requester: 'alex@example.test', description: 'The display on LAPTOP-1042 flickers when I connect the docking station. An external screen works correctly.' },
    { key: 'HD-BROWSER003', subject: 'Install design software for marketing', priority: 'normal', category: 'software', assignee: casey, hours: 3, name: 'Taylor Reed', requester: 'taylor@example.test', description: 'Please install the licensed design application on my workstation before tomorrow.' },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    store.saveTicket({ key: fixture.key, requester: fixture.requester, subject: fixture.subject, page_id: index + 10, page_url: `https://wiki.example.test/link/${index + 10}` });
    desk.captureEmail(fixture.key, { text: fixture.description, from: { address: fixture.requester, name: fixture.name }, receivedAt: new Date().toISOString(), desk: { priority: fixture.priority, category: fixture.category, assignee_id: fixture.assignee?.id || null } }, { receiptId: `browser-fixture-${index}` });
    const created = new Date(Date.now() - fixture.hours * 3600000).toISOString();
    store.db.prepare('UPDATE tickets SET created_at=?,updated_at=?,response_due_at=NULL,resolution_due_at=NULL WHERE key=?').run(created, created, fixture.key);
  }
  desk.addAssets(TARGET_KEY, [{ ref: 'LAPTOP-1042', id: 42, url: 'https://wiki.example.test/link/42' }]);
  const bookstack = fakeBookStack();
  const worker = new Worker({ store, desk, bookstack, logger: { error() {} } });
  const config = { inboundToken: 'browser-intake-test-token-1234567890', adminToken: 'browser-admin-test-token-12345678901', bookstack: { url: 'https://wiki.example.test', publicUrl: 'https://wiki.example.test' }, cookieSecure: false };
  const server = createApp({ store, desk, worker, bookstack, config }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  t.after(async () => {
    await browser.close();
    await worker.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return { page, desk, store, worker, admin, avery, casey, responseTemplate, pageErrors, url: `http://127.0.0.1:${server.address().port}` };
}

async function signIn(page, url) {
  await page.goto(url);
  await page.getByLabel('Email address', { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('region', { name: 'Ticket queue' }).getByRole('button', { name: 'Laptop display flickers on LAPTOP-1042', exact: true }).waitFor();
}

async function eventually(check, message) {
  const expires = Date.now() + 10000;
  while (Date.now() < expires) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

// Real browser + Express + SQLite + queue: only the remote wiki is substituted.
// Tests verify persisted behavior, not snapshots or mocked browser responses.
test('dashboard supports technician assignment, triage, notes, resolution and team administration', { timeout: 120000 }, async t => {
  const h = await harness(t);
  await signIn(h.page, h.url);
  await h.page.screenshot({ path: '/tmp/assetdesk-dashboard.png', fullPage: true });
  assert.equal(h.desk.dashboard().stats.open, 3);
  const queue = h.page.getByRole('region', { name: 'Ticket queue' });
  await h.page.getByLabel('Search tickets', { exact: true }).fill('VPN access');
  await queue.getByRole('button', { name: 'Laptop display flickers on LAPTOP-1042', exact: true }).waitFor({ state: 'hidden' });
  await queue.getByRole('button', { name: 'VPN access fails after password change', exact: true }).waitFor();
  await h.page.getByLabel('Search tickets', { exact: true }).fill('');
  await queue.getByRole('button', { name: 'Laptop display flickers on LAPTOP-1042', exact: true }).waitFor();
  await h.page.getByRole('region', { name: 'Ticket queue' }).getByRole('button', { name: 'Laptop display flickers on LAPTOP-1042', exact: true }).click();
  const drawer = h.page.getByRole('dialog', { name: 'Ticket details' });
  await drawer.waitFor();
  try { await drawer.getByLabel('Assigned technician', {exact:true}).waitFor({timeout:5000}); } catch(error) { t.diagnostic(await drawer.innerText()); await h.page.screenshot({path:'/tmp/assetdesk-browser-failure.png',fullPage:true}); throw error; }
  await drawer.getByLabel('Assigned technician', { exact: true }).selectOption(h.avery.id);
  await drawer.getByLabel('Priority', { exact: true }).selectOption('urgent');
  await drawer.getByLabel('Status', { exact: true }).selectOption('in_progress');
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await eventually(() => h.desk.getTicket(TARGET_KEY).assignee_id === h.avery.id && h.desk.getTicket(TARGET_KEY).status === 'in_progress', 'Assignment and status must persist.');
  assert.equal(h.desk.getTicket(TARGET_KEY).priority, 'urgent');
  await h.page.waitForLoadState('networkidle');
  await h.page.screenshot({path:'/tmp/assetdesk-ticket.png',fullPage:true});
  await drawer.getByLabel('Asset ID', { exact: true }).fill('MONITOR-55');
  const assetPost = h.page.waitForResponse(response => response.url().endsWith(`/api/desk/tickets/${TARGET_KEY}/assets`) && response.request().method() === 'POST', {timeout:5000});
  await drawer.getByRole('button', { name: 'Link asset', exact: true }).click();
  const assetResponse=await assetPost;
  assert.equal(assetResponse.status(),202,JSON.stringify(await assetResponse.json()));
  await eventually(() => {
    const ticket = h.desk.getTicket(TARGET_KEY);
    const failed = ticket.pending_asset_links.find(link => link.error);
    if (failed) assert.fail(`Manual asset link failed: ${failed.error}`);
    return ticket.assets.some(asset => asset.ref === 'MONITOR-55' && asset.id === 55);
  }, 'Manually linked known asset must persist.');
  await drawer.getByText('MONITOR-55', { exact: true }).waitFor();
  await h.page.waitForLoadState('networkidle');
  await drawer.getByRole('button', { name: 'Manage templates', exact: true }).click();
  const responseModal = h.page.getByRole('dialog', { name: 'Workspace form' });
  await h.page.screenshot({path:'/tmp/assetdesk-templates.png',fullPage:true});
  await responseModal.getByLabel('Template title', { exact: true }).fill('Temporary browser response');
  await responseModal.getByLabel('Template message', { exact: true }).fill('Hi {{requester}}, this is a temporary saved response.');
  await responseModal.getByRole('button', { name: 'Create template', exact: true }).click();
  await eventually(() => h.desk.listResponses().some(response => response.title === 'Temporary browser response'), 'Created response template must persist.');
  await responseModal.getByRole('button', { name: 'Archive Temporary browser response', exact: true }).click();
  await eventually(() => !h.desk.listResponses().some(response => response.title === 'Temporary browser response'), 'Archived template must disappear from active choices.');
  assert.ok(h.desk.listResponses({includeInactive:true}).some(response => response.title === 'Temporary browser response' && response.active === false));
  await responseModal.getByRole('button', {name:'Archive Temporary browser response',exact:true}).waitFor({state:'hidden'});
  await h.page.waitForLoadState('networkidle');
  const oldTemplateSelect = await drawer.getByLabel('Response template', {exact:true}).elementHandle();
  await responseModal.getByRole('button',{name:'Close response templates',exact:true}).click();
  await responseModal.waitFor({state:'hidden'});
  await h.page.waitForFunction(element => !element.isConnected, oldTemplateSelect);
  await oldTemplateSelect.dispose();
  await drawer.getByLabel('Response template', { exact: true }).selectOption(h.responseTemplate.id);
  await drawer.getByRole('button', { name: 'Insert template', exact: true }).click();
  const responseDraft = await drawer.getByLabel('Internal note', { exact: true }).inputValue();
  assert.match(responseDraft, /Alex Johnson/);
  assert.match(responseDraft, /HD-BROWSER002/);
  assert.ok(!responseDraft.includes('{{'), 'Template placeholders must be personalized.');
  await drawer.getByLabel('Internal note', { exact: true }).fill(`${responseDraft}\nDock firmware update reproduced the display issue; replacement cable ordered.`);
  await drawer.getByRole('button', { name: 'Add note', exact: true }).click();
  await eventually(() => h.desk.getTicket(TARGET_KEY).notes.some(note => note.body.includes('replacement cable ordered')), 'Internal note must persist.');
  await h.page.waitForLoadState('networkidle');
  await drawer.getByRole('button', { name: 'Mark first response', exact: true }).click();
  await eventually(() => Boolean(h.desk.getTicket(TARGET_KEY).first_response_at), 'First-response marker must persist.');
  await drawer.getByRole('button', { name: 'Mark first response', exact: true }).waitFor({state:'hidden'});
  await h.page.waitForLoadState('networkidle');
  await drawer.getByLabel('Status', { exact: true }).selectOption('resolved');
  await drawer.getByLabel('Resolution summary', { exact: true }).fill('Replaced the damaged display cable and confirmed two external screens work.');
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await eventually(() => h.desk.getTicket(TARGET_KEY).status === 'resolved', 'Resolution must persist.');
  assert.match(h.desk.getTicket(TARGET_KEY).resolution, /damaged display cable/);
  assert.ok(h.desk.getTicket(TARGET_KEY).events.some(event => event.type === 'assignment'));
  await h.page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await h.page.getByRole('button', { name: 'Team', exact: true }).click();
  await h.page.getByRole('button', { name: 'Add technician', exact: true }).click();
  const modal = h.page.getByRole('dialog', { name: 'Workspace form' });
  await modal.getByLabel('Full name', { exact: true }).fill('Devon Patel');
  await modal.getByLabel('Email address', { exact: true }).fill('devon@example.test');
  await modal.getByLabel('Temporary password', { exact: true }).fill('Temporary-browser-password-2026');
  await modal.getByLabel('Role', { exact: true }).selectOption('technician');
  await modal.getByRole('button', { name: 'Create technician', exact: true }).click();
  await eventually(() => h.desk.listTechnicians().some(user => user.email === 'devon@example.test'), 'New named technician must persist.');
  await modal.waitFor({ state: 'hidden' });
  await h.page.getByRole('button', { name: 'New ticket', exact: true }).first().click();
  await modal.getByLabel('Subject', { exact: true }).fill('Browser-created onboarding access request');
  await modal.getByLabel('Requester email', { exact: true }).fill('newstarter@example.test');
  await modal.getByLabel('Requester name', { exact: false }).fill('Morgan Quinn');
  await modal.getByLabel('Description', { exact: true }).fill('Please enable access and check ASSET-321 for the new starter.');
  await modal.getByLabel('Priority', { exact: true }).selectOption('high');
  await modal.getByLabel('Category', { exact: true }).selectOption('access');
  await modal.getByLabel('Assign technician', { exact: true }).selectOption(h.casey.id);
  await modal.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await eventually(() => h.desk.listTickets({ search: 'Browser-created onboarding access request' }).total === 1, 'Manual ticket must be created by the real queue.');
  const created = h.desk.listTickets({ search: 'Browser-created onboarding access request' }).tickets[0];
  assert.equal(created.assignee_id, h.casey.id);
  assert.equal(created.priority, 'high');
  assert.equal(created.category, 'access');
  assert.equal(created.source, 'manual');
  assert.ok(h.desk.getTicket(created.key).assets.some(asset => asset.ref === 'ASSET-321'));
  assert.deepEqual(h.pageErrors, []);
});

test('dashboard fits a mobile viewport and supports keyboard drawer dismissal', { timeout: 60000 }, async t => {
  const h = await harness(t, { mobile: true });
  await signIn(h.page, h.url);
  assert.ok(await h.page.evaluate(width => document.documentElement.scrollWidth <= width + 1, h.page.viewportSize().width), 'The page should not overflow its configured mobile viewport.');
  await h.page.screenshot({ path: '/tmp/assetdesk-mobile.png', fullPage: true });
  await h.page.getByRole('region', { name: 'Ticket queue' }).getByRole('button', { name: 'Laptop display flickers on LAPTOP-1042', exact: true }).click();
  await h.page.getByRole('dialog').waitFor();
  assert.ok(await h.page.evaluate(width => document.documentElement.scrollWidth <= width + 1, h.page.viewportSize().width), 'The open drawer should fit the configured mobile viewport.');
  await h.page.screenshot({path:'/tmp/assetdesk-mobile-ticket.png',fullPage:true});
  await h.page.keyboard.press('Escape');
  await h.page.getByRole('dialog').waitFor({ state: 'hidden' });
  await h.page.getByRole('button', {name:'New ticket',exact:true}).first().click();
  const modal=h.page.getByRole('dialog',{name:'Workspace form'});
  await modal.waitFor();
  assert.ok(await h.page.evaluate(width => document.documentElement.scrollWidth <= width + 1, h.page.viewportSize().width), 'The open create-ticket modal should fit the configured mobile viewport.');
  await h.page.keyboard.press('Escape');
  await modal.waitFor({state:'hidden'});
  assert.deepEqual(h.pageErrors, []);
});
