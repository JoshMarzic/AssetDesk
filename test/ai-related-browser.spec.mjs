import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, api, TARGET_KEY } from './native-browser-helper.mjs';

const KEY = 'browser-related-api-key-not-a-real-provider-key';
const RECENT = 'HD-RELATED-RECENT';
const PAST = 'HD-RELATED-ASSET-PAST';
const OLD_UPDATED = 'HD-RELATED-OLD-UPDATED';
const UNRELATED = 'HD-RELATED-ASSET-UNRELATED';
const PRIVATE = 'HD-RELATED-PRIVATE-PAST';
const recentReason = 'Both requests report a flickering display when a docking station is connected.';
const pastReason = 'The same laptop previously had docking-related display flicker; <img src="broken" onerror="window.relatedInjected=true"> stays literal text.';
const previousResolution = 'Replaced the faulty dock power adapter and verified the external display.';
const drawerFor = h => h.page.getByRole('dialog', { name: 'Ticket details', exact: true });
const panelFor = h => drawerFor(h).getByRole('region', { name: 'AI assistance', exact: true });
const recentFor = h => panelFor(h).getByRole('region', { name: 'Related ticket suggestions', exact: true });
const historyFor = h => panelFor(h).getByRole('region', { name: 'Linked asset issue history', exact: true });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function provider({ review } = {}) {
  const calls = [];
  return {
    calls,
    async testConnection() { return { ok: true }; },
    async review(input) {
      if (input.kind === 'summary') return { summary: 'Recent support activity.', highlights: [] };
      const { apiKey: _secret, ...safe } = input;
      calls.push(structuredClone(safe));
      if (input.kind === 'triage') return { tags: ['Display issue'], asset_mentions: [] };
      if (input.kind !== 'related') throw new Error('Unexpected AI task in related-ticket browser fixture.');
      return review ? review(input, calls.filter(call => call.kind === 'related').length) : matchingResult(input);
    },
  };
}
function matchingResult(input, { reason = pastReason } = {}) {
  const recent = input.context.recent_tickets.find(ticket => ticket.ticket_key === RECENT);
  const past = input.context.asset_issues.find(ticket => ticket.ticket_key === PAST);
  return {
    recent_tickets: recent ? [{ ticket_key: recent.ticket_key, reason: recentReason }] : [],
    asset_issues: past ? [{ asset_id: past.asset_id, ticket_key: past.ticket_key, reason }] : [],
  };
}
function configure(h, patch = {}) {
  return h.aiSettings.update({ version: h.aiSettings.snapshot().version, enabled: true, provider: 'openai',
    auto_tags: false, auto_location: false, auto_assets: false, suggest_fixes: false, suggest_related: true,
    auto_reply: false, login_summary_enabled: false, providers: { openai: { api_key: KEY } }, ...patch }, { actor: h.admin });
}
function addTicket(h, { key, subject, description, hours, status = 'open', resolution = '' }) {
  h.store.saveTicket({ key, requester: 'related-requester@example.test', subject, page_id: 0, page_url: '' });
  h.desk.captureEmail(key, { text: description, from: { address: 'related-requester@example.test', name: 'Related requester' }, receivedAt: new Date().toISOString() }, { receiptId: 'related-browser-' + key });
  const created = new Date(Date.now() - hours * 3600000).toISOString();
  h.store.db.prepare('UPDATE tickets SET created_at=?,updated_at=?,status=?,resolution=?,resolved_at=?,response_due_at=NULL,resolution_due_at=NULL WHERE key=?')
    .run(created, created, status, resolution, ['resolved', 'closed'].includes(status) ? new Date(Date.parse(created) + 3600000).toISOString() : null, key);
  return h.desk.getTicket(key);
}
function issueFixtures(h) {
  addTicket(h, { key: RECENT, subject: 'Docking station makes another display flicker', description: 'The display flickers after plugging the laptop into the docking station.', hours: 48 });
  addTicket(h, { key: OLD_UPDATED, subject: 'An older docking problem updated today', description: 'Display flickering from last week with a new administrative update.', hours: 144 });
  h.store.db.prepare('UPDATE tickets SET updated_at=? WHERE key=?').run(new Date().toISOString(), OLD_UPDATED);
  addTicket(h, { key: PAST, subject: 'Previous LAPTOP-1042 dock display flicker', description: 'The laptop display flickered when connected to the same docking station.', hours: 40 * 24, status: 'resolved', resolution: previousResolution });
  addTicket(h, { key: UNRELATED, subject: 'Inventory location audit for LAPTOP-1042', description: 'Recorded the equipment location during an inventory audit; no display symptoms.', hours: 90 * 24, status: 'resolved', resolution: 'Updated the inventory location.' });
  h.workspace.linkTicket(PAST, h.laptop.id, h.admin);
  h.workspace.linkTicket(UNRELATED, h.laptop.id, h.admin);
  addTicket(h, { key: PRIVATE, subject: 'Restricted payroll display evidence', description: 'PRIVATE-RELATED-EVIDENCE should never enter an asset-history prompt.', hours: 50 * 24, status: 'resolved', resolution: 'PRIVATE-RELATED-RESOLUTION' });
  h.workspace.linkTicket(PRIVATE, h.privateAsset.id, h.admin);
  h.workspace.linkTicket(TARGET_KEY, h.privateAsset.id, h.admin);
  h.desk.addNote(PAST, { body: 'INTERNAL-RELATED-NOTE must not be sent to the model.', actor: h.admin });
}
async function openTicket(h, key = TARGET_KEY) {
  await h.page.goto(h.origin + '/#tickets/' + key);
  await drawerFor(h).getByRole('heading', { name: h.desk.getTicket(key).subject, exact: true }).waitFor();
}
async function complete(h, key = TARGET_KEY) {
  let state;
  await eventually(() => {
    state = h.aiService.ticketState(key, h.admin);
    assert.ok(!['failed', 'blocked', 'needs_attention'].includes(state.status), state.error || state.status);
    return state.status === 'completed';
  }, 'The related-ticket review must finish.');
  return state;
}
async function review(h, key = TARGET_KEY) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === `/api/desk/tickets/${key}/ai/review` && response.request().method() === 'POST');
  await panelFor(h).getByRole('button', { name: 'Review ticket', exact: true }).click();
  assert.equal((await pending).status(), 202);
  return complete(h, key);
}
async function openSettings(h) {
  const menu = h.page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await h.page.getByRole('complementary', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
  await h.page.getByRole('tab', { name: 'AI', exact: true }).click();
  await h.page.getByRole('button', { name: 'Save AI settings', exact: true }).waitFor();
}
async function saveSettings(h) {
  const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/settings/ai' && response.request().method() === 'PATCH');
  await h.page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200, await response.text()); return response.json();
}

