import { formatActionImplementation } from './action-implementation.js';
import { createWorkflowsUI, renderWorkflowOverview, bindWorkflowOverview } from './workflows.js';

const TYPE_UI = {
  approval: { label: 'Approval', icon: 'shield', description: 'Email a person and wait for an explicit approval or rejection.', fields: [['to', 'recipient', 'text'], ['subject', 'subject', 'text'], ['body', 'message', 'textarea'], ['expires_hours', 'approval expiry (hours)', 'number']] },
  email: { label: 'Send email', icon: 'mail', description: 'Send a message, then continue after the mail service accepts it.', fields: [['to', 'recipient', 'text'], ['subject', 'subject', 'text'], ['body', 'message', 'textarea']] },
  api: { label: 'API call', icon: 'activity', description: 'Make an HTTP request using an administrator-configured connection.', fields: [['connection', 'API connection', 'connection'], ['method', 'method', 'method'], ['path', 'path', 'text'], ['body', 'JSON body', 'textarea']] },
  power_automate: { label: 'Power Automate flow', icon: 'activity', description: 'Send JSON to a configured HTTP-triggered flow. Acceptance starts the flow; its work continues in Power Automate.', fields: [['connection', 'Power Automate connection', 'connection'], ['body', 'JSON body', 'textarea']] },
  task: { label: 'Manual task', icon: 'check', description: 'Pause until the assigned technician confirms the work is complete.', fields: [['instructions', 'instructions', 'textarea'], ['assignee_email', 'technician email', 'text']] },
  delay: { label: 'Wait', icon: 'clock', description: 'Wait for a chosen number of minutes before continuing.', fields: [['minutes', 'wait minutes', 'text']] },
};
const STATUS_LABELS = { queued: 'Queued', running: 'Running', waiting_approval: 'Waiting for approval', waiting_task: 'Waiting for a task', waiting_delay: 'Waiting', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed', blocked: 'Needs setup', needs_attention: 'Needs attention', pending: 'Pending', approved: 'Approved', expired: 'Expired' };
const TERMINAL = new Set(['completed', 'rejected', 'cancelled']);
const TOKENS = /{{\s*([a-z][a-z0-9_]{0,39})\s*}}/g;
const clone = value => JSON.parse(JSON.stringify(value));
const typeId = item => item.type || item.id || item.name;
const uid = () => crypto.randomUUID();
const variable = (key, label, type = 'text', required = true) => ({ key, label, type, required, default: '', description: '' });

export function createActionsUI({ api, esc, icon, toast, getUser, getCurrentView, activate, openTicket }) {
  const $ = selector => document.querySelector(selector);
  const byId = id => document.getElementById(id);
  const main = () => $('#main-content');
  const state = { hash: '', generation: 0, catalog: null, catalogAt: 0, catalogUser: '', catalogRequest: 0, templates: [], runs: [], total: 0, offset: 0, status: '', tab: 'runs', editor: null, dirty: false, saving: false, run: null, runSignature: '', runRequest: 0, completion: '', timer: null, focused: null };
  const userKey = () => getUser()?.id;
  const active = (generation, user) => getCurrentView() === 'actions' && userKey() === user && generation === state.generation;
  const status = value => `<span class="action-status ${Object.hasOwn(STATUS_LABELS, value) ? value : 'pending'}">${esc(STATUS_LABELS[value] || value)}</span>`;
  const date = value => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not set';
  const types = () => state.catalog?.types?.length ? state.catalog.types : Object.entries(TYPE_UI).map(([type, item]) => ({ type, ...item }));
  const typeInfo = type => ({ ...TYPE_UI[type], ...(types().find(item => typeId(item) === type) || {}) });
  const fieldList = type => TYPE_UI[type]?.fields || (typeInfo(type).fields || []).map(item => typeof item === 'string' ? [item, item.replaceAll('_', ' '), 'text'] : [item.name || item.key, item.label || item.name, item.type || 'text']);
  const typeOptions = selected => types().map(item => `<option value="${esc(typeId(item))}"${typeId(item) === selected ? ' selected' : ''}>${esc(item.label || TYPE_UI[typeId(item)]?.label || typeId(item))}</option>`).join('');
  const definitionOf = template => ({ name: template.name, description: template.description || '', variables: clone(template.variables || []), steps: clone(template.steps || []) });
  const connectionsFor = type => (state.catalog?.capabilities?.connections || []).filter(connection => (connection.kind || 'api') === (type === 'power_automate' ? 'power_automate' : 'api'));

  const workflowsUI = createWorkflowsUI({ api, esc, icon, toast, getUser, getCurrentView, goto, onActionsTab: tab => { state.tab = tab; goto('#actions'); } });

  function stopTimer() { clearTimeout(state.timer); state.timer = null; }
  function reset() { workflowsUI.reset(); stopTimer(); state.generation++; state.catalogRequest++; state.runRequest++; state.hash = ''; state.editor = null; state.run = null; state.catalog = null; state.catalogUser = ''; state.templates = []; state.dirty = false; state.saving = false; state.completion = ''; }
  function leave() { workflowsUI.leave(); stopTimer(); state.generation++; state.editor = null; state.dirty = false; state.hash = ''; }
  function canLeave() { if (!workflowsUI.canLeave()) return false; if (state.saving) { toast('Finishing the action save. Please wait a moment.'); return false; } if (!state.dirty) return true; if (!window.confirm('Discard your unsaved action changes?')) return false; state.dirty = false; return true; }
  function isDirty() { return state.dirty || workflowsUI.isDirty(); }
  function matches(hash = location.hash) { return /^#actions(?:\/|\?|$)/.test(hash); }
  function goto(hash) {
    if (!canLeave()) return;
    state.dirty = false; stopTimer();
    if (location.hash === hash) open(hash, { force: true }); else location.hash = hash;
  }
  function backButton() { return `<button class="view-link" type="button" data-action-go="#actions">${icon('left')}Back to actions</button>`; }
  function notice() {
    const caps = state.catalog?.capabilities;
    if (!caps || caps.approval?.configured) return '';
    return `<div class="action-config-notice">${icon('mail')}<div><strong>Email approvals need outbound email setup.</strong><p>You can build templates now. Manual tasks and waits are ready to use; approval and email steps require a configured mail service${caps.email?.configured ? ' and public approval address' : ''}.</p></div></div>`;
  }
  function bindNavigation() {
    main().querySelectorAll('[data-action-go]').forEach(button => button.addEventListener('click', () => goto(button.dataset.actionGo)));
    main().querySelectorAll('[data-action-ticket]').forEach(button => button.addEventListener('click', () => openTicket(button.dataset.actionTicket)));
  }
  function errorPanel(message, retry) {
    main().innerHTML = `<div class="actions-page">${backButton()}<section class="panel error-panel">${icon('alert')}<div><strong>The action could not be loaded.</strong><p>${esc(message)}</p></div><button class="btn" id="actions-retry">Try again</button></section></div>`;
    bindNavigation(); $('#actions-retry').addEventListener('click', retry);
  }
  async function catalog(force = false) {
    const user = `${userKey()}:${getUser()?.role}`, request = ++state.catalogRequest;
    if (!force && state.catalog && state.catalogUser === user && Date.now() - state.catalogAt < 30000) return state.catalog;
    const result = await api('/api/desk/actions/types');
    if (`${userKey()}:${getUser()?.role}` !== user || request !== state.catalogRequest) throw new Error('The action view changed. Open it again to continue.');
    state.catalog = result; state.catalogAt = Date.now(); state.catalogUser = user; return result;
  }
  async function open(hash = '#actions', { force = false, quiet = false } = {}) {
    if (!matches(hash) || !getUser()) return;
    if (state.hash === hash && (state.editor || workflowsUI.hasDraft()) && !force) return;
    if (state.hash && state.hash !== hash && (state.dirty || workflowsUI.isDirty()) && !canLeave()) { location.hash = state.hash; return; }
    const generation = ++state.generation, user = userKey(); stopTimer();
    if (state.hash !== hash || !workflowsUI.matches(hash)) workflowsUI.leave();
    state.hash = hash; state.dirty = false; state.saving = false; state.editor = null; state.focused = null;
    activate(); document.title = 'Actions · AssetDesk'; $('#breadcrumb-current').textContent = 'Actions';
    if (!quiet) main().innerHTML = '<section class="panel"><div class="table-loading"><span class="spinner"></span>Opening actions…</div></section>';
    try {
      await catalog(); if (!active(generation, user)) return;
      const route = new URL(hash.slice(1), 'https://assetdesk.invalid/');
      const path = route.pathname.replace(/\/$/, '');
      if (workflowsUI.matches(hash)) { await workflowsUI.open(hash, { quiet }); return; }
      workflowsUI.leave();
      if (path === '/actions/new') {
        const templates = await api('/api/desk/actions/templates'); if (!active(generation, user)) return; state.templates = templates.templates || [];
        const id = route.searchParams.get('template'), template = id ? await api('/api/desk/actions/templates/' + encodeURIComponent(id)) : null;
        if (!active(generation, user)) return;
        state.editor = { mode: 'run', template, definition: template ? definitionOf(template) : blankDefinition(), values: {}, editedValues: new Set(), ticket_key: '', error: '' };
        for (const item of state.editor.definition.variables) state.editor.values[item.key] = item.default ?? '';
        renderEditor();
      } else if (/^\/actions\/templates\/(?:new|[^/]+\/edit)$/.test(path)) {
        const id = path.match(/^\/actions\/templates\/([^/]+)\/edit$/)?.[1], copyId = route.searchParams.get('copy');
        const template = id || copyId ? await api('/api/desk/actions/templates/' + encodeURIComponent(id || copyId)) : null;
        if (!active(generation, user)) return;
        if (id && !template.canEdit) throw new Error('Only the template owner or an administrator can edit this template.');
        state.editor = { mode: 'template', template: id ? template : null, definition: template ? definitionOf(template) : blankDefinition(), values: {}, active: template?.active !== false, error: '' };
        if (copyId) state.editor.definition.name += ' — copy';
        renderEditor();
      } else if (/^\/actions\/runs\/[^/]+$/.test(path)) {
        state.run = null; state.runSignature = ''; state.completion = ''; await loadRun(path.split('/').at(-1), generation, user);
      } else if (path === '/actions') {
        const [runs, templates] = await Promise.all([api('/api/desk/actions/runs?' + new URLSearchParams({ limit: '25', offset: String(state.offset), ...(state.status ? { status: state.status } : {}) })), api('/api/desk/actions/templates')]);
        if (!active(generation, user)) return;
        state.runs = runs.runs || []; state.total = runs.total || 0; state.templates = templates.templates || []; renderLanding();
      } else throw new Error('This action page was not found.');
    } catch (error) { if (active(generation, user)) errorPanel(error.message, () => open(hash, { force: true })); }
  }
  function blankDefinition() {
    return { name: '', description: '', variables: [variable('person_name', 'Person'), variable('request_details', 'Request details')], steps: [{ id: uid(), type: 'task', name: 'Complete the request', config: { instructions: 'Complete {{request_details}} for {{person_name}}.', assignee_email: '' } }] };
  }
  function renderLanding() {
    const cards = state.tab === 'templates' ? `<div class="action-template-grid">${state.templates.map(template => `<article class="panel action-template-card"><div class="action-template-heading"><span class="action-type-icon">${icon('note')}</span>${template.active === false ? '<span class="role-badge">Archived</span>' : '<span class="role-badge">Template</span>'}</div><span class="action-template-label">Title</span><h2>${esc(template.name)}</h2><span class="action-template-label">Description</span><p>${esc(template.description || 'A reusable workflow with details you can change for each run.')}</p><div class="action-card-meta">${template.steps?.length || 0} steps · ${template.variables?.length || 0} editable variables</div><div class="action-token-list">${(template.variables || []).map(item => `<span class="action-token action-variable-token">{{${esc(item.key)}}}</span>`).join('')}</div><details class="action-template-implementation"><summary>Technical implementation</summary>${template.steps.map((step, index) => implementationBlock(step, index, { variables: template.variables || [] })).join('')}</details><div class="action-card-footer">${template.active !== false ? `<button class="btn primary" data-action-go="#actions/new?template=${encodeURIComponent(template.id)}" aria-label="Use template ${esc(template.name)}">Use template</button>` : ''}${template.canEdit ? `<button class="btn" data-action-go="#actions/templates/${encodeURIComponent(template.id)}/edit" aria-label="Edit template ${esc(template.name)}">Edit</button>` : ''}<button class="view-link" data-action-go="#actions/templates/new?copy=${encodeURIComponent(template.id)}" aria-label="Duplicate template ${esc(template.name)}">Duplicate</button></div></article>`).join('')}</div>` : `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Action runs <span class="count-badge">${state.total}</span></h2><p class="panel-subtitle">Track progress, decisions, and the work waiting on your team.</p></div><select id="action-status-filter" aria-label="Filter action status"><option value="">All statuses</option>${Object.entries(STATUS_LABELS).filter(([key]) => !['pending', 'approved', 'expired'].includes(key)).map(([key, label]) => `<option value="${key}"${state.status === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div><div class="actions-run-list">${state.runs.length ? state.runs.map(run => `<button class="action-run-card" data-action-go="#actions/runs/${encodeURIComponent(run.id)}"><div><strong>${esc(run.name)}</strong><span class="action-card-meta">${esc(run.created_by_name || 'Your team')} · ${esc(date(run.created_at))}</span></div><div class="action-run-card-progress">${status(run.status)}<small>${run.progress?.completed || 0} / ${run.progress?.total || run.steps?.length || 0} steps complete</small></div>${icon('chevron')}</button>`).join('') : '<div class="action-empty">' + icon('spark') + '<h3>Start the next repeatable task.</h3><p>Create an action or use a template to keep approvals and follow-up work organized.</p></div>'}</div><footer class="table-footer"><span>${state.total ? `${state.offset + 1}–${Math.min(state.offset + state.runs.length, state.total)} of ${state.total} actions` : 'No actions yet'}</span><div class="pagination"><button class="icon-button" id="action-prev" aria-label="Previous action page"${state.offset === 0 ? ' disabled' : ''}>${icon('left')}</button><button class="icon-button" id="action-next" aria-label="Next action page"${state.offset + 25 >= state.total ? ' disabled' : ''}>${icon('chevron')}</button></div></footer></section>`;
    main().innerHTML = `<div class="actions-page"><header class="page-heading actions-heading"><div><div class="eyebrow">Automation workspace</div><h1>Actions</h1><p>Run repeatable workflows with clear steps, approvals, and editable details.</p></div><div class="actions-heading-actions"><button class="btn" data-action-go="#actions/workflows/new">${icon('spark')}New workflow</button><button class="btn" data-action-go="#actions/templates/new">${icon('note')}New template</button><button class="btn primary" data-action-go="#actions/new">${icon('plus')}New action</button></div></header>${notice()}<div class="actions-tabs" role="tablist" aria-label="Action views"><button class="tab${state.tab === 'runs' ? ' active' : ''}" role="tab" aria-selected="${state.tab === 'runs'}" data-action-tab="runs">Runs</button><button class="tab${state.tab === 'templates' ? ' active' : ''}" role="tab" aria-selected="${state.tab === 'templates'}" data-action-tab="templates">Templates <span class="count-badge">${state.templates.filter(item => item.active !== false).length}</span></button><button class="tab" role="tab" aria-selected="false" data-action-go="#actions/workflows">Workflows</button><button class="btn subtle" id="actions-refresh" aria-label="Refresh actions">${icon('refresh')}</button></div>${cards}</div>`;
    bindNavigation();
    main().querySelectorAll('[data-action-tab]').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.actionTab; renderLanding(); }));
    $('#actions-refresh').addEventListener('click', () => open('#actions', { force: true, quiet: true }));
    $('#action-status-filter')?.addEventListener('change', event => { state.status = event.target.value; state.offset = 0; open('#actions', { force: true, quiet: true }); });
    $('#action-prev')?.addEventListener('click', () => { state.offset = Math.max(0, state.offset - 25); open('#actions', { force: true, quiet: true }); });
    $('#action-next')?.addEventListener('click', () => { state.offset += 25; open('#actions', { force: true, quiet: true }); });
  }
  function tokensIn(value) { return [...String(value ?? '').matchAll(new RegExp(TOKENS.source, 'g'))].map(match => match[1]).filter((key, index, all) => all.indexOf(key) === index); }
  function highlight(value, values = null, variables = null) {
    let html = '', end = 0; const input = String(value ?? '');
    for (const match of input.matchAll(new RegExp(TOKENS.source, 'g'))) {
      html += esc(input.slice(end, match.index));
      const item = variables ? variables.find(v => v.key === match[1]) : state.editor?.definition.variables.find(v => v.key === match[1]) || state.run?.definition?.variables?.find(v => v.key === match[1]);
      const actual = values?.[match[1]] ?? item?.default, display = values && actual !== undefined && String(actual).trim() !== '' ? String(actual) : match[0];
      html += `<mark class="action-token action-variable-token${!item || (values && item.required && !String(actual ?? '').trim()) ? ' missing' : ''}" title="${esc(item?.label || 'Undeclared variable')}">${esc(display)}</mark>`; end = match.index + match[0].length;
    }
    return html + esc(input.slice(end));
  }
  function input(name, label, value, { textarea = false, type = 'text', required = false, hint = '', target = false, disabled = false } = {}) {
    const attributes = `id="${esc(name)}" class="input${target ? ' action-token-target' : ''}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}${type === 'number' ? ' min="0.0001" step="any"' : ''}`;
    return `<div class="field${textarea ? ' action-wide-field' : ''}"><label for="${esc(name)}">${esc(label)}</label>${textarea ? `<textarea ${attributes} rows="4">${esc(value)}</textarea>` : `<input ${attributes} type="${type}" value="${esc(value)}">`}${hint ? `<small>${esc(hint)}</small>` : ''}${target ? '<div class="action-token-list action-field-tokens" aria-live="polite"></div>' : ''}</div>`;
  }
  function variableDefinitions() {
    const editor = state.editor;
    return `<section class="panel action-variables-panel" aria-label="Editable variables"><header class="panel-header"><div><h2 class="panel-title">Editable variables</h2><p class="panel-subtitle">Make changing details obvious in every run.</p></div></header><div class="action-variables-body"><p class="action-field-hint">Use <span class="action-token action-variable-token">{{variable_key}}</span> in a step field. Select a field, then select a variable token to insert it.</p>${editor.definition.variables.map((item, index) => `<article class="action-variable-row" data-variable-index="${index}"><header><strong>${esc(item.label || item.key || 'New variable')}</strong><button class="icon-button" type="button" data-remove-variable="${index}" aria-label="Remove variable ${index + 1}">${icon('close')}</button></header><button type="button" class="action-token action-variable-token" data-insert-variable="${esc(item.key)}" aria-label="Insert {{${esc(item.key)}}}">{{${esc(item.key)}}}</button><div class="action-variable-grid">${input(`action-var-${index}-label`, `Variable ${index + 1} label`, item.label)}${input(`action-var-${index}-key`, `Variable ${index + 1} key`, item.key)}<div class="field"><label for="action-var-${index}-type">Variable ${index + 1} type</label><select id="action-var-${index}-type">${['text', 'email', 'number', 'date'].map(type => `<option${type === item.type ? ' selected' : ''}>${type}</option>`).join('')}</select></div>${input(`action-var-${index}-default`, `Variable ${index + 1} default value`, item.default ?? '')}</div>${input(`action-var-${index}-description`, `Variable ${index + 1} help text`, item.description || '')}<label class="action-required"><input type="checkbox" id="action-var-${index}-required"${item.required ? ' checked' : ''}>Variable ${index + 1} required</label></article>`).join('')}<button class="btn" type="button" id="action-add-variable">${icon('plus')}Add variable</button></div></section>`;
  }
  function valuesPanel() {
    const editor = state.editor;
    return `<section class="panel action-values-panel" aria-label="Change for this run"><header class="panel-header"><div><h2 class="panel-title">Change for this run</h2><p class="panel-subtitle">These highlighted details change. The template stays standardized.</p></div></header><div class="action-values-grid">${editor.definition.variables.length ? editor.definition.variables.map(item => `<div class="field"><label for="action-value-${esc(item.key)}">${esc(item.label || item.key)}${item.required ? ' <span class="action-required-star">*</span>' : ''}</label><span class="action-token action-variable-token">{{${esc(item.key)}}}</span><input class="input" id="action-value-${esc(item.key)}" aria-label="${esc(item.label || item.key)}" type="${['email', 'number', 'date'].includes(item.type) ? item.type : 'text'}" value="${esc(editor.values[item.key] ?? item.default ?? '')}"${item.type === 'number' ? ' step="any"' : ''}${item.required ? ' required' : ''}>${item.description ? `<small>${esc(item.description)}</small>` : ''}</div>`).join('') : '<p>This workflow has no editable variables.</p>'}</div></section>`;
  }
  function stepField(step, index, field) {
    const [key, label, type] = field, id = `action-step-${index}-${key}`, value = step.config[key] ?? '', title = `Step ${index + 1} ${label}`;
    if (type === 'connection') { const connections = connectionsFor(step.type); return `<div class="field"><label for="${id}">${esc(title)}</label><select id="${id}" data-step-index="${index}" data-step-field="${key}"><option value="">Choose a connection</option>${connections.map(connection => `<option value="${esc(connection.id)}"${connection.id === value ? ' selected' : ''}>${esc(connection.name)}</option>`).join('')}</select><small>${connections.length ? 'Credentials and private trigger URLs are managed on the server.' : `Ask an administrator to configure ${step.type === 'power_automate' ? 'a Power Automate' : 'an API'} connection for your role.`}</small></div>`; }
    if (type === 'method') { const methods = state.catalog?.capabilities?.connections?.find(item => item.id === step.config.connection)?.methods || ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']; return `<div class="field"><label for="${id}">${esc(title)}</label><select id="${id}" data-step-index="${index}" data-step-field="${key}">${methods.map(method => `<option${method === value ? ' selected' : ''}>${method}</option>`).join('')}</select></div>`; }
    const hint = key === 'assignee_email' ? 'Leave blank to assign the person starting the action.' : key === 'body' && ['api', 'power_automate'].includes(step.type) ? 'Use valid JSON. Put variable tokens inside quoted JSON values.' : key === 'path' ? 'A relative path such as /requests/{{person_name}}.' : '';
    return input(id, title, value, { textarea: type === 'textarea', type: type === 'number' ? 'number' : 'text', hint, target: type !== 'number', disabled: step.type === 'api' && key === 'body' && step.config.method === 'GET' });
  }
  function stepEditor(step, index) {
    const info = typeInfo(step.type);
    return `<section class="panel action-step-card" data-step-card="${index}"><header class="action-step-heading"><span class="action-step-number">${index + 1}</span><div><h2>${esc(info.label || step.type)}</h2><p>${esc(info.description || '')}</p></div><div class="action-step-controls"><button class="icon-button" type="button" data-step-up="${index}" aria-label="Move step ${index + 1} up"${index === 0 ? ' disabled' : ''}>${icon('left')}</button><button class="icon-button" type="button" data-step-down="${index}" aria-label="Move step ${index + 1} down"${index === state.editor.definition.steps.length - 1 ? ' disabled' : ''}>${icon('chevron')}</button><button class="icon-button" type="button" data-step-remove="${index}" aria-label="Remove step ${index + 1}">${icon('close')}</button></div></header><div class="action-step-fields"><div class="field"><label for="action-step-${index}-type">Step ${index + 1} type</label><select id="action-step-${index}-type" data-step-type="${index}">${typeOptions(step.type)}</select></div>${input(`action-step-${index}-name`, `Step ${index + 1} name`, step.name, { target: true })}${fieldList(step.type).map(field => stepField(step, index, field)).join('')}</div><div data-implementation-preview="${index}">${implementationBlock(step, index, { variables: state.editor.definition.variables, values: state.editor.mode === 'run' ? state.editor.values : null })}</div></section>`;
  }
  function implementationBlock(step, index, { variables = [], values = null, assigneeEmail = '', resolvedStep = null } = {}) {
    const options = { connections: state.catalog?.capabilities?.connections || [], variables, publicUrl: state.catalog?.capabilities?.publicUrl || '' };
    return `<section class="action-implementation" aria-label="Step ${index + 1} technical implementation"><div class="action-implementation-heading"><strong>Server operation</strong><span>Template placeholders</span></div><pre class="action-implementation-code"><code>${highlight(formatActionImplementation(step, options), null, variables)}</code></pre>${values !== null ? `<details class="action-resolved-implementation"><summary>With this run’s values</summary><pre class="action-implementation-code"><code>${esc(formatActionImplementation(resolvedStep || step, { ...options, values: resolvedStep ? null : values, assigneeEmail }))}</code></pre></details>` : ''}</section>`;
  }
  function stepPreview(step, index, values = null) {
    const info = typeInfo(step.type);
    return `<section class="panel action-step-card action-preview"><header class="action-step-heading"><span class="action-step-number">${index + 1}</span><div><h2>${highlight(step.name || info.label || step.type, values)}</h2><p>${esc(info.label || step.type)}</p></div></header>${['api', 'power_automate'].includes(step.type) ? '' : `<dl>${fieldList(step.type).map(([key, label]) => `<div class="action-preview-field"><dt class="action-preview-label">${esc(label)}</dt><dd class="action-preview-value">${highlight(typeof step.config[key] === 'object' ? JSON.stringify(step.config[key], null, 2) : step.config[key] ?? '', values) || '<span class="muted">' + (key === 'assignee_email' ? 'Person starting the action' : 'Not set') + '</span>'}</dd></div>`).join('')}</dl>`}${implementationBlock(step, index, { variables: state.editor.definition.variables, values })}</section>`;
  }
  function renderEditor() {
    const editor = state.editor, fromTemplate = editor.mode === 'run' && editor.template, templateMode = editor.mode === 'template';
    const title = templateMode ? editor.template ? 'Edit action template' : 'New action template' : 'New action';
    document.title = title + ' · AssetDesk'; $('#breadcrumb-current').textContent = title;
    main().innerHTML = `<div class="actions-page">${backButton()}<header class="page-heading actions-heading"><div><div class="eyebrow">${templateMode ? 'Standardized workflows' : 'Start a workflow'}</div><h1>${title}</h1><p>${templateMode ? 'Define the repeatable steps and make every changing detail a visible variable.' : fromTemplate ? 'Change the highlighted details, review the steps, and start the action.' : 'Choose the steps your team needs, then fill the details for this run.'}</p></div></header>${notice()}<form id="action-editor-form"><section class="panel action-definition-panel"><div class="action-step-fields">${!templateMode ? `<div class="field action-wide-field"><label for="action-source">Start from</label><select id="action-source"><option value="">Blank workflow</option>${state.templates.filter(item => item.active !== false).map(item => `<option value="${esc(item.id)}"${item.id === editor.template?.id ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}</select></div>` : ''}${input('action-definition-name', templateMode ? 'Template title' : 'Action name', editor.definition.name, { required: true })}${!templateMode ? input('action-ticket-key', 'Linked ticket ID (optional)', editor.ticket_key, { hint: 'Keep this workflow connected to an existing support ticket.' }) : ''}${fromTemplate ? `<div class="action-wide-field action-template-description"><strong>Template description</strong><p>${esc(editor.definition.description || 'Follow the standardized steps below.')}</p></div>` : input('action-definition-description', 'Description', editor.definition.description, { textarea: true })}${templateMode && editor.template ? `<label class="action-required action-wide-field"><input type="checkbox" id="action-template-active"${editor.active ? ' checked' : ''}>Available for new actions</label>` : ''}</div></section><div class="action-builder-layout"><div class="action-builder-main">${fromTemplate ? `<h2 class="action-section-heading">Technical implementation <span class="role-badge">Template version ${editor.template.version}</span></h2><div id="action-workflow-preview">${editor.definition.steps.map((step, index) => stepPreview(step, index, editor.values)).join('')}</div>` : `<div class="action-section-heading"><h2>Technical implementation</h2><span>Server steps run in this order</span></div><p class="action-implementation-intro">Edit the operation settings below. The server executes these steps with the highlighted variable values.</p><div id="action-workflow-steps">${editor.definition.steps.map(stepEditor).join('')}</div><button class="btn" type="button" id="action-add-step">${icon('plus')}Add step</button>`}</div><aside>${fromTemplate ? '' : variableDefinitions()}${!templateMode ? valuesPanel() : ''}</aside></div><p class="action-form-error field-error" id="action-editor-error" role="alert">${esc(editor.error || '')}</p><footer class="action-sticky-actions"><p>${templateMode ? 'Saving a template does not execute its steps.' : 'Starting an action can send email or make the API calls shown above.'}</p><div><button class="btn" type="button" data-action-go="#actions">Cancel</button>${templateMode ? '<button class="btn primary" type="submit" data-intent="template">Save template</button>' : `${!fromTemplate ? '<button class="btn" type="submit" data-intent="template" formnovalidate>Save as template</button>' : ''}<button class="btn primary" type="submit" data-intent="run">Start action</button>`}</div></footer></form></div>`;
    bindNavigation(); bindEditor(); refreshTokenHints();
  }
  function dirty() { state.dirty = true; if (state.editor) state.editor.error = ''; const box = $('#action-editor-error'); if (box) box.textContent = ''; }
  function bindEditor() {
    const editor = state.editor;
    $('#action-definition-name').addEventListener('input', event => { editor.definition.name = event.target.value; dirty(); });
    $('#action-definition-description')?.addEventListener('input', event => { editor.definition.description = event.target.value; dirty(); });
    $('#action-ticket-key')?.addEventListener('input', event => { editor.ticket_key = event.target.value; dirty(); });
    $('#action-template-active')?.addEventListener('change', event => { editor.active = event.target.checked; dirty(); });
    $('#action-source')?.addEventListener('change', event => goto(event.target.value ? '#actions/new?template=' + encodeURIComponent(event.target.value) : '#actions/new'));
    editor.definition.variables.forEach((item, index) => {
      for (const field of ['label', 'key', 'type', 'default', 'description', 'required']) {
        const input = $(`#action-var-${index}-${field}`);
        input?.addEventListener(field === 'type' || field === 'required' ? 'change' : 'input', event => { const oldKey = item.key; item[field] = field === 'required' ? event.target.checked : event.target.value; if (field === 'key' && oldKey !== item.key) { editor.values[item.key] = editor.values[oldKey] ?? item.default ?? ''; delete editor.values[oldKey]; if (editor.editedValues?.delete(oldKey)) editor.editedValues.add(item.key); } if (field === 'default' && !editor.editedValues?.has(item.key)) editor.values[item.key] = item.default; dirty(); refreshVariableRow(index, item); refreshTokenHints(); refreshValuesPanel(); });
      }
      const field = byId(`action-value-${item.key}`);
      field?.addEventListener('input', event => { editor.values[item.key] = event.target.value; editor.editedValues?.add(item.key); dirty(); renderPreviewOnly(); });
    });
    main().querySelectorAll('[data-remove-variable]').forEach(button => button.addEventListener('click', () => { const [removed] = editor.definition.variables.splice(Number(button.dataset.removeVariable), 1); if (removed) { delete editor.values[removed.key]; editor.editedValues?.delete(removed.key); } dirty(); renderEditor(); }));
    $('#action-add-variable')?.addEventListener('click', () => { let index = editor.definition.variables.length + 1; while (editor.definition.variables.some(item => item.key === 'variable_' + index)) index++; editor.definition.variables.push(variable('variable_' + index, 'New variable')); dirty(); renderEditor(); });
    main().querySelectorAll('[data-insert-variable]').forEach(button => { button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => insertVariable(button.dataset.insertVariable)); });
    main().querySelectorAll('.action-token-target').forEach(field => field.addEventListener('focus', () => { state.focused = field; }));
    editor.definition.steps.forEach((step, index) => {
      $(`#action-step-${index}-name`)?.addEventListener('input', event => { step.name = event.target.value; dirty(); refreshTokenHints(); });
      main().querySelectorAll(`[data-step-index="${index}"]`).forEach(field => field.addEventListener('input', event => { step.config[field.dataset.stepField] = event.target.value; if (field.dataset.stepField === 'connection' && step.type === 'api') { const methods = state.catalog?.capabilities?.connections?.find(item => item.id === event.target.value)?.methods || ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']; if (!methods.includes(step.config.method)) step.config.method = methods[0]; const method = byId(`action-step-${index}-method`); if (method) method.innerHTML = methods.map(value => `<option${value === step.config.method ? ' selected' : ''}>${value}</option>`).join(''); } if (step.type === 'api') { const body = byId(`action-step-${index}-body`); if (step.config.method === 'GET') { step.config.body = ''; if (body) body.value = ''; } if (body) body.disabled = step.config.method === 'GET'; } dirty(); refreshTokenHints(); }));
      for (const [key, , type] of fieldList(step.type)) {
        if (['connection', 'method'].includes(type)) continue;
        $(`#action-step-${index}-${key}`)?.addEventListener('input', event => { step.config[key] = type === 'number' ? Number(event.target.value) : event.target.value; dirty(); refreshTokenHints(); });
      }
    });
    main().querySelectorAll('[data-step-type]').forEach(field => field.addEventListener('change', () => { const index = Number(field.dataset.stepType); editor.definition.steps[index] = defaultStep(field.value); ensureTypeVariables(field.value); dirty(); renderEditor(); }));
    main().querySelectorAll('[data-step-remove]').forEach(button => button.addEventListener('click', () => { editor.definition.steps.splice(Number(button.dataset.stepRemove), 1); dirty(); renderEditor(); }));
    for (const [attribute, direction] of [['stepUp', -1], ['stepDown', 1]]) main().querySelectorAll(`[data-${attribute === 'stepUp' ? 'step-up' : 'step-down'}]`).forEach(button => button.addEventListener('click', () => { const index = Number(button.dataset[attribute]); [editor.definition.steps[index], editor.definition.steps[index + direction]] = [editor.definition.steps[index + direction], editor.definition.steps[index]]; dirty(); renderEditor(); }));
    $('#action-add-step')?.addEventListener('click', () => { editor.definition.steps.push(defaultStep('task')); dirty(); renderEditor(); });
    $('#action-editor-form').addEventListener('submit', event => { event.preventDefault(); saveEditor(event.submitter?.dataset.intent || 'run'); });
  }
  function refreshVariableRow(index, item) {
    const row = main().querySelector(`[data-variable-index="${index}"]`); if (!row) return;
    row.querySelector('header strong').textContent = item.label || item.key || 'New variable';
    const token = row.querySelector('[data-insert-variable]'); token.dataset.insertVariable = item.key; token.textContent = '{{' + item.key + '}}'; token.setAttribute('aria-label', 'Insert {{' + item.key + '}}');
  }
  function refreshValuesPanel() {
    const panel = main().querySelector('.action-values-panel'); if (!panel || state.editor.mode === 'template') return;
    panel.outerHTML = valuesPanel();
    for (const item of state.editor.definition.variables) byId(`action-value-${item.key}`)?.addEventListener('input', event => { state.editor.values[item.key] = event.target.value; state.editor.editedValues?.add(item.key); dirty(); renderPreviewOnly(); });
    renderPreviewOnly();
  }
  function ensureTypeVariables(type) {
    const definitions = type === 'approval' ? [variable('approver_email', 'Approver email', 'email')] : type === 'email' ? [variable('recipient_email', 'Recipient email', 'email')] : [];
    for (const item of definitions) if (!state.editor.definition.variables.some(value => value.key === item.key)) { state.editor.definition.variables.push(item); state.editor.values[item.key] = ''; }
  }
  function defaultStep(type) {
    const config = type === 'approval' ? { to: '{{approver_email}}', subject: 'Approval needed: {{person_name}}', body: 'Please review {{request_details}} for {{person_name}}.', expires_hours: 168 } : type === 'email' ? { to: '{{recipient_email}}', subject: 'Update for {{person_name}}', body: '{{request_details}}' } : type === 'api' ? { connection: connectionsFor(type)[0]?.id || '', method: 'POST', path: '/requests', body: '{\n  "person": "{{person_name}}",\n  "request": "{{request_details}}"\n}' } : type === 'power_automate' ? { connection: connectionsFor(type)[0]?.id || '', body: '{\n  "person": "{{person_name}}",\n  "request": "{{request_details}}"\n}' } : type === 'delay' ? { minutes: '30' } : { instructions: 'Complete {{request_details}} for {{person_name}}.', assignee_email: '' };
    if (type === 'api') { const methods = state.catalog?.capabilities?.connections?.find(item => item.id === config.connection)?.methods; if (methods && !methods.includes(config.method)) config.method = methods[0]; if (config.method === 'GET') config.body = ''; }
    return { id: uid(), type, name: TYPE_UI[type]?.label || type, config };
  }
  function insertVariable(key) {
    const field = state.focused;
    if (!field?.isConnected || !field.classList.contains('action-token-target')) { toast('Select a step field, then choose a variable to insert.'); return; }
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    field.value = field.value.slice(0, start) + '{{' + key + '}}' + field.value.slice(end); field.dispatchEvent(new Event('input', { bubbles: true })); field.focus(); field.setSelectionRange(start + key.length + 4, start + key.length + 4);
  }
  function refreshTokenHints() {
    main()?.querySelectorAll('.action-token-target').forEach(field => {
      const keys = tokensIn(field.value), container = field.closest('.field'); container.classList.toggle('action-field-tokenized', keys.length > 0);
      container.querySelector('.action-field-tokens').innerHTML = keys.map(key => `<span class="action-token action-variable-token${state.editor.definition.variables.some(item => item.key === key) ? '' : ' missing'}">{{${esc(key)}}}</span>`).join('');
    });
    refreshImplementationPreviews();
  }
  function refreshImplementationPreviews() {
    if (!state.editor) return;
    main()?.querySelectorAll('[data-implementation-preview]').forEach(container => {
      const index = Number(container.dataset.implementationPreview), expanded = container.querySelector('.action-resolved-implementation')?.open;
      container.innerHTML = implementationBlock(state.editor.definition.steps[index], index, { variables: state.editor.definition.variables, values: state.editor.mode === 'run' ? state.editor.values : null });
      const details = container.querySelector('.action-resolved-implementation'); if (details) details.open = expanded;
    });
  }
  function renderPreviewOnly() {
    const preview = $('#action-workflow-preview');
    if (preview) {
      const expanded = [...preview.querySelectorAll('.action-resolved-implementation')].map(details => details.open);
      preview.innerHTML = state.editor.definition.steps.map((step, index) => stepPreview(step, index, state.editor.values)).join('');
      preview.querySelectorAll('.action-resolved-implementation').forEach((details, index) => { details.open = expanded[index]; });
    }
    refreshImplementationPreviews();
  }
  function validateEditor(intent) {
    const editor = state.editor, definition = editor.definition;
    if (!definition.name.trim()) throw new Error('Add a name for this workflow.');
    if (!definition.steps.length) throw new Error('Add at least one workflow step.');
    const keys = definition.variables.map(item => item.key);
    if (keys.some(key => !/^[a-z][a-z0-9_]{0,39}$/.test(key)) || new Set(keys).size !== keys.length) throw new Error('Variable keys must be unique lowercase names, using letters, numbers, and underscores.');
    for (const step of definition.steps) for (const value of [step.name, ...Object.values(step.config)]) for (const key of tokensIn(value)) if (!keys.includes(key)) throw new Error(`Declare the variable {{${key}}} or remove it from the step.`);
    if (intent === 'run') for (const item of definition.variables) if (item.required && !String(editor.values[item.key] ?? item.default ?? '').trim()) throw new Error(`Fill in ${item.label || item.key} before starting.`);
  }
  async function saveEditor(intent) {
    if (state.saving) return;
    const editor = state.editor, user = userKey(), generation = state.generation;
    try { validateEditor(intent); } catch (error) { editor.error = error.message; $('#action-editor-error').textContent = error.message; return; }
    const controls = [...$('#action-editor-form').elements].map(field => [field, field.disabled]);
    state.saving = true; controls.forEach(([field]) => { field.disabled = true; }); $('#action-editor-error').textContent = '';
    try {
      if (intent === 'template') {
        const payload = { ...clone(editor.definition), ...(editor.template && editor.mode === 'template' ? { version: editor.template.version, active: editor.active } : {}) };
        const result = await api('/api/desk/actions/templates' + (editor.template && editor.mode === 'template' ? '/' + encodeURIComponent(editor.template.id) : ''), { method: editor.template && editor.mode === 'template' ? 'PATCH' : 'POST', body: payload });
        if (!active(generation, user) || state.editor !== editor) return;
        state.dirty = false; state.saving = false; toast('Action template saved.'); goto('#actions/templates/' + result.id + '/edit');
      } else {
        const payload = { name: editor.definition.name.trim(), values: clone(editor.values), ...(editor.ticket_key?.trim() ? { ticket_key: editor.ticket_key.trim() } : {}), ...(editor.template ? { template_id: editor.template.id, template_version: editor.template.version } : { definition: clone(editor.definition) }) };
        const result = await api('/api/desk/actions/runs', { method: 'POST', body: payload });
        if (!active(generation, user) || state.editor !== editor) return;
        state.dirty = false; state.saving = false; toast('Action started.'); goto('#actions/runs/' + result.id);
      }
    } catch (error) {
      if (!active(generation, user) || state.editor !== editor) return;
      editor.error = error.status === 409 ? 'This template changed. Your draft is kept here. Copy your changes before reopening the latest version.' : error.message;
      $('#action-editor-error').textContent = editor.error;
    } finally { if (state.editor === editor) { state.saving = false; controls.forEach(([field, disabled]) => { if (field.isConnected) field.disabled = disabled; }); } }
  }
  async function loadRun(id, generation = state.generation, user = userKey()) {
    const request = ++state.runRequest;
    try {
      const run = await api('/api/desk/actions/runs/' + encodeURIComponent(id)); if (!active(generation, user) || request !== state.runRequest) return;
      if (state.run?.id === run.id && run.version < state.run.version) return;
      const signature = JSON.stringify(run);
      if (signature !== state.runSignature) { state.run = run; state.runSignature = signature; renderRun(); }
      if (!TERMINAL.has(run.status)) state.timer = setTimeout(() => loadRun(id, generation, user), 2500);
    } catch (error) { if (active(generation, user) && request === state.runRequest) errorPanel(error.message, () => loadRun(id, generation, user)); }
  }
  function renderRun() {
    const run = state.run; document.title = `${run.name} · AssetDesk`; $('#breadcrumb-current').textContent = 'Action run';
    const focused = $('#action-completion-note') === document.activeElement, selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const original = run.definition || { variables: [], steps: [] };
    const displayedVariables = run.workflow?.variables || original.variables, displayedValues = run.workflow?.values || run.values;
    main().innerHTML = `<div class="actions-page">${backButton()}<header class="page-heading actions-heading"><div><div class="eyebrow">Action progress</div><h1>${esc(run.name)}</h1><p>${esc(run.description || original.description || '')}</p></div>${status(run.status)}</header><section class="panel action-summary"><div class="action-summary-grid"><div><span>Started by</span><strong>${esc(run.created_by_name || 'Your team')}</strong></div><div><span>Progress</span><strong>${run.progress?.completed || 0} of ${run.progress?.total || run.steps.length} steps complete</strong></div><div><span>Started</span><strong>${esc(date(run.created_at))}</strong></div>${run.ticket_key ? `<div><span>Linked ticket</span><button class="view-link" data-action-ticket="${esc(run.ticket_key)}">${esc(run.ticket_key)} ${icon('chevron')}</button></div>` : ''}</div>${run.error ? `<div class="action-inline-error" role="status">${icon('alert')}<p>${esc(run.error)}</p></div>` : ''}${run.status === 'needs_attention' ? '<p class="action-owner-note">The previous attempt may have reached the external service. Check its outcome before retrying to avoid repeating the operation.</p>' : ''}<div class="action-card-footer">${run.canRetry ? '<button class="btn primary" type="button" data-run-operation="retry">Retry step</button>' : ''}${run.canCancel ? '<button class="btn danger" type="button" data-run-operation="cancel">Cancel action</button>' : ''}<button class="btn" type="button" id="action-run-refresh">${icon('refresh')}Refresh progress</button></div></section><div class="action-builder-layout"><section class="action-run-steps" aria-label="Workflow progress"><h2 class="action-section-heading">Technical implementation</h2>${(run.steps || []).map((step, index) => `<article class="panel action-run-step" id="action-run-step-${index}" tabindex="-1"><header class="action-step-heading"><span class="action-step-number">${index + 1}</span><div><h2>${esc(step.name || TYPE_UI[step.type]?.label || step.type)}</h2><p>${esc(TYPE_UI[step.type]?.label || step.type)} · Attempt ${step.attempt || 0}</p></div>${status(step.status)}</header><div class="action-run-step-body">${step.approval ? `<div class="action-approval-state"><strong>Approver: ${esc(step.approval.recipient)}</strong><p>${esc(STATUS_LABELS[step.approval.decision] || step.approval.decision || 'Pending')} · Expires ${esc(date(step.approval.expires_at))}</p></div>` : ''}${step.due_at ? `<p class="action-owner-note">Continue after ${esc(date(step.due_at))}</p>` : ''}${step.assignee_email ? `<p class="action-owner-note">Assigned to ${esc(step.assignee_email)}</p>` : ''}${original.steps[index] ? `${['api', 'power_automate'].includes(step.type) ? '' : `<div class="action-run-config">${fieldList(step.type).map(([key, label]) => `<div class="action-preview-field"><span class="action-preview-label">${esc(label)}</span><div class="action-preview-value">${highlight(original.steps[index].config?.[key] ?? '', run.values) || '<span class="muted">Not set</span>'}</div></div>`).join('')}</div>`}${implementationBlock(original.steps[index], index, { variables: original.variables, values: run.values, resolvedStep: step, assigneeEmail: step.assignee_email })}` : ''}${step.output ? `<p class="action-step-output">${step.output.status ? `HTTP ${Number(step.output.status)}${step.type === 'power_automate' ? ' · Flow trigger accepted' : ''}` : 'Step completed.'}</p>` : ''}${step.error ? `<p class="field-error">${esc(step.error)}</p>` : ''}${run.canCompleteTask && (step.status === 'waiting_task' || index === run.current_step && run.status === 'waiting_task') ? `<form class="action-complete-form"><label for="action-completion-note">Completion note (optional)</label><textarea id="action-completion-note" maxlength="1000" rows="3">${esc(state.completion)}</textarea><button class="btn primary" type="submit">${icon('check')}Complete task</button></form>` : ''}</div></article>`).join('')}</section><aside>${run.workflow ? renderWorkflowOverview(run.workflow, esc, { run }) : ''}<section class="panel action-values-panel" aria-label="Values for this run"><header class="panel-header"><h2 class="panel-title">Values for this run</h2></header><dl class="action-values-grid">${(displayedVariables || []).map(item => `<div><dt>${esc(item.label || item.key)} <span class="action-token action-variable-token">{{${esc(item.key)}}}</span></dt><dd>${esc(displayedValues?.[item.key] ?? item.default ?? '—')}</dd></div>`).join('')}</dl><p class="action-owner-note">These values belong to this run. Later template edits do not change its saved workflow.</p></section><section class="panel action-run-events" aria-label="Action activity"><header class="panel-header"><h2 class="panel-title">Activity</h2></header>${(run.events || []).map(event => `<article class="action-event"><strong>${esc(event.actor_name || 'AssetDesk')}</strong><p>${esc(event.message || event.type)}</p><time>${esc(date(event.created_at))}</time></article>`).join('')}</section></aside></div></div>`;
    bindNavigation();
    bindWorkflowOverview(main());
    $('#action-run-refresh').addEventListener('click', () => { stopTimer(); loadRun(run.id); });
    main().querySelectorAll('[data-run-operation]').forEach(button => button.addEventListener('click', () => mutateRun(button.dataset.runOperation, button)));
    $('#action-completion-note')?.addEventListener('input', event => { state.completion = event.target.value; });
    main().querySelector('.action-complete-form')?.addEventListener('submit', event => { event.preventDefault(); mutateRun('complete-task', event.currentTarget.querySelector('button')); });
    if (selection) { const field = $('#action-completion-note'); if (field) { field.focus({ preventScroll: true }); field.setSelectionRange(...selection); } }
  }
  async function mutateRun(operation, button) {
    const run = state.run, generation = state.generation, user = userKey(); button.disabled = true;
    try { await api(`/api/desk/actions/runs/${encodeURIComponent(run.id)}/${operation}`, { method: 'POST', body: operation === 'complete-task' ? { comment: state.completion } : {} }); if (!active(generation, user)) return; state.completion = ''; state.runSignature = ''; stopTimer(); await loadRun(run.id, generation, user); }
    catch (error) { if (active(generation, user)) { toast(error.message, true); button.disabled = false; } }
  }
  function refresh({ quiet = false } = {}) { if (state.editor || workflowsUI.hasDraft() || workflowsUI.isDirty()) return; if (workflowsUI.matches(location.hash)) { open(location.hash, { force: true, quiet }); return; } if (state.run && state.hash.startsWith('#actions/runs/')) { stopTimer(); loadRun(state.run.id); } else open(location.hash.startsWith('#actions') ? location.hash : '#actions', { force: true, quiet }); }
  return { open, matches, reset, leave, canLeave, isDirty, refresh, get hash() { return state.hash; } };
}
