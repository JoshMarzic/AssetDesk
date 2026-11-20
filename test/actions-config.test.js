import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsConfigFromEnv, configFromEnv } from '../src/config.js';
import { ActionTransports } from '../src/action-transports.js';

test('existing deployments start with manual actions and no implicit external connections', () => {
  const config = configFromEnv({ INBOUND_EMAIL_TOKEN: 'i'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32) });
  assert.deepEqual(config.actions.connections, []); assert.equal(config.actions.publicUrl, '');
  const capabilities = new ActionTransports(config.actions).capabilities({ role: 'admin' });
  assert.equal(capabilities.email.configured, false); assert.equal(capabilities.approval.configured, false);
});

test('automation environment configuration supports verified mail delivery and scoped API profiles without exposing secrets', () => {
  const config = actionsConfigFromEnv({ ACTION_PUBLIC_URL: 'https://helpdesk.example.test/', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_FROM: 'desk@example.test', SMTP_USER: 'account', SMTP_PASS: 'private-mail-secret',
    ACTION_API_CONNECTIONS: JSON.stringify([{ id: 'service', name: 'Service API', baseUrl: 'https://api.example.test/v1/', headers: { Authorization: 'Bearer private-api-secret' } }]) });
  assert.equal(config.publicUrl, 'https://helpdesk.example.test'); assert.equal(config.smtp.secure, true);
  assert.deepEqual(config.connections[0].roles, ['admin']);
  const transports = new ActionTransports(config);
  const capabilities = JSON.stringify(transports.capabilities({ role: 'admin' }));
  assert.doesNotMatch(capabilities, /private-mail-secret|private-api-secret|Authorization|SMTP_PASS/);
  assert.equal(transports.capabilities({ role: 'technician' }).connections.length, 0);
  assert.equal(transports.capabilities({ role: 'admin' }).approval.configured, true);
});

test('invalid automation settings fail with fixed errors instead of echoing credential-bearing JSON', () => {
  assert.throws(() => actionsConfigFromEnv({ ACTION_API_CONNECTIONS: '[{"Authorization":"private-syntax-secret"' }), error => !error.message.includes('private-syntax-secret') && /JSON/.test(error.message));
  for (const env of [{ SMTP_PORT: '0' }, { SMTP_SECURE: 'maybe' }, { SMTP_USER: 'account' }, { ACTION_PUBLIC_URL: 'https://name:secret@example.test/' }, { ACTION_API_CONNECTIONS: '{}' }]) assert.throws(() => actionsConfigFromEnv(env));
});
