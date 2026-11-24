import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow, ADMIN_EMAIL, PASSWORD } from './native-browser-helper.mjs';

const RECENT_KEY = 'HD-BROWSER003';
const KEY = 'login-summary-browser-test-key-not-a-real-key';
const dialogFor = h => h.page.getByRole('dialog', { name: 'Ticket activity summary', exact: true });
const summaryResponse = h => h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/login-summary' && response.request().method() === 'POST');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function providers({ summary = 'Review the recently submitted software installation request.', review } = {}) {
  const calls = [];
  return {
    calls,
    async testConnection(input) { return { ok: true, provider: input.provider }; },
    async review(input) {
      assert.equal(input.kind, 'summary', 'These browser tests must invoke only login summaries.');
      const { apiKey: _secret, ...safe } = input;
      calls.push(structuredClone(safe));
      return review ? review(input, calls.length) : { summary, highlights: [{ ticket_key: RECENT_KEY, text: 'Review the software installation request.' }] };
    },
  };
}
function configure(h, patch = {}) {
  return h.aiSettings.update({ version: h.aiSettings.snapshot().version, enabled: true, login_summary_enabled: true, summary_hours: 24,
    auto_tags: false, auto_location: false, auto_assets: false, suggest_fixes: false, auto_reply: false,
    providers: { openai: { api_key: KEY }, anthropic: { api_key: KEY } }, ...patch }, { actor: h.admin });
}
async function loginSummary(h, email = ADMIN_EMAIL) {
  const pending = summaryResponse(h);
  await signIn(h.page, h.origin, email, { keepSummary: true });
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  const data = await response.json();
  if (data.status !== 'disabled') await dialogFor(h).getByRole('heading', { name: new RegExp(`^Past ${data.hours} hours?$`) }).waitFor();
  return { data, dialog: dialogFor(h) };
}
async function signOut(h) {
  const button = h.page.getByRole('button', { name: 'Sign out', exact: true });
  const navigation = h.page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await navigation.isVisible() && !await h.page.locator('.shell').evaluate(shell => shell.classList.contains('menu-open'))) await navigation.click();
  await button.click();
  await h.page.getByLabel('Email address', { exact: true }).waitFor();
}
async function openAiSettings(h) {
  const nav = h.page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await nav.isVisible()) await nav.click();
  await h.page.getByRole('complementary', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
  await h.page.getByRole('tab', { name: 'AI', exact: true }).click();
  await h.page.getByRole('button', { name: 'Save AI settings', exact: true }).waitFor();
}

test('login shows a real-count placeholder without credentials and does not repeat the popup on session restoration', { timeout: 60000 }, async t => {
  const fake = providers(), h = await harness(t, { aiProviders: fake, timezoneId: 'America/New_York' });
  const { data, dialog } = await loginSummary(h);
  assert.equal(data.status, 'placeholder'); assert.equal(data.reason, 'unconfigured'); assert.equal(data.hours, 24);
  assert.equal(data.metrics.total, 2); assert.equal(data.metrics.new, 2);
  assert.equal(fake.calls.length, 0, 'A missing API key must not make a provider request.');
  assert.match(await dialog.innerText(), /AI|API/); assert.match(await dialog.innerText(), /configur|connect|key/i);
  assert.doesNotMatch(await dialog.innerText(), /Review the recently submitted software/);
  await h.page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false, 'Escape must dismiss the summary.');
  const requests = h.requests.filter(url => new URL(url).pathname === '/api/desk/login-summary').length;
  await h.page.reload(); await h.page.getByRole('region', { name: 'Ticket queue', exact: true }).waitFor();
  await h.page.waitForLoadState('networkidle');
  assert.equal(await dialogFor(h).isVisible(), false);
  assert.equal(h.requests.filter(url => new URL(url).pathname === '/api/desk/login-summary').length, requests, 'Restoring a session must not create another summary request.');
  await signOut(h);
  const next = await loginSummary(h);
  assert.equal(next.data.status, 'placeholder');
  await next.dialog.getByRole('button', { name: 'AI settings', exact: true }).click();
  await h.page.getByLabel('Hours to summarize', { exact: true }).waitFor();
  assert.equal(await h.page.getByLabel('Hours to summarize', { exact: true }).inputValue(), '24');
  assert.equal(await dialogFor(h).isVisible(), false);
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});

