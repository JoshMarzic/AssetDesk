import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signIn, eventually, noOverflow } from './native-browser-helper.mjs';

const person = { key: 'person_name', label: 'Employee name', type: 'text', required: true, default: '', description: 'The employee being onboarded.' };
const account = { key: 'account_name', label: 'Account name', type: 'text', required: true, default: '', description: '' };
const manager = { key: 'manager_email', label: 'Future manager email', type: 'email', required: true, default: '', description: '' };
const employee = { key: 'employee_email', label: 'Employee email', type: 'email', required: true, default: '', description: '' };
const literalDefault = '<img src="data:image/png,broken" onerror="window.workflowInjected=true">';
const reference = (id, type, source, name = source.name, bindings = {}) => ({ id, type, ref_id: source.id, ref_version: source.version, name, bindings });

async function openWorkflows(h) {
  await signIn(h.page, h.origin);
  await h.page.getByRole('button', { name: 'Actions', exact: true }).click();
  await h.page.getByRole('heading', { name: 'Actions', exact: true }).waitFor();
  await h.page.getByRole('tab', { name: /^Workflows/ }).click();
  await h.page.getByRole('button', { name: 'New workflow', exact: true }).waitFor();
}

function onboarding(h) {
  const approval = h.actions.createTemplate({ name: 'Get approval', description: 'Ask the future manager to approve onboarding.', variables: [person, manager],
    steps: [{ id: 'approval', type: 'approval', name: 'Approve onboarding', config: { to: '{{manager_email}}', subject: 'Onboarding approval for {{person_name}}', body: 'Please approve onboarding for {{person_name}}.', expires_hours: 168 } }],
  }, h.admin);
  const systems = ['AD', 'HR', 'SAP'].map(system => h.actions.createTemplate({ name: `Create ${system} account`, description: `Create an employee record in ${system}.`, variables: [person, account],
    steps: [{ id: `create-${system.toLowerCase()}`, type: 'api', name: `Create ${system} account`, config: { connection: 'browser_service', method: 'POST', path: `/accounts/${system.toLowerCase()}`, body: JSON.stringify({ system, person: '{{person_name}}', account: '{{account_name}}' }) } }],
  }, h.admin));
  const setup = h.workflows.createWorkflow({ name: 'Set up standard user', description: 'Create the AD, HR, and SAP accounts in order.', variables: [person, account],
    steps: systems.map((template, index) => reference(`account-${index}`, 'template', template, template.name, { person_name: '{{person_name}}', account_name: '{{account_name}}' })),
  }, h.admin);
  const notify = h.actions.createTemplate({ name: 'Notify IT', description: 'Send account status and follow-up instructions to IT.', variables: [person, account, { key: 'default_note', label: 'Optional setup note', type: 'text', required: false, default: literalDefault, description: '' }],
    steps: [{ id: 'it-email', type: 'email', name: 'Send IT account status', config: { to: 'it@example.test', subject: 'Accounts ready for {{person_name}}', body: 'AD, HR, and SAP accounts are ready for {{account_name}}. Arrange the equipment handover.' } }],
  }, h.admin);
  const welcome = h.actions.createTemplate({ name: 'Welcome employee', description: 'Welcome the employee after their accounts are ready.', variables: [person, employee],
    steps: [{ id: 'welcome-email', type: 'email', name: 'Send employee welcome', config: { to: '{{employee_email}}', subject: 'Welcome {{person_name}}', body: 'Welcome {{person_name}}. Your accounts are ready; IT will arrange your equipment handover.' } }],
  }, h.admin);
  const workflow = h.workflows.createWorkflow({ name: 'Employee onboarding', description: 'Get approval, create standard accounts, and notify IT and the new employee.', variables: [person, account, manager, employee],
    steps: [reference('manager-approval', 'template', approval, 'Get manager approval', { person_name: '{{person_name}}', manager_email: '{{manager_email}}' }),
      reference('standard-user', 'workflow', setup, setup.name, { person_name: '{{person_name}}', account_name: '{{account_name}}' }),
      reference('notify-it', 'template', notify, notify.name, { person_name: '{{person_name}}', account_name: '{{account_name}}' }),
      reference('welcome', 'template', welcome, welcome.name, { person_name: '{{person_name}}', employee_email: '{{employee_email}}' })],
  }, h.admin);
  return { approval, systems, setup, notify, welcome, workflow };
}

function trackOperations(h) {
  const order = [], send = h.actionTransports.sendEmail.bind(h.actionTransports), api = h.actionTransports.callApi.bind(h.actionTransports);
  h.actionTransports.sendEmail = async message => { order.push('email:' + message.to); return send(message); };
  h.actionTransports.callApi = async (input, user) => { order.push('api:' + input.body.system); return api(input, user); };
  return order;
}

