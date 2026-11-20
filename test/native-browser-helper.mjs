import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { createApp } from '../src/app.js';
import { ActionsStore } from '../src/actions-store.js';
import { ActionsRunner } from '../src/actions-runner.js';

export const PASSWORD = 'Native-browser-password-2026';
export const ADMIN_EMAIL = 'admin@example.test';
export const TARGET_KEY = 'HD-BROWSER002';

export async function harness(t, { mobile = false, actionTransports: suppliedTransports } = {}) {
  const store = new Store(':memory:');
  const desk = new DeskStore(store);
  const admin = await desk.ensureAdmin({ name: 'Jordan Blake', email: ADMIN_EMAIL, password: PASSWORD });
  const avery = await desk.createTechnician({ name: 'Avery Chen', email: 'avery@example.test', password: PASSWORD, role: 'technician' });
  const casey = await desk.createTechnician({ name: 'Casey Morgan', email: 'casey@example.test', password: PASSWORD, role: 'technician' });
  const workspace = new WorkspaceStore(desk);
  const general = workspace.listCategories(admin).find(category => category.kind === 'knowledge');
  const assetCategory = workspace.listCategories(admin).find(category => category.kind === 'assets');
  const publicCategory = workspace.createCategory({ name: 'Connectivity', description: 'Network and VPN guides.', kind: 'knowledge', visibility: 'all', reader_ids: [], editor_ids: [], allow_staff_edit: true }, admin);
  const privateCategory = workspace.createCategory({ name: 'Restricted operations', description: 'Selected support staff only.', kind: 'knowledge', visibility: 'restricted', reader_ids: [avery.id], editor_ids: [avery.id], allow_staff_edit: false }, admin);
  const privateAssetCategory = workspace.createCategory({ name: 'Restricted equipment', description: 'Selected support staff only.', kind: 'assets', visibility: 'restricted', reader_ids: [avery.id], editor_ids: [avery.id], allow_staff_edit: false }, admin);
  const vpnArticle = workspace.createArticle({ name: 'Connect to the office VPN', category_id: publicCategory.id, html: '<h2>Before you start</h2><p>Install the supported VPN client.</p>' }, admin);
  const privateArticle = workspace.createArticle({ name: 'Restricted payroll recovery', category_id: privateCategory.id, html: '<h2>Restricted procedure</h2><p>Verify the authorized payroll contact before any changes.</p>' }, admin);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const publicMedia = workspace.addMedia({ article_id: vpnArticle.id, filename: 'vpn-guide.png', mime: 'image/png', data: png }, admin);
  workspace.updateArticle(vpnArticle.id, { html: vpnArticle.html + `<img src="${publicMedia.url}" alt="VPN connection guide">`, version: vpnArticle.version }, admin);
  const privateMedia = workspace.addMedia({ article_id: privateArticle.id, filename: 'private-guide.png', mime: 'image/png', data: png }, admin);
  const person = workspace.createAsset({ ref: 'PERSON-1042', name: 'Alex Johnson', type: 'personnel', category_id: assetCategory.id, email: 'alex@example.test', department: 'Design', status: 'active' }, admin);
  const laptop = workspace.createAsset({ ref: 'LAPTOP-1042', name: 'Alex’s design laptop', type: 'laptop', category_id: assetCategory.id, owner_id: person.id, department: 'Design', location: 'Office west', manufacturer: 'Example hardware', model: 'Workstation 14', serial_number: 'SERIAL-1042', status: 'active' }, admin);
  const monitor = workspace.createAsset({ ref: 'MONITOR-55', name: 'Design studio monitor', type: 'peripheral', category_id: assetCategory.id, status: 'spare' }, admin);
  const privateAsset = workspace.createAsset({ ref: 'PC-PRIVATE', name: 'Restricted payroll workstation', type: 'pc', category_id: privateAssetCategory.id, status: 'active' }, admin);
  const restrictedPerson = workspace.createAsset({ ref: 'PERSON-PRIVATE', name: 'Restricted employee record', type: 'personnel', category_id: privateAssetCategory.id, email: 'private-person@example.test', status: 'active' }, admin);
  const visibleOwnedPC = workspace.createAsset({ ref: 'PC-REDACTED', name: 'Shared support workstation', type: 'pc', category_id: assetCategory.id, owner_id: restrictedPerson.id, location: 'Office south', status: 'active' }, admin);
  const responseTemplate = desk.createResponse({ title: 'Display troubleshooting', body: 'Hi {{requester}}, {{technician}} is investigating {{ticket_id}}: {{subject}}.' }, admin);
  const fixtures = [
    { key: 'HD-BROWSER001', subject: 'VPN access fails after password change', priority: 'urgent', category: 'network', assignee: avery, hours: 12, name: 'Sam Rivera', requester: 'sam@example.test', description: 'The VPN client refuses my new password. I cannot reach the shared project folders.' },
    { key: TARGET_KEY, subject: 'Laptop display flickers on LAPTOP-1042', priority: 'high', category: 'hardware', assignee: null, hours: 30, name: 'Alex Johnson', requester: 'alex@example.test', description: 'The display on LAPTOP-1042 flickers when I connect the docking station. An external screen works correctly.' },
    { key: 'HD-BROWSER003', subject: 'Install design software for marketing', priority: 'normal', category: 'software', assignee: casey, hours: 3, name: 'Taylor Reed', requester: 'taylor@example.test', description: 'Please install the licensed design application on my workstation before tomorrow.' },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    store.saveTicket({ key: fixture.key, requester: fixture.requester, subject: fixture.subject, page_id: 0, page_url: '' });
    desk.captureEmail(fixture.key, { text: fixture.description, from: { address: fixture.requester, name: fixture.name }, receivedAt: new Date().toISOString(), desk: { priority: fixture.priority, category: fixture.category, assignee_id: fixture.assignee?.id || null } }, { receiptId: `browser-fixture-${index}` });
    const created = new Date(Date.now() - fixture.hours * 3600000).toISOString();
    store.db.prepare('UPDATE tickets SET created_at=?,updated_at=?,response_due_at=NULL,resolution_due_at=NULL WHERE key=?').run(created, created, fixture.key);
  }
  workspace.linkTicket(TARGET_KEY, laptop.id, admin);
  const worker = new Worker({ store, desk, workspace, logger: { error() {} } });
  const actions = new ActionsStore(desk), actionMessages = [], actionApiCalls = [];
  let origin = '';
  const actionTransports = suppliedTransports || {
    get publicUrl() { return origin; },
    get config() { return { publicUrl: origin }; },
    capabilities() { return { email: { configured: true }, approval: { configured: true }, publicUrl: origin,
      connections: [{ id: 'browser_service', name: 'Demo service', baseUrl: 'https://service.example.test/v1', methods: ['GET', 'POST'] }] }; },
    async sendEmail(message) { actionMessages.push(structuredClone(message)); return { messageId: message.messageId || 'browser-message' }; },
    async callApi(request, user) { actionApiCalls.push({ ...structuredClone(request), actor_id: user.id }); return { status: 200 }; },
  };
  const actionsRunner = new ActionsRunner({ actions, transports: actionTransports, logger: { error() {} } });
  const config = { inboundToken: 'native-browser-intake-test-token-12345', adminToken: 'native-browser-admin-test-token-123456', cookieSecure: false };
  const server = createApp({ store, desk, workspace, worker, config, actions, actionRunner: actionsRunner, actionTransports }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  worker.start();
  actionsRunner.start();
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  t.after(async () => { await browser.close(); await actionsRunner.stop(); await worker.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  return { store, desk, workspace, worker, actions, actionsRunner, actionMessages, actionApiCalls, actionTransports, browser, context, page, errors, requests, origin, admin, avery, casey, general, assetCategory, publicCategory, privateCategory, privateAssetCategory, publicMedia, privateMedia, vpnArticle, privateArticle, person, laptop, monitor, privateAsset, restrictedPerson, visibleOwnedPC, responseTemplate };
}

export async function signIn(page, origin, email = ADMIN_EMAIL) {
  await page.goto(origin);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('region', { name: 'Ticket queue' }).waitFor();
}
export async function eventually(check, message) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
export async function noOverflow(page) {
  assert.ok(await page.evaluate(width => document.documentElement.scrollWidth <= width + 1, page.viewportSize().width), 'The page must fit the configured viewport.');
}
export async function api(page, path, { method = 'GET', body } = {}) {
  const base = new URL(page.url()).origin;
  const session = await (await page.request.get(base + '/api/desk/session')).json();
  const response = await page.request.fetch(`${base}/api/desk${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken } : {}, data: body });
  return { status: response.status(), body: await response.json() };
}