test('AI links genuinely related recent tickets and older resolved issues on the same shared asset with safe native navigation', { timeout: 90000 }, async t => {
  const fake = provider(), h = await harness(t, { aiProviders: fake }); issueFixtures(h); configure(h);
  await signIn(h.page, h.origin); await openTicket(h);
  const result = await review(h);
  assert.equal(result.related.status, 'ready');
  const call = fake.calls.find(call => call.kind === 'related'); assert.ok(call);
  assert.ok(call.context.recent_tickets.some(ticket => ticket.ticket_key === RECENT));
  assert.ok(!call.context.recent_tickets.some(ticket => [OLD_UPDATED, PAST, TARGET_KEY].includes(ticket.ticket_key)), 'Recent means submission within 72 hours, rather than an old ticket updated today.');
  assert.ok(call.context.asset_issues.some(ticket => ticket.ticket_key === PAST));
  assert.ok(call.context.asset_issues.some(ticket => ticket.ticket_key === UNRELATED), 'The model can inspect an association without claiming every association is a similar issue.');
  assert.doesNotMatch(JSON.stringify(call.context), /PRIVATE-RELATED|INTERNAL-RELATED-NOTE|Restricted payroll workstation|SERIAL-1042/);
  assert.equal(fake.calls.some(call => call.kind === 'suggestions'), false, 'Related-ticket review must work with documentation suggestions disabled.');
  await recentFor(h).getByText(recentReason, { exact: false }).waitFor();
  await historyFor(h).getByText(pastReason, { exact: false }).waitFor();
  await historyFor(h).getByText(previousResolution, { exact: false }).waitFor();
  assert.equal(await historyFor(h).locator('img').count(), 0); assert.equal(await h.page.evaluate(() => window.relatedInjected), undefined);
  assert.equal(await historyFor(h).getByRole('link', { name: /Inventory location audit/ }).count(), 0, 'Sharing an asset does not itself prove the symptom is related.');
  const recentLink = recentFor(h).locator(`a[href="#tickets/${RECENT}"]`), pastLink = historyFor(h).locator(`a[href="#tickets/${PAST}"]`);
  assert.equal(await recentLink.count(), 1); assert.equal(await pastLink.count(), 1);
  assert.match(await historyFor(h).innerText(), /Resolved/);
  await noOverflow(h.page); await h.page.screenshot({ path: '/tmp/assetdesk-ai-related-desktop.png', fullPage: true });
  await pastLink.click();
  await drawerFor(h).getByRole('heading', { name: 'Previous LAPTOP-1042 dock display flicker', exact: true }).waitFor();
  assert.equal(new URL(h.page.url()).hash, '#tickets/' + PAST);
  assert.equal(h.actionMessages.length, 0); assert.deepEqual(h.errors, []);
});

