import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { AiSettings } from '../src/ai-settings.js';
import { LoginSummaryService } from '../src/login-summary.js';

const CLOCK = '2035-05-01T12:00:00.000Z';
const admin = { id: 'summary-admin', name: 'Summary administrator', email: 'summary-admin@example.test', role: 'admin', active: true };
function fixture(t, { configured = true, patch = {}, review } = {}) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: new Date(CLOCK) });
  const store = new Store(':memory:'), desk = new DeskStore(store);
  t.after(() => store.close());
  desk.db.prepare('INSERT INTO technicians(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,1,?)').run(admin.id, admin.email, admin.name, admin.role, 'unused-test-hash', CLOCK);
  const settings = new AiSettings(desk.db, { encryptionKey: 'summary-test-encryption-key-long-enough' });
  if (configured) settings.update({ version: 1, enabled: true, providers: { openai: { api_key: 'summary-openai-private-key' }, anthropic: { api_key: 'summary-claude-private-key' } }, ...patch }, { actor: admin });
  const calls = [], providers = { async review(input) { calls.push(structuredClone(input)); return review ? review(input) : { summary: 'Review recent support requests and prioritize the documented overdue work.', highlights: input.context.tickets.slice(0, 1).map(ticket => ({ ticket_key: ticket.ticket_key, text: 'Review this recent request.' })) }; } };
  const summary = new LoginSummaryService({ desk, settings, providers });
  function ticket(key = 'HD-SUMMARY', values = {}) {
    const created = values.created_at || CLOCK;
    store.saveTicket({ key, requester: 'requester@example.test', subject: values.subject || 'VPN needs investigation', page_id: 0, page_url: '', created_at: created });
    desk.initializeRows();
    const changes = { updated_at: created, description: 'The VPN connection fails.', ...values };
    const allowed = ['created_at','updated_at','description','status','priority','category','assignee_id','first_response_at','resolved_at','response_due_at','resolution_due_at','paused_until'];
    for (const [field, value] of Object.entries(changes)) if (allowed.includes(field)) desk.db.prepare(`UPDATE tickets SET ${field}=? WHERE key=?`).run(value, key);
    return desk.getTicket(key);
  }
  const update = patch => settings.update({ version: settings.snapshot().version, ...patch }, { actor: admin });
  return { store, desk, settings, providers, calls, summary, ticket, update };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('missing active-provider credentials return an honest placeholder with live metrics and never fall back to another key', async t => {
  const h = fixture(t, { configured: false }); h.ticket();
  let result = await h.summary.generate(admin);
  assert.equal(result.status, 'placeholder'); assert.equal(result.reason, 'unconfigured'); assert.equal(result.hours, 24);
  assert.equal(result.metrics.total, 1); assert.equal(result.metrics.new, 1); assert.equal(h.calls.length, 0);
  assert.match(result.summary, /will appear here.*configures an API key/);
  h.update({ enabled: true, providers: { anthropic: { api_key: 'configured-other-provider-only' } } });
  result = await h.summary.generate(admin);
  assert.equal(result.reason, 'unconfigured'); assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /configured-other-provider-only|provider_keys|api_key/);
});

test('master AI and login-summary toggles suppress inference independently and empty windows avoid a provider call', async t => {
  const h = fixture(t); h.ticket(); h.update({ enabled: false });
  assert.equal((await h.summary.generate(admin)).reason, 'ai_disabled');
  h.update({ enabled: true, login_summary_enabled: false });
  assert.equal((await h.summary.generate(admin)).status, 'disabled');
  assert.equal(h.calls.length, 0);
  h.update({ login_summary_enabled: true, summary_hours: 1 });
  h.desk.db.prepare("UPDATE tickets SET created_at='2035-04-29T00:00:00.000Z',updated_at='2035-04-29T00:00:00.000Z'").run();
  const empty = await h.summary.generate(admin);
  assert.equal(empty.status, 'empty'); assert.equal(empty.metrics.total, 0); assert.equal(empty.sample_count, 0);
  assert.match(empty.summary, /past 1 hours/); assert.equal(h.calls.length, 0);
});

