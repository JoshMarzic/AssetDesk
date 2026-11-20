const clone = value => JSON.parse(JSON.stringify(value));
const tokenPattern = /{{\s*([a-z][a-z0-9_]{0,39})\s*}}/g;
const uid = () => crypto.randomUUID();
const renameVariable = (value, previous, next) => String(value).replace(/{{([^{}]*)}}/g, (token, key) => key.trim() === previous ? '{{' + next + '}}' : token);

/** A compact connected outline. Its buttons contain only the saved step titles. */
export function renderWorkflowOverview(workflow, esc, { run = null, draft = false } = {}) {
  function nodes(items, parentTarget = '', depth = 0) {
    return `<ol class="workflow-overview-list${depth ? ' nested' : ''}">${items.map((step, index) => {
      const target = draft ? step.overview_target || step.id : `action-run-step-${step.start_index ?? 0}`;
      const current = run && !['completed', 'cancelled', 'rejected'].includes(run.status) && run.current_step >= step.start_index && run.current_step <= step.end_index;
      return `<li><button type="button" class="workflow-overview-title${current ? ' current' : ''}" data-workflow-overview-target="${esc(draft ? 'workflow-step-' + (parentTarget || target) : target)}">${esc(step.name || 'Choose a step')}</button>${step.steps?.length && depth < 5 ? nodes(step.steps, draft ? parentTarget || target : '', depth + 1) : ''}${index < items.length - 1 ? '<span class="workflow-overview-arrow" aria-hidden="true">↓</span>' : ''}</li>`;
    }).join('')}</ol>`;
  }
  return `<section class="panel workflow-overview" aria-label="Workflow overview"><header class="panel-header"><h2 class="panel-title">Workflow overview</h2></header>${workflow.steps?.length ? nodes(workflow.steps) : '<p class="workflow-empty-outline">Add a template or workflow to see the sequence.</p>'}</section>`;
}

export function bindWorkflowOverview(root = document) {
  root.querySelectorAll('[data-workflow-overview-target]').forEach(button => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.workflowOverviewTarget);
    if (!target) return;
    root.querySelectorAll('.workflow-overview-title.selected').forEach(item => item.classList.remove('selected'));
    button.classList.add('selected');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
  }));
}