async function startWorkflow(h, workflow, values) {
  await h.page.goto(`${h.origin}/#actions/workflows/${workflow.id}/run`);
  await h.page.getByRole('button', { name: 'Start workflow', exact: true }).waitFor();
  for (const variable of workflow.variables) if (Object.hasOwn(values, variable.key)) await h.page.getByLabel(variable.label, { exact: true }).fill(String(values[variable.key]));
  const loaded = h.requests.filter(url => new URL(url).pathname === `/api/desk/actions/workflows/${workflow.id}`).length;
  await h.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await h.page.waitForTimeout(120);
  assert.equal(h.requests.filter(url => new URL(url).pathname === `/api/desk/actions/workflows/${workflow.id}`).length, loaded, 'Automatic Actions refresh must not reload the workflow start form.');
  for (const variable of workflow.variables) if (Object.hasOwn(values, variable.key)) assert.equal(await h.page.getByLabel(variable.label, { exact: true }).inputValue(), String(values[variable.key]), 'The entered run values must survive an automatic refresh.');
  const accepted = h.page.waitForResponse(response => new URL(response.url()).pathname === `/api/desk/actions/workflows/${workflow.id}/runs` && response.request().method() === 'POST');
  await h.page.getByRole('button', { name: 'Start workflow', exact: true }).click();
  const response = await accepted; assert.equal(response.status(), 202, await response.text());
  const run = await response.json(); assert.ok(run.id);
  await eventually(() => h.page.url().includes('#actions/runs/' + run.id), 'A workflow must open the existing durable run page.');
  return run;
}

async function waitState(h, id, expected) {
  await eventually(() => h.actions.getRun(id, h.admin).status === expected, `The workflow must reach ${expected}.`);
  return h.actions.getRun(id, h.admin);
}

function approvalPath(message) {
  const match = message.text.match(/https?:\/\/[^\s<>]+\/approve\/[A-Za-z0-9_-]+/);
  assert.ok(match, 'The approval must send a private review link.');
  return new URL(match[0]).pathname;
}

async function dragStep(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  const start = await source.boundingBox(); assert.ok(start);
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  // Begin the native drag before scrolling to a distant card. A direct dragTo
  // scrolls the oversized target first, before Chromium crosses its threshold.
  await page.mouse.move(x + 12, y + 3, { steps: 4 });
  await target.scrollIntoViewIfNeeded();
  const end = await target.boundingBox(); assert.ok(end);
  await page.mouse.move(end.x + 40, end.y + 12, { steps: 12 });
  await page.mouse.move(end.x + 42, end.y + 13);
  await page.mouse.up();
}

