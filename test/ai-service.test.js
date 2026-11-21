import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore, ASSETS_CATEGORY_ID } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { AiSettings } from '../src/ai-settings.js';
import { AiService } from '../src/ai-service.js';

const password = 'AI-service-test-password-2026';
const encryptionKey = 'AI-service-private-encryption-key-2026';
const requester = 'alex@service.example.test';
const message = (text = 'The VPN connection fails.', more = {}) => ({ messageId: `<${randomUUID()}@service.example.test>`, subject: 'VPN connection problem', from: { address: requester, name: 'Alex Employee' }, text, assetRefs: [], receivedAt: new Date().toISOString(), ...more });
async function fixture(t, { filename = ':memory:', patch = {}, review, mailConfigured = true, send } = {}) {
  const store = new Store(filename), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'AI administrator', email: 'admin@service.example.test', password });
  const technician = desk.listTechnicians().find(user => user.email === 'tech@service.example.test') || await desk.createTechnician({ name: 'Technician', email: 'tech@service.example.test', password });
  const settings = new AiSettings(store.db, { encryptionKey });
  settings.update({ version: settings.snapshot().version, enabled: true, providers: { openai: { api_key: 'test-only-provider-key' } }, ...patch }, { actor: admin });
  const calls = [], sent = [];
  const providers = { async review(input) {
    calls.push(structuredClone(input));
    if (review) return review(input);
    if (input.kind === 'triage') return { tags: ['VPN', 'network'], asset_mentions: ['UNMENTIONED-99'] };
    if (input.kind === 'reply') return { needs_information: true, questions: ['What error message appears?'], body: 'Please share the exact error message.' };
    return { summary: 'Use the documented VPN recovery procedure.', steps: ['Reconnect the VPN client.'], article_ids: input.context.documentation.slice(0, 1).map(article => article.id) };
  } };
  const mail = { capabilities: () => ({ email: { configured: mailConfigured } }), isSender: address => address === 'desk@service.example.test', async sendEmail(input) { sent.push(structuredClone(input)); return send ? send(input) : { messageId: input.messageId }; } };
  const ai = new AiService({ desk, workspace, settings, providers, mail, supportEmails: ['support@service.example.test'], logger: { error() {} } });
  const worker = new Worker({ store, desk, workspace, ai, logger: { error() {} } });
  if (t) t.after(async () => { await ai.stop(); await worker.stop(); store.close(); });
  const asset = (ref, type, fields = {}) => workspace.createAsset({ ref, name: ref, type, ...fields }, admin);
  const article = (name = 'VPN recovery', html = '<p>Reconnect the VPN client.</p>', category_id) => workspace.createArticle({ name, html, ...(category_id ? { category_id } : {}) }, admin);
  return { store, desk, workspace, admin, technician, settings, providers, mail, ai, worker, calls, sent, asset, article };
}
async function done(h) { await h.ai.wake(); await turn(); if (h.ai.running) await h.ai.active; }
function state(h, key) { return h.ai.ticketState(key, h.admin); }

