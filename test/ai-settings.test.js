import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { AiSettings, AI_DEFAULT_MODELS, AI_DEFAULT_PROMPTS } from '../src/ai-settings.js';

const actor = { id: 'admin-test', name: 'AI administrator', role: 'admin', active: true };
const encryptionKey = 'AI settings encryption test key '.repeat(2);
function fixture(t, options = {}) {
  const store = new Store(':memory:'), settings = new AiSettings(store.db, { encryptionKey, ...options });
  t.after(() => store.close()); return { store, settings };
}

test('AI settings default to disabled and encrypt both provider keys separately from editable prompts', t => {
  const { store, settings } = fixture(t), initial = settings.snapshot();
  assert.equal(initial.version, 1); assert.equal(initial.enabled, false); assert.equal(initial.auto_reply, false);
  assert.equal(initial.login_summary_enabled, true); assert.equal(initial.summary_hours, 24);
  assert.deepEqual(initial.prompts, AI_DEFAULT_PROMPTS); assert.equal(initial.providers.openai.model, AI_DEFAULT_MODELS.openai);
  assert.equal(initial.providers.anthropic.key_configured, false);
  const prompts = Object.fromEntries(Object.keys(AI_DEFAULT_PROMPTS).map(key => [key, 'Custom editable ' + key + ' instructions.']));
  const saved = settings.update({ version: initial.version, enabled: true, provider: 'anthropic', auto_reply: true, prompts,
    providers: { openai: { api_key: 'private-openai-key', model: 'gpt-4.1-mini' }, anthropic: { api_key: 'private-claude-key', model: 'claude-sonnet-4-5' } } }, { actor });
  assert.equal(saved.version, 2); assert.equal(saved.enabled, true); assert.equal(saved.provider, 'anthropic');
  assert.equal(saved.providers.openai.key_configured, true); assert.equal(saved.providers.anthropic.key_configured, true);
  assert.deepEqual(saved.prompts, prompts);
  assert.doesNotMatch(JSON.stringify(saved), /private-openai-key|private-claude-key|api_key/);
  const persisted = store.db.prepare('SELECT config,provider_keys FROM ai_settings WHERE id=1').get();
  assert.doesNotMatch(JSON.stringify(persisted), /private-openai-key|private-claude-key/);
  const runtime = settings.runtime(); assert.equal(runtime.providers.openai.api_key, 'private-openai-key'); assert.equal(runtime.providers.anthropic.api_key, 'private-claude-key');
  saved.prompts.system = 'Mutated client copy'; assert.equal(settings.snapshot().prompts.system, prompts.system);
  const events = store.db.prepare('SELECT * FROM ai_settings_events').all();
  assert.equal(events.length, 1); assert.match(events[0].changed_fields, /providers.openai.key_updated/);
  assert.doesNotMatch(JSON.stringify(events), /private-openai-key|private-claude-key|Custom editable/);
});

test('encrypted credentials survive reopening and reject key rotation or provider ciphertext swapping safely', t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-ai-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'settings.sqlite');
  const first = new Store(filename), original = new AiSettings(first.db, { encryptionKey });
  original.update({ version: 1, providers: { openai: { api_key: 'private-persisted-key' }, anthropic: { api_key: 'private-second-key' } } }, { actor }); first.close();
  const reopened = new Store(filename); t.after(() => reopened.close());
  const restored = new AiSettings(reopened.db, { encryptionKey }); assert.equal(restored.runtime().providers.openai.api_key, 'private-persisted-key');
  const row = reopened.db.prepare('SELECT provider_keys FROM ai_settings').get(), keys = JSON.parse(row.provider_keys);
  reopened.db.prepare('UPDATE ai_settings SET provider_keys=?').run(JSON.stringify({ ...keys, anthropic: keys.openai }));
  assert.throws(() => restored.runtime(), error => error.statusCode === 503 && /could not be decrypted/.test(error.message) && !/private-/.test(error.message));
  reopened.db.prepare('UPDATE ai_settings SET provider_keys=?').run(row.provider_keys);
  const rotated = new AiSettings(reopened.db, { encryptionKey: 'a different long server encryption key'.repeat(2) });
  assert.equal(rotated.snapshot().providers.openai.key_configured, true);
  assert.throws(() => rotated.runtime(), error => error.statusCode === 503 && !/private-persisted-key|private-second-key/.test(error.message));
  const replacement = rotated.update({ version: rotated.snapshot().version, providers: { openai: { api_key: 'replacement-key' }, anthropic: { clear_key: true } } }, { actor });
  assert.equal(replacement.providers.anthropic.key_configured, false); assert.equal(rotated.runtime().providers.openai.api_key, 'replacement-key');
});

test('AI settings validate fields, preserve blank keys, clear explicitly, and reject stale or unauthorized saves atomically', t => {
  const { settings } = fixture(t);
  const saved = settings.update({ version: 1, providers: { openai: { api_key: 'retained-private-key' } } }, { actor });
  const kept = settings.update({ version: saved.version, providers: { openai: { api_key: '', model: 'gpt-4.1' } } }, { actor });
  assert.equal(settings.runtime().providers.openai.api_key, 'retained-private-key'); assert.equal(kept.providers.openai.model, 'gpt-4.1');
  assert.throws(() => settings.update({ version: saved.version, enabled: true }, { actor }), error => error.statusCode === 409);
  assert.throws(() => settings.update({ version: kept.version, enabled: true }, { actor: { role: 'technician', active: true } }), error => error.statusCode === 403);
  for (const patch of [
    { enabled: 'true' }, { provider: 'other' }, { api_key: 'private-key-at-wrong-level' }, { prompts: { unknown: 'Instructions' } },
    { prompts: { system: '' } }, { prompts: { reply: 'x'.repeat(12001) } }, { providers: { openai: { baseUrl: 'https://other.example.test' } } },
    { providers: { openai: { api_key: 'bad\nheader' } } }, { providers: { openai: { clear_key: true, api_key: 'unexpected-replacement' } } },
    { providers: { anthropic: { model: 'model\r\nheader' } } },
  ]) {
    assert.throws(() => settings.update({ version: kept.version, ...patch }, { actor }), error => error.statusCode === 400 && !/private-key-at-wrong-level|bad\nheader|unexpected-replacement/.test(error.message));
    assert.equal(settings.snapshot().version, kept.version, 'Rejected saves must not partially change settings.');
  }
  const cleared = settings.update({ version: kept.version, providers: { openai: { clear_key: true } } }, { actor });
  assert.equal(cleared.providers.openai.key_configured, false); assert.equal(settings.runtime().providers.openai.api_key, '');
});

