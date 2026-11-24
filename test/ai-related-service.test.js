import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { AiSettings } from '../src/ai-settings.js';
import { AiService } from '../src/ai-service.js';

const NOW = '2035-05-04T12:00:00.000Z';
const key = 'HD-CURRENT';
const secret = 'private-related-provider-test-key';
const password = 'Related-service-test-password-2035';
const encryptionKey = 'related-service-stable-test-encryption-key';
const hoursAgo = hours => new Date(Date.parse(NOW) - hours * 3600000).toISOString();
const freeze = t => t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { filename = ':memory:', patch = {}, review } = {}) {
  const store = new Store(filename), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ email: 'admin@related.example.test', name: 'Related administrator', password });
  const settings = new AiSettings(store.db, { encryptionKey });
  settings.update({ version: settings.snapshot().version, enabled: true, auto_tags: false, auto_location: false, auto_assets: false,
    suggest_fixes: false, suggest_related: true, auto_reply: false, login_summary_enabled: false,
    providers: { openai: { api_key: secret }, anthropic: { api_key: 'private-related-claude-test-key' } }, ...patch }, { actor: admin });
  const calls = [], sent = [];
  const providers = { async review(input) {
    calls.push(structuredClone(input));
    if (review) return review(input);
    if (input.kind === 'related') return { recent_tickets: [], asset_issues: [] };
    if (input.kind === 'reply') return { needs_information: true, questions: ['What error do you see?'], body: 'Please share the exact error message.' };
    if (input.kind === 'triage') return { tags: ['Network'], asset_mentions: [] };
    return { summary: 'Use the guide.', steps: ['Follow the documented procedure.'], article_ids: input.context.documentation.slice(0, 1).map(article => article.id) };
  } };
  const mail = { capabilities: () => ({ email: { configured: true } }), isSender: () => false,
    async sendEmail(message) { sent.push(structuredClone(message)); return { messageId: message.messageId }; } };
  const ai = new AiService({ desk, workspace, settings, providers, mail, logger: { error() {} } });
  const worker = new Worker({ store, desk, workspace, ai, logger: { error() {} } });
  if (t) t.after(async () => { await ai.stop(); await worker.stop(); store.close(); });
  function ticket(ticketKey = key, fields = {}) {
    store.saveTicket({ key: ticketKey, requester: 'requester@related.example.test', subject: fields.subject || 'VPN connection drops repeatedly', page_id: 0, page_url: '', created_at: fields.created_at || NOW });
    desk.captureEmail(ticketKey, { text: fields.description || 'The VPN disconnects when the display docking station is connected.', from: { address: 'requester@related.example.test', name: 'Requester' }, receivedAt: fields.created_at || NOW }, { receiptId: 'related-fixture-' + randomUUID(), source: 'manual' });
    store.db.prepare('UPDATE tickets SET created_at=?,updated_at=?,status=?,resolution=? WHERE key=?')
      .run(fields.created_at || NOW, fields.updated_at || fields.created_at || NOW, fields.status || 'open', fields.resolution || '', ticketKey);
    return desk.getTicket(ticketKey);
  }
  function asset(ref, fields = {}) { return workspace.createAsset({ ref, name: ref, type: 'laptop', ...fields }, admin); }
  return { store, desk, workspace, admin, settings, ai, worker, calls, sent, ticket, asset };
}
async function done(h) { await h.ai.wake(); await turn(); if (h.ai.running) await h.ai.active; }
async function review(h, ticketKey = key) { h.ai.reviewTicket(ticketKey, h.admin); await done(h); return h.ai.ticketState(ticketKey, h.admin); }

