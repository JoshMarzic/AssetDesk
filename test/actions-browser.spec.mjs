import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow } from './native-browser-helper.mjs';

async function openActions(h) {
  await signIn(h.page, h.origin);
  await h.page.getByRole('button', { name: 'Actions', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Actions', exact: true }).waitFor();
  await h.page.getByRole('button', { name: 'New action', exact: true }).waitFor();
}

function manualDefinition(name = 'Equipment handover') {
  return { name, description: 'A standard handover that changes only the person and equipment.',
    variables: [
      { key: 'person_name', label: 'Person receiving equipment', type: 'text', required: true, default: '', description: 'The employee being supported.' },
      { key: 'equipment_details', label: 'Equipment to prepare', type: 'text', required: true, default: '', description: 'The device or equipment requested.' },
    ],
    steps: [{ id: 'prepare-equipment', type: 'task', name: 'Prepare equipment', config: { instructions: 'Prepare {{equipment_details}} for {{person_name}}.', assignee_email: '' } }],
  };
}

async function startTemplate(h, template, values) {
  await h.page.goto(`${h.origin}/#actions/new?template=${template.id}`);
  await h.page.getByRole('button', { name: 'Start action', exact: true }).waitFor();
  for (const [key, value] of Object.entries(values)) {
    const variable = template.variables.find(item => item.key === key);
    assert.ok(variable, `The template must declare ${key}.`);
    await h.page.getByLabel(variable.label, { exact: true }).fill(String(value));
  }
  const accepted = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/actions/runs' && response.request().method() === 'POST');
  await h.page.getByRole('button', { name: 'Start action', exact: true }).click();
  const response = await accepted; assert.equal(response.status(), 202, await response.text());
  const run = await response.json(); assert.ok(run.id);
  await eventually(() => h.page.url().includes('#actions/runs/' + run.id), 'Starting an action must open its own run page.');
  return run;
}

async function waitState(h, id, status) {
  await eventually(() => h.actions.getRun(id, h.admin).status === status, `The action must reach ${status}.`);
  return h.actions.getRun(id, h.admin);
}

async function completeTask(h, id, comment = 'Prepared and checked the equipment.') {
  await h.page.getByRole('button', { name: 'Complete task', exact: true }).waitFor();
  const note = h.page.getByLabel('Completion note (optional)', { exact: true });
  if (await note.count()) await note.fill(comment);
  await h.page.getByRole('button', { name: 'Complete task', exact: true }).click();
  await waitState(h, id, 'completed');
}

function approvalTemplate() {
  return { name: 'Standard access approval', description: 'Approve a named person’s request before notifying the support team.',
    variables: [
      { key: 'person_name', label: 'Who is being approved', type: 'text', required: true, default: '', description: 'The person receiving access.' },
      { key: 'request_details', label: 'What is being approved', type: 'text', required: true, default: '', description: 'The exact access or service requested.' },
      { key: 'approver_email', label: 'Who is approving', type: 'email', required: true, default: '', description: 'The person who must approve the request.' },
    ], steps: [
      { id: 'approve-access', type: 'approval', name: 'Approve {{request_details}}', config: { to: '{{approver_email}}', subject: 'Access approval for {{person_name}}', body: 'Please approve {{request_details}} for {{person_name}}.', expires_hours: 168 } },
      { id: 'notify-support', type: 'email', name: 'Notify support', config: { to: 'support@example.test', subject: 'Approved request for {{person_name}}', body: 'The approval for {{request_details}} has been recorded.' } },
    ],
  };
}

function approvalPath(message) {
  const text = message.text || message.body || '';
  const match = text.match(/https?:\/\/[^\s<>]+\/approve\/[A-Za-z0-9_-]+/);
  assert.ok(match, 'The delivered message must contain an approval review link.');
  return new URL(match[0]).pathname;
}

test('New action opens a new page, validates template variables, and completes a real manual workflow', { timeout: 90000 }, async t => {
  const h = await harness(t);
  await openActions(h);
  await h.page.getByRole('button', { name: 'New action', exact: true }).click();
  await eventually(() => h.page.url().includes('#actions/new'), 'New action must navigate to a dedicated page.');
  await h.page.getByLabel('Start from', { exact: true }).waitFor();
  const template = h.actions.listTemplates(h.admin).find(item => item.name === 'Equipment preparation');
  assert.ok(template, 'A manual template must be usable without real outbound email.');
  await h.page.goto(`${h.origin}/#actions/new?template=${template.id}`);
  await h.page.getByRole('button', { name: 'Start action', exact: true }).waitFor();
  const before = h.actions.listRuns(h.admin).total;
  const start = h.page.getByRole('button', { name: 'Start action', exact: true });
  if (await start.isEnabled()) { await start.click(); await h.page.waitForTimeout(150); }
  assert.equal(h.actions.listRuns(h.admin).total, before, 'Missing required variables must not create a run.');
  const run = await startTemplate(h, template, { person_name: 'Alex Johnson', equipment_details: 'LAPTOP-1042 and a docking station' });
  await waitState(h, run.id, 'waiting_task');
  await h.page.getByRole('button', { name: 'Complete task', exact: true }).waitFor();
  assert.match(await h.page.locator('#main-content').innerText(), /Alex Johnson/);
  assert.match(await h.page.locator('#main-content').innerText(), /LAPTOP-1042/);
  await h.page.screenshot({ path: '/tmp/assetdesk-actions-run.png', fullPage: true });
  await completeTask(h, run.id);
  assert.equal(h.actionMessages.length, 0); assert.equal(h.actionApiCalls.length, 0);
  assert.deepEqual(h.errors, []);
});

test('A highlighted variable workflow can be saved as a template and reused without changing existing runs', { timeout: 90000 }, async t => {
  const h = await harness(t);
  await openActions(h);
  await h.page.getByRole('button', { name: 'New action', exact: true }).click();
  await h.page.getByLabel('Action name', { exact: true }).fill('Standard workstation handover');
  await h.page.getByLabel('Description', { exact: true }).fill('Reusable preparation instructions with visibly editable details.');
  for (const [index, label, key] of [[1, 'Person receiving equipment', 'person_name'], [2, 'Equipment to prepare', 'equipment_details']]) {
    if (!await h.page.getByLabel(`Variable ${index} label`, { exact: true }).count()) await h.page.getByRole('button', { name: 'Add variable', exact: true }).click();
    await h.page.getByLabel(`Variable ${index} label`, { exact: true }).fill(label);
    await h.page.getByLabel(`Variable ${index} key`, { exact: true }).fill(key);
    await h.page.getByLabel(`Variable ${index} type`, { exact: true }).selectOption('text');
    await h.page.getByLabel(`Variable ${index} required`, { exact: true }).check();
  }
  if (!await h.page.getByLabel('Step 1 type', { exact: true }).count()) await h.page.getByRole('button', { name: 'Add step', exact: true }).click();
  const availableTypes = await h.page.getByLabel('Step 1 type', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value));
  for (const type of ['approval', 'email', 'api', 'task', 'delay']) assert.ok(availableTypes.includes(type), `The action builder must expose the ${type} step type.`);
  await h.page.getByLabel('Step 1 type', { exact: true }).selectOption('task');
  await h.page.getByLabel('Step 1 name', { exact: true }).fill('Prepare equipment');
  await h.page.getByLabel('Step 1 instructions', { exact: true }).fill('Prepare {{equipment_details}} for {{person_name}}.');
  await h.page.locator('.action-variable-token').first().waitFor();
  await h.page.screenshot({ path: '/tmp/assetdesk-actions-builder.png', fullPage: true });
  const created = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/actions/templates' && response.request().method() === 'POST');
  await h.page.getByRole('button', { name: 'Save as template', exact: true }).click();
  const response = await created; assert.equal(response.status(), 201, await response.text());
  const template = await response.json();
  assert.equal(h.actions.listRuns(h.admin).total, 0, 'Saving a template must not execute its steps.');
  assert.equal(template.variables.length, 2); assert.match(template.steps[0].config.instructions, /\{\{person_name\}\}/);
  const first = await startTemplate(h, template, { person_name: 'Alex Johnson', equipment_details: 'a design laptop' });
  await waitState(h, first.id, 'waiting_task');
  const changed = h.actions.updateTemplate(template.id, { version: template.version, steps: [{ ...template.steps[0], config: { instructions: 'New standard: prepare {{equipment_details}} for {{person_name}}.', assignee_email: '' } }] }, h.admin);
  await h.page.reload(); await h.page.getByRole('button', { name: 'Complete task', exact: true }).waitFor();
  assert.ok((await h.page.locator('#main-content').innerText()).includes('Prepare a design laptop for Alex Johnson.'));
  assert.ok(!(await h.page.locator('#main-content').innerText()).includes('New standard:'), 'A run must retain the template snapshot it started with.');
  await completeTask(h, first.id);
  const second = await startTemplate(h, changed, { person_name: 'Morgan Quinn', equipment_details: 'an Operations PC' });
  await waitState(h, second.id, 'waiting_task');
  await h.page.getByText('New standard: prepare an Operations PC for Morgan Quinn.', { exact: true }).waitFor();
  await completeTask(h, second.id);

  // Removing a variable must remove its entered run value too; the API rejects unknown keys.
  await h.page.goto(`${h.origin}/#actions/new`);
  await h.page.getByLabel('Action name', { exact: true }).fill('Handover after simplifying variables');
  await h.page.getByLabel('Person', { exact: true }).fill('Casey Lee');
  await h.page.getByLabel('Request details', { exact: true }).fill('Prepare PC-307');
  await h.page.getByRole('button', { name: 'Add variable', exact: true }).click();
  await h.page.getByLabel('Variable 3 label', { exact: true }).fill('Unused detail');
  await h.page.getByLabel('Variable 3 key', { exact: true }).fill('unused_detail');
  await h.page.getByLabel('Unused detail', { exact: true }).fill('A value that must be discarded');
  await h.page.getByRole('button', { name: 'Remove variable 3', exact: true }).click();
  const simplifiedResponse = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/actions/runs' && response.request().method() === 'POST');
  await h.page.getByRole('button', { name: 'Start action', exact: true }).click();
  const simplified = await simplifiedResponse;
  assert.equal(simplified.status(), 202, await simplified.text());
  assert.ok(!Object.hasOwn(simplified.request().postDataJSON().values, 'unused_detail'), 'Removed variables must not remain in the submitted values.');
  const simplifiedRun = await simplified.json();
  await waitState(h, simplifiedRun.id, 'waiting_task');
  await completeTask(h, simplifiedRun.id);
  assert.deepEqual(h.errors, []);
});

test('Email approvals wait for an explicit decision, continue once approved, and stop on rejection', { timeout: 90000 }, async t => {
  const h = await harness(t), template = h.actions.createTemplate(approvalTemplate(), h.admin);
  await openActions(h);
  const run = await startTemplate(h, template, { person_name: 'Alex Johnson', request_details: 'Design shared-folder access', approver_email: 'manager@example.test' });
  await waitState(h, run.id, 'waiting_approval');
  assert.equal(h.actionMessages.length, 1); assert.equal(h.actionMessages[0].to, 'manager@example.test');
  const reviewContext = await h.browser.newContext(), review = await reviewContext.newPage();
  try {
    const path = approvalPath(h.actionMessages[0]);
    await review.goto(h.origin + path);
    await review.getByRole('heading', { name: 'Review approval request', exact: true }).waitFor();
    assert.ok((await review.locator('main').innerText()).includes('Design shared-folder access for Alex Johnson'));
    assert.equal(h.actions.getRun(run.id, h.admin).status, 'waiting_approval', 'Opening a review link must not approve a workflow.');
    assert.equal(h.actionMessages.length, 1);
    await review.getByLabel('Comment (optional)', { exact: true }).fill('Approved for the new design project.');
    const decisionResponse = review.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await review.getByRole('button', { name: 'Approve request', exact: true }).click();
    const decision = await decisionResponse;
    assert.equal(decision.status(), 200, `Origin ${decision.request().headers().origin}; expected ${h.origin}. ${await review.locator('main').innerText()}`);
    await review.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
    await waitState(h, run.id, 'completed'); assert.equal(h.actionMessages.length, 2);
    await review.goto(h.origin + path);
    assert.equal(await review.getByRole('button', { name: 'Approve request', exact: true }).count(), 0, 'An approval decision is single use.');
    const rejected = await startTemplate(h, template, { person_name: 'Morgan Quinn', request_details: 'Privileged service access', approver_email: 'manager@example.test' });
    await waitState(h, rejected.id, 'waiting_approval'); assert.equal(h.actionMessages.length, 3);
    await review.goto(h.origin + approvalPath(h.actionMessages[2]));
    await review.getByRole('button', { name: 'Reject request', exact: true }).click();
    await review.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
    await waitState(h, rejected.id, 'rejected'); assert.equal(h.actionMessages.length, 3, 'A rejected approval must not execute the following email step.');
  } finally { await reviewContext.close(); }
  assert.deepEqual(h.errors, []);
});

test('An API-call action renders the selected connection and records its real execution result', { timeout: 90000 }, async t => {
  const h = await harness(t);
  const template = h.actions.createTemplate({ name: 'Update an employee record', description: 'Use a configured API connection.',
    variables: [{ key: 'employee_id', label: 'Employee record ID', type: 'text', required: true, default: '', description: '' }],
    steps: [{ id: 'update-record', type: 'api', name: 'Update employee', config: { connection: 'browser_service', method: 'POST', path: '/people/{{employee_id}}', body: '{"employee":"{{employee_id}}"}' } }],
  }, h.admin);
  await openActions(h);
  await h.page.goto(`${h.origin}/#actions/templates/${template.id}/edit`);
  const connection = h.page.getByLabel('Step 1 API connection', { exact: true });
  await connection.waitFor();
  assert.equal(await connection.inputValue(), 'browser_service');
  assert.ok((await connection.locator('option').allTextContents()).includes('Demo service'));
  assert.deepEqual(await h.page.getByLabel('Step 1 method', { exact: true }).locator('option').allTextContents(), ['GET', 'POST'], 'The builder must offer only methods allowed by the selected connection.');
  const run = await startTemplate(h, template, { employee_id: 'employee-1042' });
  await waitState(h, run.id, 'completed'); assert.equal(h.actionApiCalls.length, 1);
  const call = h.actionApiCalls[0]; assert.equal(call.connection, 'browser_service'); assert.equal(call.method, 'POST'); assert.ok(call.path.includes('employee-1042'));
  await h.page.reload();
  await h.page.getByText(/200/).first().waitFor();
  assert.equal(h.actionMessages.length, 0); assert.deepEqual(h.errors, []);
});

test('Actions, variable entry and a waiting manual task fit a mobile viewport', { timeout: 90000 }, async t => {
  const h = await harness(t, { mobile: true }), template = h.actions.createTemplate(manualDefinition('Mobile equipment handover'), h.admin);
  await signIn(h.page, h.origin);
  await h.page.goto(h.origin + '/#actions');
  await h.page.getByRole('button', { name: 'New action', exact: true }).waitFor(); await noOverflow(h.page);
  await h.page.getByRole('button', { name: 'New template', exact: true }).click();
  await h.page.getByLabel('Template name', { exact: true }).waitFor(); await noOverflow(h.page);
  await h.page.goto(`${h.origin}/#actions/new?template=${template.id}`);
  await h.page.getByLabel('Person receiving equipment', { exact: true }).waitFor(); await noOverflow(h.page);
  const run = await startTemplate(h, template, { person_name: 'Morgan Quinn', equipment_details: 'PC-207' });
  await waitState(h, run.id, 'waiting_task');
  await h.page.getByRole('button', { name: 'Complete task', exact: true }).waitFor(); await noOverflow(h.page);
  await h.page.screenshot({ path: '/tmp/assetdesk-actions-mobile.png', fullPage: true });
  await completeTask(h, run.id); await noOverflow(h.page);
  assert.deepEqual(h.errors, []);
});