test('manual intake returns before AI, then merges tags, looks up requester location, links evidenced shared assets and cites knowledge', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, { review: async input => {
    if (input.kind === 'triage') { entered(); await gate; return { tags: ['VPN', 'network'], asset_mentions: ['PRIVATE-99', 'UNMENTIONED-99'] }; }
    return { summary: 'Follow the VPN documentation.', steps: ['Reconnect the VPN client.'], article_ids: [input.context.documentation[0].id] };
  } });
  h.asset('PERSON-1', 'personnel', { name: 'Alex Employee', email: requester, location: 'Office west' });
  const monitor = h.asset('DISPLAY-1', 'peripheral', { name: 'Design studio monitor' });
  const custom = h.asset('ABC-17', 'pc', { name: 'Custom workstation' });
  h.asset('ABC-170', 'pc'); h.asset('UNMENTIONED-99', 'pc');
  const privateCategory = h.workspace.createCategory({ name: 'Private assets', kind: 'assets', visibility: 'restricted' }, h.admin);
  h.asset('PRIVATE-99', 'pc', { category_id: privateCategory.id });
  const doc = h.article();
  const accepted = h.worker.accept(message('VPN fails on ABC-17 using the Design studio monitor. PRIVATE-99 is in a restricted area.', { desk: { source: 'manual', actor: h.admin } }));
  assert.equal(accepted.state, 'done');
  assert.equal(h.calls.length, 0, 'Intake must commit before any provider request starts.');
  h.desk.addTicketTag(accepted.ticketKey, 'Technician tag', h.technician);
  h.desk.addNote(accepted.ticketKey, { body: 'Private technician note should never enter AI context.', actor: h.technician });
  await started;
  assert.equal(state(h, accepted.ticketKey).status, 'running');
  release(); await done(h);
  const result = state(h, accepted.ticketKey), ticket = h.desk.getTicket(accepted.ticketKey);
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(ticket.tags, ['network', 'Technician tag', 'VPN']);
  assert.equal(ticket.location, 'Office west');
  assert.deepEqual(h.workspace.ticketAssets(ticket.key, h.admin).map(asset => asset.id).sort(), [monitor.id, custom.id].sort());
  assert.equal(result.suggestions.articles[0].id, doc.id); assert.equal(result.suggestions.articles[0].url, '#knowledge/article/' + doc.id);
  assert.doesNotMatch(JSON.stringify(h.calls), /Private technician note|Private assets/);
  assert.ok(!h.calls[0].context.asset_candidates.some(asset => asset.ref === 'PRIVATE-99'));
  assert.equal(h.sent.length, 0);
});

test('location lookup preserves manual values and skips ambiguous or restricted personnel while asset-name ambiguity is scoped to shared records', async t => {
  const h = await fixture(t, { patch: { auto_tags: false, suggest_fixes: false } });
  h.asset('PERSON-ONE', 'personnel', { email: requester, location: 'Office one' });
  const manual = h.worker.accept(message('Known location', { desk: { source: 'manual', location: 'Chosen manually' } })); await done(h);
  assert.equal(h.desk.getTicket(manual.ticketKey).location, 'Chosen manually');
  h.asset('PERSON-TWO', 'personnel', { email: requester, location: 'Office two' });
  const ambiguous = h.worker.accept(message()); await done(h); assert.equal(h.desk.getTicket(ambiguous.ticketKey).location, '');
  const privateCategory = h.workspace.createCategory({ name: 'Restricted personnel', kind: 'assets', visibility: 'restricted' }, h.admin);
  h.asset('PERSON-PRIVATE', 'personnel', { email: 'private@service.example.test', location: 'Secret location', category_id: privateCategory.id });
  const known = h.asset('PUBLIC-DISPLAY', 'peripheral', { name: 'Studio display panel' });
  h.asset('PRIVATE-DISPLAY', 'peripheral', { name: 'Studio display panel', category_id: privateCategory.id });
  const privatePerson = h.worker.accept(message('Please inspect the Studio display panel.', { from: { address: 'private@service.example.test' } })); await done(h);
  assert.equal(h.desk.getTicket(privatePerson.ticketKey).location, '');
  assert.deepEqual(h.workspace.ticketAssets(privatePerson.ticketKey, h.admin).map(asset => asset.id), [known.id]);
});

test('all supplied documentation provenance is revalidated, including an uncited article that becomes restricted', async t => {
  const h = await fixture(t);
  const first = h.article('VPN recovery procedure'), category = h.workspace.createCategory({ name: 'Shared VPN procedures', kind: 'knowledge', visibility: 'all' }, h.admin);
  const second = h.article('VPN advanced troubleshooting', '<p>Check the VPN profile configuration.</p>', category.id);
  const privateCategory = h.workspace.createCategory({ name: 'Secret VPN records', kind: 'knowledge', visibility: 'restricted' }, h.admin);
  h.article('VPN secret procedure', '<p>Private-only-secret-evidence.</p>', privateCategory.id);
  h.providers.review = async input => { h.calls.push(structuredClone(input)); return input.kind === 'triage' ? { tags: [], asset_mentions: [] } : { summary: 'Use the shared guidance.', steps: ['Reconnect the VPN client.'], article_ids: [first.id] }; };
  const accepted = h.worker.accept(message()); await done(h);
  assert.equal(state(h, accepted.ticketKey).suggestions.status, 'ready');
  const supplied = h.calls.find(call => call.kind === 'suggestions').context.documentation;
  assert.ok(supplied.some(article => article.id === second.id)); assert.doesNotMatch(JSON.stringify(h.calls), /Private-only-secret-evidence/);
  h.workspace.updateCategory(category.id, { visibility: 'restricted', version: category.version }, h.admin);
  const hidden = state(h, accepted.ticketKey).suggestions;
  assert.equal(hidden.status, 'stale'); assert.deepEqual(hidden.articles, []); assert.deepEqual(hidden.steps, []); assert.ok(!hidden.summary.includes('shared guidance'));
});