test('related review works without documentation and returns canonical recent links plus older similar asset issues', async t => {
  freeze(t);
  let selectedAsset;
  const h = await fixture(t, { patch: { provider: 'anthropic', prompts: { related: 'Find genuine symptom matches and cite exact supplied tickets.' } }, review: async input => {
    assert.equal(input.kind, 'related');
    return { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'Both VPN connections drop when a docking station is connected.' }],
      asset_issues: [{ asset_id: selectedAsset.id, ticket_key: 'HD-OLD', reason: 'The same laptop previously had matching docking symptoms.' }] };
  } });
  h.ticket(); h.ticket('HD-RECENT', { subject: 'VPN disconnects with docking station', created_at: hoursAgo(20) });
  h.ticket('HD-OLD', { subject: 'Docking station interrupts VPN on laptop', created_at: hoursAgo(720), status: 'resolved', resolution: 'Updated the docking station firmware.' });
  selectedAsset = h.asset('LAPTOP-2002', { name: 'Support laptop', serial_number: 'Serial must not enter related context' });
  h.workspace.linkTicket(key, selectedAsset.id, h.admin); h.workspace.linkTicket('HD-OLD', selectedAsset.id, h.admin);
  h.desk.addNote(key, { body: 'Internal-only-private-note-must-not-leak', actor: h.admin });
  const before = h.desk.getTicket(key), result = await review(h);
  assert.equal(result.status, 'completed'); assert.equal(result.suggestions.status, 'disabled'); assert.equal(result.related.status, 'ready');
  assert.equal(result.related.recent_tickets[0].subject, 'VPN disconnects with docking station');
  assert.equal(result.related.recent_tickets[0].url, '#tickets/HD-RECENT');
  assert.equal(result.related.asset_issues[0].asset.name, 'Support laptop');
  assert.equal(result.related.asset_issues[0].tickets[0].resolution, 'Updated the docking station firmware.');
  assert.equal(result.related.asset_issues[0].tickets[0].url, '#tickets/HD-OLD');
  assert.equal(h.calls[0].provider, 'anthropic'); assert.equal(h.calls[0].prompt, 'Find genuine symptom matches and cite exact supplied tickets.');
  assert.doesNotMatch(JSON.stringify(h.calls[0].context), /Internal-only|Serial must|requester@|api_key/);
  assert.ok(!Object.hasOwn(result.related, 'provenance')); assert.doesNotMatch(JSON.stringify(result.related), /private-related/);
  assert.deepEqual(h.desk.getTicket(key), before, 'Suggested links must not change ticket fields, notes, or audit history.');
});

test('asset history includes an asset linked by the same review before matching begins', async t => {
  freeze(t); let linkedAsset;
  const h = await fixture(t, { patch: { auto_assets: true, auto_tags: true }, review: async input => {
    if (input.kind === 'triage') return { tags: ['Docking'], asset_mentions: ['LAPTOP-2002'] };
    assert.ok(input.context.linked_assets.some(asset => asset.asset_id === linkedAsset.id));
    return { recent_tickets: [], asset_issues: [{ asset_id: linkedAsset.id, ticket_key: 'HD-OLD', reason: 'Matching display disconnections on this laptop.' }] };
  } });
  linkedAsset = h.asset('LAPTOP-2002');
  h.ticket(key, { subject: 'Display docking failure on LAPTOP-2002' }); h.ticket('HD-OLD', { created_at: hoursAgo(500) });
  h.workspace.linkTicket('HD-OLD', linkedAsset.id, h.admin);
  const result = await review(h);
  assert.equal(result.status, 'completed'); assert.equal(result.related.status, 'ready');
  assert.equal(h.workspace.ticketAssets(key, h.admin)[0].id, linkedAsset.id);
  assert.deepEqual(h.desk.getTicket(key).tags, ['Docking']);
  assert.equal(result.related.asset_issues[0].tickets[0].key, 'HD-OLD');
});