test('AI settings persist the lookback and editable prompt and Claude summaries use the selected window with safe ticket links', { timeout: 90000 }, async t => {
  const literal = 'Recent support work: <img src="broken" onerror="window.summaryInjected=true"> is literal text.';
  const fake = providers({ summary: literal }), h = await harness(t, { aiProviders: fake });
  h.desk.addNote(RECENT_KEY, { body: 'INTERNAL-NOTE-MUST-STAY-OUT-OF-SUMMARY', actor: h.admin });
  await signIn(h.page, h.origin); await openAiSettings(h);
  await h.page.getByLabel('Enable AI assistance', { exact: true }).check();
  await h.page.getByLabel('Show ticket summary after login', { exact: true }).check();
  await h.page.getByLabel('Hours to summarize', { exact: true }).fill('6');
  await h.page.getByLabel('Active AI provider', { exact: true }).selectOption('anthropic');
  await h.page.getByLabel('Claude API key', { exact: true }).fill(KEY);
  await h.page.getByLabel('Claude model', { exact: true }).fill('claude-summary-browser-model');
  const prompt = 'Summarize this shift. Highlight urgent work and identify the support technician using only the supplied tickets.';
  await h.page.getByLabel('Login summary prompt', { exact: true }).fill(prompt);
  const savedResponse = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/settings/ai' && response.request().method() === 'PATCH');
  await h.page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
  const saved = await savedResponse; assert.equal(saved.status(), 200, await saved.text());
  const snapshot = await saved.json();
  assert.equal(snapshot.summary_hours, 6); assert.equal(snapshot.login_summary_enabled, true); assert.equal(snapshot.prompts.summary, prompt);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(KEY));
  await h.page.reload(); await h.page.getByRole('tab', { name: 'AI', exact: true }).click();
  await h.page.getByLabel('Hours to summarize', { exact: true }).waitFor();
  assert.equal(await h.page.getByLabel('Hours to summarize', { exact: true }).inputValue(), '6');
  assert.equal(await h.page.getByLabel('Login summary prompt', { exact: true }).inputValue(), prompt);
  await signOut(h);
  const { data, dialog } = await loginSummary(h);
  assert.equal(data.status, 'ready'); assert.equal(data.hours, 6); assert.equal(data.metrics.total, 1);
  assert.equal(Date.parse(data.to) - Date.parse(data.from), 6 * 3600000);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]; assert.equal(call.provider, 'anthropic'); assert.equal(call.model, 'claude-summary-browser-model'); assert.equal(call.prompt, prompt);
  const evidence = JSON.stringify(call.context);
  assert.ok(evidence.includes(RECENT_KEY)); assert.ok(!evidence.includes('HD-BROWSER001')); assert.ok(!evidence.includes('HD-BROWSER002'));
  assert.doesNotMatch(evidence, /INTERNAL-NOTE-MUST-STAY-OUT-OF-SUMMARY|Restricted payroll recovery|PC-PRIVATE|provider-credentials/);
  assert.ok((await dialog.innerText()).includes(literal));
  assert.equal(await dialog.locator('img').count(), 0); assert.equal(await h.page.evaluate(() => window.summaryInjected), undefined);
  await h.page.screenshot({ path: '/tmp/assetdesk-login-summary-desktop.png', fullPage: true });
  await noOverflow(h.page);
  await dialog.getByRole('button', { name: RECENT_KEY, exact: true }).click();
  await h.page.getByRole('dialog', { name: 'Ticket details', exact: true }).getByRole('heading', { name: 'Install design software for marketing', exact: true }).waitFor();
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(h.errors, []);
});

test('the master AI switch suppresses inference while enabled OpenAI summaries and the popup toggle remain independent', { timeout: 90000 }, async t => {
  const fake = providers(), h = await harness(t, { aiProviders: fake });
  configure(h, { enabled: false, provider: 'openai' });
  let result = await loginSummary(h);
  assert.equal(result.data.status, 'placeholder'); assert.equal(result.data.reason, 'ai_disabled'); assert.equal(fake.calls.length, 0);
  await result.dialog.getByRole('button', { name: 'Continue to dashboard', exact: true }).click();
  await signOut(h); configure(h, { provider: 'openai' });
  result = await loginSummary(h);
  assert.equal(result.data.status, 'ready'); assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].provider, 'openai');
  await result.dialog.getByRole('button', { name: 'Close ticket summary', exact: true }).click();
  await signOut(h); configure(h, { login_summary_enabled: false });
  result = await loginSummary(h);
  assert.equal(result.data.status, 'disabled');
  await eventually(async () => !await dialogFor(h).isVisible(), 'Turning off login summaries must leave the dashboard usable without a popup.');
  assert.equal(fake.calls.length, 1); assert.deepEqual(h.errors, []);
});