/** Reusable compositions delegate execution to the existing durable action run. */
export function createWorkflowsUI({ api, esc, icon, toast, getUser, getCurrentView, goto, onActionsTab }) {
  const main = () => document.getElementById('main-content');
  const byId = id => document.getElementById(id);
  const state = { generation: 0, hash: '', templates: [], workflows: [], draft: null, source: null, values: {}, dirty: false, saving: false, dragging: '', error: '' };
  const userKey = () => getUser()?.id;
  const active = (generation, user) => generation === state.generation && user === userKey() && getCurrentView() === 'actions' && state.hash === location.hash;
  const matches = hash => /^#actions\/workflows(?:\/|\?|$)/.test(hash);
  const isDirty = () => state.dirty;
  const hasDraft = () => Boolean(state.draft || state.source);
  function reset() { state.generation++; state.hash = ''; state.draft = null; state.source = null; state.dirty = false; state.saving = false; state.dragging = ''; state.values = {}; state.templates = []; state.workflows = []; }
  function canLeave() {
    if (state.saving) { toast('Finishing the workflow save. Please wait a moment.'); return false; }
    if (!state.dirty) return true;
    if (!window.confirm('Discard your unsaved workflow changes?')) return false;
    state.dirty = false; return true;
  }
  function dirty() { state.dirty = true; state.error = ''; const error = byId('workflow-error'); if (error) error.textContent = ''; }
  const definition = item => ({ name: item.name, description: item.description || '', variables: clone(item.variables || []), steps: clone(item.steps || []) });
  const reference = step => (step.type === 'workflow' ? state.workflows : state.templates).find(item => item.id === step.ref_id);
  const back = () => `<button type="button" class="view-link" data-workflow-go="#actions/workflows">${icon('left')}Back to workflows</button>`;
  const field = (id, label, value, { textarea = false, required = false, type = 'text', hint = '' } = {}) => `<div class="field${textarea ? ' action-wide-field' : ''}"><label for="${esc(id)}">${esc(label)}</label>${textarea ? `<textarea class="input" id="${esc(id)}" rows="3"${required ? ' required' : ''}>${esc(value ?? '')}</textarea>` : `<input class="input" id="${esc(id)}" type="${type}"${type === 'number' ? ' step="any"' : ''} value="${esc(value ?? '')}"${required ? ' required' : ''}>`}${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  function highlight(value) {
    let end = 0, html = ''; const input = String(value ?? '');
    for (const match of input.matchAll(new RegExp(tokenPattern.source, 'g'))) { html += esc(input.slice(end, match.index)) + `<mark class="action-token action-variable-token">${esc(match[0])}</mark>`; end = match.index + match[0].length; }
    return html + esc(input.slice(end));
  }
  function navigation() {
    main().querySelectorAll('[data-workflow-go]').forEach(button => button.addEventListener('click', () => goto(button.dataset.workflowGo)));
    main().querySelectorAll('[data-workflow-actions-tab]').forEach(button => button.addEventListener('click', () => onActionsTab(button.dataset.workflowActionsTab)));
    bindWorkflowOverview(main());
  }
  async function catalogs() {
    const [templates, workflows] = await Promise.all([api('/api/desk/actions/templates'), api('/api/desk/actions/workflows')]);
    return { templates: templates.templates || [], workflows: workflows.workflows || [] };
  }
  async function open(hash, { quiet = false } = {}) {
    const generation = ++state.generation, user = userKey();
    state.hash = hash; state.draft = null; state.source = null; state.dirty = false; state.saving = false; state.error = '';
    document.title = 'Workflows · AssetDesk'; byId('breadcrumb-current').textContent = 'Workflows';
    if (!quiet) main().innerHTML = '<section class="panel"><div class="table-loading"><span class="spinner"></span>Opening workflows…</div></section>';
    try {
      const data = await catalogs(); if (!active(generation, user)) return;
      Object.assign(state, data);
      const path = new URL(hash.slice(1), 'https://assetdesk.invalid').pathname.replace(/\/$/, '');
      if (path === '/actions/workflows') renderList();
      else if (path === '/actions/workflows/new') { state.draft = { name: '', description: '', variables: [], steps: [] }; renderEditor(); }
      else {
        const route = path.match(/^\/actions\/workflows\/([^/]+)\/(edit|run)$/);
        if (!route) throw new Error('This workflow page was not found.');
        const source = await api('/api/desk/actions/workflows/' + encodeURIComponent(route[1])); if (!active(generation, user)) return;
        state.source = source;
        if (route[2] === 'edit') { if (!source.canEdit) throw new Error('Only the workflow owner or an administrator can edit this workflow.'); state.draft = definition(source); state.draft.active = source.active !== false; renderEditor(); }
        else { state.values = Object.fromEntries((source.variables || []).map(item => [item.key, item.default ?? ''])); renderStart(); }
      }
    } catch (error) {
      if (!active(generation, user)) return;
      main().innerHTML = `<div class="actions-page">${back()}<section class="panel workflow-error-panel"><h1>The workflow could not be loaded.</h1><p>${esc(error.message)}</p><button class="btn" id="workflow-load-retry">Try again</button></section></div>`;
      navigation(); byId('workflow-load-retry').addEventListener('click', () => open(hash));
    }
  }
  function renderList() {
    main().innerHTML = `<div class="actions-page"><header class="page-heading actions-heading"><div><div class="eyebrow">Reusable sequences</div><h1>Workflows</h1><p>Connect action templates and nested workflows into one repeatable process.</p></div><button class="btn primary" data-workflow-go="#actions/workflows/new">${icon('plus')}New workflow</button></header><div class="actions-tabs" role="tablist" aria-label="Action views"><button class="tab" role="tab" aria-selected="false" data-workflow-actions-tab="runs">Runs</button><button class="tab" role="tab" aria-selected="false" data-workflow-actions-tab="templates">Templates</button><button class="tab active" role="tab" aria-selected="true">Workflows</button></div><div class="action-template-grid">${state.workflows.length ? state.workflows.map(item => `<article class="panel action-template-card"><div class="action-template-heading"><span class="action-type-icon">${icon('spark')}</span><span class="role-badge">${item.active === false ? 'Archived' : 'Workflow'}</span></div><h2>${esc(item.name)}</h2><p>${esc(item.description || 'A reusable sequence of action templates and workflows.')}</p><div class="action-card-meta">${item.steps.length} steps · ${item.variables.length} editable variables</div><div class="workflow-card-sequence">${item.steps.map(step => `<span>${esc(step.name || reference(step)?.name || 'Step')}</span>`).join('<span aria-hidden="true">→</span>')}</div><div class="action-card-footer">${item.active !== false ? `<button class="btn primary" data-workflow-go="#actions/workflows/${encodeURIComponent(item.id)}/run" aria-label="Run workflow ${esc(item.name)}">Run workflow</button>` : ''}${item.canEdit ? `<button class="btn" data-workflow-go="#actions/workflows/${encodeURIComponent(item.id)}/edit" aria-label="Edit workflow ${esc(item.name)}">Edit</button>` : ''}</div></article>`).join('') : '<section class="panel workflow-empty"><h2>Build your first workflow.</h2><p>For example: manager approval → account setup → IT handover → welcome email.</p><button class="btn primary" data-workflow-go="#actions/workflows/new">Create workflow</button></section>'}</div></div>`;
    navigation();
  }
  function outlineSteps(steps, seen = new Set(), target = '', depth = 0) {
    return steps.map(step => {
      const source = reference(step), result = { ...step, name: step.name || source?.name || 'Choose a step', overview_target: target || step.id };
      if (step.type === 'workflow' && source && !seen.has(source.id) && depth < 5) result.steps = outlineSteps(source.steps, new Set([...seen, source.id]), target || step.id, depth + 1);
      return result;
    });
  }
  function overview() { return renderWorkflowOverview({ steps: outlineSteps(state.draft?.steps || state.source?.steps || []) }, esc, { draft: true }); }
  function variablesPanel() {
    return `<section class="panel workflow-variables" aria-label="Workflow variables"><header class="panel-header"><div><h2 class="panel-title">Workflow variables</h2><p class="panel-subtitle">Enter changing details once, then map them to each step.</p></div></header><div class="workflow-panel-body">${state.draft.variables.map((item, index) => `<article class="action-variable-row"><header><strong>${esc(item.label || item.key || 'New variable')}</strong><button class="icon-button" type="button" data-workflow-remove-variable="${index}" aria-label="Remove workflow variable ${index + 1}">${icon('close')}</button></header><span class="action-token action-variable-token">{{${esc(item.key)}}}</span><div class="action-variable-grid">${field(`workflow-var-${index}-label`, `Workflow variable ${index + 1} label`, item.label)}${field(`workflow-var-${index}-key`, `Workflow variable ${index + 1} key`, item.key)}<div class="field"><label for="workflow-var-${index}-type">Workflow variable ${index + 1} type</label><select id="workflow-var-${index}-type">${['text', 'email', 'number', 'date'].map(type => `<option${type === item.type ? ' selected' : ''}>${type}</option>`).join('')}</select></div>${field(`workflow-var-${index}-default`, `Workflow variable ${index + 1} default value`, item.default ?? '')}</div>${field(`workflow-var-${index}-description`, `Workflow variable ${index + 1} help text`, item.description || '')}<label class="action-required"><input id="workflow-var-${index}-required" type="checkbox"${item.required ? ' checked' : ''}>Workflow variable ${index + 1} required</label></article>`).join('')}<button class="btn" type="button" id="workflow-add-variable">${icon('plus')}Add workflow variable</button></div></section>`;
  }
  function stepCard(step, index) {
    const source = reference(step), choices = (step.type === 'workflow' ? state.workflows : state.templates).filter(item => item.active !== false && item.id !== state.source?.id);
    const stale = source && source.version !== step.ref_version;
    return `<article class="panel workflow-step-card" id="workflow-step-${esc(step.id)}" data-workflow-step-id="${esc(step.id)}" data-workflow-step-index="${index}" tabindex="-1"><header class="action-step-heading"><span class="workflow-drag-handle" role="button" tabindex="0" draggable="true" data-workflow-drag="${esc(step.id)}" aria-label="Drag step ${index + 1}" title="Drag to reorder">⠿</span><span class="action-step-number">${index + 1}</span><div class="workflow-step-title"><h2>${esc(step.name || source?.name || 'Choose a step')}</h2><p>${step.type === 'workflow' ? 'Nested workflow' : 'Action template'}${source ? ` · Version ${step.ref_version}` : ''}</p></div><div class="action-step-controls"><button class="icon-button" type="button" data-workflow-up="${esc(step.id)}" aria-label="Move workflow step ${index + 1} up"${index === 0 ? ' disabled' : ''}>${icon('left')}</button><button class="icon-button" type="button" data-workflow-down="${esc(step.id)}" aria-label="Move workflow step ${index + 1} down"${index === state.draft.steps.length - 1 ? ' disabled' : ''}>${icon('chevron')}</button><button class="icon-button" type="button" data-workflow-remove="${esc(step.id)}" aria-label="Remove workflow step ${index + 1}">${icon('close')}</button></div></header><div class="action-step-fields"><div class="field"><label for="workflow-step-${index}-type">Step ${index + 1} type</label><select id="workflow-step-${index}-type" data-workflow-type="${esc(step.id)}"><option value="template"${step.type === 'template' ? ' selected' : ''}>Action template</option><option value="workflow"${step.type === 'workflow' ? ' selected' : ''}>Nested workflow</option></select></div><div class="field"><label for="workflow-step-${index}-reference">Step ${index + 1} ${step.type}</label><select id="workflow-step-${index}-reference" data-workflow-reference="${esc(step.id)}"><option value="">Choose ${step.type === 'workflow' ? 'a workflow' : 'a template'}</option>${choices.map(item => `<option value="${esc(item.id)}"${item.id === step.ref_id ? ' selected' : ''}>${esc(item.name)}</option>`).join('')}${step.ref_id && !choices.some(item => item.id === step.ref_id) ? `<option value="${esc(step.ref_id)}" selected>${esc(source?.name || 'Unavailable reference')}</option>` : ''}</select></div>${field(`workflow-step-${index}-title`, `Step ${index + 1} title`, step.name || '', { hint: 'This title appears in the overview.' })}${source?.description ? `<p class="workflow-step-description action-wide-field">${esc(source.description)}</p>` : ''}${stale || (step.ref_id && (!source || source.active === false)) ? `<div class="workflow-reference-warning action-wide-field" role="status">${stale ? 'This reference has a newer version.' : 'This reference is unavailable or archived.'} Refresh references or choose another step before saving and starting.</div>` : ''}</div>${source ? `<div class="workflow-bindings"><h3>Details for this step</h3>${source.variables.length ? source.variables.map(item => `<div class="field workflow-binding-field"><label for="workflow-binding-${index}-${esc(item.key)}">${esc(`Step ${index + 1} ${item.label || item.key}`)}</label><span class="action-token action-variable-token">{{${esc(item.key)}}}</span><div class="workflow-binding-controls"><input class="input" id="workflow-binding-${index}-${esc(item.key)}" list="workflow-variable-options" data-workflow-binding-step="${esc(step.id)}" data-workflow-binding-key="${esc(item.key)}" value="${esc(step.bindings?.[item.key] ?? '')}" placeholder="${esc(item.default ?? '')}"><button class="view-link" type="button" data-workflow-binding-default="${esc(step.id)}" data-workflow-binding-key="${esc(item.key)}">Use default</button></div><small>${esc(Object.hasOwn(step.bindings || {}, item.key) ? 'Use a workflow variable or enter a fixed value.' : `Uses the reference default${item.default ? ': ' + item.default : item.required ? '; a required value must be mapped.' : ' (blank).'}`)}</small><div class="workflow-binding-preview">${highlight(step.bindings?.[item.key] ?? item.default ?? '')}</div></div>`).join('') : '<p class="action-owner-note">This step has no variables to map.</p>'}</div>` : ''}</article>`;
  }
  function renderEditor() {
    const title = state.source ? 'Edit workflow' : 'New workflow'; document.title = `${title} · AssetDesk`; byId('breadcrumb-current').textContent = title;
    main().innerHTML = `<div class="actions-page">${back()}<header class="page-heading actions-heading"><div><div class="eyebrow">Compose a reusable process</div><h1>${title}</h1><p>Select action templates or nested workflows. Drag the handles to choose their execution order.</p></div>${state.source?.active !== false && state.source ? `<button class="btn" data-workflow-go="#actions/workflows/${encodeURIComponent(state.source.id)}/run">Run workflow</button>` : ''}</header><form id="workflow-editor-form"><section class="panel action-definition-panel"><div class="action-step-fields">${field('workflow-title', 'Workflow title', state.draft.name, { required: true })}${field('workflow-description', 'Description', state.draft.description, { textarea: true })}${state.source ? `<label class="action-required action-wide-field"><input id="workflow-active" type="checkbox"${state.draft.active !== false ? ' checked' : ''}>Available for new runs</label>` : ''}</div></section><div class="workflow-builder-layout"><div class="workflow-builder-main"><div class="action-section-heading"><h2>Workflow steps</h2><button class="btn subtle" type="button" id="workflow-refresh-references">${icon('refresh')}Refresh references</button></div><p class="action-implementation-intro">Each step finishes before the next begins. An approval or manual task pauses the entire workflow.</p><datalist id="workflow-variable-options">${state.draft.variables.map(item => `<option value="{{${esc(item.key)}}}">${esc(item.label || item.key)}</option>`).join('')}</datalist><div id="workflow-step-list">${state.draft.steps.map(stepCard).join('')}</div><button class="btn" type="button" id="workflow-add-step">${icon('plus')}Add step</button><p class="workflow-drag-announcement" role="status" aria-live="polite" id="workflow-order-announcement"></p>${variablesPanel()}</div><aside class="workflow-builder-aside" id="workflow-overview-container">${overview()}</aside></div><p class="field-error action-form-error" id="workflow-error" role="alert">${esc(state.error)}</p><footer class="action-sticky-actions"><p>Saving a workflow does not execute its steps.</p><div><button class="btn" type="button" data-workflow-go="#actions/workflows">Cancel</button><button class="btn primary" type="submit">Save workflow</button></div></footer></form></div>`;
    navigation(); bindEditor();
  }
  function updateOutline() { const container = byId('workflow-overview-container'); if (container) { container.innerHTML = overview(); bindWorkflowOverview(container); } }
  function applyReference(step, id) {
    step.ref_id = id; step.bindings = {}; const source = reference(step);
    step.ref_version = source?.version || 1; step.name = source?.name || '';
    for (const item of source?.variables || []) {
      if (!state.draft.variables.some(variable => variable.key === item.key)) state.draft.variables.push(clone(item));
      step.bindings[item.key] = '{{' + item.key + '}}';
    }
  }
  function reorder(id, targetIndex) {
    const from = state.draft.steps.findIndex(step => step.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= state.draft.steps.length || from === targetIndex) return;
    const [step] = state.draft.steps.splice(from, 1); state.draft.steps.splice(targetIndex, 0, step); dirty(); renderEditor();
    byId('workflow-order-announcement').textContent = `Moved ${step.name || 'step'} to position ${targetIndex + 1}.`;
  }
  function bindEditor() {
    byId('workflow-title').addEventListener('input', event => { state.draft.name = event.target.value; dirty(); });
    byId('workflow-description').addEventListener('input', event => { state.draft.description = event.target.value; dirty(); });
    byId('workflow-active')?.addEventListener('change', event => { state.draft.active = event.target.checked; dirty(); });
    byId('workflow-add-step').addEventListener('click', () => { state.draft.steps.push({ id: uid(), type: 'template', ref_id: '', ref_version: 1, name: '', bindings: {} }); dirty(); renderEditor(); });
    main().querySelectorAll('[data-workflow-type]').forEach(select => select.addEventListener('change', () => { const step = state.draft.steps.find(item => item.id === select.dataset.workflowType); step.type = select.value; applyReference(step, ''); dirty(); renderEditor(); }));
    main().querySelectorAll('[data-workflow-reference]').forEach(select => select.addEventListener('change', () => { applyReference(state.draft.steps.find(item => item.id === select.dataset.workflowReference), select.value); dirty(); renderEditor(); }));
    state.draft.steps.forEach((step, index) => byId(`workflow-step-${index}-title`).addEventListener('input', event => { step.name = event.target.value; dirty(); const card = byId('workflow-step-' + step.id); card.querySelector('h2').textContent = step.name || reference(step)?.name || 'Choose a step'; updateOutline(); }));
    main().querySelectorAll('[data-workflow-binding-step]').forEach(input => input.addEventListener('input', () => { const step = state.draft.steps.find(item => item.id === input.dataset.workflowBindingStep); step.bindings[input.dataset.workflowBindingKey] = input.value; dirty(); input.closest('.field').querySelector('.workflow-binding-preview').innerHTML = highlight(input.value); input.closest('.field').querySelector('small').textContent = 'Use a workflow variable or enter a fixed value.'; }));
    main().querySelectorAll('[data-workflow-binding-default]').forEach(button => button.addEventListener('click', () => { const step = state.draft.steps.find(item => item.id === button.dataset.workflowBindingDefault); delete step.bindings[button.dataset.workflowBindingKey]; dirty(); renderEditor(); }));
    main().querySelectorAll('[data-workflow-up]').forEach(button => button.addEventListener('click', () => reorder(button.dataset.workflowUp, state.draft.steps.findIndex(step => step.id === button.dataset.workflowUp) - 1)));
    main().querySelectorAll('[data-workflow-down]').forEach(button => button.addEventListener('click', () => reorder(button.dataset.workflowDown, state.draft.steps.findIndex(step => step.id === button.dataset.workflowDown) + 1)));
    main().querySelectorAll('[data-workflow-remove]').forEach(button => button.addEventListener('click', () => { state.draft.steps = state.draft.steps.filter(step => step.id !== button.dataset.workflowRemove); dirty(); renderEditor(); }));
    main().querySelectorAll('[data-workflow-drag]').forEach(handle => {
      handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } state.dragging = handle.dataset.workflowDrag; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', state.dragging); handle.closest('.workflow-step-card').classList.add('dragging'); });
      handle.addEventListener('dragend', () => { state.dragging = ''; main()?.querySelectorAll('.workflow-step-card').forEach(card => card.classList.remove('dragging', 'drag-over')); });
    });
    main().querySelectorAll('[data-workflow-step-id]').forEach(card => {
      card.addEventListener('dragover', event => { if (!state.dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; card.classList.add('drag-over'); });
      card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) card.classList.remove('drag-over'); });
      card.addEventListener('drop', event => { if (!state.dragging) return; event.preventDefault(); const id = state.dragging; state.dragging = ''; reorder(id, state.draft.steps.findIndex(step => step.id === card.dataset.workflowStepId)); });
    });
    byId('workflow-add-variable').addEventListener('click', () => { let index = state.draft.variables.length + 1; while (state.draft.variables.some(item => item.key === 'variable_' + index)) index++; state.draft.variables.push({ key: 'variable_' + index, label: 'New variable', type: 'text', required: true, default: '', description: '' }); dirty(); renderEditor(); });
    main().querySelectorAll('[data-workflow-remove-variable]').forEach(button => button.addEventListener('click', () => { state.draft.variables.splice(Number(button.dataset.workflowRemoveVariable), 1); dirty(); renderEditor(); }));
    state.draft.variables.forEach((item, index) => {
      for (const name of ['label', 'key', 'type', 'default', 'description', 'required']) byId(`workflow-var-${index}-${name}`).addEventListener(['type', 'required'].includes(name) ? 'change' : 'input', event => {
        const oldKey = item.key; item[name] = name === 'required' ? event.target.checked : event.target.value;
        if (name === 'key' && oldKey !== item.key) for (const step of state.draft.steps) { step.name = renameVariable(step.name, oldKey, item.key); for (const [key, value] of Object.entries(step.bindings)) if (typeof value === 'string') step.bindings[key] = renameVariable(value, oldKey, item.key); }
        dirty(); const row = event.target.closest('.action-variable-row'); row.querySelector('header strong').textContent = item.label || item.key || 'New variable'; row.querySelector('.action-variable-token').textContent = '{{' + item.key + '}}';
        byId('workflow-variable-options').innerHTML = state.draft.variables.map(variable => `<option value="{{${esc(variable.key)}}}">${esc(variable.label || variable.key)}</option>`).join('');
        if (name === 'key') { main().querySelectorAll('[data-workflow-binding-step]').forEach(input => { input.value = state.draft.steps.find(step => step.id === input.dataset.workflowBindingStep).bindings[input.dataset.workflowBindingKey] ?? ''; input.closest('.field').querySelector('.workflow-binding-preview').innerHTML = highlight(input.value); }); state.draft.steps.forEach((step, stepIndex) => { byId(`workflow-step-${stepIndex}-title`).value = step.name; byId('workflow-step-' + step.id).querySelector('h2').textContent = step.name || reference(step)?.name || 'Choose a step'; }); updateOutline(); }
      });
    });
    byId('workflow-refresh-references').addEventListener('click', refreshReferences);
    byId('workflow-editor-form').addEventListener('submit', event => { event.preventDefault(); save(); });
  }
  async function refreshReferences() {
    const generation = state.generation, user = userKey(), draft = state.draft; const button = byId('workflow-refresh-references'); button.disabled = true;
    try {
      const data = await catalogs(); if (!active(generation, user) || draft !== state.draft) return; Object.assign(state, data);
      for (const step of draft.steps) { const source = reference(step); if (!source || source.active === false) continue; step.ref_version = source.version; const keys = new Set(source.variables.map(item => item.key)); step.bindings = Object.fromEntries(Object.entries(step.bindings).filter(([key]) => keys.has(key))); }
      dirty(); renderEditor(); toast('References refreshed. Review the variable mappings before saving.');
    } catch (error) { if (active(generation, user)) { byId('workflow-error').textContent = error.message; button.disabled = false; } }
  }
  function validate() {
    if (!state.draft.name.trim()) throw new Error('Add a title for this workflow.');
    if (!state.draft.steps.length) throw new Error('Add at least one template or nested workflow.');
    if (state.draft.steps.some(step => !step.ref_id)) throw new Error('Choose a template or workflow for every step.');
    const keys = state.draft.variables.map(item => item.key);
    if (keys.some(key => !/^[a-z][a-z0-9_]{0,39}$/.test(key)) || new Set(keys).size !== keys.length) throw new Error('Workflow variable keys must be unique lowercase names with letters, numbers, and underscores.');
    for (const step of state.draft.steps) for (const value of [step.name, ...Object.values(step.bindings)]) for (const token of String(value).matchAll(tokenPattern)) if (!keys.includes(token[1])) throw new Error(`Declare the workflow variable {{${token[1]}}} or change its mapping.`);
  }
  async function save() {
    if (state.saving) return;
    try { validate(); } catch (error) { byId('workflow-error').textContent = error.message; return; }
    const generation = state.generation, user = userKey(), draft = state.draft, source = state.source;
    const controls = [...byId('workflow-editor-form').elements].map(item => [item, item.disabled]); state.saving = true; controls.forEach(([item]) => { item.disabled = true; });
    try {
      const payload = { ...definition(draft), ...(source ? { version: source.version, active: draft.active !== false } : {}) };
      const result = await api('/api/desk/actions/workflows' + (source ? '/' + encodeURIComponent(source.id) : ''), { method: source ? 'PATCH' : 'POST', body: payload });
      if (!active(generation, user) || state.draft !== draft) return;
      state.dirty = false; state.saving = false; toast('Workflow saved.'); goto('#actions/workflows/' + result.id + '/edit');
    } catch (error) { if (active(generation, user) && state.draft === draft) { state.error = error.status === 409 ? `${error.message} Your draft is kept here. Refresh references to review dependencies, or reopen the latest workflow after copying your changes.` : error.message; byId('workflow-error').textContent = state.error; } }
    finally { if (state.draft === draft) { state.saving = false; controls.forEach(([item, disabled]) => { if (item.isConnected) item.disabled = disabled; }); } }
  }
  function previewCards(steps, seen = new Set(), depth = 0) {
    return steps.map((step, index) => { const source = reference(step); return `<article class="panel workflow-step-card workflow-preview-card" id="workflow-step-${esc(step.id)}" tabindex="-1"><header class="action-step-heading"><span class="action-step-number">${index + 1}</span><div><h2>${esc(step.name || source?.name || 'Unavailable step')}</h2><p>${step.type === 'workflow' ? 'Nested workflow' : 'Action template'} · Version ${step.ref_version}</p></div></header><div class="workflow-panel-body">${source?.description ? `<p>${esc(source.description)}</p>` : ''}${Object.keys(step.bindings || {}).length ? `<dl class="workflow-preview-bindings">${Object.entries(step.bindings).map(([key, value]) => `<div><dt>${esc(source?.variables?.find(item => item.key === key)?.label || key)}</dt><dd>${highlight(value)}</dd></div>`).join('')}</dl>` : ''}${step.type === 'workflow' && source && !seen.has(source.id) && depth < 5 ? `<div class="workflow-nested-preview">${source.steps.map(child => `<span>${esc(child.name || reference(child)?.name || 'Step')}</span>`).join('<span aria-hidden="true">→</span>')}</div>` : ''}</div></article>`; }).join('');
  }
  function renderStart() {
    const source = state.source; document.title = source.name + ' · AssetDesk'; byId('breadcrumb-current').textContent = 'Run workflow';
    main().innerHTML = `<div class="actions-page">${back()}<header class="page-heading actions-heading"><div><div class="eyebrow">Run a saved workflow · Version ${source.version}</div><h1>${esc(source.name)}</h1><p>${esc(source.description || 'Review the sequence and enter the changing details for this run.')}</p></div></header><form id="workflow-start-form"><section class="panel action-definition-panel"><div class="action-step-fields">${field('workflow-run-name', 'Run name', source.name, { required: true })}${field('workflow-ticket-key', 'Linked ticket ID (optional)', '')}</div></section><div class="workflow-builder-layout"><div class="workflow-builder-main"><section class="panel action-values-panel" aria-label="Values for this workflow"><header class="panel-header"><div><h2 class="panel-title">Change for this run</h2><p class="panel-subtitle">These values are passed to each template and nested workflow through its mappings.</p></div></header><div class="action-values-grid">${source.variables.length ? source.variables.map((item, index) => `<div class="workflow-run-variable">${field(`workflow-run-value-${index}`, item.label || item.key, state.values[item.key], { type: ['email', 'number', 'date'].includes(item.type) ? item.type : 'text', required: item.required, hint: item.description || '' })}<span class="action-token action-variable-token">{{${esc(item.key)}}}</span></div>`).join('') : '<p>This workflow has no changing details.</p>'}</div></section><h2 class="action-section-heading">Steps run in this order</h2>${previewCards(source.steps)}</div><aside class="workflow-builder-aside">${overview()}</aside></div><p class="field-error action-form-error" id="workflow-error" role="alert"></p><footer class="action-sticky-actions"><p>Starting this workflow can send email and make the configured API or flow calls.</p><div><button class="btn" type="button" data-workflow-go="#actions/workflows">Cancel</button><button class="btn primary" type="submit"${source.active === false ? ' disabled' : ''}>Start workflow</button></div></footer></form></div>`;
    navigation(); source.variables.forEach((item, index) => byId('workflow-run-value-' + index).addEventListener('input', event => { state.values[item.key] = event.target.value; dirty(); }));
    byId('workflow-run-name').addEventListener('input', dirty); byId('workflow-ticket-key').addEventListener('input', dirty);
    byId('workflow-start-form').addEventListener('submit', event => { event.preventDefault(); start(); });
  }
  async function start() {
    if (state.saving) return;
    const generation = state.generation, user = userKey(), source = state.source, form = byId('workflow-start-form');
    const payload = { workflow_version: source.version, values: clone(state.values), name: byId('workflow-run-name').value.trim(), ...(byId('workflow-ticket-key').value.trim() ? { ticket_key: byId('workflow-ticket-key').value.trim() } : {}) };
    const controls = [...form.elements].map(item => [item, item.disabled]); state.saving = true; controls.forEach(([item]) => { item.disabled = true; });
    try {
      const result = await api('/api/desk/actions/workflows/' + encodeURIComponent(source.id) + '/runs', { method: 'POST', body: payload });
      if (!active(generation, user) || state.source !== source) return;
      state.dirty = false; state.saving = false; toast('Workflow started.'); goto('#actions/runs/' + result.id);
    } catch (error) { if (active(generation, user)) byId('workflow-error').textContent = error.status === 409 ? `${error.message} Ask the workflow owner to refresh references and save before starting it again.` : error.message; }
    finally { if (state.source === source) { state.saving = false; controls.forEach(([item, disabled]) => { if (item.isConnected) item.disabled = disabled; }); } }
  }
  return { open, matches, reset, leave: reset, canLeave, isDirty, hasDraft };
}