test('empty candidate sets and disabled matching avoid provider requests while missing keys remain a setup error', async t => {
  freeze(t);
  const empty = await fixture(t); empty.ticket();
  const noMatches = await review(empty); assert.equal(noMatches.related.status, 'no_matches'); assert.equal(empty.calls.length, 0);
  const disabled = await fixture(t, { patch: { suggest_related: false } }); disabled.ticket(); disabled.ticket('HD-RECENT', { created_at: hoursAgo(2) });
  assert.equal((await review(disabled)).related.status, 'disabled'); assert.equal(disabled.calls.length, 0);
  const missing = await fixture(t); missing.ticket(); missing.ticket('HD-RECENT', { created_at: hoursAgo(2) });
  missing.settings.update({ version: missing.settings.snapshot().version, providers: { openai: { clear_key: true } } }, { actor: missing.admin });
  const blocked = await review(missing); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.related.recent_tickets.length, 0); assert.equal(missing.calls.length, 0);
});

test('unrelated provider failures and unsupported references do not interrupt acknowledgements or expose previous issues to the reply model', async t => {
  freeze(t);
  const scenarios = ['remote error', 'malformed', 'invented ticket', 'invented asset pair', 'credential echo'];
  for (const scenario of scenarios) {
    let linkedAsset;
    const h = await fixture(t, { patch: { auto_reply: true }, review: async input => {
      if (input.kind === 'reply') {
        assert.deepEqual(Object.keys(input.context), ['ticket']);
        assert.doesNotMatch(JSON.stringify(input.context), /Previous-case-private-resolution|Similar incident reason/);
        return { needs_information: true, questions: ['What error message do you see?'], body: 'Please share the exact error message.' };
      }
      if (scenario === 'remote error') throw new Error('PRIVATE-PROVIDER-BODY-' + secret);
      if (scenario === 'malformed') return { recent_tickets: 'bad', asset_issues: [] };
      if (scenario === 'invented ticket') return { recent_tickets: [{ ticket_key: 'HD-INVENTED', reason: 'Similar incident reason' }], asset_issues: [] };
      if (scenario === 'invented asset pair') return { recent_tickets: [], asset_issues: [{ asset_id: linkedAsset.id, ticket_key: 'HD-RECENT', reason: 'Similar incident reason' }] };
      return { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: secret }], asset_issues: [] };
    } });
    h.ticket(); h.ticket('HD-RECENT', { created_at: hoursAgo(3) }); h.ticket('HD-OLD', { created_at: hoursAgo(500), resolution: 'Previous-case-private-resolution' });
    linkedAsset = h.asset('LAPTOP-FAIL-' + scenarios.indexOf(scenario));
    h.workspace.linkTicket(key, linkedAsset.id, h.admin); h.workspace.linkTicket('HD-OLD', linkedAsset.id, h.admin);
    h.ai.enqueue(key, { source: 'email', is_reply: false, auto_reply_allowed: true }); await done(h);
    const state = h.ai.ticketState(key, h.admin);
    assert.equal(state.status, 'completed', scenario); assert.equal(state.related.status, 'unavailable', scenario);
    assert.equal(state.related.coverage, null, 'A failed review must not retain asset association counts without provenance.');
    assert.equal(state.reply.status, 'sent', scenario); assert.equal(h.sent.length, 1, scenario);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE-PROVIDER|private-related-provider|Similar incident reason/);
    assert.doesNotMatch(h.sent[0].text, /Previous-case-private-resolution|Similar incident reason/);
  }
});

test('a related-context collection failure leaves existing requester acknowledgements available', async t => {
  freeze(t);
  const h = await fixture(t, { patch: { auto_reply: true } }); h.ticket(); h.ticket('HD-RECENT', { created_at: hoursAgo(2) });
  // Simulate the optional asset-history query becoming unavailable while the
  // ticket and mail stores remain healthy; only the related stage uses it.
  h.store.db.exec('ALTER TABLE native_asset_tickets RENAME TO temporarily_unavailable_asset_links');
  try {
    h.ai.enqueue(key, { source: 'email', is_reply: false, auto_reply_allowed: true }); await done(h);
    const result = h.ai.ticketState(key, h.admin);
    assert.equal(result.status, 'completed'); assert.equal(result.related.status, 'unavailable');
    assert.equal(result.related.coverage, null); assert.equal(result.related.window, null);
    assert.equal(result.reply.status, 'sent'); assert.equal(h.sent.length, 1);
    assert.deepEqual(h.calls.map(call => call.kind), ['reply']);
  } finally { h.store.db.exec('ALTER TABLE temporarily_unavailable_asset_links RENAME TO native_asset_tickets'); }
});