test('empty windows skip AI and a failed provider leaves a dismissible placeholder that can be retried', { timeout: 90000 }, async t => {
  const fake = providers({ review: async (_input, count) => {
    if (count === 1) throw new Error('PRIVATE-UPSTREAM-BODY-' + KEY);
    return { summary: 'The summary is available after retry.', highlights: [] };
  } }), h = await harness(t, { aiProviders: fake });
  configure(h, { summary_hours: 1 });
  let result = await loginSummary(h);
  assert.equal(result.data.status, 'empty'); assert.equal(result.data.metrics.total, 0); assert.equal(fake.calls.length, 0);
  assert.match(await result.dialog.innerText(), /no .*ticket|no .*activit/i);
  await result.dialog.getByRole('button', { name: 'Close ticket summary', exact: true }).click();
  await signOut(h); configure(h);
  result = await loginSummary(h);
  assert.equal(result.data.status, 'placeholder'); assert.equal(result.data.reason, 'unavailable'); assert.equal(fake.calls.length, 1);
  assert.doesNotMatch(await result.dialog.innerText(), /PRIVATE-UPSTREAM-BODY|login-summary-browser-test-key/);
  const pending = summaryResponse(h);
  await result.dialog.getByRole('button', { name: /Try again|Retry/i }).click();
  assert.equal((await pending).status(), 200);
  await result.dialog.getByText('The summary is available after retry.', { exact: true }).waitFor();
  assert.equal(fake.calls.length, 2);
  await h.page.keyboard.press('Escape'); assert.equal(await result.dialog.isVisible(), false);
  assert.deepEqual(h.errors, []);
});

test('a dismissed pending summary cannot replace or reopen the summary of a later signed-in technician', { timeout: 90000 }, async t => {
  const gate = deferred(), started = deferred();
  const fake = providers({ review: async (_input, count) => {
    if (count === 1) { started.resolve(); await gate.promise; return { summary: 'OLD-ADMIN-SUMMARY-MUST-NOT-APPEAR', highlights: [] }; }
    return { summary: 'Current technician summary.', highlights: [] };
  } }), h = await harness(t, { aiProviders: fake });
  t.after(() => gate.resolve()); configure(h);
  const oldRequest = h.page.waitForRequest(request => new URL(request.url()).pathname === '/api/desk/login-summary' && request.method() === 'POST');
  await signIn(h.page, h.origin, ADMIN_EMAIL, { keepSummary: true });
  const pendingRequest = await oldRequest;
  const oldResponse = h.page.waitForResponse(response => response.request() === pendingRequest);
  await started.promise;
  assert.equal(await h.page.getByRole('region', { name: 'Ticket queue', exact: true }).count(), 1, 'The workspace must load while the provider is still pending.');
  await dialogFor(h).getByRole('button', { name: 'Close ticket summary', exact: true }).click();
  await signOut(h);
  // Keep the same document alive so the original request can actually finish
  // after another user signs in; page navigation would abort it instead.
  const nextResponse = summaryResponse(h);
  await h.page.getByLabel('Email address', { exact: true }).fill(h.avery.email);
  await h.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await h.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await nextResponse; assert.equal(response.status(), 200, await response.text());
  assert.equal((await response.json()).status, 'ready');
  const dialog = dialogFor(h);
  await dialog.getByText('Current technician summary.', { exact: true }).waitFor();
  gate.resolve(); await oldResponse; await h.page.waitForLoadState('networkidle');
  assert.ok((await dialog.innerText()).includes('Current technician summary.'));
  assert.doesNotMatch(await h.page.locator('body').innerText(), /OLD-ADMIN-SUMMARY-MUST-NOT-APPEAR/);
  await dialog.getByRole('button', { name: 'Continue to dashboard', exact: true }).click();
  assert.ok((await h.page.getByRole('complementary', { name: 'Main navigation', exact: true }).innerText()).includes('Avery Chen'));
  assert.equal(await h.page.getByLabel('Email address', { exact: true }).isVisible(), false);
  assert.deepEqual(h.errors, []);
});

test('mobile summaries fit the viewport and technicians get setup guidance without administrator controls', { timeout: 90000 }, async t => {
  const fake = providers({ summary: 'Review current support requests. '.repeat(35) }), h = await harness(t, { mobile: true, aiProviders: fake, timezoneId: 'America/New_York' });
  let result = await loginSummary(h, h.avery.email);
  assert.equal(result.data.status, 'placeholder');
  assert.equal(await result.dialog.getByRole('button', { name: 'AI settings', exact: true }).count(), 0);
  assert.match(await result.dialog.innerText(), /administrator/i);
  await noOverflow(h.page);
  await result.dialog.getByRole('button', { name: 'Continue to dashboard', exact: true }).click();
  await signOut(h); configure(h);
  result = await loginSummary(h);
  assert.equal(result.data.status, 'ready');
  await noOverflow(h.page);
  await h.page.screenshot({ path: '/tmp/assetdesk-login-summary-mobile.png', fullPage: true });
  await result.dialog.getByRole('button', { name: 'Continue to dashboard', exact: true }).click();
  await openAiSettings(h);
  assert.equal(await h.page.getByLabel('Hours to summarize', { exact: true }).getAttribute('max'), '720');
  await h.page.getByLabel('Hours to summarize', { exact: true }).fill('48');
  await h.page.getByLabel('Login summary prompt', { exact: true }).fill('Summarize recent requests with a concise handover for the next shift.');
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});