test('rolling UTC windows include both boundaries and updated older tickets while excluding old, future, and paused work', async t => {
  const h = fixture(t, { patch: { summary_hours: 12 } });
  h.ticket('HD-BOUNDARY', { created_at: '2035-05-01T00:00:00.000Z', response_due_at: '2035-05-01T02:00:00.000Z' });
  h.ticket('HD-UPDATED', { created_at: '2035-04-01T00:00:00.000Z', updated_at: '2035-05-01T08:00:00.000Z', assignee_id: admin.id, first_response_at: '2035-04-01T01:00:00.000Z', resolution_due_at: '2035-05-02T12:00:00.000Z' });
  h.ticket('HD-RESOLVED', { created_at: '2035-05-01T03:00:00.000Z', status: 'resolved', resolved_at: '2035-05-01T08:00:00.000Z' });
  h.ticket('HD-UPPER', { created_at: CLOCK });
  h.ticket('HD-TOO-OLD', { created_at: '2035-04-30T23:59:59.999Z' });
  h.ticket('HD-FUTURE', { created_at: '2035-05-01T12:00:00.001Z' });
  h.ticket('HD-PAUSED', { status: 'paused', paused_until: '2035-05-02T12:00:00.000Z' });
  const result = await h.summary.generate(admin);
  assert.equal(result.status, 'ready'); assert.equal(result.from, '2035-05-01T00:00:00.000Z'); assert.equal(result.to, CLOCK);
  assert.deepEqual(result.metrics, { total: 4, new: 3, active: 3, resolved: 1, unassigned: 2, overdue: 1 });
  assert.deepEqual(h.calls[0].context.tickets.map(ticket => ticket.ticket_key), ['HD-UPPER','HD-UPDATED','HD-RESOLVED','HD-BOUNDARY']);
  assert.doesNotMatch(JSON.stringify(h.calls), /HD-PAUSED|HD-FUTURE|HD-TOO-OLD/);
});

test('the selected provider receives editable prompts and bounded ticket evidence without notes or secrets, and summary generation leaves tickets unchanged', async t => {
  const h = fixture(t, { patch: { provider: 'anthropic', summary_hours: 6, prompts: { summary: 'Custom shift summary instructions.', system: 'Custom shared system instructions.' } } });
  let ticket = h.ticket();
  h.desk.addNote(ticket.key, { body: 'Private internal technician note must not enter the model context.', actor: admin });
  ticket = h.desk.getTicket(ticket.key);
  const before = JSON.stringify(ticket), result = await h.summary.generate(admin), request = h.calls[0];
  assert.equal(result.status, 'ready'); assert.equal(request.provider, 'anthropic'); assert.equal(request.apiKey, 'summary-claude-private-key');
  assert.equal(request.prompt, 'Custom shift summary instructions.'); assert.equal(request.systemPrompt, 'Custom shared system instructions.');
  assert.equal(request.kind, 'summary'); assert.equal(request.context.window.hours, 6);
  assert.doesNotMatch(JSON.stringify(request.context), /Private internal|summary-claude-private-key|summary-openai-private-key|unused-test-hash/);
  assert.doesNotMatch(JSON.stringify(result), /summary-claude-private-key|Custom shift summary instructions|Custom shared system instructions/);
  assert.equal(JSON.stringify(h.desk.getTicket(ticket.key)), before);
  assert.deepEqual(result.highlights, [{ ticket_key: ticket.key, text: 'Review this recent request.' }]);
});

test('large activity windows report truthful totals while descriptions, tags, ticket sampling and the overall context stay bounded', async t => {
  const h = fixture(t);
  for (let index = 0; index < 65; index++) h.ticket('HD-LARGE-' + String(index).padStart(3, '0'), { description: 'Long request evidence. '.repeat(5000) });
  const insert = h.desk.db.prepare('INSERT INTO ticket_tags(ticket_key,normalized,name,created_at) VALUES(?,?,?,?)');
  for (let index = 0; index < 120; index++) insert.run('HD-LARGE-000', 'tag-' + String(index).padStart(3, '0'), 'tag-' + String(index).padStart(3, '0'), CLOCK);
  const result = await h.summary.generate(admin), context = h.calls[0].context;
  assert.equal(result.metrics.total, 65); assert.equal(result.truncated, true);
  assert.ok(result.sample_count <= 50 && result.sample_count > 0); assert.equal(context.tickets.length, result.sample_count);
  assert.ok(JSON.stringify(context).length <= 50000);
  assert.ok(context.tickets.every(ticket => ticket.description.length <= 1200 && ticket.tags.length <= 10));
  assert.equal(context.tickets[0].ticket_key, 'HD-LARGE-000');
  assert.equal(context.tickets[0].tags.length, 10);
});

