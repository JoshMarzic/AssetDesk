const clone = value => JSON.parse(JSON.stringify(value));
const PROVIDERS = { openai: 'OpenAI', anthropic: 'Claude' };
const PROMPTS = { system: ['System prompt', 'Shared instructions for every AI task.'], triage: ['Ticket handling prompt', 'How tickets are classified and mentioned assets are identified.'], reply: ['Auto reply prompt', 'How to decide whether more information is needed and write the requester reply.'], suggestions: ['Suggested fixes prompt', 'How to use matching shared documentation to suggest troubleshooting steps.'], summary: ['Login summary prompt', 'How to summarize ticket activity from the configured lookback period after sign-in.'] };
const STATUS = { disabled: 'Disabled', not_reviewed: 'Not reviewed', queued: 'Queued', running: 'Reviewing', completed: 'Reviewed', failed: 'Review failed', blocked: 'Needs setup', needs_attention: 'Needs attention', stale: 'Needs a new review' };
const REPLY_STATUS = { disabled: 'Automatic replies are off', not_needed: 'No additional information requested', queued: 'Reply queued', sent: 'Reply sent', blocked: 'Reply needs setup', failed: 'Reply failed', needs_attention: 'Delivery needs attention', suppressed: 'Automatic reply suppressed', skipped: 'Automatic reply skipped', pending: 'Reviewing whether more information is needed' };