test('new manual tickets are accepted while related review is pending and preserve unsaved technician work as matches arrive', { timeout: 90000 }, async t => {
  const gate = deferred(), entered = deferred();
  const fake = provider({ review: async input => { entered.resolve(); await gate.promise; return matchingResult(input); } });
  const h = await harness(t, { aiProviders: fake }); issueFixtures(h); configure(h, { auto_assets: true }); t.after(() => gate.resolve());
  await signIn(h.page, h.origin);
  await h.page.getByRole('button', { name: 'New ticket', exact: true }).first().click();
  const modal = h.page.getByRole('dialog', { name: 'Workspace form', exact: true });
  const subject = 'LAPTOP-1042 display flickers again when docked';
  await modal.getByLabel('Subject', { exact: true }).fill(subject);
  await modal.getByLabel('Requester email', { exact: true }).fill('alex@example.test');
  await modal.getByLabel('Description', { exact: true }).fill('The display flickers whenever LAPTOP-1042 is connected to its docking station.');
  const accepted = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/tickets' && response.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Create ticket', exact: true }).click();
  const response = await accepted; assert.equal(response.status(), 202); const receipt = await response.json();
  await drawerFor(h).getByRole('heading', { name: subject, exact: true }).waitFor(); await entered.promise;
  assert.ok(h.workspace.ticketAssets(receipt.ticketKey, h.admin).some(asset => asset.id === h.laptop.id), 'An asset linked during intake must be available to the same AI review.');
  const draft = 'Keep my unsaved docking investigation note.';
  await drawerFor(h).getByLabel('Internal note', { exact: true }).fill(draft);
  await drawerFor(h).getByLabel('Priority', { exact: true }).selectOption('urgent');
  gate.resolve(); const state = await complete(h, receipt.ticketKey); assert.equal(state.related.status, 'ready');
  await historyFor(h).getByText(pastReason, { exact: false }).waitFor();
  assert.equal(await drawerFor(h).getByLabel('Internal note', { exact: true }).inputValue(), draft);
  assert.equal(await drawerFor(h).getByLabel('Priority', { exact: true }).inputValue(), 'urgent');
  assert.ok(!h.desk.getTicket(receipt.ticketKey).notes.some(note => note.body === draft));
  assert.equal(h.actionMessages.length, 0); assert.deepEqual(h.errors, []);
});

test('a permission change on an uncited supplied asset withholds saved AI matches and their reasoning on the next ticket read', { timeout: 90000 }, async t => {
  const fake = provider(), h = await harness(t, { aiProviders: fake }); issueFixtures(h);
  const category = h.workspace.createCategory({ name: 'Initially shared diagnostic assets', kind: 'assets', visibility: 'all', allow_staff_edit: true }, h.admin);
  const second = h.workspace.createAsset({ ref: 'DISPLAY-HISTORY-2', name: 'Shared diagnostic display', type: 'peripheral', category_id: category.id }, h.admin);
  addTicket(h, { key: 'HD-RELATED-UNCITED', subject: 'A diagnostic display issue', description: 'Display flickering during a diagnostic test.', hours: 25 * 24 });
  h.workspace.linkTicket('HD-RELATED-UNCITED', second.id, h.admin); h.workspace.linkTicket(TARGET_KEY, second.id, h.admin);
  configure(h); await signIn(h.page, h.origin, h.casey.email); await openTicket(h); await review(h);
  await historyFor(h).getByText(pastReason, { exact: false }).waitFor();
  const call = fake.calls.find(call => call.kind === 'related'); assert.ok(call.context.linked_assets.some(asset => asset.asset_id === second.id));
  h.workspace.updateCategory(category.id, { visibility: 'restricted', version: category.version }, h.admin);
  await h.page.reload(); await panelFor(h).waitFor();
  const result = await api(h.page, '/tickets/' + TARGET_KEY + '/ai'); assert.equal(result.status, 200);
  assert.equal(result.body.related.status, 'stale'); assert.deepEqual(result.body.related.recent_tickets, []); assert.deepEqual(result.body.related.asset_issues, []);
  assert.doesNotMatch(JSON.stringify(result.body.related), /Shared diagnostic display|DISPLAY-HISTORY-2|HD-RELATED-UNCITED|onerror|faulty dock/);
  assert.equal(await historyFor(h).locator(`a[href="#tickets/${PAST}"]`).count(), 0);
  assert.match(await panelFor(h).innerText(), /changed|review again|new review/i);
  assert.deepEqual(h.errors, []);
});

