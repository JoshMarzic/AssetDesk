import test from 'node:test';
import assert from 'node:assert/strict';
import { formatActionImplementation } from '../public/action-implementation.js';
import { validateActionDefinition, resolveActionValues, renderActionSteps } from '../src/actions-store.js';

function rendered(definition, supplied) {
  const source = validateActionDefinition(definition);
  const values = resolveActionValues(source, supplied);
  return { source, actual: renderActionSteps(source, values, { email: 'initiator@example.test' }, { listTechnicians: () => [{ active: true, email: 'initiator@example.test' }] })[0] };
}
function bodyFromPreview(preview) {
  const match = preview.match(/\n\n([\[{][\s\S]*[\]}])\n\nContinue/);
  assert.ok(match, 'The technical preview must contain a distinct JSON request body.');
  return JSON.parse(match[1]);
}

test('HTTP implementation previews preserve placeholders and keep configured credentials private', () => {
  const step = { type: 'api', config: { connection: 'hr', method: 'POST', path: '/people/{{person}}', body: '{"name":"{{person}}","count":"{{count}}"}' } };
  const preview = formatActionImplementation(step, { connections: [{ id: 'hr', name: 'HR API', baseUrl: 'https://account:private-password@api.example.test/v1?sig=private-signature', headers: { Authorization: 'Bearer private-bearer' } }] });
  assert.match(preview, /^POST https:\/\/api\.example\.test\/v1\/people\/\{\{person\}\}/);
  assert.match(preview, /"count": "\{\{count\}\}"/);
  assert.doesNotMatch(preview, /private-password|private-signature|private-bearer|account:/);
});

test('resolved HTTP previews match the executable path and typed JSON with quotes, Unicode, whitespace, and literal tokens', () => {
  const definition = { name: 'Create an employee', variables: [{ key: 'person', type: 'text', required: true }, { key: 'count', type: 'number', required: true }, { key: 'email', type: 'email', required: true }],
    steps: [{ type: 'api', config: { connection: 'hr', method: 'POST', path: '/people/{{person}}', body: '{"name":"{{person}}","count":"{{count}}","email":"{{email}}"}' } }] };
  const supplied = { person: '  Renée "Alex" / {{count}}  ', count: ' -2 ', email: '  PERSON@EXAMPLE.TEST  ' };
  const { source, actual } = rendered(definition, supplied);
  const preview = formatActionImplementation(source.steps[0], { variables: source.variables, values: supplied, connections: [{ id: 'hr', name: 'HR', baseUrl: 'https://api.example.test/v1' }] });
  assert.equal(preview.split('\n')[0], 'POST https://api.example.test/v1' + actual.config.path);
  assert.deepEqual(bodyFromPreview(preview), actual.config.body);
  assert.equal(bodyFromPreview(preview).name, 'Renée "Alex" / {{count}}', 'Variable values must be substituted once.');
});

test('Power Automate previews match the JSON sent while never including private trigger URLs', () => {
  const definition = { name: 'Trigger onboarding', variables: [{ key: 'person', type: 'text', required: true }, { key: 'count', type: 'number', required: true }],
    steps: [{ type: 'power_automate', config: { connection: 'onboarding', body: '{"person":"{{person}}","count":"{{count}}"}' } }] };
  const supplied = { person: 'Alex \\ "quoted"', count: '2' }, { source, actual } = rendered(definition, supplied);
  const preview = formatActionImplementation(source.steps[0], { variables: source.variables, values: supplied, connections: [{ id: 'onboarding', name: 'Employee onboarding', triggerUrl: 'https://flow.example.test/private-flow?sig=private-signature', headers: { Authorization: 'Bearer private-bearer' } }] });
  assert.match(preview, /^POST \[private Power Automate trigger URL\]/);
  assert.deepEqual(bodyFromPreview(preview), actual.config.body);
  assert.match(preview, /not completion of the Power Automate flow/);
  assert.doesNotMatch(preview, /private-flow|private-signature|private-bearer|triggerUrl/);
  assert.deepEqual(bodyFromPreview(formatActionImplementation({ type: 'power_automate', config: { connection: 'onboarding', body: '' } })), {});
});

test('SMTP previews use the executable recipient, subject, message, and explicit approval wait', () => {
  const definition = { name: 'Approve access', variables: [{ key: 'person', type: 'text', required: true }, { key: 'approver', type: 'email', required: true }],
    steps: [{ type: 'approval', config: { to: '{{approver}}', subject: 'Approval for {{person}}', body: 'Review access for {{person}}.', expires_hours: 24 } }] };
  const supplied = { person: '  Alex  ', approver: '  MANAGER@EXAMPLE.TEST  ' }, { source, actual } = rendered(definition, supplied);
  const preview = formatActionImplementation(source.steps[0], { variables: source.variables, values: supplied, publicUrl: 'https://desk.example.test' });
  assert.ok(preview.includes('To: ' + actual.config.to));
  assert.ok(preview.includes('Subject: ' + actual.config.subject));
  assert.ok(preview.includes(actual.config.body));
  assert.match(preview, /https:\/\/desk\.example\.test\/approve\/\[private single-use token\]/);
  assert.match(preview, /WAIT FOR APPROVAL \(expires after 24 hours\)/);
  assert.match(preview, /Reject: stop the workflow/);
});

test('saved run configs are shown directly, including an assigned technician and token-like literal values', () => {
  const config = { connection: 'hr', method: 'POST', path: '/people/Alex', body: { person: '{{count}}', count: 2 } };
  assert.deepEqual(bodyFromPreview(formatActionImplementation({ type: 'api', config })), config.body);
  const task = formatActionImplementation({ type: 'task', config: { instructions: 'Hand over LAPTOP-17.', assignee_email: '' } }, { assigneeEmail: 'initiator@example.test' });
  assert.match(task, /Assigned technician: initiator@example\.test/);
  assert.match(task, /WAIT FOR MANUAL TASK/);
  assert.match(formatActionImplementation({ type: 'delay', config: { minutes: '30' } }), /^WAIT 30 minutes/);
});