test('asset permissions changing during review invalidate the entire result including an uncited supplied asset', async t => {
  freeze(t); const entered = deferred(), gate = deferred(); let cited;
  const h = await fixture(t, { review: async () => { entered.resolve(); await gate.promise; return { recent_tickets: [], asset_issues: [{ asset_id: cited.id, ticket_key: 'HD-OLD-A', reason: 'A matching previous issue.' }] }; } });
  h.ticket(); h.ticket('HD-OLD-A', { created_at: hoursAgo(400) }); h.ticket('HD-OLD-B', { created_at: hoursAgo(450) });
  cited = h.asset('LAPTOP-A-1'); const uncited = h.asset('LAPTOP-B-2');
  for (const [asset, ticketKey] of [[cited, 'HD-OLD-A'], [uncited, 'HD-OLD-B']]) { h.workspace.linkTicket(key, asset.id, h.admin); h.workspace.linkTicket(ticketKey, asset.id, h.admin); }
  h.ai.reviewTicket(key, h.admin);
  try {
    await entered.promise;
    const restricted = h.workspace.createCategory({ name: 'Private asset history', kind: 'assets', visibility: 'restricted' }, h.admin);
    h.workspace.updateAsset(uncited.id, { category_id: restricted.id, version: uncited.version }, h.admin);
  } finally { gate.resolve(); }
  await done(h); const result = h.ai.ticketState(key, h.admin);
  assert.equal(result.status, 'completed'); assert.equal(result.related.status, 'stale');
  assert.deepEqual(result.related.recent_tickets, []); assert.deepEqual(result.related.asset_issues, []);
  assert.doesNotMatch(JSON.stringify(result.related), /A matching previous issue|Private asset history|LAPTOP-B-2/);
});

test('current ticket or AI settings edits while matching is pending retain normal stale-job safeguards', async t => {
  freeze(t);
  for (const change of ['ticket', 'settings']) {
    const entered = deferred(), gate = deferred();
    const h = await fixture(t, { patch: { auto_reply: true }, review: async () => { entered.resolve(); await gate.promise; return { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'Old issue evidence.' }], asset_issues: [] }; } });
    h.ticket(); h.ticket('HD-RECENT', { created_at: hoursAgo(2) }); h.ai.enqueue(key, { source: 'email', auto_reply_allowed: true });
    try {
      await entered.promise;
      if (change === 'ticket') { const ticket = h.desk.getTicket(key); h.desk.updateTicket(key, { subject: 'A clarified and different problem' }, { version: ticket.version, actor: h.admin }); }
      else h.settings.update({ version: h.settings.snapshot().version, prompts: { related: 'Use changed instructions.' } }, { actor: h.admin });
    } finally { gate.resolve(); }
    await done(h); const result = h.ai.ticketState(key, h.admin);
    assert.equal(result.status, 'blocked', change); assert.equal(h.sent.length, 0, change);
    assert.equal(result.related.recent_tickets.length, 0); assert.doesNotMatch(JSON.stringify(result.related), /Old issue evidence/);
  }
});