test('automatic questions are fixed to the requester, recorded once, and requester replies thread to the original ticket', async t => {
  const h = await fixture(t, { patch: { auto_tags: false, suggest_fixes: false, auto_reply: true } });
  const initial = message('My application does not work.'), accepted = h.worker.accept(initial); await done(h);
  assert.equal(state(h, accepted.ticketKey).reply.status, 'sent'); assert.equal(h.sent.length, 1);
  const outgoing = h.sent[0]; assert.equal(outgoing.to, requester); assert.equal(outgoing.inReplyTo, initial.messageId); assert.equal(outgoing.autoReply, true);
  assert.ok(outgoing.text.includes('We received your ticket ' + accepted.ticketKey)); assert.ok(outgoing.text.includes('What error message appears?'));
  assert.equal(h.desk.getTicket(accepted.ticketKey).first_response_at, null, 'Automatic acknowledgements do not claim technician response milestones.');
  h.worker.accept(initial); await done(h); assert.equal(h.sent.length, 1, 'Duplicate delivery must not send another reply.');
  const reply = h.worker.accept(message('The error code is 91.', { inReplyTo: outgoing.messageId, references: [outgoing.messageId] }));
  assert.equal(reply.ticketKey, accepted.ticketKey); await done(h);
  assert.equal(h.sent.length, 1); assert.ok(h.desk.getTicket(accepted.ticketKey).notes.some(note => note.body.includes('error code is 91')));
  h.ai.reviewTicket(accepted.ticketKey, h.admin); await done(h); assert.equal(h.sent.length, 1, 'A technician refresh never resends the acknowledgement.');
});

test('reply decisions respect feature toggles, sufficient information, missing SMTP, automatic messages, and support sender suppression', async t => {
  for (const scenario of [
    { name: 'off', patch: { auto_reply: false }, expected: 'disabled' },
    { name: 'enough information', reply: { needs_information: false, questions: [], body: '' }, expected: 'not_needed' },
    { name: 'SMTP missing', mailConfigured: false, expected: 'blocked' },
    { name: 'automatic message', message: { autoReplyAllowed: false }, expected: 'suppressed' },
    { name: 'support sender', message: { from: { address: 'support@service.example.test' } }, expected: 'suppressed' },
    { name: 'own sender', message: { from: { address: 'desk@service.example.test' } }, expected: 'suppressed' },
  ]) {
    const h = await fixture(t, { patch: { auto_tags: false, suggest_fixes: false, auto_reply: true, ...scenario.patch }, mailConfigured: scenario.mailConfigured !== false,
      review: async () => scenario.reply || { needs_information: true, questions: ['What happened?'], body: 'Please share the symptoms.' } });
    const accepted = h.worker.accept(message('Need help.', scenario.message)); await done(h);
    assert.equal(state(h, accepted.ticketKey).reply.status, scenario.expected, scenario.name); assert.equal(h.sent.length, 0, scenario.name);
  }
});

test('settings or ticket changes while a provider is pending prevent stale tags and outgoing replies', async t => {
  for (const change of ['settings', 'ticket', 'resolution']) {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const h = await fixture(t, { patch: { auto_tags: false, suggest_fixes: false, auto_reply: true }, review: async () => { entered(); await gate; return { needs_information: true, questions: ['What happened?'], body: 'Please share symptoms.' }; } });
    const accepted = h.worker.accept(message()); await started;
    if (change === 'settings') h.settings.update({ version: h.settings.snapshot().version, auto_reply: false }, { actor: h.admin });
    else { const ticket = h.desk.getTicket(accepted.ticketKey); h.desk.updateTicket(ticket.key, change === 'ticket' ? { subject: 'A new clarified problem' } : { status: 'resolved', resolution: 'Fixed by technician.' }, { actor: h.admin, version: ticket.version }); }
    release(); await done(h); assert.equal(h.sent.length, 0, change);
    assert.equal(state(h, accepted.ticketKey).status, change === 'resolution' ? 'completed' : 'blocked', change);
  }
});