export function createAiUI({ api, esc, icon, toast, getUser, getCurrentView, getSettingsTab, getTicket, drawer, onTicketChanged, openSettings }) {
  const state = { generation: 0, container: null, saved: null, draft: null, loading: false, saving: false, dirty: false, error: '', testing: '', ticketGeneration: 0, ticketKey: '', ticketSignature: '', ticketTimer: null, reviewing: false };
  const $ = selector => document.querySelector(selector);
  const byId = id => document.getElementById(id);
  const settingActive = (generation, user) => generation === state.generation && user === getUser()?.id && getUser()?.role === 'admin' && getCurrentView() === 'settings' && getSettingsTab() === 'ai' && state.container?.isConnected;
  const ticketActive = (generation, user, key) => generation === state.ticketGeneration && user === getUser()?.id && drawer.open && drawer.dataset.ticketKey === key && getTicket()?.key === key;
  function draftOf(snapshot) { const draft = clone(snapshot); draft.summary_hours ??= 24; draft.login_summary_enabled ??= true; for (const provider of Object.values(draft.providers || {})) { provider.api_key = ''; provider.clear_key = false; } return draft; }
  function stopTicket() { state.ticketGeneration++; clearTimeout(state.ticketTimer); state.ticketTimer = null; state.ticketKey = ''; state.ticketSignature = ''; state.reviewing = false; }
  function leaveSettings() { state.generation++; state.container = null; state.draft = null; state.loading = false; state.dirty = false; state.testing = ''; state.error = ''; }
  function reset() { leaveSettings(); state.saved = null; state.saving = false; stopTicket(); }
  function canLeave() {
    if (state.saving) { toast('Finishing the AI settings save. Please wait a moment.'); return false; }
    if (!state.dirty) return true;
    if (!window.confirm('Discard your unsaved AI settings changes?')) return false;
    state.dirty = false; state.draft = state.saved ? draftOf(state.saved) : null; return true;
  }
  const isDirty = () => state.dirty;
  function dirty() { state.dirty = true; state.error = ''; const error = byId('ai-settings-error'); if (error) error.textContent = ''; updateTests(); }
  function updateTests() {
    for (const id of Object.keys(PROVIDERS)) { const button = byId('ai-test-' + id); if (button) button.disabled = state.dirty || state.saving || Boolean(state.testing) || !state.saved?.providers?.[id]?.key_configured; }
    const hint = byId('ai-test-hint'); if (hint) hint.textContent = state.dirty ? 'Save your changes before testing a connection.' : 'Tests use the saved API key and do not send ticket data.';
  }
  async function loadSettings() {
    const generation = ++state.generation, user = getUser()?.id;
    state.loading = true; state.testing = ''; state.error = ''; renderSettings();
    try {
      const snapshot = await api('/api/desk/settings/ai');
      if (!settingActive(generation, user)) return;
      state.saved = snapshot; state.draft = draftOf(snapshot); state.dirty = false; state.loading = false; renderSettings();
    } catch (error) { if (settingActive(generation, user)) { state.loading = false; state.error = error.message; renderSettings(); } }
  }
  function openSettingsPanel(container) {
    state.container = container;
    if (state.draft) renderSettings();
    else if (!state.loading) loadSettings();
  }
  function refreshSettings() { if (!canLeave()) return; return loadSettings(); }
  function toggle(name, label, description) { return `<label class="ai-setting-toggle" for="ai-${name}"><input type="checkbox" id="ai-${name}" aria-label="${esc(label)}"${state.draft[name] ? ' checked' : ''}><span><strong>${esc(label)}</strong><small>${esc(description)}</small></span></label>`; }
  function providerCard(id) {
    const provider = state.draft.providers[id], name = PROVIDERS[id];
    return `<section class="panel ai-provider-card" aria-label="${name} API connection"><header class="panel-header"><div><h3>${name === 'OpenAI' ? 'OpenAI · ChatGPT API' : 'Claude · Anthropic API'}</h3><p>${provider.key_configured ? '<span class="ai-key-status configured">API key saved</span>' : '<span class="ai-key-status">No API key saved</span>'}</p></div>${icon('lock')}</header><div class="ai-panel-body"><div class="field"><label for="ai-key-${id}">${name} API key</label><input class="input" type="password" id="ai-key-${id}" value="${esc(provider.api_key)}" maxlength="4096" autocomplete="new-password" spellcheck="false"${provider.clear_key ? ' disabled' : ''}><small>Leave blank to keep the saved key. Saved keys are never displayed.</small></div><label class="ai-clear-key"><input type="checkbox" id="ai-clear-${id}"${provider.clear_key ? ' checked' : ''}>Clear saved ${name} key</label><div class="field"><label for="ai-model-${id}">${name} model</label><input class="input" id="ai-model-${id}" value="${esc(provider.model)}" required maxlength="200" spellcheck="false"><small>Use a model available to your API account.</small></div><button class="btn" type="button" id="ai-test-${id}">Test ${name} connection</button><p class="ai-connection-result" role="status" id="ai-test-result-${id}"></p></div></section>`;
  }
  function renderSettings() {
    const root = state.container; if (!root?.isConnected) return;
    root.setAttribute('aria-busy', String(state.loading));
    if (state.loading) { root.innerHTML = '<section class="panel"><div class="table-loading"><span class="spinner"></span>Loading AI settings…</div></section>'; return; }
    if (!state.draft) { root.innerHTML = `<section class="panel ai-load-error"><h2>AI settings could not be loaded.</h2><p>${esc(state.error)}</p><button class="btn" id="ai-settings-retry">Try again</button></section>`; byId('ai-settings-retry').addEventListener('click', loadSettings); return; }
    const draft = state.draft, mail = state.saved?.capabilities?.email?.configured;
    root.innerHTML = `<form id="ai-settings-form" aria-label="AI settings"><section class="panel ai-overview"><header class="panel-header"><div><h2 class="panel-title">AI assistance</h2><p class="panel-subtitle">Review tickets in the background while your team keeps working.</p></div><span class="ai-state-badge ${draft.enabled && draft.providers[draft.provider]?.key_configured ? 'completed' : 'disabled'}">${draft.enabled ? draft.providers[draft.provider]?.key_configured ? 'Enabled' : 'Needs provider setup' : 'Disabled'}</span></header><div class="ai-panel-body">${toggle('enabled', 'Enable AI assistance', 'Review new manual tickets, incoming support email, and enabled login summaries using the selected provider.')}<div class="field ai-provider-choice"><label for="ai-provider">Active AI provider</label><select id="ai-provider"><option value="openai"${draft.provider === 'openai' ? ' selected' : ''}>OpenAI (ChatGPT API)</option><option value="anthropic"${draft.provider === 'anthropic' ? ' selected' : ''}>Claude (Anthropic)</option></select></div><p class="ai-data-notice">When enabled, ticket content and matching shared knowledge are sent to the selected API provider. Automatic assistance uses shared knowledge and inventory categories; restricted information stays out of its context. API keys are stored encrypted on the server.</p></div></section><div class="ai-provider-grid">${Object.keys(PROVIDERS).map(providerCard).join('')}</div><p class="ai-test-hint" id="ai-test-hint"></p><section class="panel ai-features"><header class="panel-header"><div><h2 class="panel-title">Ticket handling</h2><p class="panel-subtitle">Choose how AI helps when a ticket arrives.</p></div></header><div class="ai-panel-body ai-feature-grid">${toggle('auto_tags', 'Auto-tag tickets', 'Add relevant tags while keeping tags entered by your technicians.')}${toggle('auto_location', 'Fill requester location', 'Look up the requester by email in shared personnel records and fill an empty ticket location.')}${toggle('auto_assets', 'Link mentioned assets', 'Connect shared asset records mentioned in the ticket title or description.')}${toggle('suggest_fixes', 'Suggest fixes from documentation', 'Show internal troubleshooting suggestions with links to matching shared knowledge.')}</div></section><section class="panel ai-reply-settings"><header class="panel-header"><div><h2 class="panel-title">AI auto reply</h2><p class="panel-subtitle">Ask for missing details when a new request needs more information.</p></div>${icon('mail')}</header><div class="ai-panel-body">${toggle('auto_reply', 'AI auto reply', 'Send the requester a receipt acknowledgement and useful questions only when additional information is needed.')}<p class="ai-delivery-note${mail ? '' : ' needs-setup'}">${mail ? 'Outbound email is configured.' : 'Outgoing AI replies need SMTP setup in the server environment.'} One automated reply is sent per ticket. Internal fix suggestions stay with your support team.</p></div></section><section class="panel ai-login-summary-settings"><header class="panel-header"><div><h2 class="panel-title">Login ticket summary</h2><p class="panel-subtitle">Catch up on recent ticket activity when you sign in.</p></div>${icon('spark')}</header><div class="ai-panel-body">${toggle('login_summary_enabled', 'Show ticket summary after login', 'Display a dismissible summary after each sign-in. A placeholder appears when AI is disabled or the selected provider has no API key.')}<div class="field ai-summary-hours"><label for="ai-summary-hours">Hours to summarize</label><input class="input" id="ai-summary-hours" type="number" min="1" max="720" step="1" required value="${esc(draft.summary_hours)}"><small>Choose 1 to 720 hours. Includes tickets submitted or updated during that period; paused tickets stay hidden.</small></div><p class="ai-delivery-note">Summaries use Enable AI assistance, the active provider, and the Login summary prompt below. Signing in and opening your workspace do not wait for AI to finish.</p></div></section><section class="panel ai-prompts"><header class="panel-header"><div><h2 class="panel-title">Editable AI prompts</h2><p class="panel-subtitle">All AI instructions are editable here. Ticket and knowledge context is supplied automatically.</p></div>${state.saved.default_prompts ? '<button class="btn" type="button" id="ai-reset-prompts">Reset prompts to defaults</button>' : ''}</header><div class="ai-panel-body">${Object.entries(PROMPTS).map(([key, [label, hint]]) => `<div class="field ai-prompt-field"><label for="ai-prompt-${key}">${label}</label><small>${hint}</small><textarea class="input" id="ai-prompt-${key}" rows="6" maxlength="12000" required spellcheck="false">${esc(draft.prompts[key])}</textarea></div>`).join('')}</div></section><p class="field-error ai-settings-error" role="alert" id="ai-settings-error">${esc(state.error)}</p><footer class="action-sticky-actions ai-settings-footer"><p>Changes apply to future reviews. Existing technician work is retained.</p><div><button class="btn" type="button" id="ai-discard-changes">Discard changes</button><button class="btn primary" type="submit">Save AI settings</button></div></footer></form>`;
    for (const name of ['enabled', 'auto_tags', 'auto_location', 'auto_assets', 'suggest_fixes', 'auto_reply', 'login_summary_enabled']) byId('ai-' + name).addEventListener('change', event => { draft[name] = event.target.checked; dirty(); });
    byId('ai-summary-hours').addEventListener('input', event => { draft.summary_hours = Number(event.target.value); dirty(); });
    byId('ai-provider').addEventListener('change', event => { draft.provider = event.target.value; dirty(); });
    for (const id of Object.keys(PROVIDERS)) {
      for (const [field, prefix] of [['api_key', 'ai-key-'], ['model', 'ai-model-']]) byId(prefix + id).addEventListener('input', event => { draft.providers[id][field] = event.target.value; dirty(); });
      byId('ai-clear-' + id).addEventListener('change', event => { draft.providers[id].clear_key = event.target.checked; const input = byId('ai-key-' + id); if (event.target.checked) { input.value = ''; draft.providers[id].api_key = ''; } input.disabled = event.target.checked; dirty(); });
      byId('ai-test-' + id).addEventListener('click', () => testConnection(id));
    }
    for (const key of Object.keys(PROMPTS)) byId('ai-prompt-' + key).addEventListener('input', event => { draft.prompts[key] = event.target.value; dirty(); });
    byId('ai-reset-prompts')?.addEventListener('click', () => { draft.prompts = clone(state.saved.default_prompts); dirty(); renderSettings(); });
    byId('ai-discard-changes').addEventListener('click', () => { state.draft = draftOf(state.saved); state.dirty = false; state.error = ''; renderSettings(); });
    byId('ai-settings-form').addEventListener('submit', event => { event.preventDefault(); saveSettings(); }); updateTests();
  }
  async function saveSettings() {
    if (state.saving) return;
    const draft = state.draft, generation = state.generation, user = getUser()?.id, form = byId('ai-settings-form');
    const payload = { version: state.saved.version, provider: draft.provider, prompts: clone(draft.prompts), providers: {}, summary_hours: draft.summary_hours };
    for (const key of ['enabled', 'auto_tags', 'auto_location', 'auto_assets', 'suggest_fixes', 'auto_reply', 'login_summary_enabled']) payload[key] = draft[key];
    for (const id of Object.keys(PROVIDERS)) payload.providers[id] = { model: draft.providers[id].model, ...(draft.providers[id].api_key ? { api_key: draft.providers[id].api_key } : {}), ...(draft.providers[id].clear_key ? { clear_key: true } : {}) };
    const controls = [...form.elements].map(field => [field, field.disabled]); state.saving = true; controls.forEach(([field]) => { field.disabled = true; });
    try {
      const snapshot = await api('/api/desk/settings/ai', { method: 'PATCH', body: payload });
      if (!settingActive(generation, user) || state.draft !== draft) return;
      state.saved = snapshot; state.draft = draftOf(snapshot); state.dirty = false; state.error = ''; state.saving = false; renderSettings(); toast('AI settings saved.');
    } catch (error) {
      if (!settingActive(generation, user) || state.draft !== draft) return;
      state.error = error.status === 409 ? 'AI settings changed in another session. Your draft is kept here. Copy your changes, then refresh to review the latest settings.' : error.message;
      byId('ai-settings-error').textContent = state.error;
    } finally { if (state.draft === draft) { state.saving = false; controls.forEach(([field, disabled]) => { if (field.isConnected) field.disabled = disabled; }); updateTests(); } }
  }
  async function testConnection(provider) {
    if (state.dirty || state.testing || state.saving) return;
    const generation = state.generation, user = getUser()?.id, result = byId('ai-test-result-' + provider); state.testing = provider; updateTests(); result.textContent = 'Testing saved connection…';
    try { await api('/api/desk/settings/ai/test', { method: 'POST', body: { provider } }); if (settingActive(generation, user)) result.textContent = PROVIDERS[provider] + ' connection verified.'; }
    catch (error) { if (settingActive(generation, user)) result.textContent = error.message; }
    finally { if (generation === state.generation) { state.testing = ''; updateTests(); } }
  }
  function panelContent(ai = {}) {
    const status = ai.status || 'disabled', suggestions = ai.suggestions || {}, reply = ai.reply || {};
    const articles = (suggestions.articles || []).filter(article => /^[A-Za-z0-9_-]+$/.test(String(article.id || '')));
    return `<header class="ai-ticket-heading"><div><span class="ai-ticket-icon">${icon('spark')}</span><h2>AI assistance</h2></div><span class="ai-state-badge ${['completed', 'failed', 'blocked', 'needs_attention', 'running', 'queued'].includes(status) ? status : 'disabled'}" role="status">${esc(STATUS[status] || status)}</span></header>${ai.error ? `<p class="ai-inline-error" role="status">${esc(ai.error)}</p>` : ''}${!ai.enabled ? '<p class="ai-panel-description">AI assistance is disabled. An administrator can configure it in Settings → AI.</p>' : ['queued', 'running'].includes(status) ? '<p class="ai-panel-description">Reviewing this ticket in the background. You can keep working while suggestions are prepared.</p>' : ''}${suggestions.summary || suggestions.steps?.length ? `<div class="ai-fix-suggestions"><h3>Suggested fixes</h3>${suggestions.summary ? `<p>${esc(suggestions.summary)}</p>` : ''}${suggestions.steps?.length ? `<ol>${suggestions.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}${articles.length ? `<div class="ai-citations"><h4>Documentation used</h4>${articles.map(article => `<a href="#knowledge/article/${encodeURIComponent(article.id)}">${icon('book')}${esc(article.name || 'Knowledge article')}${icon('chevron')}</a>`).join('')}</div>` : ''}<p class="ai-suggestion-note">Review these suggestions before applying a fix.</p></div>` : ai.enabled && !['queued', 'running'].includes(status) ? '<p class="ai-panel-description">No documentation-based fix suggestions are available yet.</p>' : ''}${ai.tags_added?.length || ai.location_set || ai.assets_linked?.length ? `<div class="ai-processing-summary">${ai.tags_added?.length ? `<p><strong>Tags added:</strong> ${ai.tags_added.map(tag => esc(tag)).join(', ')}</p>` : ''}${ai.location_set ? `<p><strong>Location filled:</strong> ${esc(ai.location_set)}</p>` : ''}${ai.assets_linked?.length ? `<p><strong>Assets linked:</strong> ${ai.assets_linked.map(asset => `<a href="#assets/${encodeURIComponent(asset.id)}">${esc(asset.ref || asset.name)}</a>`).join(', ')}</p>` : ''}</div>` : ''}${reply.status && reply.status !== 'disabled' ? `<div class="ai-reply-state"><strong>${esc(REPLY_STATUS[reply.status] || reply.status)}</strong>${reply.sent_at ? `<time>${esc(new Date(reply.sent_at).toLocaleString())}</time>` : ''}${reply.error ? `<p>${esc(reply.error)}</p>` : ''}${reply.body ? `<details id="ai-reply-preview"><summary>${reply.status === 'sent' ? 'View automatic reply' : 'View reply details'}</summary><p class="ai-reply-body">${esc(reply.body)}</p></details>` : reply.questions?.length ? `<ul>${reply.questions.map(question => `<li>${esc(question)}</li>`).join('')}</ul>` : ''}</div>` : ''}<footer class="ai-ticket-footer"><button class="btn" type="button" id="ai-review-ticket"${!ai.can_review || state.reviewing || ['queued', 'running'].includes(status) ? ' disabled' : ''}>${icon('refresh')}Review ticket</button>${!ai.enabled && getUser()?.role === 'admin' ? '<button class="view-link" type="button" id="ai-open-settings">AI settings</button>' : ''}</footer>`;
  }
  function ticketPanel(ticket) { return `<section class="ai-ticket-panel" id="ticket-ai-panel" aria-label="AI assistance">${panelContent(ticket.ai)}</section>`; }
  function bindTicketPanel() {
    byId('ai-review-ticket')?.addEventListener('click', reviewTicket);
    byId('ai-open-settings')?.addEventListener('click', openSettings);
  }
  function watchTicket(ticket) {
    stopTicket(); state.ticketKey = ticket.key; state.ticketSignature = JSON.stringify(ticket.ai || {}); bindTicketPanel();
    if (ticket.ai?.enabled) scheduleTicket(1500);
  }
  function scheduleTicket(delay) { clearTimeout(state.ticketTimer); state.ticketTimer = setTimeout(pollTicket, delay); }
  async function pollTicket() {
    const generation = state.ticketGeneration, user = getUser()?.id, key = state.ticketKey;
    if (!ticketActive(generation, user, key)) return;
    try {
      const response = await api('/api/desk/tickets/' + encodeURIComponent(key) + '/ai');
      if (!ticketActive(generation, user, key)) return;
      const ai = response.ai || response, signature = JSON.stringify(ai);
      if (signature !== state.ticketSignature) {
        const open = byId('ai-reply-preview')?.open; state.ticketSignature = signature; getTicket().ai = ai;
        const panel = byId('ticket-ai-panel'); if (panel) { panel.innerHTML = panelContent(ai); bindTicketPanel(); if (open && byId('ai-reply-preview')) byId('ai-reply-preview').open = true; }
        if (ai.location_set || ai.tags_added?.length || ai.assets_linked?.length) await onTicketChanged?.();
      }
      if (ticketActive(generation, user, key) && ai.enabled) scheduleTicket(['queued', 'running'].includes(ai.status) ? 1500 : 7000);
    } catch (error) { if (ticketActive(generation, user, key)) { const panel = byId('ticket-ai-panel'); if (panel) { panel.innerHTML = `<p class="ai-inline-error">${esc(error.message)}</p><button class="btn" id="ai-panel-retry">Refresh AI assistance</button>`; byId('ai-panel-retry').addEventListener('click', pollTicket); } } }
  }
  async function reviewTicket() {
    const generation = state.ticketGeneration, user = getUser()?.id, key = state.ticketKey; if (state.reviewing || !ticketActive(generation, user, key)) return;
    state.reviewing = true; const button = byId('ai-review-ticket'); if (button) button.disabled = true;
    try { await api('/api/desk/tickets/' + encodeURIComponent(key) + '/ai/review', { method: 'POST', body: {} }); if (ticketActive(generation, user, key)) { state.reviewing = false; await pollTicket(); } }
    catch (error) { if (ticketActive(generation, user, key)) { toast(error.message, true); state.reviewing = false; if (button?.isConnected) button.disabled = false; } }
  }
  return { openSettings: openSettingsPanel, refreshSettings, leaveSettings, canLeave, isDirty, reset, ticketPanel, watchTicket, stopTicket };
}