test('retained related results are hidden after source unlinking, recent expiry, or feature disablement', async t => {
  freeze(t); let linkedAsset;
  const h = await fixture(t, { review: async () => ({ recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'Recent matching symptoms.' }], asset_issues: [{ asset_id: linkedAsset.id, ticket_key: 'HD-OLD', reason: 'Past matching symptoms.' }] }) });
  h.ticket(); h.ticket('HD-RECENT', { created_at: hoursAgo(50) }); h.ticket('HD-OLD', { created_at: hoursAgo(500) }); linkedAsset = h.asset('LAPTOP-REFRESH-1');
  h.workspace.linkTicket(key, linkedAsset.id, h.admin); h.workspace.linkTicket('HD-OLD', linkedAsset.id, h.admin);
  assert.equal((await review(h)).related.status, 'ready');
  h.store.db.prepare('DELETE FROM native_asset_tickets WHERE asset_id=? AND ticket_key=?').run(linkedAsset.id, 'HD-OLD');
  assert.equal(h.ai.ticketState(key, h.admin).related.status, 'stale');
  h.workspace.linkTicket('HD-OLD', linkedAsset.id, h.admin); assert.equal((await review(h)).related.status, 'ready');
  t.mock.timers.tick(23 * 3600000);
  const expired = h.ai.ticketState(key, h.admin).related;
  assert.equal(expired.status, 'stale'); assert.deepEqual(expired.recent_tickets, []); assert.deepEqual(expired.asset_issues, []);
  h.settings.update({ version: h.settings.snapshot().version, suggest_related: false }, { actor: h.admin });
  assert.equal(h.ai.ticketState(key, h.admin).related.status, 'disabled');
});

test('valid related matches survive a database restart and remain linked to canonical source records', async t => {
  freeze(t); const directory = mkdtempSync(join(tmpdir(), 'assetdesk-related-')), filename = join(directory, 'desk.sqlite');
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = await fixture(null, { filename, review: async () => ({ recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'Same VPN symptoms.' }], asset_issues: [] }) });
  first.ticket(); first.ticket('HD-RECENT', { subject: 'Previous VPN failure', created_at: hoursAgo(6) });
  assert.equal((await review(first)).related.status, 'ready'); await first.ai.stop(); await first.worker.stop(); first.store.close();
  store = new Store(filename); const desk = new DeskStore(store), workspace = new WorkspaceStore(desk), settings = new AiSettings(store.db, { encryptionKey });
  const ai = new AiService({ desk, workspace, settings, providers: { review() { assert.fail('Reading durable results must not make a provider call.'); } }, mail: {}, logger: { error() {} } });
  const result = ai.ticketState(key, first.admin).related;
  assert.equal(result.status, 'ready'); assert.equal(result.recent_tickets[0].subject, 'Previous VPN failure'); assert.equal(result.recent_tickets[0].url, '#tickets/HD-RECENT');
  assert.ok(!Object.hasOwn(result, 'provenance'));
});

test('manual and email intake commit before a pending related review while subsequent requester replies remain separate from history context', async t => {
  freeze(t); const entered = deferred(), gate = deferred(); let first = true;
  const h = await fixture(t, { review: async input => { if (first) { first = false; entered.resolve(); await gate.promise; } return { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'Similar VPN disconnections.' }], asset_issues: [] }; } });
  h.ticket('HD-RECENT', { created_at: hoursAgo(10) });
  const original = { messageId: '<related-manual@example.test>', subject: 'The VPN disconnects repeatedly', text: 'The VPN client loses its connection with docking.', from: { address: 'requester@related.example.test' }, assetRefs: [], receivedAt: NOW, desk: { source: 'manual', actor: h.admin } };
  const accepted = h.worker.accept(original);
  assert.equal(accepted.state, 'done'); assert.equal(h.calls.length, 0, 'Durable intake must finish before any related provider call starts.');
  try { await entered.promise; assert.equal(h.ai.ticketState(accepted.ticketKey, h.admin).status, 'running'); }
  finally { gate.resolve(); }
  await done(h); assert.equal(h.ai.ticketState(accepted.ticketKey, h.admin).related.recent_tickets[0].key, 'HD-RECENT');
  const reply = h.worker.accept({ ...original, desk: undefined, messageId: '<related-reply@example.test>', text: 'The exact disconnect error is 812.', inReplyTo: original.messageId, references: [original.messageId] });
  assert.equal(reply.ticketKey, accepted.ticketKey); await done(h);
  assert.equal(h.ai.ticketState(accepted.ticketKey, h.admin).related.status, 'ready');
  assert.equal(h.sent.length, 0); assert.ok(h.desk.getTicket(accepted.ticketKey).notes.some(note => note.body.includes('812')));
});