test('malformed provider outputs and invented sources cannot modify tags or expose unsupported fixes', async t => {
  const h = await fixture(t, { review: async () => ({ tags: ['Valid tag', 'bad\nheader'], asset_mentions: [] }) });
  const first = h.worker.accept(message()); await done(h);
  assert.equal(state(h, first.ticketKey).status, 'failed'); assert.deepEqual(h.desk.getTicket(first.ticketKey).tags, []);
  h.article(); h.providers.review = async input => input.kind === 'triage' ? { tags: [], asset_mentions: [] } : { summary: 'A fake source proves this.', steps: ['Run an unsupported fix.'], article_ids: ['invented-source'] };
  const second = h.worker.accept(message()); await done(h);
  const result = state(h, second.ticketKey); assert.equal(result.status, 'failed'); assert.deepEqual(result.suggestions.steps, []); assert.deepEqual(result.suggestions.articles, []);
  assert.doesNotMatch(JSON.stringify(result), /test-only-provider-key|unsupported fix/);
});

test('a newer receipt supersedes a pending review and manual tag removals remain respected', async t => {
  let release, entered, firstCall = true;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, { patch: { suggest_fixes: false }, review: async () => { if (firstCall) { firstCall = false; entered(); await gate; return { tags: ['Stale tag'], asset_mentions: [] }; } return { tags: ['Current tag'], asset_mentions: [] }; } });
  const original = message(), accepted = h.worker.accept(original); await started;
  h.worker.accept(message('The requester clarified the symptom.', { inReplyTo: original.messageId, references: [original.messageId] })); release(); await done(h);
  assert.deepEqual(h.desk.getTicket(accepted.ticketKey).tags, ['Current tag']);
  let releaseAgain, enteredAgain;
  const nextGate = new Promise(resolve => { releaseAgain = resolve; }), nextStarted = new Promise(resolve => { enteredAgain = resolve; });
  h.providers.review = async () => { enteredAgain(); await nextGate; return { tags: ['Current tag', 'New tag'], asset_mentions: [] }; };
  h.ai.reviewTicket(accepted.ticketKey, h.admin); await nextStarted; h.desk.removeTicketTag(accepted.ticketKey, 'Current tag', h.technician); releaseAgain(); await done(h);
  assert.deepEqual(h.desk.getTicket(accepted.ticketKey).tags, ['New tag']);
});

test('uncertain mail delivery survives restart without replay and historical tickets remain manually reviewable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-ai-')), filename = join(directory, 'desk.sqlite'); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await fixture(null, { filename, patch: { auto_tags: false, suggest_fixes: false, auto_reply: true }, send: async () => { throw Object.assign(new Error('private transport body'), { uncertain: true }); } });
  const accepted = first.worker.accept(message()); await done(first);
  assert.equal(state(first, accepted.ticketKey).status, 'needs_attention'); assert.equal(first.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(state(first, accepted.ticketKey)), /private transport body/);
  // A crash between SMTP acceptance and the completion marker leaves sending.
  first.store.db.prepare("UPDATE ai_ticket_replies SET state='sending' WHERE ticket_key=?").run(accepted.ticketKey);
  await first.ai.stop(); first.store.close();
  const reopened = await fixture(t, { filename, patch: { auto_tags: false, suggest_fixes: false, auto_reply: true } });
  await reopened.ai.start(); assert.equal(state(reopened, accepted.ticketKey).reply.status, 'needs_attention'); assert.equal(reopened.sent.length, 0);
  reopened.ai.reviewTicket(accepted.ticketKey, reopened.admin); await done(reopened); assert.equal(reopened.sent.length, 0); assert.equal(state(reopened, accepted.ticketKey).status, 'needs_attention');
  reopened.settings.update({ version: reopened.settings.snapshot().version, enabled: false }, { actor: reopened.admin });
  const historical = reopened.worker.accept(message('A ticket accepted while disabled.'));
  reopened.settings.update({ version: reopened.settings.snapshot().version, enabled: true }, { actor: reopened.admin });
  assert.equal(state(reopened, historical.ticketKey).status, 'not_reviewed'); assert.equal(state(reopened, historical.ticketKey).can_review, true);
});