test('tag-only truncation is disclosed even when every eligible ticket fits the summary sample', async t => {
  const h = fixture(t); h.ticket();
  const insert = h.desk.db.prepare('INSERT INTO ticket_tags(ticket_key,normalized,name,created_at) VALUES(?,?,?,?)');
  for (let index = 0; index < 11; index++) insert.run('HD-SUMMARY', 'tag-' + index, 'tag-' + index, CLOCK);
  const result = await h.summary.generate(admin);
  assert.equal(result.sample_count, 1); assert.equal(result.metrics.total, 1); assert.equal(result.truncated, true);
});

test('invented ticket references, malformed outputs, remote failures, and echoed credentials become fixed safe placeholders', async t => {
  const h = fixture(t); h.ticket();
  for (const result of [
    { summary: 'Invented ticket evidence', highlights: [{ ticket_key: 'HD-INVENTED', text: 'This ticket does not exist.' }] },
    { summary: 'Invalid extra fields', highlights: [], raw: 'private-account-data' },
    { summary: 'summary-openai-private-key', highlights: [] },
  ]) {
    h.providers.review = async () => result;
    const response = await h.summary.generate(admin);
    assert.equal(response.status, 'placeholder'); assert.equal(response.reason, 'unavailable'); assert.deepEqual(response.highlights, []);
    assert.doesNotMatch(JSON.stringify(response), /HD-INVENTED|private-account-data|summary-openai-private-key|Invented ticket evidence/);
  }
  h.providers.review = async () => { throw new Error('Remote private-account-data summary-openai-private-key'); };
  assert.equal((await h.summary.generate(admin)).reason, 'unavailable');
});

test('concurrent same-user requests share one provider call and a changed ticket suppresses its stale AI response', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, { review: async () => { entered.resolve(); await gate.promise; return { summary: 'Old ticket detail must not be displayed.', highlights: [{ ticket_key: 'HD-SUMMARY', text: 'Old detail.' }] }; } });
  const ticket = h.ticket(), first = h.summary.generate(admin), second = h.summary.generate(admin);
  await entered.promise; assert.equal(h.calls.length, 1);
  h.desk.updateTicket(ticket.key, { paused_until: '2035-05-02T12:00:00.000Z' }, { actor: admin, version: ticket.version });
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.reason === 'context_changed' && result.status === 'placeholder'));
  assert.ok(results.every(result => !result.summary.includes('Old ticket detail') && !result.highlights.length));
  assert.equal(h.summary.inFlight.size, 0);
});

test('settings edits and disabling login summaries during inference cannot deliver a result prepared with old instructions', async t => {
  for (const disabled of [false, true]) {
    const gate = deferred(), entered = deferred();
    const h = fixture(t, { review: async () => { entered.resolve(); await gate.promise; return { summary: 'Do not display old instructions.', highlights: [] }; } });
    h.ticket(); const pending = h.summary.generate(admin); await entered.promise;
    h.update(disabled ? { login_summary_enabled: false } : { summary_hours: 48, prompts: { summary: 'New instructions.' } });
    gate.resolve(); const result = await pending;
    assert.equal(result.status, disabled ? 'disabled' : 'placeholder'); assert.equal(result.reason, 'settings_changed');
    assert.equal(result.hours, disabled ? 24 : 48); assert.ok(!result.summary.includes('old instructions'));
  }
});

test('user deactivation during inference and unauthenticated direct calls cannot return ticket summary data', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, { review: async () => { entered.resolve(); await gate.promise; return { summary: 'Private old session result.', highlights: [] }; } });
  h.ticket(); assert.throws(() => h.summary.generate({ id: 'missing-user' }), error => error.statusCode === 401);
  const pending = h.summary.generate(admin); await entered.promise;
  h.desk.db.prepare('UPDATE technicians SET active=0 WHERE id=?').run(admin.id); gate.resolve();
  await assert.rejects(pending, error => error.statusCode === 401);
  assert.equal(h.summary.inFlight.size, 0);
});

test('summary collection resumes due tickets before deciding whether their activity belongs in the visible summary', async t => {
  const h = fixture(t);
  h.ticket('HD-DUE', { status: 'paused', paused_until: '2035-05-02T12:00:00.000Z' });
  h.desk.db.prepare("UPDATE tickets SET paused_until='2035-05-01T11:59:00.000Z' WHERE key='HD-DUE'").run();
  const result = await h.summary.generate(admin);
  assert.equal(result.status, 'ready'); assert.equal(result.metrics.total, 1);
  assert.equal(h.calls[0].context.tickets[0].status, 'In progress');
  assert.equal(h.desk.getTicket('HD-DUE').status, 'in_progress');
});