test('AI settings retain the related-ticket switch and sixth editable prompt and use the saved prompt for a review', { timeout: 90000 }, async t => {
  const fake = provider(), h = await harness(t, { aiProviders: fake }); issueFixtures(h); configure(h, { enabled: false });
  await signIn(h.page, h.origin); await openSettings(h);
  const toggle = h.page.getByLabel('Suggest related tickets and asset history', { exact: true });
  assert.equal(await toggle.isChecked(), true);
  const prompt = 'Compare actual symptoms from recent tickets and retained linked-asset history. Explain the evidence for each supplied ticket reference.';
  await h.page.getByLabel('Related tickets prompt', { exact: true }).fill(prompt); await toggle.uncheck();
  let saved = await saveSettings(h); assert.equal(saved.suggest_related, false); assert.equal(saved.prompts.related, prompt); assert.equal(Object.keys(saved.prompts).length, 6);
  await h.page.reload(); await h.page.getByRole('tab', { name: 'AI', exact: true }).click();
  await h.page.getByRole('button', { name: 'Save AI settings', exact: true }).waitFor();
  assert.equal(await h.page.getByLabel('Related tickets prompt', { exact: true }).inputValue(), prompt);
  assert.equal(await h.page.getByLabel('Suggest related tickets and asset history', { exact: true }).isChecked(), false);
  await h.page.getByLabel('Suggest related tickets and asset history', { exact: true }).check(); await h.page.getByLabel('Enable AI assistance', { exact: true }).check();
  saved = await saveSettings(h); assert.equal(saved.suggest_related, true); assert.equal(saved.enabled, true);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(KEY));
  await openTicket(h); await review(h);
  assert.equal(fake.calls.find(call => call.kind === 'related').prompt, prompt);
  assert.deepEqual(h.errors, []);
});

test('unavailable related matching does not lose other assistance and a later review can report no matching issues', { timeout: 90000 }, async t => {
  const fake = provider({ review: async (_input, count) => {
    if (count === 1) throw Object.assign(new Error('PRIVATE-RELATED-UPSTREAM-DETAIL'), { statusCode: 502, safeMessage: 'PRIVATE-RELATED-UPSTREAM-DETAIL' });
    return { recent_tickets: [], asset_issues: [] };
  } }), h = await harness(t, { aiProviders: fake }); issueFixtures(h); configure(h, { auto_tags: true });
  await signIn(h.page, h.origin); await openTicket(h); let state = await review(h);
  assert.equal(state.related.status, 'unavailable'); assert.ok(h.desk.getTicket(TARGET_KEY).tags.includes('Display issue'));
  await eventually(async () => /unavailable|could not|try again/i.test(await recentFor(h).innerText()), 'The related section must explain the unavailable matching result.');
  assert.doesNotMatch(await panelFor(h).innerText(), /PRIVATE-RELATED-UPSTREAM-DETAIL/);
  await eventually(async () => await panelFor(h).getByRole('button', { name: 'Review ticket', exact: true }).isEnabled(), 'Review must remain available after a matching-only provider failure.');
  state = await review(h); assert.equal(state.related.status, 'no_matches');
  await eventually(async () => /no .*related|no .*matching|no similar/i.test(await recentFor(h).innerText()), 'The section must clearly report no matches.');
  assert.equal(await recentFor(h).locator('a[href^="#tickets/"]').count(), 0);
  assert.equal(h.actionMessages.length, 0); assert.deepEqual(h.errors, []);
});

test('mobile related-ticket and asset-history cards fit the drawer and keep draft notes during refresh', { timeout: 90000 }, async t => {
  const longReason = 'The same linked laptop had a similar docking-related display flicker. '.repeat(12);
  const fake = provider({ review: async input => matchingResult(input, { reason: longReason }) });
  const h = await harness(t, { mobile: true, aiProviders: fake }); issueFixtures(h); configure(h);
  await signIn(h.page, h.origin); await openTicket(h); await review(h);
  await historyFor(h).getByText(longReason.trim(), { exact: false }).waitFor();
  await noOverflow(h.page);
  const draft = 'Keep this mobile investigation note.';
  await drawerFor(h).getByLabel('Internal note', { exact: true }).fill(draft);
  await eventually(async () => await panelFor(h).getByRole('button', { name: 'Review ticket', exact: true }).isEnabled(), 'The completed review must allow refreshing.');
  await review(h); await historyFor(h).getByText(longReason.trim(), { exact: false }).waitFor();
  assert.equal(await drawerFor(h).getByLabel('Internal note', { exact: true }).inputValue(), draft);
  await panelFor(h).scrollIntoViewIfNeeded(); await h.page.screenshot({ path: '/tmp/assetdesk-ai-related-mobile.png', fullPage: true });
  await noOverflow(h.page);
  await drawerFor(h).getByLabel('Internal note', { exact: true }).fill('');
  await historyFor(h).locator(`a[href="#assets/${h.laptop.id}"]`).click();
  await h.page.locator('#main-content').getByRole('heading', { name: h.laptop.name, exact: true }).waitFor();
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});