test('Workflows combine templates and nested workflows, persist real drag ordering, and show a title-only linked overview', { timeout: 90000 }, async t => {
  const h = await harness(t), fixtures = onboarding(h);
  await openWorkflows(h);
  await h.page.getByRole('button', { name: 'New workflow', exact: true }).click();
  await h.page.getByLabel('Workflow title', { exact: true }).fill('Standard employee setup sequence');
  await h.page.getByLabel('Description', { exact: true }).fill('Prepare standard accounts and then send the handover and welcome messages.');
  const sources = [[fixtures.notify, 'template'], [fixtures.setup, 'workflow'], [fixtures.welcome, 'template']];
  for (const [index, [source, type]] of sources.entries()) {
    if (!await h.page.getByLabel(`Step ${index + 1} type`, { exact: true }).count()) await h.page.getByRole('button', { name: 'Add step', exact: true }).click();
    await h.page.getByLabel(`Step ${index + 1} type`, { exact: true }).selectOption(type);
    await h.page.getByLabel(`Step ${index + 1} ${type}`, { exact: true }).selectOption(source.id);
    await h.page.getByLabel(`Step ${index + 1} title`, { exact: true }).fill(source.name);
  }
  const cards = h.page.locator('[data-workflow-step-id]');
  await eventually(async () => await cards.count() === 3, 'The workflow must contain all three references.');
  await cards.nth(0).locator('[data-workflow-binding-default][data-workflow-binding-key="default_note"]').click();
  const defaultField = h.page.getByLabel('Step 1 Optional setup note', { exact: true }).locator('xpath=../..');
  assert.ok((await defaultField.innerText()).includes(literalDefault), 'Reference defaults must be displayed as literal text in the hint.');
  assert.equal(await h.page.locator('#main-content img').count(), 0, 'A template default must never create markup.');
  assert.equal(await h.page.evaluate(() => window.workflowInjected), undefined);
  const originalIds = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId));
  await h.page.evaluate(() => { window.workflowNativeDrags = []; for (const name of ['dragstart', 'drop']) document.addEventListener(name, event => window.workflowNativeDrags.push({ type: name, trusted: event.isTrusted }), true); });
  await dragStep(h.page, h.page.getByRole('button', { name: 'Drag step 2', exact: true }), cards.nth(0).locator('.action-step-heading'));
  await eventually(async () => (await cards.evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId)))[0] === originalIds[1], 'Dragging a step must move the stable reference and its bindings.');
  await dragStep(h.page, h.page.getByRole('button', { name: 'Drag step 1', exact: true }), cards.nth(1).locator('.action-step-heading'));
  await eventually(async () => (await cards.evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId)))[1] === originalIds[1], 'Dragging downward must also preserve the reference and its bindings.');
  await dragStep(h.page, h.page.getByRole('button', { name: 'Drag step 2', exact: true }), cards.nth(0).locator('.action-step-heading'));
  await eventually(async () => (await cards.evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId)))[0] === originalIds[1], 'The final drag order must be the saved execution order.');
  const nativeEvents = await h.page.evaluate(() => window.workflowNativeDrags);
  assert.ok(nativeEvents.filter(event => event.type === 'dragstart' && event.trusted).length >= 3);
  assert.ok(nativeEvents.filter(event => event.type === 'drop' && event.trusted).length >= 3, 'Reordering must use actual browser drag-and-drop events.');
  const overview = h.page.getByRole('region', { name: 'Workflow overview', exact: true });
  await overview.waitFor();
  for (const name of ['Set up standard user', 'Notify IT', 'Welcome employee']) assert.equal((await overview.getByRole('button', { name, exact: true }).innerText()).trim(), name, 'Overview links show only the step title.');
  assert.doesNotMatch(await overview.innerText(), /SMTP SEND|Authentication:|POST https:/);
  const before = h.page.url();
  await overview.getByRole('button', { name: 'Welcome employee', exact: true }).click();
  assert.equal(h.page.url(), before, 'Overview links scroll to a step without leaving the draft.');
  await eventually(async () => { const target = await cards.nth(2).boundingBox(); return target && target.y < 1024 && target.y + target.height > 0; }, 'The overview must scroll its step into view.');
  await h.page.screenshot({ path: '/tmp/assetdesk-workflows-builder.png', fullPage: true });
  const savedResponse = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/desk/actions/workflows' && response.request().method() === 'POST');
  await h.page.getByRole('button', { name: 'Save workflow', exact: true }).click();
  const response = await savedResponse; assert.equal(response.status(), 201, await response.text());
  const saved = await response.json();
  assert.deepEqual(saved.steps.map(step => step.ref_id), [fixtures.setup.id, fixtures.notify.id, fixtures.welcome.id]);
  assert.deepEqual(saved.steps.map(step => step.id), [originalIds[1], originalIds[0], originalIds[2]]);
  assert.equal(saved.steps[0].type, 'workflow'); assert.equal(saved.steps[0].bindings.person_name, '{{person_name}}');
  assert.ok(!Object.hasOwn(saved.steps[1].bindings, 'default_note'), 'Use default must omit the binding while preserving the literal reference default.');
  await h.page.reload(); await h.page.getByLabel('Workflow title', { exact: true }).waitFor();
  assert.equal(await h.page.getByLabel('Workflow title', { exact: true }).inputValue(), saved.name);
  assert.deepEqual(await h.page.locator('[data-workflow-step-id]').evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId)), saved.steps.map(step => step.id));
  assert.equal(h.actions.listRuns(h.admin).total, 0, 'Saving and reordering must never execute a workflow.');
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});