test('disabled deployments work without an encryption secret while credential writes require a stable server key', t => {
  const { settings } = fixture(t, { encryptionKey: undefined });
  assert.equal(settings.snapshot().enabled, false); assert.equal(settings.runtime().providers.openai.api_key, '');
  assert.throws(() => settings.update({ version: 1, enabled: true, providers: { openai: { api_key: 'never-saved-private-key' } } }, { actor }), error => error.statusCode === 503 && !error.message.includes('never-saved-private-key'));
  assert.equal(settings.snapshot().version, 1); assert.equal(settings.snapshot().enabled, false);
});

test('legacy AI settings inherit login summary defaults without changing saved credentials, prompts, or revision on reads', t => {
  const { store, settings } = fixture(t);
  settings.update({ version: 1, enabled: true, provider: 'anthropic', auto_tags: false, prompts: { system: 'Existing shared instruction.', reply: 'Existing requester instruction.' }, providers: { anthropic: { model: 'claude-existing-model', api_key: 'legacy-provider-private-key' } } }, { actor });
  const saved = store.db.prepare('SELECT * FROM ai_settings WHERE id=1').get(), legacy = JSON.parse(saved.config);
  delete legacy.login_summary_enabled; delete legacy.summary_hours; delete legacy.prompts.summary;
  store.db.prepare('UPDATE ai_settings SET config=? WHERE id=1').run(JSON.stringify(legacy));
  const before = store.db.prepare('SELECT * FROM ai_settings WHERE id=1').get();
  const restored = new AiSettings(store.db, { encryptionKey });
  const snapshot = restored.snapshot();
  assert.equal(snapshot.version, before.version); assert.equal(snapshot.login_summary_enabled, true); assert.equal(snapshot.summary_hours, 24);
  assert.equal(snapshot.prompts.summary, AI_DEFAULT_PROMPTS.summary);
  assert.equal(snapshot.enabled, true); assert.equal(snapshot.auto_tags, false); assert.equal(snapshot.provider, 'anthropic');
  assert.equal(snapshot.prompts.system, legacy.prompts.system); assert.equal(snapshot.prompts.reply, legacy.prompts.reply);
  assert.equal(snapshot.providers.anthropic.model, 'claude-existing-model');
  assert.equal(restored.runtime().providers.anthropic.api_key, 'legacy-provider-private-key');
  assert.deepEqual(store.db.prepare('SELECT * FROM ai_settings WHERE id=1').get(), before, 'Default merging is read-only and preserves encrypted provider bytes and settings timestamps.');
  const updated = restored.update({ version: snapshot.version, summary_hours: 48, prompts: { summary: '  Explain current shift priorities.  ' } }, { actor });
  assert.equal(updated.summary_hours, 48); assert.equal(updated.prompts.summary, 'Explain current shift priorities.');
  assert.equal(updated.prompts.system, legacy.prompts.system); assert.equal(updated.providers.anthropic.key_configured, true);
  assert.equal(restored.runtime().providers.anthropic.api_key, 'legacy-provider-private-key');
  assert.deepEqual(new AiSettings(store.db, { encryptionKey }).snapshot(), updated);
});

test('login summary hours, visibility and prompt edits validate atomically and retain optimistic settings protection', t => {
  const { store, settings } = fixture(t), initial = settings.snapshot();
  for (const patch of [{ summary_hours: 0 }, { summary_hours: 721 }, { summary_hours: 1.5 }, { summary_hours: '24' }, { summary_hours: null }, { summary_hours: Infinity }, { login_summary_enabled: 'true' }, { prompts: { summary: '' } }, { prompts: { summary: 'x'.repeat(12001) } }]) {
    assert.throws(() => settings.update({ version: initial.version, ...patch }, { actor }), error => error.statusCode === 400);
    assert.deepEqual(settings.snapshot(), initial);
  }
  const saved = settings.update({ version: initial.version, summary_hours: 720, login_summary_enabled: false, prompts: { summary: 'Summarize the last configured period.' } }, { actor });
  assert.equal(saved.summary_hours, 720); assert.equal(saved.login_summary_enabled, false);
  assert.equal(saved.prompts.summary, 'Summarize the last configured period.');
  assert.equal(saved.prompts.triage, initial.prompts.triage);
  assert.throws(() => settings.update({ version: initial.version, summary_hours: 12 }, { actor }), error => error.statusCode === 409);
  assert.equal(settings.update({ version: saved.version, summary_hours: 1, login_summary_enabled: true }, { actor }).summary_hours, 1);
  const changes = store.db.prepare('SELECT changed_fields FROM ai_settings_events ORDER BY version').all();
  assert.deepEqual(JSON.parse(changes[0].changed_fields), ['login_summary_enabled', 'summary_hours', 'prompts.summary']);
  assert.doesNotMatch(JSON.stringify(changes), /Summarize the last configured period/);
});