test('Employee onboarding waits for approval then completes the nested AD, HR, SAP and notification sequence exactly once', { timeout: 90000 }, async t => {
  const h = await harness(t), fixtures = onboarding(h), order = trackOperations(h);
  await openWorkflows(h);
  const values = { person_name: 'Renée "Mo" Quinn', account_name: 'morgan.quinn', manager_email: 'manager@example.test', employee_email: 'morgan@example.test' };
  const run = await startWorkflow(h, fixtures.workflow, values);
  await waitState(h, run.id, 'waiting_approval');
  assert.deepEqual(order, ['email:manager@example.test']); assert.equal(h.actionApiCalls.length, 0);
  assert.equal(run.workflow.name, 'Employee onboarding'); assert.equal(run.workflow.steps[1].type, 'workflow');
  assert.deepEqual(run.workflow.steps[1].steps.map(step => step.name), ['Create AD account', 'Create HR account', 'Create SAP account']);
  const overview = h.page.getByRole('region', { name: 'Workflow overview', exact: true });
  await overview.getByRole('button', { name: 'Set up standard user', exact: true }).waitFor();
  const reviewContext = await h.browser.newContext(), review = await reviewContext.newPage();
  try {
    await review.goto(h.origin + approvalPath(h.actionMessages[0]));
    await review.getByRole('heading', { name: 'Review approval request', exact: true }).waitFor();
    assert.equal(h.actions.getRun(run.id, h.admin).status, 'waiting_approval', 'Opening the link must not release the account creation steps.');
    await review.getByRole('button', { name: 'Approve request', exact: true }).click();
    await review.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
    const completed = await waitState(h, run.id, 'completed');
    assert.deepEqual(order, ['email:manager@example.test', 'api:AD', 'api:HR', 'api:SAP', 'email:it@example.test', 'email:morgan@example.test']);
    assert.deepEqual(h.actionApiCalls.map(call => call.body), ['AD', 'HR', 'SAP'].map(system => ({ system, person: values.person_name, account: values.account_name })));
    assert.equal(completed.steps.length, 6); assert.ok(completed.steps.every(step => step.status === 'completed'));
    await h.actionsRunner.wake(); assert.equal(order.length, 6, 'Polling or waking must not repeat already completed operations.');
    await h.page.reload();
    const completedOverview = h.page.getByRole('region', { name: 'Workflow overview', exact: true });
    await completedOverview.waitFor();
    await completedOverview.getByRole('button', { name: 'Create SAP account', exact: true }).click();
    const sap = h.page.locator('#action-run-step-' + run.workflow.steps[1].steps[2].start_index);
    await eventually(async () => { const box = await sap.boundingBox(); return box && box.y < 1024 && box.y + box.height > 0; }, 'A nested overview title must lead to its actual concrete run step.');
    await h.page.screenshot({ path: '/tmp/assetdesk-workflows-run.png', fullPage: true });
    await noOverflow(h.page);
  } finally { await reviewContext.close(); }
  assert.deepEqual(h.errors, []);
});

test('Rejecting the first workflow approval prevents every nested account call and follow-up email', { timeout: 90000 }, async t => {
  const h = await harness(t), { workflow } = onboarding(h), order = trackOperations(h);
  await openWorkflows(h);
  const run = await startWorkflow(h, workflow, { person_name: 'Casey Lee', account_name: 'casey.lee', manager_email: 'manager@example.test', employee_email: 'casey@example.test' });
  await waitState(h, run.id, 'waiting_approval');
  const reviewContext = await h.browser.newContext(), review = await reviewContext.newPage();
  try {
    await review.goto(h.origin + approvalPath(h.actionMessages[0]));
    await review.getByRole('button', { name: 'Reject request', exact: true }).click();
    await review.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
    await waitState(h, run.id, 'rejected'); await h.actionsRunner.wake();
    assert.deepEqual(order, ['email:manager@example.test']); assert.equal(h.actionApiCalls.length, 0); assert.equal(h.actionMessages.length, 1);
    await h.page.reload();
    await h.page.getByRole('region', { name: 'Workflow overview', exact: true }).waitFor();
    assert.ok((await h.page.locator('#main-content').innerText()).includes('Rejected'));
  } finally { await reviewContext.close(); }
  assert.deepEqual(h.errors, []);
});

test('Mobile workflows keep the title overview usable and support accessible step reordering without losing mappings', { timeout: 90000 }, async t => {
  const h = await harness(t, { mobile: true }), { workflow } = onboarding(h);
  await signIn(h.page, h.origin);
  await h.page.goto(`${h.origin}/#actions/workflows/${workflow.id}/edit`);
  await h.page.getByLabel('Workflow title', { exact: true }).waitFor();
  await noOverflow(h.page);
  const cards = h.page.locator('[data-workflow-step-id]'), originalIds = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId));
  await h.page.getByRole('button', { name: 'Move workflow step 4 up', exact: true }).click();
  const expected = [originalIds[0], originalIds[1], originalIds[3], originalIds[2]];
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.workflowStepId)), expected);
  const overview = h.page.getByRole('region', { name: 'Workflow overview', exact: true });
  await overview.getByRole('button', { name: 'Welcome employee', exact: true }).click();
  await eventually(async () => { const box = await cards.nth(2).boundingBox(); return box && box.y < 844 && box.y + box.height > 0; }, 'The mobile overview must scroll its step into view.');
  await noOverflow(h.page); await h.page.screenshot({ path: '/tmp/assetdesk-workflows-mobile.png', fullPage: true });
  const savedResponse = h.page.waitForResponse(response => new URL(response.url()).pathname === `/api/desk/actions/workflows/${workflow.id}` && response.request().method() === 'PATCH');
  await h.page.getByRole('button', { name: 'Save workflow', exact: true }).click();
  const response = await savedResponse; assert.equal(response.status(), 200, await response.text());
  const saved = await response.json(); assert.deepEqual(saved.steps.map(step => step.id), expected);
  assert.equal(saved.steps[2].bindings.employee_email, '{{employee_email}}');
  assert.equal(saved.steps[3].bindings.account_name, '{{account_name}}');
  await h.page.reload(); await h.page.getByLabel('Workflow title', { exact: true }).waitFor();
  await noOverflow(h.page); assert.deepEqual(h.errors, []);
});
