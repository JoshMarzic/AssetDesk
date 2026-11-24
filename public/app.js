import { createActionsUI } from './actions.js';
import { createAiUI } from './ai.js';
import { createLoginSummaryUI } from './login-summary.js';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const drawer = $('#ticket-drawer');
const modal = $('#modal');
const statusLabels = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', paused: 'Paused', resolved: 'Resolved', closed: 'Closed' };
const priorityLabels = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const assetTypeLabels = { personnel: 'Personnel', pc: 'PC', laptop: 'Laptop', server: 'Server', printer: 'Printer', network: 'Network equipment', peripheral: 'Peripheral', hardware: 'Hardware', other: 'Other' };
const assetGroupLabels = { personnel: 'Personnel', pc: 'PCs', laptop: 'Laptops', server: 'Servers', printer: 'Printers', network: 'Network equipment', peripheral: 'Peripherals', hardware: 'General hardware', other: 'Other' };
const hardwareAssetTypes = Object.keys(assetTypeLabels).filter(type => !['personnel', 'other'].includes(type));
const assetStatusLabels = { active: 'Active', spare: 'Spare', repair: 'In repair', retired: 'Retired', unverified: 'Unverified' };
const categoryLabels = { general: 'General', hardware: 'Hardware', software: 'Software', network: 'Network', access: 'Access' };
const icons = {
  ticket: '<path d="M4 4h16v5a3 3 0 0 0 0 6v5H4v-5a3 3 0 0 0 0-6z"/><path d="M14 5v2m0 4v2m0 4v2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  inbox: '<path d="M4 4h16l2 12v4H2v-4z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  laptop: '<rect x="4" y="3" width="16" height="13" rx="2"/><path d="m4 16-2 4h20l-2-4M9 20h6"/>',
  book: '<path d="M3 4h6a4 4 0 0 1 3 1 4 4 0 0 1 3-1h6v16h-6a4 4 0 0 0-3 1 4 4 0 0 0-3-1H3z"/><path d="M12 5v16"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="m12 3 10 18H2z"/><path d="M12 9v4m0 4h.01"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5M21 12H9"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8m-8 4h6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z"/><path d="m8 12 3 3 5-6"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="2"/>',
  reports: '<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 17v-3m4 3v-6m4 6v-4"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.ticket}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = value => String(value || '').replaceAll('_', ' ').replace(/^./, s => s.toUpperCase());
const safeUrl = value => { try { const u = new URL(value, location.origin); return ['http:', 'https:'].includes(u.protocol) ? u.href : '#'; } catch { return '#'; } };
const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(v => v[0]).join('').toUpperCase();
const tone = name => [...String(name || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % 5;
const avatar = (name, extra = '') => `<span class="avatar tone-${tone(name)} ${extra}" aria-hidden="true">${esc(initials(name))}</span>`;
const shortDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not set';
function ago(value) {
  if (!value) return 'Just now';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(diff)) return '';
  const minutes = Math.floor(diff / 60000);
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
function due(ticket, detailed = false) {
  if (ticketStatusKind(ticket) === 'paused') return `<span class="due paused" title="${esc(`Resumes ${shortDate(ticket.paused_until)}`)}">${icon('clock')} ${esc(shortDate(ticket.paused_until))}</span>`;
  if (ticketStatusKind(ticket) !== 'active') return `<span class="due good">${icon('check')} ${esc(statusLabels[ticket.status] || ticket.status_name || cap(ticket.status))}</span>`;
  const value = !ticket.first_response_at ? ticket.response_due_at : ticket.resolution_due_at;
  if (!value) return '<span class="due">—</span>';
  const diff = new Date(value).getTime() - Date.now();
  const hours = Math.abs(diff) / 3600000;
  const duration = hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m` : hours < 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  return `<span class="due ${diff < 0 ? 'overdue' : ''}" title="${esc(shortDate(value))}">${diff < 0 ? `${duration} overdue` : `${detailed ? 'Due in ' : ''}${duration}${detailed ? '' : ' left'}`}</span>`;
}
function pill(status) { const tone = ['open', 'in_progress', 'waiting', 'paused', 'resolved', 'closed'].includes(status) ? status : statusKind(status) === 'active' ? 'in_progress' : statusKind(status); return `<span class="pill ${tone}">${esc(statusLabels[status] || cap(status))}</span>`; }
function newReportState() { return { draft: { date_field: 'created_at', sort: 'newest', limit: '25' }, applied: { date_field: 'created_at', sort: 'newest', limit: '25' }, tickets: [], total: 0, offset: 0, limit: 25, technicians: [], initialized: false, loading: false, exporting: false, error: '', generation: 0, advanced: false }; }
const state = { session: null, current: 'overview', tickets: [], total: 0, technicians: [], dashboard: null, assets: [], responses: [], view: 'all', search: '', status: '', priority: '', category: '', assignee: '', sort: 'newest', offset: 0, filtersOpen: false, ticket: null, ticketTag: null, loading: false, generation: 0, busy: false, knowledge: null, knowledgeSearch: '', knowledgeCategory: '', knowledgeOffset: 0, article: null, articleEditing: false, articleDirty: false, articleSaving: false, knowledgeGeneration: 0, asset: null, assetTarget: null, assetSearch: '', assetTypes: [], assetTypeCounts: {}, assetLocations: [], assetLocationCounts: [], assetLocationsOpen: false, assetLocationMenuSearch: '', assetHardwareOpen: false, assetSearchDraft: '', assetCategory: '', assetOffset: 0, assetTotal: 0, assetGeneration: 0, categories: [], workflow: null, settingsTab: 'priorities', settingsGeneration: 0, settingsLoading: false, settingsError: '', reports: newReportState() };

let ticketPauseTimer = null, ticketPauseGeneration = 0;

const actionsUI = createActionsUI({ api, esc, icon, toast, getUser: () => state.session?.user, getCurrentView: () => state.current, activate: activateActions, openTicket });
const aiUI = createAiUI({ api, esc, icon, toast, getUser: () => state.session?.user, getCurrentView: () => state.current, getSettingsTab: () => state.settingsTab, getTicket: () => state.ticket, drawer, onTicketChanged: () => state.busy ? null : reloadTicket({ preserveEdits: true, quiet: true }), openSettings: () => { state.settingsTab = 'ai'; navigate('settings'); } });
const loginSummaryUI = createLoginSummaryUI({ api, esc, icon, getUser: () => state.session?.user, openTicket, openSettings: () => { state.settingsTab = 'ai'; navigate('settings'); } });
drawer.addEventListener('close', () => { aiUI.stopTicket(); stopTicketPauseWatch(); });
function activateActions() {
  state.article = null; state.articleTarget = null; state.articleEditing = false; state.articleDirty = false; state.asset = null; state.assetTarget = null;
  activateView('actions');
}

function applyWorkflow(workflow) {
  if (state.workflow && workflow.version < state.workflow.version) return;
  state.workflow = workflow;
  for (const [type, labels] of [['statuses', statusLabels], ['priorities', priorityLabels], ['categories', categoryLabels]]) {
    for (const key of Object.keys(labels)) delete labels[key];
    for (const item of workflow[type] || []) labels[item.id] = item.name;
  }
}
async function loadWorkflow() {
  const userId = state.session?.user.id;
  const workflow = await api('/api/desk/workflow');
  if (!state.session || state.session.user.id !== userId) throw new Error('Sign in to continue.');
  applyWorkflow(workflow);
  return workflow;
}
function statusKind(id) { return state.workflow?.statuses.find(item => item.id === id)?.kind || (['paused', 'resolved', 'closed'].includes(id) ? id : 'active'); }
function ticketStatusKind(ticket) { return ticket.status_kind || statusKind(ticket.status); }
function isResolving(ticket, nextStatus) { return statusKind(nextStatus) === 'resolved' && ticketStatusKind(ticket) !== 'resolved'; }
function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return local.endsWith(':00') ? local.slice(0, 16) : local;
}
function pauseDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not set';
}
function renderPauseField(id, value, creating = false) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your device’s time zone';
  return `<div class="field ticket-pause-field"><label for="${id}">Start or delay until</label><input class="input" id="${id}" name="paused_until" type="datetime-local" step="1" value="${esc(localDateTime(value))}" aria-describedby="${id}-help"><small id="${id}-help">${creating ? 'Optional. ' : ''}Choose a future date to pause this ticket until then. Times use ${esc(zone)}.</small></div>`;
}
function serializePauseInput(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTime(date).slice(0, Math.min(value.length, 19)) !== value.slice(0, 19)) throw new Error('Choose a valid date and time in your local time zone.');
  if (date.getTime() <= Date.now()) throw new Error('Choose a future date and time to pause this ticket.');
  return date.toISOString();
}
function ticketPropertyEdits(ticket, form) {
  return Object.fromEntries([...new FormData(form)].filter(([name, value]) => value !== (name === 'resolution' ? '' : name === 'paused_until' ? localDateTime(ticket.paused_until) : String(ticket[name] ?? ''))));
}
function updateTicketPropertyRequirements(ticket) {
  const status = $('#ticket-status'), pause = $('#ticket-paused-until');
  if (!status || !pause) return;
  pause.required = status.value === 'paused';
  const resolving = isResolving(ticket, status.value);
  $('#resolution-field').hidden = !resolving;
  $('#ticket-resolution').required = resolving;
}
function restoreTicketPropertyEdits(edits) {
  if (!edits) return;
  const form = $('#ticket-update');
  if (!form) return;
  for (const [name, value] of Object.entries(edits)) {
    const field = form.elements.namedItem(name);
    if (field && (field.tagName !== 'SELECT' || [...field.options].some(option => option.value === value))) field.value = value;
  }
  // A new unsaved schedule remains a pause even if the prior schedule just resumed.
  if (edits.paused_until) form.elements.status.value = 'paused';
  updateTicketPropertyRequirements(state.ticket);
}
function stopTicketPauseWatch() {
  clearTimeout(ticketPauseTimer); ticketPauseTimer = null; ticketPauseGeneration++;
}
function watchTicketPause(ticket) {
  stopTicketPauseWatch();
  if (ticketStatusKind(ticket) !== 'paused' || !ticket.paused_until || !Number.isFinite(Date.parse(ticket.paused_until))) return;
  const generation = ticketPauseGeneration, key = ticket.key, userId = state.session?.user.id;
  const current = () => generation === ticketPauseGeneration && state.session?.user.id === userId && drawer.open && drawer.dataset.ticketKey === key && state.ticket?.key === key;
  const tick = async () => {
    if (!current()) return;
    const remaining = Date.parse(state.ticket.paused_until) - Date.now();
    if (remaining > 0 || state.busy) { ticketPauseTimer = setTimeout(tick, state.busy ? 250 : Math.min(60000, Math.max(100, remaining + 100))); return; }
    try {
      await reloadTicket({ preserveEdits: true, quiet: true });
      if (state.session?.user.id === userId && state.ticket?.key === key && drawer.open && ticketStatusKind(state.ticket) !== 'paused') { await refresh({ quiet: true }); return; }
    } catch { /* Retry a delayed server or connection without losing the ticket draft. */ }
    if (current()) ticketPauseTimer = setTimeout(tick, 1000);
  };
  ticketPauseTimer = setTimeout(tick, Math.min(60000, Math.max(100, Date.parse(ticket.paused_until) - Date.now() + 100)));
}
function priorityTone(id) {
  const rank = state.workflow?.priorities.find(item => item.id === id)?.rank ?? ({ low: 1, normal: 2, high: 3, urgent: 4 }[id] || 2);
  return rank >= 4 ? 'urgent' : rank >= 3 ? 'high' : rank <= 1 ? 'low' : 'normal';
}
function workflowChoices(type, selected) {
  const items = state.workflow?.[type] || [];
  const choices = Object.fromEntries(items.filter(item => item.active || item.id === selected).map(item => [item.id, item.name + (item.current_only ? ' (current)' : item.active ? '' : ' (archived)')]));
  return selected && !Object.hasOwn(choices, selected) ? { ...choices, [selected]: selected } : choices;
}
function rememberTicketChoices(ticket) {
  for (const [type, field] of [['statuses', 'status'], ['priorities', 'priority'], ['categories', 'category']]) {
    if (!ticket[field] || state.workflow[type].some(item => item.id === ticket[field])) continue;
    const record = { id: ticket[field], name: ticket[`${field}_name`] || ticket[field], active: false, system: false, current_only: true };
    if (field === 'status') record.kind = ticket.status_kind || 'active';
    if (field === 'priority') record.rank = ticket.priority_rank || 0;
    state.workflow[type].push(record);
    ({ statuses: statusLabels, priorities: priorityLabels, categories: categoryLabels })[type][record.id] = record.name;
  }
}
function ticketStatusChoices(ticket) {
  const currentKind = ticketStatusKind(ticket);
  const choices = Object.fromEntries((state.workflow?.statuses || []).filter(item => {
    if (item.id === ticket.status) return true;
    if (!item.active) return false;
    return ['active', 'paused'].includes(currentKind) ? item.kind !== 'closed' : currentKind === 'closed' ? item.kind !== 'resolved' : true;
  }).map(item => [item.id, item.name + (item.current_only ? ' (current)' : item.active ? '' : ' (archived)')]));
  return Object.hasOwn(choices, ticket.status) ? choices : { ...choices, [ticket.status]: ticket.status_name || ticket.status };
}

async function api(path, { method = 'GET', body } = {}) {
  const requestSession = state.session;
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && state.session?.csrfToken ? { 'X-CSRF-Token': state.session.csrfToken } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/desk/login' && state.session === requestSession) { state.session = null; state.ticketTag = null; state.reports = newReportState(); actionsUI.reset(); closeDialogs(); renderLogin(); }
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.setAttribute('role', error ? 'alert' : 'status');
  element.innerHTML = `${icon(error ? 'alert' : 'circleCheck')}<span>${esc(message)}</span>`;
  $('#toasts').append(element);
  setTimeout(() => element.remove(), error ? 9000 : 5500);
}
function closeDialogs() { aiUI.stopTicket(); stopTicketPauseWatch(); loginSummaryUI.close(); if (drawer.open) drawer.close(); if (modal.open) modal.close(); }
function loadingPanel() { return `<div class="panel"><div class="table-loading"><span class="spinner"></span>Loading your workspace…</div></div>`; }
function emptyState(title, description, { symbol = 'inbox', action = '' } = {}) { return `<div class="empty-state"><span class="empty-icon">${icon(symbol)}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`; }

function renderLogin(error = '') {
  aiUI.reset();
  loginSummaryUI.reset();
  resetAssetInventory();
  app.innerHTML = `<main class="login-page"><section class="login-story"><div class="brand"><span class="brand-mark">${icon('ticket')}</span>AssetDesk</div><div class="login-pitch"><div class="eyebrow">A little clarity goes a long way</div><h1>Great support.<br><span>All in one place.</span></h1><p>A calmer home for your IT tickets, your team, and the equipment that keeps everyone moving.</p><div class="login-features"><div class="login-feature">${icon('inbox')}A clear queue. Nothing slips through.</div><div class="login-feature">${icon('users')}The right technician for every ticket.</div><div class="login-feature">${icon('laptop')}Every asset, with its full support story.</div></div></div><div class="login-story-foot">Thoughtful tools for the people behind the help desk.</div></section><section class="login-form-wrap"><div class="login-form-card"><div class="login-mini-logo">${icon('ticket')}</div><h2>Welcome back.</h2><p class="login-intro">Sign in to your support workspace.<br>Let’s make someone’s day a little easier.</p><form id="login-form" class="login-form"><div class="field"><label for="login-email">Email address</label><input class="input" id="login-email" name="email" type="email" autocomplete="username" required placeholder="you@company.com"></div><div class="field"><label for="login-password">Password</label><input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your password"></div><div class="field-error" role="alert">${esc(error)}</div><button class="btn primary full" type="submit">Sign in ${icon('arrow')}</button></form><div class="login-security">${icon('lock')}Your workspace. Your team’s eyes only.</div><p class="login-help">Need access? Ask your workspace administrator to create a technician account. Your administrator manages access to this workspace and its knowledge categories.</p></div></section></main>`;
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget; const button = $('button[type=submit]', form); const values = new FormData(form);
    button.disabled = true; button.textContent = 'Signing in…';
    try { state.session = await api('/api/desk/login', { method: 'POST', body: { email: values.get('email'), password: values.get('password') } }); await loadWorkflow(); const initial = location.hash.slice(1); if (['overview', 'tickets', 'my-tickets', 'assets', 'team', 'knowledge', 'actions', 'reports', 'settings'].includes(initial)) state.current = initial; renderShell(); await restoreLocation(); void loginSummaryUI.show(); }
    catch (error) { $('.field-error', form).textContent = error.message; button.disabled = false; button.innerHTML = `Sign in ${icon('arrow')}`; }
  });
}
function navItem(view, label, symbol, count) { return `<button class="nav-item${state.current === view ? ' active' : ''}" data-nav="${view}" ${state.current === view ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${count !== undefined ? `<span class="nav-count">${count}</span>` : ''}</button>`; }
function renderShell() {
  const user = state.session.user;
  app.innerHTML = `<div class="shell"><button class="sidebar-mobile-overlay" aria-label="Close navigation" data-action="menu"></button><aside class="sidebar" aria-label="Main navigation"><a href="#overview" class="brand" data-nav="overview"><span class="brand-mark">${icon('ticket')}</span>AssetDesk</a><div class="workspace-switch"><span class="workspace-icon">IT</span><div class="workspace-label">IT workspace<small>Support, together.</small></div></div><div class="sidebar-group-label">Workspace</div><nav class="nav-group">${navItem('overview', 'Overview', 'grid')}${navItem('tickets', 'All tickets', 'ticket', state.dashboard?.stats?.open ?? 0)}${navItem('my-tickets', 'My tickets', 'inbox')}${navItem('assets', 'Assets', 'laptop')}${navItem('actions', 'Actions', 'spark')}${navItem('reports', 'Reports', 'reports')}</nav><div class="sidebar-group-label">Organization</div><nav class="nav-group">${navItem('team', 'Team', 'users')}${navItem('knowledge', 'Knowledge base', 'book')}${user.role === 'admin' ? navItem('settings', 'Settings', 'settings') : ''}</nav><div class="sidebar-bottom"><div class="sidebar-note">${icon('spark')}<strong>Context makes better support.</strong><p>Asset ownership and documentation, connected to every ticket.</p><button class="sidebar-knowledge-link" data-nav="knowledge">Explore knowledge base ${icon('arrow')}</button></div><div class="profile">${avatar(user.name)}<div><div class="profile-name">${esc(user.name)}</div><div class="profile-role">${esc(user.role === 'admin' ? 'Workspace admin' : 'Technician')}</div></div><button class="icon-button" data-action="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button></div></div></aside><header class="topbar"><button class="icon-button mobile-menu" data-action="menu" aria-label="Open navigation">${icon('menu')}</button><div class="breadcrumbs"><span class="workspace-breadcrumb muted">Workspace</span><span class="crumb-separator">${icon('chevron')}</span><span id="breadcrumb-current">Overview</span></div><form class="global-search" id="search-form" role="search">${icon('search')}<label class="sr-only" for="global-search">Search tickets</label><input id="global-search" type="search" placeholder="Search tickets, people, IDs…" value="${esc(state.search)}" autocomplete="off"><kbd>/</kbd></form><div class="topbar-divider"></div>${avatar(user.name)}</header><main class="main" id="main-content">${loadingPanel()}</main></div>`;
  $('#search-form').addEventListener('submit', event => { event.preventDefault(); runSearch(); });
  let searchTimer;
  $('#global-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
}
function runSearch() {
  const input = $('#global-search');
  if (!input) return;
  state.search = input.value.trim(); state.offset = 0;
  if (!['overview', 'tickets', 'my-tickets'].includes(state.current)) navigate('tickets', false);
  else refresh();
}
function navigate(view, clearSearch = true) {
  if (!['overview', 'tickets', 'my-tickets', 'assets', 'team', 'knowledge', 'actions', 'reports', 'settings'].includes(view)) return;
  if (!mayLeaveArticle() || !aiUI.canLeave()) return;
  if (state.current === 'settings' && view !== 'settings') aiUI.leaveSettings();
  if (state.current === 'actions' && !actionsUI.canLeave()) return;
  if (state.current === 'actions') actionsUI.leave();
  state.article = null; state.articleTarget = null; state.articleEditing = false; state.articleDirty = false; state.asset = null; state.assetTarget = null;
  closeDialogs();
  state.generation++;
  state.current = view; state.view = 'all'; state.offset = 0; state.status = ''; state.priority = ''; state.category = ''; state.assignee = ''; state.filtersOpen = false;
  if (clearSearch) { state.search = ''; const input = $('#global-search'); if (input) input.value = ''; }
  location.hash = view;
  $('.shell')?.classList.remove('menu-open');
  document.querySelectorAll('[data-nav]').forEach(button => { const active = button.dataset.nav === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  refresh();
}
function currentTitle() { return ({ overview: 'Overview', tickets: 'All tickets', 'my-tickets': 'My tickets', assets: 'Assets', team: 'Team', knowledge: 'Knowledge base', actions: 'Actions', reports: 'Reports', settings: 'Settings' })[state.current]; }
async function refresh({ quiet = false } = {}) {
  if (!state.session) return;
  if (state.current === 'knowledge') { if (!state.article && !state.articleEditing) await loadKnowledge(); return; }
  if (state.current === 'assets') { if (state.asset) await openAsset(state.asset.id, { quiet: true }); else await loadAssets(); return; }
  if (state.current === 'actions') { if (quiet) actionsUI.refresh({ quiet: true }); else await actionsUI.open(location.hash.startsWith('#actions') ? location.hash : '#actions'); return; }
  if (state.current === 'settings') { if (!quiet) await loadSettings(); return; }
  if (state.current === 'reports') { if (!quiet) { renderReports(); await loadReports(); } return; }
  const generation = ++state.generation;
  if (!quiet && !state.dashboard) $('#main-content').innerHTML = loadingPanel();
  const params = new URLSearchParams({ view: state.view, sort: state.sort, limit: '20', offset: String(state.offset) });
  for (const [name, value] of Object.entries({ search: state.search, status: state.status, priority: state.priority, category: state.category, assignee: state.current === 'my-tickets' ? state.session.user.id : state.assignee })) if (value) params.set(name, value);
  try {
    const promises = [api('/api/desk/dashboard'), api('/api/desk/technicians'), api(`/api/desk/tickets?${params}`)];
    const [dashboard, technicians, tickets] = await Promise.all(promises);
    if (generation !== state.generation || !state.session) return;
    if (dashboard.workflow) applyWorkflow(dashboard.workflow);
    Object.assign(state, { dashboard, technicians: technicians.technicians || [], tickets: tickets.tickets || [], total: tickets.total || 0 });
    renderContent();
    const count = $('.nav-item[data-nav=tickets] .nav-count'); if (count) count.textContent = dashboard.stats?.open ?? 0;
  } catch (error) {
    if (generation !== state.generation || !state.session) return;
    $('#main-content').innerHTML = `<div class="error-panel">${icon('alert')}<div><strong>We couldn’t load your workspace.</strong><p>${esc(error.message)}</p></div><button class="btn" data-action="refresh">Try again</button></div>`;
  }
}
function renderContent() {
  if (state.current === 'knowledge') { renderKnowledge(); return; }
  if (state.current === 'assets') { renderAssetInventory(); return; }
  if (state.current === 'actions') { renderActions(); return; }
  if (state.current === 'reports') { renderReports(); return; }
  if (state.current === 'settings') { renderSettings(); return; }
  $('#breadcrumb-current').textContent = currentTitle();
  document.title = `${currentTitle()} · AssetDesk`;
  const first = state.session.user.name.split(' ')[0];
  const title = state.current === 'overview' ? `Your support desk, in focus.` : currentTitle();
  const subtitles = { overview: `Welcome back, ${first}. Here’s what needs your team’s attention.`, tickets: 'Every request, one clear queue. Keep good support moving.', 'my-tickets': 'Your queue, your priorities. A little focus goes a long way.', assets: 'The equipment behind every request, with its support history attached.', team: 'A great support experience starts with a connected team.' };
  $('#main-content').innerHTML = `<div class="page-heading"><div><div class="eyebrow">${state.current === 'overview' ? 'Workspace overview' : 'IT workspace'}</div><h1>${esc(title)}</h1><p>${esc(subtitles[state.current])}</p></div><div class="heading-actions"><span class="date-stamp">${icon('calendar')}${esc(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date()))}</span><button class="btn subtle" data-action="refresh" aria-label="Refresh workspace" title="Refresh workspace">${icon('refresh')}</button>${state.current === 'team' && state.session.user.role === 'admin' ? `<button class="btn" data-action="new-technician">${icon('plus')}Add technician</button>` : ''}<button class="btn primary" data-action="new-ticket">${icon('plus')}New ticket</button></div></div>${intakeBanner()}${state.current === 'assets' ? renderAssets() : state.current === 'team' ? renderTeam() : `${renderStats()}${state.current === 'overview' ? `<div class="dashboard-grid"><div>${renderTickets()}</div><aside class="side-panels" aria-label="Team overview">${renderWorkload()}${renderActivity()}</aside></div>` : renderTickets()}`}<footer class="page-footer"><span>${icon('shield')}A clear view. A better support experience.</span><span class="live-indicator">Connected to your workspace</span></footer>`;
}
function intakeBanner() {
  const counts = state.dashboard?.intake?.counts || [];
  const failed = Number(counts.find(c => c.state === 'failed')?.count || 0);
  const pending = counts.filter(c => ['pending', 'processing'].includes(c.state)).reduce((s, c) => s + Number(c.count || 0), 0);
  return failed ? `<div class="intake-banner" role="status">${icon('alert')}<span>${failed} request${failed === 1 ? '' : 's'} need attention. An administrator can inspect the failed intake receipts.</span></div>` : pending ? `<div class="intake-banner" role="status">${icon('clock')}<span>${pending} request${pending === 1 ? ' is' : 's are'} being recorded. Saved tickets are ready to work on.</span></div>` : '';
}
function renderStats() {
  const stats = state.dashboard?.stats || {};
  const cards = [
    { label: 'Active tickets', value: stats.open || 0, symbol: 'ticket', color: 'blue', bottom: 'Tickets in active status types', view: 'open' },
    { label: 'Unassigned', value: stats.unassigned || 0, symbol: 'user', color: 'orange', bottom: stats.unassigned ? 'Ready for a helping hand' : 'Everything has an owner', view: 'unassigned', emphasis: stats.unassigned ? 'attention' : 'positive' },
    { label: 'SLA overdue', value: stats.overdue || 0, symbol: 'clock', color: 'red', bottom: stats.overdue ? 'A little extra attention needed' : 'Keeping commitments on track', view: 'overdue', emphasis: stats.overdue ? 'attention' : 'positive' },
    { label: 'Resolved today', value: stats.resolvedToday || 0, symbol: 'circleCheck', color: '', bottom: 'Good work, one request at a time', view: 'resolved', emphasis: 'positive' },
  ];
  return `<section class="stats-grid" aria-label="Ticket overview">${cards.map(card => `<button class="stat-card" data-view="${card.view}"><div class="stat-top"><span>${card.label}</span><span class="stat-icon ${card.color}">${icon(card.symbol)}</span></div><div class="stat-number">${card.value}</div><div class="stat-bottom ${card.emphasis || ''}"><span class="stat-dot"></span>${card.bottom}</div></button>`).join('')}</section>`;
}
function renderTickets() {
  const tickets = state.tickets;
  const tabItems = [['all', 'All tickets'], ['open', 'Active'], ['unassigned', 'Unassigned'], ['overdue', 'Overdue'], ['paused', 'Paused'], ['resolved', 'Resolved']];
  return `<section class="panel" aria-label="Ticket queue"><div class="panel-header"><div><h2 class="panel-title">${state.current === 'my-tickets' ? 'Your ticket queue' : 'Ticket queue'}<span class="count-badge">${state.total}</span></h2><p class="panel-subtitle">${state.search ? `Results for “${esc(state.search)}”` : 'A little organization. A lot less friction.'}</p></div><select class="ticket-sort" aria-label="Sort tickets" id="ticket-sort"><option value="newest"${state.sort === 'newest' ? ' selected' : ''}>Newest first</option><option value="oldest"${state.sort === 'oldest' ? ' selected' : ''}>Oldest first</option><option value="priority"${state.sort === 'priority' ? ' selected' : ''}>Priority</option><option value="due"${state.sort === 'due' ? ' selected' : ''}>SLA due</option></select></div><div class="table-toolbar"><div class="tabs" role="tablist" aria-label="Ticket views">${tabItems.map(([view, label]) => `<button class="tab${state.view === view ? ' active' : ''}" data-view="${view}" role="tab" aria-selected="${state.view === view}">${label}${view === 'all' && state.view === 'all' ? `<span class="tiny-count">${state.total}</span>` : ''}</button>`).join('')}</div><button class="filter-toggle" data-action="toggle-filters" aria-expanded="${state.filtersOpen}" aria-controls="ticket-filters">${icon('filter')}Filters</button></div>${state.filtersOpen ? renderFilters() : ''}${tickets.length ? `<div class="table-scroll"><table class="tickets-table"><thead><tr><th scope="col">Ticket / requester</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Assignee</th><th scope="col">SLA</th></tr></thead><tbody>${tickets.map(ticket => `<tr><td class="subject-cell"><button class="ticket-title" data-ticket="${esc(ticket.key)}">${esc(ticket.subject)}</button><div class="ticket-meta"><span class="ticket-key mono" title="${esc(ticket.key)}">${esc(ticket.key)}</span><span class="meta-dot"></span><span>${esc(ticket.requester_name || ticket.requester?.split('@')[0] || 'Requester')}</span><span class="meta-dot"></span><span>${ago(ticket.created_at)}</span></div></td><td>${pill(ticket.status)}</td><td><span class="priority-label"><span class="priority-dot ${priorityTone(ticket.priority)}"></span>${esc(priorityLabels[ticket.priority] || 'Normal')}</span></td><td>${ticket.assignee ? `<div class="person table-person">${avatar(ticket.assignee.name)}<span class="name">${esc(ticket.assignee.name.split(' ')[0])}</span></div>` : `<span class="unassigned">${icon('user')}Unassigned</span>`}</td><td class="nowrap">${due(ticket)}</td></tr>`).join('')}</tbody></table></div>` : emptyState(state.search || state.view !== 'all' || state.current === 'my-tickets' ? 'A clear queue.' : 'Good support starts here.', state.search || state.view !== 'all' ? 'No tickets match this view. Try another filter or clear your search.' : state.current === 'my-tickets' ? 'Tickets assigned to you will appear here. Pick up an unassigned request to get started.' : 'Create your first ticket or connect your support mailbox. Requests will appear right here.', { action: `<button class="btn" data-action="new-ticket">${icon('plus')}Create a ticket</button>` })}<div class="table-footer"><span>${state.total ? `${state.offset + 1}–${Math.min(state.offset + state.tickets.length, state.total)} of ${state.total} tickets` : 'No tickets to show'}</span><div class="pagination"><button class="icon-button" data-action="prev-page" aria-label="Previous page"${state.offset <= 0 ? ' disabled' : ''}>${icon('left')}</button><span>Page ${Math.floor(state.offset / 20) + 1}</span><button class="icon-button" data-action="next-page" aria-label="Next page"${state.offset + 20 >= state.total ? ' disabled' : ''}>${icon('chevron')}</button></div></div></section>`;
}
function renderFilters() { return `<div class="filters" id="ticket-filters"><div class="field"><label for="filter-status">Status</label><select id="filter-status" data-filter="status"><option value="">All statuses</option>${options(statusLabels, state.status)}</select></div><div class="field"><label for="filter-priority">Priority</label><select id="filter-priority" data-filter="priority"><option value="">All priorities</option>${options(priorityLabels, state.priority)}</select></div><div class="field"><label for="filter-category">Category</label><select id="filter-category" data-filter="category"><option value="">All categories</option>${options(categoryLabels, state.category)}</select></div>${state.current !== 'my-tickets' ? `<div class="field"><label for="filter-assignee">Technician</label><select id="filter-assignee" data-filter="assignee"><option value="">All technicians</option><option value="unassigned"${state.assignee === 'unassigned' ? ' selected' : ''}>Unassigned</option>${technicianOptions(state.assignee)}</select></div>` : ''}</div>`; }
function renderWorkload() {
  const workload = (state.dashboard?.workload || []).filter(row => row.active !== 0).slice(0, 6);
  const max = Math.max(1, ...workload.map(row => Number(row.active_tickets || 0)));
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Team workload</h2><p class="panel-subtitle">A helping hand, evenly shared.</p></div><button class="view-link" data-nav="team" aria-label="View team">${icon('arrow')}</button></div>${workload.length ? `<div class="workload-list">${workload.map(row => `<div class="workload-row">${avatar(row.name)}<div class="workload-info"><div class="workload-name">${esc(row.name)}</div><progress class="workload-progress" max="${max}" value="${Number(row.active_tickets || 0)}" aria-label="${esc(row.name)}: ${Number(row.active_tickets || 0)} active tickets"></progress></div><div class="workload-count">${Number(row.active_tickets || 0)}</div></div>`).join('')}</div>` : '<p class="empty-small">Add technicians to see how your team’s work is distributed.</p>'}<div class="workload-footnote">${icon('users')}Active tickets per technician</div></section>`;
}
function renderActivity() {
  const activities = (state.dashboard?.activity || []).slice(0, 5);
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Recent activity</h2><p class="panel-subtitle">The latest from your support desk.</p></div><span class="muted">${icon('activity')}</span></div>${activities.length ? `<div class="activity-list">${activities.map(event => `<div class="activity-item"><span class="activity-symbol">${icon(event.type === 'email' ? 'mail' : event.type === 'note' ? 'note' : event.type?.includes('resolv') ? 'circleCheck' : 'ticket')}</span><div class="activity-content"><strong>${esc(event.actor_name || 'AssetDesk')}</strong> ${esc(activitySummary(event))}${event.ticket_key ? `<button class="view-link activity-subject" data-ticket="${esc(event.ticket_key)}">${esc(event.ticket_subject || event.ticket_key)}</button>` : ''}<div class="activity-time">${ago(event.created_at)}</div></div></div>`).join('')}</div>` : '<p class="empty-small">Updates, assignments, and notes will appear here as your team gets to work.</p>'}</section>`;
}
function activitySummary(event) { return event.type === 'created' || event.type === 'ticket_created' ? 'created a ticket' : event.type === 'email' ? 'sent an email update' : event.type === 'note' ? 'added an internal note' : String(event.body || cap(event.type) || 'updated a ticket').slice(0, 110); }
function renderAssets() { return renderAssetCards(state.assets); }
function renderTeam() {
  const technicians = state.technicians;
  return `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Your support team<span class="count-badge">${technicians.length}</span></h2><p class="panel-subtitle">${state.session.user.role === 'admin' ? 'Manage workspace access and who can take the next ticket.' : 'The people making IT a little more human.'}</p></div></div><div class="table-scroll"><table class="team-table"><thead><tr><th scope="col">Team member</th><th scope="col" class="role-column">Role</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${technicians.map(person => `<tr class="${person.active ? '' : 'inactive'}"><td><div class="person">${avatar(person.name, 'big')}<div><strong>${esc(person.name)}</strong><div class="team-email">${esc(person.email)}</div></div></div></td><td class="role-column"><span class="role-badge">${esc(person.role)}</span></td><td><span class="status-live${person.active ? '' : ' off'}">${person.active ? 'Active' : 'Inactive'}</span></td><td><div class="team-actions">${state.session.user.role === 'admin' ? `<button class="btn subtle" data-edit-technician="${esc(person.id)}" aria-label="Edit ${esc(person.name)}">Edit</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div></section>`;
}
function options(values, selected) { return Object.entries(values).map(([value, label]) => `<option value="${value}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`).join(''); }
function technicianOptions(selected, { includeInactive = false, historical = null } = {}) {
  const people = state.technicians.filter(person => person.active || (includeInactive && person.id === selected));
  // Technician accounts cannot list inactive colleagues. Preserve the ticket's
  // existing owner instead of silently choosing Unassigned when it is saved.
  if (includeInactive && historical?.id && historical.id === selected && !people.some(person => person.id === selected)) people.push(historical);
  return people.map(person => `<option value="${esc(person.id)}"${selected === person.id ? ' selected' : ''}>${esc(person.name)}${person.active ? '' : ' (inactive)'}</option>`).join('');
}

async function loadSettings() {
  if (!state.session || state.current !== 'settings') return;
  if (state.session.user.role !== 'admin') { renderSettings(); return; }
  if (state.settingsTab === 'ai') { if (!$('#ai-settings-container')) renderSettings(); else await aiUI.refreshSettings(); return; }
  const userId = state.session.user.id, generation = ++state.settingsGeneration;
  state.settingsLoading = true; state.settingsError = ''; renderSettings();
  try {
    const [workflow, people] = await Promise.all([api('/api/desk/settings'), api('/api/desk/technicians')]);
    if (!state.session || state.session.user.id !== userId || state.current !== 'settings' || generation !== state.settingsGeneration) return;
    applyWorkflow(workflow); state.technicians = people.technicians || []; state.settingsLoading = false; if (state.settingsTab !== 'ai') renderSettings();
  } catch (error) {
    if (!state.session || state.session.user.id !== userId || state.current !== 'settings' || generation !== state.settingsGeneration) return;
    state.settingsLoading = false; state.settingsError = error.message; if (state.settingsTab !== 'ai') renderSettings();
  }
}
function renderSettings() {
  $('#breadcrumb-current').textContent = 'Settings'; document.title = 'Settings · AssetDesk';
  if (state.session.user.role !== 'admin') {
    $('#main-content').innerHTML = `<section class="panel settings-denied">${icon('lock')}<h1>Settings</h1><p>Administrator access is required to manage workspace settings.</p><button class="btn" data-nav="tickets">Back to tickets</button></section>`;
    return;
  }
  const tabs = { priorities: 'Priorities & SLA', statuses: 'Statuses', categories: 'Categories', technicians: 'Technicians', ai: 'AI' };
  $('#main-content').innerHTML = `<div class="page-heading"><div><div class="eyebrow">Workspace administration</div><h1>Settings</h1><p>Shape ticket workflows, service targets, and team access.</p></div><button class="btn" id="settings-refresh" aria-label="Refresh settings">${icon('refresh')}Refresh</button></div><div class="settings-tabs" role="tablist" aria-label="Settings areas">${Object.entries(tabs).map(([id, name]) => `<button class="tab${state.settingsTab === id ? ' active' : ''}" role="tab" id="settings-tab-${id}" aria-controls="settings-panel" aria-selected="${state.settingsTab === id}" data-settings-tab="${id}">${icon(id === 'priorities' ? 'clock' : id === 'statuses' ? 'activity' : id === 'categories' ? 'book' : id === 'ai' ? 'spark' : 'users')}${name}</button>`).join('')}</div><section id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-${state.settingsTab}" aria-busy="${state.settingsTab !== 'ai' && state.settingsLoading}">${state.settingsTab === 'ai' ? renderSettingsPanel() : state.settingsLoading ? loadingPanel() : state.settingsError ? `<div class="error-panel">${icon('alert')}<div><strong>Settings could not be loaded.</strong><p>${esc(state.settingsError)}</p></div><button class="btn" id="settings-retry">Try again</button></div>` : renderSettingsPanel()}</section>`;
  $('#settings-refresh').addEventListener('click', loadSettings); $('#settings-retry')?.addEventListener('click', loadSettings);
  document.querySelectorAll('[data-settings-tab]').forEach(button => button.addEventListener('click', () => { if (state.settingsTab === button.dataset.settingsTab) return; if (!aiUI.canLeave()) return; if (state.settingsTab === 'ai') aiUI.leaveSettings(); state.settingsTab = button.dataset.settingsTab; renderSettings(); }));
  $('#settings-add')?.addEventListener('click', () => state.settingsTab === 'technicians' ? openTechnician() : openWorkflowEditor(state.settingsTab));
  document.querySelectorAll('[data-edit-workflow]').forEach(button => button.addEventListener('click', () => openWorkflowEditor(state.settingsTab, button.dataset.editWorkflow)));
  $('#settings-knowledge')?.addEventListener('click', () => openCategoryManager());
  if (state.settingsTab === 'ai') aiUI.openSettings($('#ai-settings-container'));
}
function renderSettingsPanel() {
  const type = state.settingsTab;
  if (type === 'ai') return '<div id="ai-settings-container"></div>';
  if (type === 'technicians') return `<div class="settings-team-heading"><div><h2>Technicians</h2><p>Create accounts, assign roles, and manage access.</p></div><button class="btn primary" id="settings-add">${icon('plus')}Add technician</button></div>${renderTeam()}`;
  const singular = { priorities: 'priority', statuses: 'status', categories: 'category' }[type];
  const rows = state.workflow?.[type] || [];
  const descriptions = { priorities: 'Set priority names, urgency ranks, and response and resolution targets.', statuses: 'Give tickets clear stages, with scheduled pauses when work must wait.', categories: 'Organize tickets by the type of support they need.' };
  const extraHead = type === 'priorities' ? '<th scope="col">Rank</th><th scope="col">First response</th><th scope="col">Resolution</th>' : type === 'statuses' ? '<th scope="col">Status type</th>' : '';
  return `<section class="panel settings-records" aria-label="${type === 'priorities' ? 'Priorities and SLA targets' : cap(type)}"><header class="panel-header"><div><h2 class="panel-title">${type === 'priorities' ? 'Priorities & SLA targets' : type === 'categories' ? 'Ticket categories' : 'Ticket statuses'}</h2><p class="panel-subtitle">${descriptions[type]}</p></div><button class="btn primary" id="settings-add">${icon('plus')}Add ${singular}</button></header>${type === 'priorities' ? '<div class="settings-guidance">Targets use elapsed hours from the original ticket submission, including weekends. Editing a target affects new tickets and priority changes. Choose the option in Edit priority to also recalculate active ticket deadlines.</div>' : type === 'statuses' ? '<div class="settings-guidance">Paused tickets stay out of the dashboard until their scheduled return to In progress. SLA targets remain based on submission time. Resolved statuses require a resolution summary; close a ticket after it has been resolved. Status types stay fixed so historical tickets keep their meaning.</div>' : ''}<div class="table-scroll"><table class="settings-table"><thead><tr><th scope="col">Name</th>${extraHead}<th scope="col">Availability</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map(row => `<tr class="${row.active ? '' : 'settings-archived'}"><td><strong>${esc(row.name)}</strong>${row.system ? '<span class="settings-default">Default</span>' : ''}</td>${type === 'priorities' ? `<td>${Number(row.rank)}</td><td>${Number(row.response_hours)} hours</td><td>${Number(row.resolution_hours)} hours</td>` : type === 'statuses' ? `<td><span class="role-badge">${esc(cap(row.kind))}</span></td>` : ''}<td><span class="status-live${row.active ? '' : ' off'}">${row.active ? 'Active' : 'Archived'}</span></td><td><button class="btn subtle" data-edit-workflow="${esc(row.id)}" aria-label="Edit ${singular} ${esc(row.name)}">Edit</button></td></tr>`).join('')}</tbody></table></div><footer class="settings-guidance">Archive custom choices to stop using them on new tickets while keeping historical records and reports. Default choices remain available.</footer></section>${type === 'categories' ? `<section class="panel settings-knowledge-card"><div>${icon('shield')}<h2>Knowledge categories & permissions</h2><p>Manage knowledge and asset categories, including who can view and edit their contents.</p></div><button class="btn" id="settings-knowledge">Knowledge categories & permissions ${icon('arrow')}</button></section>` : ''}`;
}
function openWorkflowEditor(type, id = null) {
  const record = id ? state.workflow[type].find(item => item.id === id) : null;
  const singular = { priorities: 'priority', statuses: 'status', categories: 'category' }[type];
  if (!singular || (id && !record)) return;
  const userId = state.session.user.id;
  let version = state.workflow.version;
  const highestRank = Math.max(0, ...(state.workflow.priorities || []).map(item => Number(item.rank)));
  showModal(`<form id="workflow-editor"><header class="modal-header"><div><h2>${record ? 'Edit' : 'Add'} ${singular}</h2><p>${type === 'priorities' ? 'Balance urgency with clear service commitments.' : type === 'statuses' ? 'Choose a clear stage for the support workflow.' : 'Give your team a useful way to classify requests.'}</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close ${singular} editor">${icon('close')}</button></header><div class="modal-body modal-form"><div class="field"><label for="setting-name">Name</label><input class="input" id="setting-name" name="name" required maxlength="100" value="${esc(record?.name)}"></div>${type === 'statuses' ? `<div class="field"><label for="setting-kind">Status type</label><select id="setting-kind" name="kind"${record ? ' disabled' : ''}>${options({ active: 'Active', ...(record?.kind === 'paused' ? { paused: 'Paused' } : {}), resolved: 'Resolved', closed: 'Closed' }, record?.kind || 'active')}</select><small>Active work counts toward SLA targets. Resolved work needs a summary; closed work is complete. The type cannot change after creation.</small></div>` : type === 'priorities' ? `<div class="field"><label for="setting-rank">Priority rank</label><input class="input" id="setting-rank" name="rank" type="number" min="1" step="1" required value="${record ? Number(record.rank) : highestRank + 1}"><small>Higher numbers mean greater urgency when sorting tickets.</small></div><div class="field-grid"><div class="field"><label for="setting-response">First response target (hours)</label><input class="input" id="setting-response" name="response_hours" type="number" min="0.0001" max="87600" step="any" required value="${record ? Number(record.response_hours) : 4}"></div><div class="field"><label for="setting-resolution">Resolution target (hours)</label><input class="input" id="setting-resolution" name="resolution_hours" type="number" min="0.0001" max="87600" step="any" required value="${record ? Number(record.resolution_hours) : 24}"></div></div>${record ? '<label class="settings-apply-sla"><input type="checkbox" name="recalculate_open_tickets"><span>Apply SLA changes to active tickets<small>Recalculate this priority’s deadlines from each ticket’s original submission time. Completed tickets keep their existing deadlines.</small></span></label>' : ''}` : ''}${record && !record.system ? `<label class="settings-availability"><input type="checkbox" name="active"${record.active ? ' checked' : ''}><span>Available for new tickets<small>Uncheck to archive this choice. Existing tickets and reports are preserved.</small></span></label>` : ''}<div class="field-error" role="alert"></div><button class="btn settings-conflict-review" type="button" id="settings-review-latest" hidden>Review latest settings</button></div><footer class="modal-footer"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${record ? 'Save changes' : `Create ${singular}`}</button></footer></form>`);
  const form = $('#workflow-editor'), errorBox = $('.field-error', form), review = $('#settings-review-latest');
  const editorActive = () => state.session?.user.id === userId && state.current === 'settings' && modal.open && form.isConnected;
  review.addEventListener('click', async () => {
    review.disabled = true;
    try {
      const latest = await api('/api/desk/settings');
      if (state.session?.user.id !== userId) return;
      applyWorkflow(latest); if (!editorActive()) return; version = latest.version;
      const current = id ? latest[type].find(item => item.id === id) : null;
      errorBox.textContent = current ? `Latest saved values: ${current.name}${type === 'priorities' ? `, rank ${current.rank}, response ${current.response_hours} hours, resolution ${current.resolution_hours} hours` : ''}, ${current.active ? 'active' : 'archived'}. Your draft is still in the form. Review it, then save again.` : 'The latest settings are loaded. Your draft is still in the form. Review it, then save again.';
      review.hidden = true;
    } catch (error) { if (editorActive()) errorBox.textContent = error.message; }
    finally { review.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(form));
    const payload = { version, name: values.name.trim() };
    if (type === 'statuses' && !record) payload.kind = values.kind;
    if (type === 'priorities') Object.assign(payload, { rank: Number(values.rank), response_hours: Number(values.response_hours), resolution_hours: Number(values.resolution_hours), ...(record ? { recalculate_open_tickets: Boolean(values.recalculate_open_tickets) } : {}) });
    if (record && !record.system) payload.active = Boolean(values.active);
    const button = $('button[type=submit]', form); button.disabled = true; errorBox.textContent = '';
    try {
      const updated = await api(`/api/desk/settings/${type}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: record ? 'PATCH' : 'POST', body: payload });
      if (state.session?.user.id !== userId) return;
      applyWorkflow(updated); if (!editorActive()) return; modal.close(); renderSettings();
      toast(`${cap(singular)} ${record ? 'updated' : 'created'}.${updated.affected_tickets ? ` ${updated.affected_tickets} active ticket deadlines recalculated.` : ''}`);
    } catch (error) { if (editorActive()) { errorBox.textContent = error.message; review.hidden = error.status !== 409; button.disabled = false; } }
  });
}

function normalizeTagLabel(value) {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error('Tags cannot contain line breaks or control characters.');
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > 50) throw new Error('Enter a tag with 1 to 50 characters.');
  return { name, key: name.toLowerCase() };
}
function renderTagLabels(tags = [], className = '') {
  return tags.length ? `<div class="tag-labels ${className}">${tags.map(tag => `<span class="ticket-tag-label">${esc(tag)}</span>`).join('')}</div>` : '';
}
function ticketTagState(key) {
  if (state.ticketTag?.key !== key) state.ticketTag = { key, draft: '', busy: false, error: '' };
  return state.ticketTag;
}
function tagChips(tags, { removable = false, busy = false } = {}) {
  return tags.map(tag => `<span class="ticket-tag-label"><span>${esc(tag)}</span>${removable ? `<button type="button" class="tag-remove" data-remove-tag="${esc(tag)}" aria-label="Remove tag ${esc(tag)}"${busy ? ' disabled' : ''}>${icon('close')}</button>` : ''}</span>`).join('');
}
function renderTicketTags(ticket) {
  const edit = ticketTagState(ticket.key), tags = ticket.tags || [];
  return `<section class="ticket-tags-section" aria-label="Ticket tags"><div class="ticket-tags-heading"><h2 class="drawer-section-label">Tags</h2><span>${tags.length} tag${tags.length === 1 ? '' : 's'}</span></div><div class="tag-labels" id="ticket-tag-list">${tags.length ? tagChips(tags, { removable: true, busy: edit.busy }) : '<span class="tag-empty">No tags yet.</span>'}</div><div class="tag-entry"><div class="field"><label for="ticket-tag-input" class="sr-only">Add ticket tag</label><input class="input" id="ticket-tag-input" list="ticket-tag-suggestions" placeholder="Type a tag and press Enter" maxlength="100" autocomplete="off" aria-describedby="ticket-tag-help ticket-tag-error" value="${esc(edit.draft)}"${edit.busy ? ' disabled' : ''}><datalist id="ticket-tag-suggestions"></datalist></div><button class="btn" type="button" id="ticket-tag-add"${edit.busy ? ' disabled' : ''}>${edit.busy ? '<span class="spinner"></span>Saving…' : `${icon('plus')}Add tag`}</button></div><p class="tag-help" id="ticket-tag-help">Press Enter to create or reuse a tag. Changes save immediately.</p><p class="field-error" id="ticket-tag-error" role="alert">${esc(edit.error)}</p></section>`;
}
function bindTagSuggestions(input, list) {
  let timer, generation = 0;
  const load = async () => {
    const search = input.value.trim(), current = ++generation;
    try {
      const result = await api(`/api/desk/tags?${new URLSearchParams({ search, limit: '20' })}`);
      if (!input.isConnected || current !== generation || input.value.trim() !== search) return;
      list.innerHTML = (result.tags || []).map(tag => `<option value="${esc(tag.name)}"></option>`).join('');
    } catch { /* Suggestions are optional; creating a tag still works. */ }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 180); });
  input.addEventListener('focus', load);
}
function bindTicketTags(ticket) {
  const input = $('#ticket-tag-input'), edit = ticketTagState(ticket.key);
  bindTagSuggestions(input, $('#ticket-tag-suggestions'));
  input.addEventListener('input', () => { edit.draft = input.value; edit.error = ''; $('#ticket-tag-error').textContent = ''; });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); changeTicketTag(ticket.key); }
  });
  $('#ticket-tag-add').addEventListener('click', () => changeTicketTag(ticket.key));
  $('#ticket-tag-list').addEventListener('click', event => { const button = event.target.closest('[data-remove-tag]'); if (button) changeTicketTag(ticket.key, button.dataset.removeTag); });
}
async function changeTicketTag(key, remove) {
  const edit = ticketTagState(key), userId = state.session?.user.id;
  if (edit.busy || !drawer.open || drawer.dataset.ticketKey !== key || state.ticket?.key !== key) return;
  const input = $('#ticket-tag-input');
  let tag;
  try {
    tag = normalizeTagLabel(remove ?? input.value).name;
    if (remove === undefined && (state.ticket.tags || []).some(value => normalizeTagLabel(value).key === normalizeTagLabel(tag).key)) { input.value = ''; edit.draft = ''; toast('This tag is already on the ticket.'); return; }
  } catch (error) { edit.error = error.message; $('#ticket-tag-error').textContent = error.message; return; }
  edit.error = ''; edit.busy = true;
  if (remove === undefined) { edit.draft = ''; input.value = ''; }
  input.disabled = true; $('#ticket-tag-add').disabled = true; $('#ticket-tag-add').innerHTML = '<span class="spinner"></span>Saving…';
  drawer.querySelectorAll('.tag-remove').forEach(button => { button.disabled = true; });
  try {
    await api(`/api/desk/tickets/${encodeURIComponent(key)}/tags`, { method: remove === undefined ? 'POST' : 'DELETE', body: { tag } });
    if (state.session?.user.id !== userId || state.ticketTag !== edit || !drawer.open || drawer.dataset.ticketKey !== key) return;
    edit.busy = false;
    await reloadTicket({ preserveEdits: true });
    if (state.session?.user.id !== userId || state.ticketTag !== edit || !drawer.open || drawer.dataset.ticketKey !== key || state.ticket?.key !== key) return;
    if (remove === undefined) $('#ticket-tag-input')?.focus({ preventScroll: true });
    toast(remove === undefined ? 'Tag added.' : 'Tag removed.');
    if (state.current === 'reports') loadReports();
  } catch (error) {
    if (state.session?.user.id !== userId || state.ticketTag !== edit || !drawer.open || drawer.dataset.ticketKey !== key) return;
    edit.error = error.message;
    if (remove === undefined) { edit.draft = tag; const field = $('#ticket-tag-input'); if (field) field.value = tag; }
    $('#ticket-tag-error').textContent = error.message;
  } finally {
    edit.busy = false;
    if (state.ticketTag === edit && drawer.open && drawer.dataset.ticketKey === key) { const field = $('#ticket-tag-input'); if (field) field.disabled = false; const button = $('#ticket-tag-add'); if (button) { button.disabled = false; button.innerHTML = `${icon('plus')}Add tag`; } drawer.querySelectorAll('.tag-remove').forEach(button => { button.disabled = false; }); }
  }
}

async function openTicket(key) {
  stopTicketPauseWatch();
  const userId = state.session?.user.id;
  drawer.dataset.ticketKey = key;
  if (!drawer.open) drawer.showModal();
  drawer.innerHTML = `<div class="drawer-state"><span class="spinner"></span>Opening ticket…<button class="icon-button" data-action="close-drawer" aria-label="Close ticket details">${icon('close')}</button></div>`;
  try { const [ticket, assets, responses, workflow] = await Promise.all([api(`/api/desk/tickets/${encodeURIComponent(key)}`), api('/api/desk/assets'), api('/api/desk/responses'), api('/api/desk/workflow')]); if (!state.session || state.session.user.id !== userId || !drawer.open || drawer.dataset.ticketKey !== key) return; applyWorkflow(workflow); state.ticket = ticket.ticket || ticket; rememberTicketChoices(state.ticket); state.assets = assets.assets || []; state.responses = responses.responses || []; renderTicketDetail(); }
  catch (error) { if (state.session?.user.id === userId && drawer.open && drawer.dataset.ticketKey === key) drawer.innerHTML = `<div class="drawer-state"><p>${esc(error.message)}</p><button class="btn" data-action="close-drawer">Close</button></div>`; }
}
function renderTicketDetail() {
  const ticket = state.ticket;
  const assets = ticket.assets || [];
  const activity = [...(ticket.notes || []).map(note => ({ ...note, itemKind: 'note' })), ...(ticket.events || []).filter(event => !['note', 'email'].includes(event.type)).map(event => ({ ...event, itemKind: 'event' }))].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const allowedStatuses = ticketStatusChoices(ticket);
  drawer.innerHTML = `<div class="drawer-top"><div class="drawer-breadcrumb">${icon('ticket')}<span>Tickets</span>${icon('chevron')}<span class="mono">${esc(ticket.key)}</span></div><div class="drawer-top-actions"><button class="icon-button" data-action="close-drawer" aria-label="Close ticket details">${icon('close')}</button></div></div><div class="drawer-body"><section class="drawer-content"><div class="drawer-status-line">${pill(ticket.status)}<span class="pill ${priorityTone(ticket.priority)}">${esc(priorityLabels[ticket.priority] || 'Normal')} priority</span></div>${ticketStatusKind(ticket) === 'paused' ? `<div class="ticket-pause-banner" role="status">${icon('clock')}<div><strong>Paused until ${esc(pauseDate(ticket.paused_until))}</strong><p>Returns to In progress automatically. Hidden from the default dashboard until then.</p></div></div>` : ''}<h1>${esc(ticket.subject)}</h1><div class="requester-block">${avatar(ticket.requester_name || ticket.requester)}<div><strong>${esc(ticket.requester_name || ticket.requester)}</strong><small>${esc(ticket.requester)} · ${esc(ticket.source === 'manual' ? 'Manual request' : 'Email request')}</small></div></div><h2 class="drawer-section-label">Description</h2><div class="ticket-description">${esc(ticket.description || 'No description was recorded for this ticket.')}</div>${aiUI.ticketPanel(ticket)}${renderTicketTags(ticket)}${renderAssetSection(ticket)}${renderRelatedTickets(ticket)}<div class="divider"></div><div class="activity-filter"><h2 class="drawer-section-label">Activity & notes</h2><span class="small muted">${activity.length} update${activity.length === 1 ? '' : 's'}</span></div><div class="ticket-activity">${activity.length ? activity.map(event => `<div class="ticket-activity-item">${avatar(event.actor_name || (event.kind === 'email' ? ticket.requester : 'AssetDesk'))}<div class="ticket-activity-main"><div class="ticket-activity-heading"><strong>${esc(event.actor_name || 'AssetDesk')}</strong>${event.itemKind === 'note' ? `<span class="email-tag">${event.kind === 'email' ? 'Email' : 'Internal note'}</span>` : ''}<time datetime="${esc(event.created_at)}" title="${esc(shortDate(event.created_at))}">${ago(event.created_at)}</time></div><div class="${event.itemKind === 'note' ? 'note-content' : 'activity-content'}">${esc(event.body || cap(event.type))}</div></div></div>`).join('') : '<p class="empty-small">Assignment changes, notes, and email updates will appear here.</p>'}</div><form class="note-composer" id="note-form"><div class="composer-label">${icon('lock')}Internal note <span class="muted">· visible to your team</span></div>${renderResponseTools()}<label class="sr-only" for="note-body">Internal note</label><textarea id="note-body" name="body" placeholder="Share context, an update, or your next steps…" required maxlength="20000"></textarea><div class="composer-bottom"><span>This does not send an email.</span><div class="composer-actions"><button class="btn" type="button" data-action="copy-response">${icon('note')}Copy response</button><button class="btn primary" type="submit">Add note</button></div></div></form></section><aside class="drawer-properties" aria-label="Ticket properties"><div class="eyebrow">Ticket details</div><form id="ticket-update" class="property-form"><div class="field"><label for="ticket-status">Status</label><select id="ticket-status" name="status">${options(allowedStatuses, ticket.status)}</select></div>${renderPauseField('ticket-paused-until', ticket.paused_until)}<div class="field"><label for="ticket-priority">Priority</label><select id="ticket-priority" name="priority">${options(workflowChoices('priorities', ticket.priority), ticket.priority)}</select></div><div class="field"><label for="ticket-assignee">Assigned technician</label><select id="ticket-assignee" name="assignee_id"><option value="">Unassigned</option>${technicianOptions(ticket.assignee_id || ticket.assignee?.id, { includeInactive: true, historical: ticket.assignee })}</select></div><div class="field"><label for="ticket-category">Category</label><select id="ticket-category" name="category">${options(workflowChoices('categories', ticket.category), ticket.category)}</select></div><div class="field"><label for="ticket-location">Location</label><input class="input" id="ticket-location" name="location" maxlength="300" value="${esc(ticket.location || '')}" placeholder="Requester or affected location"></div><div class="field resolution-field" id="resolution-field" hidden><label for="ticket-resolution">Resolution summary</label><textarea id="ticket-resolution" name="resolution" placeholder="What resolved this issue?" maxlength="10000"></textarea></div><div class="field-error" role="alert"></div><div class="property-actions"><button class="btn primary full" type="submit">Save changes</button>${ticket.assignee?.id !== state.session.user.id ? `<button class="btn full" type="button" data-action="assign-me">${icon('user')}Assign to me</button>` : ''}</div></form><div class="sla-box"><div class="sla-item"><div class="sla-label">${icon('clock')}First response</div><div class="sla-value${ticketStatusKind(ticket) === 'active' && !ticket.first_response_at && new Date(ticket.response_due_at) < new Date() ? ' overdue' : ''}">${ticket.first_response_at ? `Recorded ${esc(shortDate(ticket.first_response_at))}` : esc(shortDate(ticket.response_due_at))}</div></div><div class="sla-item"><div class="sla-label">${icon('circleCheck')}Resolution target</div><div class="sla-value${ticketStatusKind(ticket) === 'active' && new Date(ticket.resolution_due_at) < new Date() ? ' overdue' : ''}">${ticket.resolved_at ? `Resolved ${esc(shortDate(ticket.resolved_at))}` : esc(shortDate(ticket.resolution_due_at))}</div></div>${!ticket.first_response_at ? '<button class="btn full" type="button" data-action="first-response">Mark first response</button><p class="small muted">Record only after contacting the requester.</p>' : ''}</div><div class="drawer-created">Created ${esc(shortDate(ticket.created_at))}<br>Updated ${esc(shortDate(ticket.updated_at || ticket.created_at))}<br>Targets use elapsed hours, including weekends.</div></aside></div>`;
  bindTicketTags(ticket);
  aiUI.watchTicket(ticket);
  watchTicketPause(ticket);
  $('#asset-link-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const ref = new FormData(form).get('ref').trim();
    const button = $('button[type=submit]', form); button.disabled = true;
    try { const result = await api(`/api/desk/tickets/${encodeURIComponent(ticket.key)}/assets`, { method: 'POST', body: { ref } }); toast(result.duplicate ? 'This asset is already linked.' : 'Asset linked to this ticket.'); await reloadTicket({ preserveEdits: true }); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
  $('#ticket-status').addEventListener('change', () => {
    if ($('#ticket-status').value !== 'paused') $('#ticket-paused-until').value = '';
    updateTicketPropertyRequirements(ticket);
  });
  $('#ticket-paused-until').addEventListener('input', () => {
    if ($('#ticket-paused-until').value) $('#ticket-status').value = 'paused';
    else if ($('#ticket-status').value === 'paused') $('#ticket-status').value = 'in_progress';
    updateTicketPropertyRequirements(ticket);
  });
  updateTicketPropertyRequirements(ticket);
  $('#ticket-update').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
    values.assignee_id ||= null; values.version = ticket.version;
    if (values.paused_until === localDateTime(ticket.paused_until)) delete values.paused_until;
    else { try { values.paused_until = serializePauseInput(values.paused_until); } catch (error) { $('.field-error', form).textContent = error.message; return; } }
    if (!values.resolution) delete values.resolution;
    if (values.location === String(ticket.location || '')) delete values.location;
    await patchTicket(values, form);
  });
  setPropertyDisabled(state.busy);
  $('#note-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const body = new FormData(form).get('body').trim(); if (!body) return;
    const button = $('button[type=submit]', form); button.disabled = true;
    try { await api(`/api/desk/tickets/${encodeURIComponent(ticket.key)}/notes`, { method: 'POST', body: { body } }); toast('Internal note added.'); $('#note-body').value = ''; await reloadTicket(); await refresh({ quiet: true }); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
}
async function patchTicket(patch, form) {
  if (state.busy) { toast('Finishing the previous update. Please try again in a moment.'); return; }
  const edits = form ? ticketPropertyEdits(state.ticket, form) : null;
  state.busy = true; setPropertyDisabled(true);
  const button = form ? $('button[type=submit]', form) : null; if (button) button.disabled = true;
  try { await api(`/api/desk/tickets/${encodeURIComponent(state.ticket.key)}`, { method: 'PATCH', body: patch }); toast('Ticket updated.'); await reloadTicket(); await refresh({ quiet: true }); }
  catch (error) {
    if (error.status === 409) { await reloadTicket(); if (form) { restoreTicketPropertyEdits(edits); $('.field-error', $('#ticket-update')).textContent = 'This ticket changed. Your selections are preserved. Review the latest activity, then save again.'; } toast('Ticket updated by a teammate. Your edits are preserved for review.', true); }
    else if (form) $('.field-error', form).textContent = error.message;
    else toast(error.message, true);
  } finally { state.busy = false; setPropertyDisabled(false); if (button) button.disabled = false; }
}
async function reloadTicket({ preserveEdits = false, quiet = false } = {}) {
  const key = state.ticket?.key, userId = state.session?.user.id;
  if (!key || !drawer.open) return;
  const [data, workflow] = await Promise.all([api(`/api/desk/tickets/${encodeURIComponent(key)}`), api('/api/desk/workflow')]);
  if (!state.session || state.session.user.id !== userId || !drawer.open || state.ticket?.key !== key || drawer.dataset.ticketKey !== key) return;
  const incoming = data.ticket || data;
  if (quiet && ticketMirrorSignature(incoming) === ticketMirrorSignature(state.ticket)) return;
  applyWorkflow(workflow);
  rememberTicketChoices(incoming);
  // Snapshot at render time so typing during the request is preserved too.
  const focused = drawer.contains(document.activeElement) ? document.activeElement : null;
  const focus = focused?.id ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const scroll = ['.drawer-content', '.drawer-properties', '.drawer-body'].map(selector => [selector, $(selector, drawer)?.scrollTop || 0]);
  const draft = $('#note-body')?.value || '';
  const template = $('#response-template')?.value || '';
  const assetRef = $('#link-asset-id')?.value || '';
  if ($('#ticket-tag-input')) ticketTagState(key).draft = $('#ticket-tag-input').value;
  const edits = preserveEdits && !state.busy && $('#ticket-update') ? ticketPropertyEdits(state.ticket, $('#ticket-update')) : null;
  state.ticket = incoming;
  renderTicketDetail();
  if ($('#note-body')) $('#note-body').value = draft;
  if ($('#response-template') && [...$('#response-template').options].some(option => option.value === template)) $('#response-template').value = template;
  if ($('#link-asset-id')) $('#link-asset-id').value = assetRef;
  restoreTicketPropertyEdits(edits);
  for (const [selector, top] of scroll) { const element = $(selector, drawer); if (element) element.scrollTop = top; }
  if (focus) { const field = document.getElementById(focus.id); if (field && !field.disabled) { field.focus({ preventScroll: true }); if (typeof focus.start === 'number' && field.setSelectionRange) { try { field.setSelectionRange(focus.start, focus.end); } catch {} } } }
}
function showModal(html) { modal.dataset.responseLibrary = 'false'; modal.innerHTML = html; if (!modal.open) modal.showModal(); }
function renderNewTicketTagFields() {
  return `<section class="new-ticket-tags" aria-label="New ticket tags"><div class="ticket-tags-heading"><h3>Tags <span class="muted">(optional)</span></h3><span id="new-tag-count">0 tags</span></div><div class="tag-labels" id="new-ticket-tag-list"><span class="tag-empty">No tags yet.</span></div><div class="tag-entry"><div class="field"><label for="new-ticket-tag-input" class="sr-only">New ticket tag</label><input class="input" id="new-ticket-tag-input" list="new-ticket-tag-suggestions" placeholder="Type a tag and press Enter" maxlength="100" autocomplete="off" aria-describedby="new-ticket-tag-help new-ticket-tag-error"><datalist id="new-ticket-tag-suggestions"></datalist></div><button class="btn" type="button" id="new-ticket-tag-add">${icon('plus')}Add tag</button></div><p class="tag-help" id="new-ticket-tag-help">Create or reuse tags with Enter. They save when you create the ticket.</p><p class="tag-entry-error" id="new-ticket-tag-error" role="alert"></p></section>`;
}
function bindNewTicketTags() {
  const tags = [], input = $('#new-ticket-tag-input'), list = $('#new-ticket-tag-list'), error = $('#new-ticket-tag-error');
  const render = () => { list.innerHTML = tags.length ? tagChips(tags, { removable: true }) : '<span class="tag-empty">No tags yet.</span>'; $('#new-tag-count').textContent = `${tags.length} tag${tags.length === 1 ? '' : 's'}`; };
  const commit = () => {
    if (!input.value.trim()) return true;
    try {
      const tag = normalizeTagLabel(input.value);
      if (!tags.some(value => normalizeTagLabel(value).key === tag.key)) { tags.push(tag.name); }
      input.value = ''; error.textContent = ''; render(); return true;
    } catch (failure) { error.textContent = failure.message; input.focus(); return false; }
  };
  bindTagSuggestions(input, $('#new-ticket-tag-suggestions'));
  input.addEventListener('input', () => { error.textContent = ''; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); commit(); } });
  $('#new-ticket-tag-add').addEventListener('click', () => { commit(); input.focus(); });
  list.addEventListener('click', event => { const button = event.target.closest('[data-remove-tag]'); if (button) { tags.splice(tags.indexOf(button.dataset.removeTag), 1); render(); } });
  return { tags, commit };
}
async function openNewTicket() {
  const userId = state.session?.user.id, view = state.current;
  try { await loadWorkflow(); }
  catch (error) { if (state.session?.user.id === userId) toast(error.message, true); return; }
  if (!state.session || state.session.user.id !== userId || state.current !== view || modal.open) return;
  showModal(`<form id="new-ticket-form"><header class="modal-header"><div><h2>Create a ticket</h2><p>A clear request is the first step to a quick resolution.</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close new ticket">${icon('close')}</button></header><div class="modal-body modal-form"><div class="field"><label for="new-subject">Subject</label><input class="input" name="subject" id="new-subject" placeholder="A short summary of the issue" required maxlength="240" autofocus></div><div class="field-grid"><div class="field"><label for="new-requester">Requester email</label><input class="input" name="requester" id="new-requester" type="email" placeholder="person@company.com" required maxlength="254"></div><div class="field"><label for="new-requester-name">Requester name <span class="muted">(optional)</span></label><input class="input" name="requester_name" id="new-requester-name" placeholder="Full name" maxlength="200"></div></div><div class="field"><label for="new-description">Description</label><textarea name="description" id="new-description" placeholder="What happened? Include an asset ID such as LAPTOP-1042 to link its record." required maxlength="100000" rows="5"></textarea><small>Asset IDs in the subject or description are linked automatically.</small></div><div class="field"><label for="new-location">Location (optional)</label><input class="input" id="new-location" name="location" maxlength="300" placeholder="Leave blank to use the requester’s known location"></div>${renderPauseField('new-paused-until', null, true)}${renderNewTicketTagFields()}<div class="field-grid"><div class="field"><label for="new-priority">Priority</label><select name="priority" id="new-priority">${options(workflowChoices('priorities'), 'normal')}</select></div><div class="field"><label for="new-category">Category</label><select name="category" id="new-category">${options(workflowChoices('categories'), 'general')}</select></div><div class="field span-2"><label for="new-assignee">Assign technician</label><select name="assignee_id" id="new-assignee"><option value="">Leave unassigned</option>${technicianOptions('')}</select></div></div><div class="field-error" role="alert"></div></div><footer class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">${icon('plus')}Create ticket</button></footer></form>`);
  const draftTags = bindNewTicketTags();
  $('#new-ticket-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!draftTags.commit()) return; const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); values.assignee_id ||= null; values.tags = [...draftTags.tags];
    try { if (values.paused_until) values.paused_until = serializePauseInput(values.paused_until); else delete values.paused_until; }
    catch (error) { $('.field-error', form).textContent = error.message; return; }
    const button = $('button[type=submit]', form); button.disabled = true; button.textContent = 'Creating ticket…'; $('.field-error', form).textContent = '';
    try {
      const accepted = await api('/api/desk/tickets', { method: 'POST', body: values });
      if (accepted.ticketKey) {
        modal.close(); toast('Ticket created. Ready for your team.');
        if (state.current !== 'knowledge') refresh({ quiet: true }); await openTicket(accepted.ticketKey); return;
      }
      let receipt = accepted; let finished = false;
      for (let i = 0; i < 40; i++) {
        receipt = await api(`/api/desk/receipts/${encodeURIComponent(accepted.id)}`);
        if (receipt.state === 'failed') throw new Error(receipt.error || 'Ticket intake needs attention. Contact your administrator.');
        if (receipt.ticketKey) { finished = true; break; }
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      modal.close(); toast(finished ? 'Ticket created. Let’s get it sorted.' : 'Request accepted. Your ticket will appear when processing completes.'); await refresh({ quiet: true }); if (finished && receipt.ticketKey) await openTicket(receipt.ticketKey);
    } catch (error) { if (modal.open && form.isConnected) { $('.field-error', form).textContent = error.message; button.disabled = false; button.innerHTML = `${icon('plus')}Create ticket`; } else toast(error.message, true); }
  });
}
function openTechnician(person = null) {
  const userId = state.session?.user.id;
  const editing = Boolean(person);
  showModal(`<form id="technician-form"><header class="modal-header"><div><h2>${editing ? 'Edit team member' : 'Add a technician'}</h2><p>${editing ? 'Keep access and details up to date.' : 'Give a teammate a place in your support workspace.'}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close technician form">${icon('close')}</button></header><div class="modal-body modal-form"><div class="field"><label for="tech-name">Full name</label><input id="tech-name" class="input" name="name" required maxlength="100" value="${esc(person?.name)}" placeholder="Alex Morgan" autofocus></div><div class="field"><label for="tech-email">Email address</label><input id="tech-email" class="input" name="email" type="email" required maxlength="254" value="${esc(person?.email)}" placeholder="alex@company.com"${editing ? ' disabled' : ''}></div><div class="field"><label for="tech-password">${editing ? 'New password (optional)' : 'Temporary password'}</label><input id="tech-password" class="input" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200"${editing ? '' : ' required'} placeholder="At least 12 characters"><small>Share credentials securely. Creating an account does not send an invitation email.</small></div><div class="field-grid"><div class="field"><label for="tech-role">Role</label><select id="tech-role" name="role"><option value="technician"${person?.role !== 'admin' ? ' selected' : ''}>Technician</option><option value="admin"${person?.role === 'admin' ? ' selected' : ''}>Administrator</option></select></div>${editing ? `<div class="field"><label for="tech-active">Access</label><select id="tech-active" name="active"><option value="1"${person.active ? ' selected' : ''}>Active</option><option value="0"${!person.active ? ' selected' : ''}>Inactive</option></select></div>` : ''}</div><div class="field-error" role="alert"></div></div><footer class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${editing ? 'Save team member' : 'Create technician'}</button></footer></form>`);
  $('#technician-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); if (!values.password) delete values.password; if (editing) values.active = values.active === '1';
    const button = $('button[type=submit]', form); button.disabled = true;
    try { await api(`/api/desk/technicians${editing ? `/${encodeURIComponent(person.id)}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: values }); if (state.session?.user.id !== userId || !modal.open || !form.isConnected) return; modal.close(); toast(editing ? 'Team member updated.' : 'Technician added to your team.'); if (state.current === 'settings') await loadSettings(); else await refresh({ quiet: true }); }
    catch (error) { if (state.session?.user.id === userId && modal.open && form.isConnected) { $('.field-error', form).textContent = error.message; button.disabled = false; } }
  });
}

function renderAssetSection(ticket) {
  const assets = ticket.assets || [];
  const pending = ticket.pending_asset_links || [];
  return `<h2 class="drawer-section-label">Affected assets</h2>${assets.length ? `<div class="asset-chips">${assets.map(asset => articleLink(asset, asset.ref, 'asset-chip')).join('')}</div>` : ''}${pending.map(link => `<div class="pending-asset">${icon('clock')}<span>${esc(link.ref)} · ${link.error ? esc(link.error) : 'Linking the asset record…'}</span></div>`).join('')}<form class="asset-link-form" id="asset-link-form"><div class="field"><label for="link-asset-id">Asset ID</label><input class="input" id="link-asset-id" name="ref" list="known-assets" required maxlength="64" placeholder="Choose or enter an asset ID"><datalist id="known-assets">${state.assets.map(asset => `<option value="${esc(asset.ref)}"></option>`).join('')}</datalist></div><button class="btn" type="submit">${icon('plus')}Link asset</button></form>`;
}
function renderRelatedTickets(ticket) {
  const related = ticket.related_tickets || [];
  if (!related.length) return '';
  return `<h2 class="drawer-section-label">Related tickets</h2><div class="related-list">${related.map(item => `<button class="related-ticket" data-ticket="${esc(item.key)}"><span><strong>${esc(item.subject)}</strong><small>${esc(item.requester)}${item.resolution ? ` · ${esc(String(item.resolution).slice(0, 90))}` : ''}</small></span>${pill(item.status)}</button>`).join('')}</div>`;
}
function renderResponseTools() {
  return `<div class="response-tools"><label class="sr-only" for="response-template">Response template</label><select id="response-template"${state.responses.length ? '' : ' disabled'}><option value="">${state.responses.length ? 'Choose a response template…' : 'No response templates yet'}</option>${state.responses.map(response => `<option value="${esc(response.id)}">${esc(response.title)}</option>`).join('')}</select><button class="btn" type="button" data-action="insert-template"${state.responses.length ? '' : ' disabled'}>Insert template</button></div>${state.session.user.role === 'admin' ? '<div class="template-manage"><span>A consistent start, with room for a human touch.</span><button class="view-link" type="button" data-action="manage-responses">Manage templates</button></div>' : ''}`;
}
function expandResponse(body) {
  const ticket = state.ticket;
  const values = { requester: ticket.requester_name || ticket.requester, technician: state.session.user.name, ticket_id: ticket.key, subject: ticket.subject };
  return String(body).replace(/\{\{\s*(requester|technician|ticket_id|subject)\s*\}\}/g, (match, field) => values[field]);
}
function insertResponse() {
  const response = state.responses.find(item => item.id === $('#response-template')?.value);
  if (!response) { toast('Choose a response template first.', true); return; }
  const field = $('#note-body');
  const insertion = expandResponse(response.body);
  field.value = field.value.trim() ? `${field.value.trim()}\n\n${insertion}` : insertion;
  field.focus();
  toast('Template inserted. Review and personalize before copying.');
}
async function copyResponse() {
  const field = $('#note-body');
  const value = field?.value.trim();
  if (!value) { toast('Write or insert a response to copy first.', true); return; }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else { field.focus(); field.select(); if (!document.execCommand('copy')) throw new Error('Clipboard unavailable'); }
    toast('Response copied. Send it through your email client; nothing was sent here.');
  } catch { field.focus(); field.select(); toast('Clipboard access is unavailable. The response is selected; copy it manually.', true); }
}
async function pollAssetLinks(key) {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!drawer.open || state.ticket?.key !== key) return;
    try {
      await reloadTicket({ preserveEdits: true, quiet: true });
      if (!(state.ticket.pending_asset_links || []).length) { toast('Asset record linked to this ticket.'); await refresh({ quiet: true }); return; }
      if ((state.ticket.pending_asset_links || []).some(link => link.error)) return;
    } catch { return; }
  }
}
async function openResponseLibrary(editing = null, { refreshOnly = false } = {}) {
  const libraryIsOpen = () => modal.open && modal.dataset.responseLibrary === 'true';
  if (refreshOnly && !libraryIsOpen()) return;
  try { const data = await api('/api/desk/responses'); state.responses = data.responses || []; }
  catch (error) { toast(error.message, true); return; }
  // A completed request must respect Escape or navigation while it was pending.
  if (refreshOnly && !libraryIsOpen()) return;
  showModal(`<header class="modal-header"><div><h2>Response templates</h2><p>Shared starting points for thoughtful, consistent replies.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close response templates">${icon('close')}</button></header><div class="modal-body">${!editing ? `<div class="response-library">${state.responses.length ? state.responses.map(response => `<article class="response-card"><div class="response-card-top"><h3>${esc(response.title)}</h3><div class="response-card-actions"><button class="btn" type="button" data-edit-response="${esc(response.id)}">Edit</button><button class="btn danger" type="button" data-archive-response="${esc(response.id)}" aria-label="Archive ${esc(response.title)}">Archive</button></div></div><p>${esc(response.body)}</p></article>`).join('') : '<p class="empty-small">Create a template your team can personalize for common requests.</p>'}</div><h3 class="drawer-section-label">Create a template</h3>` : '<h3 class="drawer-section-label">Edit template</h3>'}<form class="modal-form" id="response-form"><div class="field"><label for="response-title">Template title</label><input class="input" id="response-title" name="title" required maxlength="100" placeholder="Hardware troubleshooting" value="${esc(editing?.title)}"></div><div class="field"><label for="response-body">Template message</label><textarea id="response-body" name="body" required rows="5" maxlength="10000" placeholder="Hi {{requester}}, thank you for getting in touch…">${esc(editing?.body)}</textarea></div><p class="response-placeholder-hint">Personalize automatically with <code>{{requester}}</code>, <code>{{technician}}</code>, <code>{{ticket_id}}</code>, and <code>{{subject}}</code>. Templates are drafts, never automatically sent.</p><div class="field-error" role="alert"></div><button class="btn primary" type="submit">${editing ? 'Save template' : 'Create template'}</button></form></div>`);
  modal.dataset.responseLibrary = 'true';
  $('#response-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const button = $('button[type=submit]', form); button.disabled = true;
    try { await api(`/api/desk/responses${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: values }); toast(editing ? 'Template updated.' : 'Response template created.'); await openResponseLibrary(null, { refreshOnly: true }); }
    catch (error) { $('.field-error', form).textContent = error.message; button.disabled = false; }
  });
}
function setPropertyDisabled(disabled) {
  const form = $('#ticket-update');
  if (form) form.setAttribute('aria-busy', String(disabled));
  drawer.querySelectorAll('#ticket-update button, #ticket-update input, #ticket-update select, #ticket-update textarea, [data-action="first-response"]').forEach(control => { control.disabled = disabled; });
}

document.addEventListener('click', async event => {
  const asset = event.target.closest('[data-asset]'); if (asset) { event.preventDefault(); openAsset(asset.dataset.asset); return; }
  const editCategory = event.target.closest('[data-edit-category]'); if (editCategory) { openCategoryManager(editCategory.dataset.editCategory); return; }
  const article = event.target.closest('[data-article]'); if (article) { event.preventDefault(); openArticle(article.dataset.article); return; }
  const editResponse = event.target.closest('[data-edit-response]'); if (editResponse) { openResponseLibrary(state.responses.find(response => response.id === editResponse.dataset.editResponse), { refreshOnly: true }); return; }
  const archiveResponse = event.target.closest('[data-archive-response]'); if (archiveResponse) { try { await api(`/api/desk/responses/${encodeURIComponent(archiveResponse.dataset.archiveResponse)}`, { method: 'PATCH', body: { active: false } }); toast('Response template archived.'); await openResponseLibrary(null, { refreshOnly: true }); } catch (error) { toast(error.message, true); } return; }
  const ticket = event.target.closest('[data-ticket]'); if (ticket) { openTicket(ticket.dataset.ticket); return; }
  const technician = event.target.closest('[data-edit-technician]'); if (technician) { openTechnician(state.technicians.find(person => person.id === technician.dataset.editTechnician)); return; }
  const nav = event.target.closest('[data-nav]'); if (nav) { event.preventDefault(); navigate(nav.dataset.nav); return; }
  const view = event.target.closest('[data-view]'); if (view) { state.view = view.dataset.view; state.status = ''; state.offset = 0; if (!['overview', 'tickets', 'my-tickets'].includes(state.current)) state.current = 'tickets'; await refresh({ quiet: true }); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'menu') $('.shell')?.classList.toggle('menu-open');
  else if (action === 'logout') { try { await api('/api/desk/logout', { method: 'POST', body: {} }); state.session = null; state.dashboard = null; state.ticketTag = null; state.reports = newReportState(); actionsUI.reset(); closeDialogs(); renderLogin(); } catch (error) { toast(error.message, true); } }
  else if (action === 'refresh') refresh({ quiet: true });
  else if (action === 'new-ticket') openNewTicket();
  else if (action === 'new-technician') openTechnician();
  else if (action === 'insert-template') insertResponse();
  else if (action === 'copy-response') copyResponse();
  else if (action === 'manage-responses') openResponseLibrary();
  else if (action === 'close-modal') modal.close();
  else if (action === 'close-drawer') drawer.close();
  else if (action === 'toggle-filters') { state.filtersOpen = !state.filtersOpen; renderContent(); }
  else if (action === 'prev-page') { state.offset = Math.max(0, state.offset - 20); refresh({ quiet: true }); }
  else if (action === 'next-page') { state.offset += 20; refresh({ quiet: true }); }
  else if (action === 'assign-me') patchTicket({ assignee_id: state.session.user.id, version: state.ticket.version });
  else if (action === 'first-response') patchTicket({ first_response: true, version: state.ticket.version });
  else if (action === 'new-article') editArticle();
  else if (action === 'edit-article') editArticle(state.article);
  else if (action === 'knowledge-back') navigate('knowledge');
  else if (action === 'cancel-article') cancelArticleEditing();
  else if (action === 'manage-categories') openCategoryManager();
  else if (action === 'new-category') openCategoryManager('new');
  else if (action === 'new-asset') openAssetForm(null, state.knowledgeCategory || state.assetCategory);
  else if (action === 'edit-asset') openAssetForm(state.asset);
  else if (action === 'assets-back') navigate('assets');
  else if (action === 'asset-prev') { state.assetOffset = Math.max(0, state.assetOffset - 30); loadAssets(); }
  else if (action === 'asset-next') { state.assetOffset += 30; loadAssets(); }
  else if (action === 'knowledge-prev') { state.knowledgeOffset = Math.max(0, state.knowledgeOffset - 50); loadKnowledge(); }
  else if (action === 'knowledge-next') { state.knowledgeOffset += 50; loadKnowledge(); }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-filter]')) { state[event.target.dataset.filter] = event.target.value; if (event.target.dataset.filter === 'status' && event.target.value) state.view = 'all'; state.offset = 0; refresh({ quiet: true }); }
  if (event.target.id === 'ticket-sort') { state.sort = event.target.value; state.offset = 0; refresh({ quiet: true }); }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !document.activeElement.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !drawer.open && !modal.open && !$('#login-summary-dialog')?.open) { event.preventDefault(); $('#global-search')?.focus(); }
});
modal.addEventListener('close', () => { if (modal.dataset.responseLibrary === 'true' && drawer.open && state.ticket) reloadTicket({ preserveEdits: true }).catch(error => toast(error.message, true)); });
for (const dialog of [modal, drawer]) dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
async function boot() {
  try { state.session = await api('/api/desk/session'); await loadWorkflow(); const initial = location.hash.slice(1); if (['overview', 'tickets', 'my-tickets', 'assets', 'team', 'knowledge', 'actions', 'reports', 'settings'].includes(initial)) state.current = initial; renderShell(); await restoreLocation(); }
  catch (error) { if (!state.session) renderLogin(error.status === 401 ? '' : 'Your workspace could not be reached. Please try again.'); else { app.innerHTML = `<div class="error-panel"><div><strong>Your workspace could not be loaded.</strong><p>${esc(error.message)}</p></div><button class="btn" id="startup-retry">Try again</button></div>`; $('#startup-retry').addEventListener('click', boot); } }
}
boot();
setInterval(() => { if (state.session && document.visibilityState === 'visible' && !drawer.open && !modal.open && !state.busy) refresh({ quiet: true }); }, 30000);
document.addEventListener('visibilitychange', () => { if (state.session && document.visibilityState === 'visible') { if (drawer.open && state.ticket) watchTicketPause(state.ticket); else if (!modal.open) refresh({ quiet: true }); } });

window.addEventListener('hashchange', () => {
  if (!state.session) return;
  if (state.current === 'settings' && state.settingsTab === 'ai' && location.hash !== '#settings') { if (!aiUI.canLeave()) { location.hash = '#settings'; return; } aiUI.leaveSettings(); }
  if (actionsUI.matches(location.hash)) { if (mayLeaveArticle()) actionsUI.open(location.hash); return; }
  if (state.current === 'actions') { if (!actionsUI.canLeave()) { location.hash = actionsUI.hash || '#actions'; return; } actionsUI.leave(); }
  const article = articleLocation();
  if (article) {
    if (state.current === 'knowledge' && state.article?.id === article.id) scrollArticleAnchor(article.id, article.anchor);
    else if (state.current !== 'knowledge' || state.articleTarget !== article.id) openArticle(article.id, { anchor: article.anchor });
    return;
  }
  const asset = location.hash.match(/^#assets\/([^/]+)$/);
  if (asset) { if (state.current !== 'assets' || (state.asset?.id !== asset[1] && state.assetTarget !== asset[1])) openAsset(asset[1]); return; }
  const ticket = location.hash.match(/^#tickets\/([^/]+)$/);
  if (ticket) { if (!drawer.open || drawer.dataset.ticketKey !== decodeURIComponent(ticket[1])) { activateView('tickets'); refresh({ quiet: true }); openTicket(decodeURIComponent(ticket[1])); } return; }
  const view = location.hash.slice(1);
  if (['overview', 'tickets', 'my-tickets', 'assets', 'team', 'knowledge', 'actions', 'reports', 'settings'].includes(view) && (view !== state.current || state.article || state.articleEditing || state.asset)) navigate(view);
});

// Native knowledge and inventory share the current AssetDesk session.
function articleLink(record, label, className) {
  const id = record?.id || record?.asset_id || record?.ref;
  return id ? `<button class="${className}" type="button" data-asset="${esc(id)}">${icon(record?.type === 'personnel' ? 'user' : 'laptop')}${esc(label)}${icon('chevron')}</button>` : `<span class="${className}">${esc(label)}</span>`;
}
function ticketMirrorSignature(ticket) { return JSON.stringify([ticket?.key, ticket?.version, ticket?.assets, ticket?.pending_asset_links, ticket?.tags]); }
function articleLocation() {
  const match = location.hash.match(/^#knowledge\/article\/([A-Za-z0-9_-]+)(?:#([A-Za-z][A-Za-z0-9_-]{0,199}))?$/);
  return match ? { id: match[1], anchor: match[2] || '' } : null;
}
function scrollArticleAnchor(id, anchor) {
  if (!anchor) return false;
  const prefix = `doc-${id}-`;
  const target = document.getElementById(anchor.startsWith(prefix) ? anchor : `${prefix}${anchor}`);
  if (!target || !$('#knowledge-article-body')?.contains(target)) return false;
  target.scrollIntoView({ block: 'start' });
  return true;
}
async function restoreLocation() {
  if (actionsUI.matches(location.hash)) { await actionsUI.open(location.hash); return; }
  const article = articleLocation();
  const asset = location.hash.match(/^#assets\/([^/]+)$/);
  const ticket = location.hash.match(/^#tickets\/([^/]+)$/);
  if (article) await openArticle(article.id, { anchor: article.anchor });
  else if (asset) await openAsset(asset[1]);
  else if (ticket) { activateView('tickets'); await refresh(); await openTicket(decodeURIComponent(ticket[1])); }
  else await refresh();
}
function mayLeaveArticle() {
  if (state.articleSaving) { toast('Finishing the article save. Please wait a moment.'); return false; }
  return !state.articleEditing || !state.articleDirty || window.confirm('Discard your unsaved article changes?');
}
function activateView(view) {
  state.generation++; state.current = view; closeDialogs(); $('.shell')?.classList.remove('menu-open');
  document.querySelectorAll('[data-nav]').forEach(button => { const active = button.dataset.nav === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#breadcrumb-current').textContent = currentTitle();
}
function canEditCategory(category) {
  if (!category) return false;
  if (state.session.user.role === 'admin') return true;
  if (typeof category.canEdit === 'boolean') return category.canEdit;
  if (typeof category.can_edit === 'boolean') return category.can_edit;
  return (category.editor_ids || []).includes(state.session.user.id) || (category.visibility === 'all' && category.allow_staff_edit !== false);
}
async function fetchCategories() {
  const result = await api('/api/desk/knowledge/categories');
  state.categories = result.categories || [];
  return state.categories;
}
function categoryOptions(selected, { editable = false, assetOnly = false } = {}) {
  return state.categories.filter(category => (!editable || canEditCategory(category)) && (!assetOnly || category.kind === 'assets')).map(category => `<option value="${esc(category.id)}"${category.id === selected ? ' selected' : ''}>${esc(category.name)}${category.visibility === 'restricted' ? ' · restricted' : ''}</option>`).join('');
}
function categoryBadge(category) { return category?.visibility === 'restricted' ? `<span class="permission-badge">${icon('lock')}Restricted</span>` : ''; }
function knowledgeHeading() {
  const editable = state.categories.some(canEditCategory);
  return `<div class="page-heading"><div><div class="eyebrow">Your team’s shared knowledge</div><h1>Knowledge base</h1><p>Guides, people, and equipment. Organized here, with access controlled by category.</p></div><div class="heading-actions">${state.session.user.role === 'admin' ? `<button class="btn" data-action="manage-categories">${icon('shield')}Manage categories</button>` : ''}${editable ? `<button class="btn primary" data-action="new-article">${icon('plus')}New article</button>` : ''}</div></div>`;
}
async function loadKnowledge() {
  if (!state.session || state.current !== 'knowledge' || state.articleEditing) return;
  const generation = ++state.knowledgeGeneration;
  if (!state.knowledge) $('#main-content').innerHTML = `${knowledgeHeading()}${loadingPanel()}`;
  const params = new URLSearchParams({ limit: '50', offset: String(state.knowledgeOffset) });
  if (state.knowledgeSearch) params.set('search', state.knowledgeSearch);
  if (state.knowledgeCategory) params.set('category_id', state.knowledgeCategory);
  try {
    const knowledge = await api(`/api/desk/knowledge?${params}`);
    if (generation !== state.knowledgeGeneration || state.current !== 'knowledge' || state.articleEditing || state.article) return;
    state.knowledge = knowledge; state.categories = knowledge.categories || [];
    renderKnowledge();
  } catch (error) {
    if (generation !== state.knowledgeGeneration || state.current !== 'knowledge' || !state.session) return;
    $('#main-content').innerHTML = `${knowledgeHeading()}<div class="error-panel">${icon('alert')}<div><strong>Your knowledge base could not be loaded.</strong><p>${esc(error.message)}</p></div><button class="btn" data-action="refresh">Try again</button></div>`;
  }
}
function renderKnowledge() {
  if (state.articleEditing) { renderArticleEditor(); return; }
  if (state.article) { renderArticle(); return; }
  $('#breadcrumb-current').textContent = 'Knowledge base'; document.title = 'Knowledge base · AssetDesk';
  const knowledge = state.knowledge || { categories: [], articles: [], assets: [], total: 0 };
  const selected = state.categories.find(category => category.id === state.knowledgeCategory);
  const assetsArea = selected?.kind === 'assets';
  const wasSearching = document.activeElement?.id === 'knowledge-search';
  const selection = wasSearching ? document.activeElement.selectionStart : null;
  const assetCategories = state.categories.filter(category => category.kind === 'assets');
  const rows = (knowledge.articles || []).map(article => `<button class="knowledge-article-card" data-article="${esc(article.id)}"><span class="article-card-icon">${icon('note')}</span><span><strong>${esc(article.name)}</strong><span class="article-excerpt">${esc(article.excerpt || 'Open this article to read the complete guide.')}</span><span class="article-updated">Updated ${esc(ago(article.updated_at))}</span></span>${icon('chevron')}</button>`).join('');
  const assetSection = assetsArea ? `<section class="native-kb-assets"><div class="panel-header"><div><h2 class="panel-title">${esc(selected.name)}</h2><p class="panel-subtitle">Personnel, hardware, and their complete ticket history.</p></div>${canEditCategory(selected) ? `<button class="btn" data-action="new-asset">${icon('plus')}New asset</button>` : ''}</div>${renderAssetCards(knowledge.assets || [], { compact: true })}<h2 class="drawer-section-label">Asset documentation</h2></section>` : !state.knowledgeCategory && assetCategories.length ? `<div class="knowledge-asset-areas">${assetCategories.map(category => `<button class="knowledge-assets-area" data-knowledge-category="${esc(category.id)}"><span class="asset-device">${icon('laptop')}</span><span><strong>${esc(category.name)}</strong><small>People, equipment, and linked support history</small></span>${icon('chevron')}</button>`).join('')}</div>` : '';
  $('#main-content').innerHTML = `${knowledgeHeading()}<div class="knowledge-layout"><aside class="panel knowledge-chapters" aria-label="Knowledge categories"><h2>Browse categories</h2><button class="knowledge-chapter${state.knowledgeCategory ? '' : ' active'}" data-knowledge-category="">${icon('book')}All articles</button>${state.categories.map(category => `<button class="knowledge-chapter${category.id === state.knowledgeCategory ? ' active' : ''}" data-knowledge-category="${esc(category.id)}">${icon(category.kind === 'assets' ? 'laptop' : 'note')}<span>${esc(category.name)}</span>${category.visibility === 'restricted' ? icon('lock') : ''}</button>`).join('')}<p class="knowledge-sidebar-note">Only categories available to your account appear here.</p></aside><section class="panel knowledge-library" aria-label="Knowledge articles"><div class="knowledge-search-wrap"><form id="knowledge-search-form" role="search"><label class="sr-only" for="knowledge-search">Search knowledge base</label>${icon('search')}<input class="input" id="knowledge-search" type="search" placeholder="Search articles and how-to guides…" value="${esc(state.knowledgeSearch)}" autocomplete="off"><button class="btn" type="submit">Search</button></form><div class="native-category-title">${selected ? `<strong>${esc(selected.name)}</strong>${categoryBadge(selected)}` : '<span>All accessible articles</span>'}<span class="small muted">${Number(knowledge.total || 0)} article${Number(knowledge.total || 0) === 1 ? '' : 's'}</span></div></div>${assetSection}${rows ? `<div class="knowledge-article-list">${rows}</div>` : emptyState(state.knowledgeSearch ? 'No matching articles.' : assetsArea ? 'Document what keeps your team moving.' : 'Share the answer once.', state.knowledgeSearch ? 'Try another search or category.' : 'Create a guide, procedure, or troubleshooting note in a category your team can access.', { symbol: 'book', action: state.categories.some(canEditCategory) ? `<button class="btn" data-action="new-article">${icon('plus')}Create an article</button>` : '' })}<div class="table-footer"><span>${knowledge.total ? `${state.knowledgeOffset + 1}–${Math.min(state.knowledgeOffset + knowledge.articles.length, knowledge.total)} of ${knowledge.total}` : 'Your knowledge grows with your team'}</span><div class="pagination"><button class="icon-button" data-action="knowledge-prev" aria-label="Previous articles"${state.knowledgeOffset === 0 ? ' disabled' : ''}>${icon('left')}</button><button class="icon-button" data-action="knowledge-next" aria-label="Next articles"${state.knowledgeOffset + 50 >= Number(knowledge.total || 0) ? ' disabled' : ''}>${icon('chevron')}</button></div></div></section></div>`;
  $('#knowledge-search-form').addEventListener('submit', event => { event.preventDefault(); state.knowledgeSearch = $('#knowledge-search').value.trim(); state.knowledgeOffset = 0; loadKnowledge(); });
  let timer;
  $('#knowledge-search').addEventListener('input', event => { state.knowledgeSearch = event.target.value; state.knowledgeOffset = 0; clearTimeout(timer); timer = setTimeout(loadKnowledge, 300); });
  if (wasSearching) { const input = $('#knowledge-search'); input.focus({ preventScroll: true }); if (typeof selection === 'number') input.setSelectionRange(selection, selection); }
}
async function openArticle(value, { anchor = '' } = {}) {
  const id = String(value || '');
  if (!id || !mayLeaveArticle()) return;
  const generation = ++state.knowledgeGeneration;
  state.articleEditing = false; state.articleDirty = false; state.article = null; state.asset = null;
  state.articleTarget = id; activateView('knowledge'); location.hash = `knowledge/article/${encodeURIComponent(id)}${anchor ? `#${anchor}` : ''}`;
  document.title = 'Opening article · AssetDesk';
  $('#main-content').innerHTML = `<div class="knowledge-back-row"><button class="view-link" data-action="knowledge-back">${icon('left')}Back to knowledge base</button></div>${loadingPanel()}`;
  try {
    const article = await api(`/api/desk/knowledge/articles/${encodeURIComponent(id)}`);
    if (generation !== state.knowledgeGeneration || state.current !== 'knowledge' || state.articleTarget !== id) return;
    state.article = article; renderArticle();
    if (!scrollArticleAnchor(id, articleLocation()?.anchor)) $('#main-content').scrollIntoView({ block: 'start' });
  } catch (error) {
    if (generation !== state.knowledgeGeneration || state.current !== 'knowledge' || !state.session) return;
    $('#main-content').innerHTML = `<div class="knowledge-back-row"><button class="view-link" data-action="knowledge-back">${icon('left')}Back to knowledge base</button></div><div class="error-panel">${icon('alert')}<div><strong>This article is unavailable.</strong><p>${esc(error.message)}</p></div><button class="btn" data-article="${esc(id)}">Try again</button></div>`;
  }
}
function renderArticle() {
  const article = state.article;
  if (!article) return;
  document.title = `${article.name} · AssetDesk`; $('#breadcrumb-current').textContent = 'Knowledge article';
  $('#main-content').innerHTML = `<div class="knowledge-back-row"><button class="view-link" data-action="knowledge-back">${icon('left')}Back to knowledge base</button><span class="role-badge">${esc(article.category?.name || 'Knowledge article')}</span></div><section class="panel article-reader" aria-label="Knowledge article"><header class="article-heading"><div><h1>${esc(article.name)}</h1><p>Updated ${esc(shortDate(article.updated_at))}</p></div>${article.canEdit ? `<button class="btn" data-action="edit-article">${icon('note')}Edit article</button>` : ''}</header><div class="article-body" id="knowledge-article-body"></div><footer class="article-footer">${icon('shield')}Access follows this article’s category permissions.</footer></section>`;
  $('#knowledge-article-body').innerHTML = article.html || '<p>This article is empty.</p>';
  const prefix = `#doc-${article.id}-`;
  $('#knowledge-article-body').querySelectorAll('a[href]').forEach(link => {
    const href = link.getAttribute('href');
    if (href.startsWith(prefix)) link.setAttribute('href', `#knowledge/article/${article.id}#${href.slice(prefix.length)}`);
  });
}
async function editArticle(article = null) {
  if (state.articleEditing && !mayLeaveArticle()) return;
  if (article && !article.canEdit) return;
  activateView('knowledge');
  try { await fetchCategories(); } catch (error) { toast(error.message, true); return; }
  const editable = state.categories.filter(canEditCategory);
  if (!editable.length) { toast('You do not have permission to create articles in an accessible category.', true); return; }
  state.articleEditing = true; state.articleDirty = false; state.articleSaving = false;
  state.articleDraft = article ? { ...article } : { id: null, name: '', html: '<p><br></p>', category_id: editable.some(category => category.id === state.knowledgeCategory) ? state.knowledgeCategory : editable[0].id };
  renderArticleEditor();
}
function renderArticleEditor() {
  const draft = state.articleDraft;
  if (!draft) return;
  $('#breadcrumb-current').textContent = draft.id ? 'Edit article' : 'New article'; document.title = `${draft.id ? 'Edit' : 'New'} article · AssetDesk`;
  $('#main-content').innerHTML = `<div class="knowledge-back-row"><button class="view-link" data-action="cancel-article">${icon('left')}Cancel editing</button><span class="small muted">Write clearly. Keep access intentional.</span></div><section class="panel article-editor-panel"><form id="article-editor-form"><header class="article-heading"><div><h1>${draft.id ? 'Edit article' : 'Create an article'}</h1><p>Write it once. Make the next support request easier.</p></div><div class="article-editor-actions"><button class="btn" type="button" data-action="cancel-article">Cancel editing</button><button class="btn primary" type="submit">Save article</button></div></header><div class="article-editor-fields"><div class="field"><label for="article-title">Article title</label><input class="input" id="article-title" name="name" required maxlength="255" placeholder="For example: Connect to the company VPN" value="${esc(draft.name)}"></div><div class="field"><label for="article-category">Article category</label><select id="article-category" name="category_id" required>${categoryOptions(draft.category_id, { editable: true })}</select><small>Readers and editors are controlled by the selected category.</small></div></div><div class="article-editing-surface"><div class="editor-toolbar" role="toolbar" aria-label="Article formatting"><button class="btn" type="button" data-editor-command="bold" aria-label="Bold"><strong>B</strong></button><button class="btn" type="button" data-editor-command="italic" aria-label="Italic"><em>I</em></button><button class="btn" type="button" data-editor-command="formatBlock" data-editor-value="h2">Heading</button><button class="btn" type="button" data-editor-command="formatBlock" data-editor-value="p">Paragraph</button><button class="btn" type="button" data-editor-command="insertUnorderedList">Bulleted list</button><button class="btn" type="button" data-editor-command="insertOrderedList">Numbered list</button><button class="btn" type="button" data-editor-command="formatBlock" data-editor-value="pre">Code block</button><button class="btn" type="button" data-editor-link>Insert link</button></div><div class="editor-link-fields" id="editor-link-fields" hidden><label for="editor-link-url">Link URL</label><input class="input" id="editor-link-url" type="text" placeholder="https://example.com/guide or #knowledge/article/…"><button class="btn" type="button" id="editor-apply-link">Add link</button></div><label class="sr-only" for="article-body-editor">Article body</label><div class="article-rich-editor article-body" id="article-body-editor" role="textbox" aria-label="Article body" aria-multiline="true" contenteditable="true" spellcheck="true"></div><p class="editor-help">Paste inserts plain text. Use the formatting tools to add headings, lists, and links.</p></div><div class="article-editor-error field-error" role="alert"></div><footer class="article-save-footer"><span class="small muted" id="article-draft-state">Changes are saved when you select Save article.</span><button class="btn primary" type="submit">Save article</button></footer></form></section>`;
  const form = $('#article-editor-form'), editor = $('#article-body-editor'); editor.innerHTML = draft.html || '<p><br></p>';
  let selection = null;
  const rememberSelection = () => { const selected = window.getSelection(); if (selected.rangeCount && editor.contains(selected.anchorNode)) selection = selected.getRangeAt(0).cloneRange(); };
  const restoreSelection = () => { editor.focus(); if (selection) { const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(selection); } };
  const dirty = () => { state.articleDirty = true; $('#article-draft-state').textContent = 'Unsaved changes'; };
  editor.addEventListener('mouseup', rememberSelection); editor.addEventListener('keyup', rememberSelection); editor.addEventListener('input', () => { rememberSelection(); dirty(); });
  $('#article-title').addEventListener('input', dirty); $('#article-category').addEventListener('change', dirty);
  editor.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || ''); dirty(); });
  editor.addEventListener('drop', event => event.preventDefault());
  $('.editor-toolbar').addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  $('.editor-toolbar').addEventListener('click', event => {
    const command = event.target.closest('[data-editor-command]');
    if (command) { restoreSelection(); document.execCommand(command.dataset.editorCommand, false, command.dataset.editorValue || null); rememberSelection(); dirty(); }
    if (event.target.closest('[data-editor-link]')) { rememberSelection(); $('#editor-link-fields').hidden = !$('#editor-link-fields').hidden; if (!$('#editor-link-fields').hidden) $('#editor-link-url').focus(); }
  });
  $('#editor-apply-link').addEventListener('click', () => {
    const value = $('#editor-link-url').value.trim();
    let href;
    if (/^#(?:knowledge\/article\/[A-Za-z0-9_-]+(?:#[A-Za-z][A-Za-z0-9_-]{0,199})?|(?:assets|tickets)\/[A-Za-z0-9._-]+)$/.test(value)) href = value;
    else { let url; try { url = new URL(value); } catch { toast('Enter a complete web link or an AssetDesk article, asset, or ticket link.', true); return; } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { toast('Enter a safe HTTP or HTTPS link.', true); return; } href = url.href; }
    restoreSelection(); document.execCommand('createLink', false, href); rememberSelection(); dirty(); $('#editor-link-fields').hidden = true;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (state.articleSaving) return;
    const name = $('#article-title').value.trim(), html = editor.innerHTML;
    if (!name || !editor.textContent.trim()) { $('.article-editor-error').textContent = 'Add a title and some article content.'; return; }
    const payload = { name, html, category_id: $('#article-category').value }; if (draft.id) payload.version = draft.version;
    state.articleSaving = true; editor.contentEditable = 'false'; form.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; }); $('.article-editor-error').textContent = '';
    try { const saved = await api(`/api/desk/knowledge/articles${draft.id ? `/${encodeURIComponent(draft.id)}` : ''}`, { method: draft.id ? 'PATCH' : 'POST', body: payload }); state.articleSaving = false; state.articleDirty = false; state.articleEditing = false; state.article = saved.article || saved; state.articleDraft = null; location.hash = `knowledge/article/${state.article.id}`; renderArticle(); toast(draft.id ? 'Article updated.' : 'Article created.'); }
    catch (error) { state.articleSaving = false; editor.contentEditable = 'true'; form.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; }); $('.article-editor-error').textContent = error.status === 409 ? 'This article changed. Your draft is kept here. Copy your changes before reopening the latest version.' : error.message; }
  });
}
function cancelArticleEditing() { if (!mayLeaveArticle()) return; const previous = state.article; state.articleEditing = false; state.articleDirty = false; state.articleDraft = null; if (previous) renderArticle(); else navigate('knowledge'); }
async function openCategoryManager(editId = null) {
  if (state.session.user.role !== 'admin') return;
  try { const [categories, users] = await Promise.all([fetchCategories(), api('/api/desk/technicians')]); state.technicians = users.technicians || []; const editing = editId && editId !== 'new' ? categories.find(category => category.id === editId) : null; renderCategoryManager(categories, editing, editId === 'new'); }
  catch (error) { toast(error.message, true); }
}
function renderCategoryManager(categories, editing = null, creating = false) {
  const people = state.technicians.filter(person => person.active || editing?.reader_ids?.includes(person.id) || editing?.editor_ids?.includes(person.id));
  showModal(`<header class="modal-header"><div><h2>Knowledge categories & permissions</h2><p>Choose who can find, read, and edit information in each category.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close category permissions">${icon('close')}</button></header><div class="modal-body">${!creating && !editing ? `<div class="category-manager-list">${categories.map(category => `<article class="category-manager-row"><span class="category-manager-icon">${icon(category.kind === 'assets' ? 'laptop' : 'book')}</span><div><strong>${esc(category.name)}</strong><p>${category.visibility === 'restricted' ? 'Restricted to selected people' : 'All staff can view'} · ${category.kind === 'assets' ? 'Assets area' : 'Knowledge'}</p></div><button class="btn" data-edit-category="${esc(category.id)}" aria-label="Edit category ${esc(category.name)}">Edit</button></article>`).join('')}</div><button class="btn primary" data-action="new-category">${icon('plus')}New category</button>` : `<form id="category-form" class="modal-form"><h3>${editing ? 'Edit category' : 'Create a category'}</h3><div class="field"><label for="category-name">Category name</label><input class="input" id="category-name" name="name" required maxlength="100" value="${esc(editing?.name)}"></div><div class="field"><label for="category-description">Description</label><textarea id="category-description" name="description" maxlength="2000">${esc(editing?.description)}</textarea></div><div class="field-grid"><div class="field"><label for="category-kind">Category type</label><select id="category-kind" name="kind"${editing ? ' disabled' : ''}><option value="knowledge"${editing?.kind !== 'assets' ? ' selected' : ''}>Knowledge</option><option value="assets"${editing?.kind === 'assets' ? ' selected' : ''}>Assets area</option></select></div><div class="field"><label for="category-visibility">Visibility</label><select id="category-visibility" name="visibility"><option value="all"${editing?.visibility !== 'restricted' ? ' selected' : ''}>All staff</option><option value="restricted"${editing?.visibility === 'restricted' ? ' selected' : ''}>Restricted</option></select></div></div><label class="check-row" for="category-staff-edit"><input id="category-staff-edit" type="checkbox"${editing?.allow_staff_edit !== false ? ' checked' : ''}><span>Allow all staff to edit<small>Applies while visibility is All staff. Selected editors can edit restricted categories.</small></span></label><section class="category-access-list" aria-label="Category access"><div class="category-access-heading"><strong>People with access</strong><span>View</span><span>Edit</span></div>${people.map(person => `<div class="category-access-row"><div class="person">${avatar(person.name)}<span><strong>${esc(person.name)}</strong><small>${esc(person.email)}${person.role === 'admin' ? ' · Administrator' : ''}</small></span></div><input type="checkbox" name="readers" value="${esc(person.id)}" aria-label="Can view ${esc(person.name)}"${editing?.reader_ids?.includes(person.id) || editing?.editor_ids?.includes(person.id) || person.role === 'admin' ? ' checked' : ''}${person.role === 'admin' ? ' disabled' : ''}><input type="checkbox" name="editors" value="${esc(person.id)}" aria-label="Can edit ${esc(person.name)}"${editing?.editor_ids?.includes(person.id) || person.role === 'admin' ? ' checked' : ''}${person.role === 'admin' ? ' disabled' : ''}></div>`).join('')}</section><p class="permission-explainer">${icon('shield')}Administrators always have access. Editors can also view the category. Permissions apply to articles, asset records, search results, and images inside it.</p><div class="field-error" role="alert"></div><div class="modal-form-actions"><button class="btn" type="button" data-action="manage-categories">Back to categories</button><button class="btn primary" type="submit">${editing ? 'Save category' : 'Create category'}</button></div></form>`}</div>`);
  $('#category-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); const editors = values.getAll('editors'), readers = [...new Set([...values.getAll('readers'), ...editors])];
    const body = { name: values.get('name').trim(), description: values.get('description').trim(), visibility: values.get('visibility'), reader_ids: readers, editor_ids: editors, allow_staff_edit: $('#category-staff-edit').checked };
    if (editing) body.version = editing.version; else body.kind = values.get('kind');
    const button = $('button[type=submit]', form); button.disabled = true;
    try { await api(`/api/desk/knowledge/categories${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, { method: editing ? 'PATCH' : 'POST', body }); toast(editing ? 'Category permissions saved.' : 'Category created.'); await fetchCategories(); state.knowledge = null; if (state.current === 'knowledge' && !state.articleEditing && !state.article) await loadKnowledge(); await openCategoryManager(); }
    catch (error) { $('.field-error', form).textContent = error.message; button.disabled = false; }
  });
  modal.querySelectorAll('input[name=editors]').forEach(checkbox => checkbox.addEventListener('change', () => { if (checkbox.checked) { const viewer = [...modal.querySelectorAll('input[name=readers]')].find(input => input.value === checkbox.value); if (viewer) viewer.checked = true; } }));
}
function renderAssetCards(assets, { compact = false } = {}) {
  if (!assets.length) return emptyState('No asset records yet.', 'Add people, PCs, hardware, or other equipment. Ticket references will link to their records automatically.', { symbol: 'laptop' });
  return `<div class="asset-grid${compact ? ' compact-assets' : ''}">${assets.map(asset => `<article class="asset-card"><div class="asset-card-top"><span class="asset-device">${icon(asset.type === 'personnel' ? 'user' : 'laptop')}</span><span class="role-badge">${esc(assetTypeLabels[asset.type] || 'Asset')}</span></div><button class="native-asset-title" data-asset="${esc(asset.id || asset.ref)}">${esc(asset.name || asset.ref)}</button><div class="asset-ref mono">${esc(asset.ref)}</div><p>${esc(asset.type === 'personnel' ? [asset.email, asset.department].filter(Boolean).join(' · ') || 'Personnel record' : [asset.manufacturer, asset.model, asset.location].filter(Boolean).join(' · ') || 'Equipment record')}</p><div class="asset-card-foot"><span>${Number(asset.ticket_count || 0)} linked ticket${Number(asset.ticket_count || 0) === 1 ? '' : 's'}</span><button class="view-link" data-asset="${esc(asset.id || asset.ref)}">Open record ${icon('chevron')}</button></div></article>`).join('')}</div>`;
}
function resetAssetInventory() {
  state.assetGeneration++;
  Object.assign(state, { assets: [], asset: null, assetTarget: null, assetTypes: [], assetTypeCounts: {}, assetLocations: [], assetLocationCounts: [], assetLocationsOpen: false, assetLocationMenuSearch: '', assetHardwareOpen: false, assetSearch: '', assetSearchDraft: '', assetCategory: '', assetOffset: 0, assetTotal: 0 });
}
function assetTypeCount(types) { return types.reduce((total, type) => total + Number(state.assetTypeCounts[type] || 0), 0); }
function assetTypePressed(types) {
  const count = types.filter(type => state.assetTypes.includes(type)).length;
  return count === types.length ? 'true' : count ? 'mixed' : 'false';
}
function assetSelectionLabel() {
  if (!state.assetTypes.length) return 'Showing all asset types';
  const selected = new Set(state.assetTypes), labels = [];
  if (selected.has('personnel')) labels.push('Personnel');
  if (hardwareAssetTypes.every(type => selected.has(type))) labels.push('Hardware');
  else labels.push(...hardwareAssetTypes.filter(type => selected.has(type)).map(type => assetGroupLabels[type]));
  if (selected.has('other')) labels.push('Other');
  return 'Showing ' + labels.join(' + ');
}
function assetTypeButton(id, label, types, symbol) {
  const pressed = types.length ? assetTypePressed(types) : String(!state.assetTypes.length);
  return `<button class="asset-type-chip" type="button" id="asset-types-${id}" data-asset-types="${types.join(',')}" aria-label="${types.length ? 'Show ' + esc(label) : 'All types'}" aria-pressed="${pressed}">${icon(symbol)}<span>${esc(label)}</span><span class="asset-type-count" aria-hidden="true">${assetTypeCount(types.length ? types : Object.keys(assetTypeLabels))}</span></button>`;
}
function renderAssetTypeControls() {
  return `<section class="panel asset-type-panel" aria-label="Show asset types">
    <header><div><h2>Show asset types</h2><p>Choose one or combine several. All types resets the view.</p></div><span id="asset-filter-selection" class="asset-selection-label" role="status">${esc(assetSelectionLabel())}</span></header>
    <div class="asset-type-buttons" role="group" aria-label="Quick asset type filters">${assetTypeButton('all', 'All types', [], 'grid')}${assetTypeButton('personnel', 'Personnel', ['personnel'], 'users')}${assetTypeButton('hardware', 'Hardware', hardwareAssetTypes, 'laptop')}${assetTypeButton('other', 'Other', ['other'], 'grid')}</div>
    <details class="asset-hardware-types" id="asset-hardware-types"${state.assetHardwareOpen ? ' open' : ''}><summary>Hardware types <span>Choose specific equipment types</span>${icon('down')}</summary><div class="asset-type-buttons" role="group" aria-label="Hardware type filters">${hardwareAssetTypes.map(type => assetTypeButton('type-' + type, assetGroupLabels[type], [type], 'laptop')).join('')}</div></details>
  </section>`;
}
function assetLocationRows() {
  const rows = state.assetLocationCounts.map(row => ({ ...row }));
  for (const location of state.assetLocations) if (!rows.some(row => row.location === location)) rows.push({ location, count: 0 });
  return rows;
}
function assetLocationLabel(location) { return location || 'No location set'; }
function assetLocationSelectionLabel() {
  return state.assetLocations.length ? 'Showing ' + state.assetLocations.map(assetLocationLabel).join(' + ') : 'Showing all locations';
}
function assetLocationButton(row, index, quick = false) {
  const label = assetLocationLabel(row.location);
  const suffix = row.location ? Array.from(row.location, char => char.codePointAt(0).toString(16)).join('-') : 'unset';
  return `<button class="asset-type-chip asset-location-chip" type="button" id="asset-location-${suffix}" data-asset-location="${index}" data-asset-location-value="${esc(row.location)}"${quick ? ' data-asset-location-quick' : ''} aria-label="${row.location ? 'Show location ' + esc(row.location) : 'Show assets without a location'}" aria-pressed="${state.assetLocations.includes(row.location)}" title="${esc(label)}">${icon('grid')}<span>${esc(label)}</span><span class="asset-type-count" aria-hidden="true">${Number(row.count || 0)}</span></button>`;
}
function renderAssetLocationControls() {
  const rows = assetLocationRows();
  const top = rows.filter(row => row.location && row.count > 0).slice(0, 5);
  const rest = rows.filter(row => !top.includes(row));
  const selectedRest = rest.filter(row => state.assetLocations.includes(row.location)).length;
  const total = state.assetLocationCounts.reduce((sum, row) => sum + Number(row.count || 0), 0);
  return `<section class="panel asset-type-panel asset-location-panel" aria-label="Show asset locations">
    <header><div><h2>Show asset locations</h2><p>The five most-used locations in this view. Choose one or combine several.</p></div><span id="asset-location-selection" class="asset-selection-label" role="status">${esc(assetLocationSelectionLabel())}</span></header>
    <div class="asset-type-buttons" role="group" aria-label="Top asset locations"><button class="asset-type-chip" id="asset-locations-all" type="button" data-asset-location-reset aria-label="All locations" aria-pressed="${!state.assetLocations.length}">${icon('grid')}<span>All locations</span><span class="asset-type-count" aria-hidden="true">${total}</span></button>${top.map(row => assetLocationButton(row, rows.indexOf(row), true)).join('')}</div>
    ${!top.length ? '<p class="asset-location-empty">No named locations match this view.</p>' : ''}
    ${rest.length ? `<details class="asset-hardware-types asset-more-locations" id="asset-more-locations"${state.assetLocationsOpen ? ' open' : ''}><summary>More locations <span>${rest.length} additional option${rest.length === 1 ? '' : 's'}${selectedRest ? ` · ${selectedRest} selected` : ''}</span>${icon('down')}</summary><div class="asset-location-menu"><label for="asset-location-search">Find a location</label><input class="input" type="search" id="asset-location-search" placeholder="Filter the location list…" value="${esc(state.assetLocationMenuSearch)}"><div class="asset-type-buttons" role="group" aria-label="More asset locations">${rest.map(row => assetLocationButton(row, rows.indexOf(row))).join('')}</div><p class="asset-location-empty" id="asset-location-menu-empty" hidden>No locations match this list search.</p></div></details>` : ''}
  </section>`;
}
function filterAssetLocationMenu(rows) {
  const query = state.assetLocationMenuSearch.trim().toLocaleLowerCase();
  let visible = 0;
  document.querySelectorAll('[aria-label="More asset locations"] [data-asset-location]').forEach(button => {
    const row = rows[Number(button.dataset.assetLocation)];
    button.hidden = Boolean(query && !assetLocationLabel(row.location).toLocaleLowerCase().includes(query));
    if (!button.hidden) visible++;
  });
  const empty = $('#asset-location-menu-empty'); if (empty) empty.hidden = visible > 0;
}
function applyAssetLocation(location, rows) {
  const next = location === null ? [] : state.assetLocations.includes(location) ? state.assetLocations.filter(item => item !== location) : [...state.assetLocations, location];
  if (next.length > 100 || JSON.stringify(next).length > 8192) { toast('Choose fewer locations to keep this filter within the request limit.', true); return; }
  state.assetLocations = next; state.assetSearch = state.assetSearchDraft.trim(); state.assetOffset = 0;
  document.querySelectorAll('[data-asset-location]').forEach(button => button.setAttribute('aria-pressed', state.assetLocations.includes(rows[Number(button.dataset.assetLocation)].location)));
  $('#asset-locations-all').setAttribute('aria-pressed', !state.assetLocations.length);
  $('#asset-location-selection').textContent = assetLocationSelectionLabel();
  loadAssets();
}
function renderGroupedAssets() {
  if (!state.assets.length) return `<section class="panel" aria-label="Asset groups">${emptyState('No matching assets.', 'Try another combination of types, locations, search text, or knowledge category.', { symbol: 'laptop' })}</section>`;
  return `<div class="asset-groups" role="region" aria-label="Asset groups">${Object.entries(assetGroupLabels).map(([type, label]) => {
    const assets = state.assets.filter(asset => asset.type === type);
    if (!assets.length) return '';
    const total = Number(state.assetTypeCounts[type] ?? assets.length);
    return `<section class="asset-type-group" data-asset-group="${type}" aria-labelledby="asset-group-${type}"><header class="asset-group-heading"><div><span class="asset-group-icon">${icon(type === 'personnel' ? 'users' : 'laptop')}</span><h2 id="asset-group-${type}">${esc(label)} <span class="count-badge">${total}</span></h2></div>${total > assets.length ? `<span>${assets.length} shown on this page</span>` : ''}</header>${renderAssetCards(assets)}</section>`;
  }).join('')}</div>`;
}
function applyAssetTypes(types) {
  const selected = new Set(state.assetTypes);
  if (!types.length) selected.clear();
  else if (types.every(type => selected.has(type))) types.forEach(type => selected.delete(type));
  else types.forEach(type => selected.add(type));
  state.assetTypes = Object.keys(assetTypeLabels).filter(type => selected.has(type));
  if (state.assetTypes.length === Object.keys(assetTypeLabels).length) state.assetTypes = [];
  state.assetSearch = state.assetSearchDraft.trim(); state.assetOffset = 0;
  document.querySelectorAll('[data-asset-types]').forEach(button => {
    const types = button.dataset.assetTypes ? button.dataset.assetTypes.split(',') : [];
    button.setAttribute('aria-pressed', types.length ? assetTypePressed(types) : String(!state.assetTypes.length));
  });
  $('#asset-filter-selection').textContent = assetSelectionLabel();
  loadAssets();
}
async function loadAssets() {
  if (!state.session || state.current !== 'assets' || state.asset) return;
  const generation = ++state.assetGeneration, user = state.session.user.id;
  $('#breadcrumb-current').textContent = 'Assets'; document.title = 'Assets · AssetDesk';
  const params = new URLSearchParams({ limit: '30', offset: String(state.assetOffset), sort: 'type' });
  if (state.assetSearch) params.set('search', state.assetSearch);
  if (state.assetTypes.length) params.set('types', state.assetTypes.join(','));
  if (state.assetLocations.length) params.set('locations', JSON.stringify(state.assetLocations));
  if (state.assetCategory) params.set('category_id', state.assetCategory);
  $('[aria-label="Asset groups"]')?.setAttribute('aria-busy', 'true');
  const active = () => generation === state.assetGeneration && state.session?.user.id === user && state.current === 'assets' && !state.asset;
  try {
    const [records, categories] = await Promise.all([api(`/api/desk/assets?${params}`), api('/api/desk/knowledge/categories')]);
    if (!active()) return;
    state.assets = records.assets || []; state.assetTotal = Number(records.total || 0); state.assetTypeCounts = records.type_counts || {}; state.assetLocationCounts = records.location_counts || []; state.categories = categories.categories || [];
    if (state.assetOffset && state.assetOffset >= state.assetTotal) { state.assetOffset = Math.max(0, Math.floor((state.assetTotal - 1) / 30) * 30); return loadAssets(); }
    renderAssetInventory();
  } catch (error) {
    if (!active()) return;
    $('#main-content').innerHTML = `<div class="error-panel">${icon('alert')}<div><strong>Assets could not be loaded.</strong><p>${esc(error.message)}</p></div><button class="btn" data-action="refresh">Try again</button></div>`;
  }
}
function renderAssetInventory() {
  const focused = document.activeElement;
  const focusId = focused?.closest('.asset-type-panel, .native-asset-toolbar') ? focused.id : '';
  const selection = ['asset-search', 'asset-location-search'].includes(focusId) ? [focused.selectionStart, focused.selectionEnd] : null;
  $('#breadcrumb-current').textContent = 'Assets'; document.title = 'Assets · AssetDesk';
  const selected = state.categories.find(category => category.id === state.assetCategory);
  $('#main-content').innerHTML = `<div class="page-heading"><div><div class="eyebrow">Your people & equipment</div><h1>Assets</h1><p>People, PCs, hardware, and the support history that connects them.</p></div><div class="heading-actions">${state.categories.some(category => category.kind === 'assets' && canEditCategory(category)) ? `<button class="btn primary" data-action="new-asset">${icon('plus')}New asset</button>` : ''}</div></div>
    ${renderAssetTypeControls()}
    ${renderAssetLocationControls()}
    <section class="panel native-asset-toolbar grouped-asset-toolbar" aria-label="Asset filters"><form id="asset-search-form" class="native-asset-search" role="search"><label class="sr-only" for="asset-search">Search assets</label>${icon('search')}<input class="input" id="asset-search" type="search" placeholder="Search names, asset IDs, people…" value="${esc(state.assetSearchDraft)}"><button class="btn" type="submit">Search</button></form><div class="field"><label for="asset-category-filter">Knowledge category</label><select id="asset-category-filter"><option value="">All accessible categories</option>${categoryOptions(state.assetCategory, { assetOnly: true })}</select></div></section>
    <div class="inventory-summary"><span>${state.assetTotal} matching asset${state.assetTotal === 1 ? '' : 's'} · grouped by type</span>${categoryBadge(selected)}${state.assetTypes.length || state.assetLocations.length || state.assetSearch || state.assetCategory ? '<button class="view-link" id="asset-clear-filters" type="button">Clear filters</button>' : ''}</div>
    ${renderGroupedAssets()}
    <div class="native-asset-pagination"><span>${state.assetTotal ? `${state.assetOffset + 1}–${Math.min(state.assetOffset + state.assets.length, state.assetTotal)} of ${state.assetTotal}` : 'No assets to show'}</span><div class="pagination"><button class="icon-button" data-action="asset-prev" aria-label="Previous assets"${state.assetOffset <= 0 ? ' disabled' : ''}>${icon('left')}</button><button class="icon-button" data-action="asset-next" aria-label="Next assets"${state.assetOffset + 30 >= state.assetTotal ? ' disabled' : ''}>${icon('chevron')}</button></div></div>`;
  $('#asset-search').addEventListener('input', event => { state.assetSearchDraft = event.target.value; });
  $('#asset-search-form').addEventListener('submit', event => { event.preventDefault(); state.assetSearch = state.assetSearchDraft.trim(); state.assetOffset = 0; loadAssets(); });
  $('#asset-category-filter').addEventListener('change', event => { state.assetCategory = event.target.value; state.assetSearch = state.assetSearchDraft.trim(); state.assetOffset = 0; loadAssets(); });
  document.querySelectorAll('[data-asset-types]').forEach(button => button.addEventListener('click', () => applyAssetTypes(button.dataset.assetTypes ? button.dataset.assetTypes.split(',') : [])));
  $('#asset-hardware-types').addEventListener('toggle', event => { state.assetHardwareOpen = event.target.open; });
  const locationRows = assetLocationRows();
  document.querySelectorAll('[data-asset-location]').forEach(button => button.addEventListener('click', () => applyAssetLocation(locationRows[Number(button.dataset.assetLocation)].location, locationRows)));
  $('#asset-locations-all').addEventListener('click', () => applyAssetLocation(null, locationRows));
  $('#asset-more-locations')?.addEventListener('toggle', event => { state.assetLocationsOpen = event.target.open; });
  $('#asset-location-search')?.addEventListener('input', event => { state.assetLocationMenuSearch = event.target.value; filterAssetLocationMenu(locationRows); });
  filterAssetLocationMenu(locationRows);
  $('#asset-clear-filters')?.addEventListener('click', clearAssetFilters);
  const nextFocus = focusId && document.getElementById(focusId);
  if (nextFocus) { nextFocus.focus({ preventScroll: true }); if (selection) nextFocus.setSelectionRange(...selection); }
}
function clearAssetFilters() {
  Object.assign(state, { assetTypes: [], assetLocations: [], assetLocationMenuSearch: '', assetSearch: '', assetSearchDraft: '', assetCategory: '', assetOffset: 0 });
  loadAssets();
}

async function openAsset(value, { quiet = false } = {}) {
  const id = String(value || ''); if (!id || !mayLeaveArticle()) return;
  const generation = ++state.assetGeneration; state.assetTarget = id; state.article = null; state.articleEditing = false;
  activateView('assets'); location.hash = `assets/${encodeURIComponent(id)}`;
  if (!quiet) $('#main-content').innerHTML = loadingPanel();
  try { const data = await api(`/api/desk/assets/${encodeURIComponent(id)}`); if (generation !== state.assetGeneration || state.current !== 'assets' || state.assetTarget !== id) return; state.asset = data.asset || data; renderAssetDetail(); }
  catch (error) { if (generation !== state.assetGeneration || state.current !== 'assets') return; $('#main-content').innerHTML = `<div class="knowledge-back-row"><button class="view-link" data-action="assets-back">${icon('left')}Back to assets</button></div><div class="error-panel">${icon('alert')}<div><strong>This asset is unavailable.</strong><p>${esc(error.message)}</p></div></div>`; }
}
function renderAssetDetail() {
  const asset = state.asset;
  if (!asset) return;
  $('#breadcrumb-current').textContent = 'Asset record'; document.title = `${asset.name || asset.ref} · AssetDesk`;
  const tickets = asset.tickets || asset.linked_tickets || [];
  const values = [['Asset ID', asset.ref], ['Type', assetTypeLabels[asset.type] || asset.type], ['Lifecycle status', assetStatusLabels[asset.status] || asset.status], ['Owner / personnel', asset.owner_restricted ? 'Restricted personnel record' : asset.owner?.name || asset.owner_name], ['Email', asset.email], ['Department', asset.department], ['Location', asset.location], ['Serial number', asset.serial_number], ['Manufacturer', asset.manufacturer], ['Model', asset.model]];
  $('#main-content').innerHTML = `<div class="knowledge-back-row"><button class="view-link" data-action="assets-back">${icon('left')}Back to assets</button><span class="role-badge">${esc(assetTypeLabels[asset.type] || 'Asset record')}</span></div><section class="panel native-asset-detail"><header class="article-heading"><div><div class="eyebrow">${esc(asset.ref)}</div><h1>${esc(asset.name || asset.ref)}</h1><p>${esc(asset.category?.name || 'Assets')} · Updated ${esc(shortDate(asset.updated_at))}</p></div>${asset.canEdit ? `<button class="btn" data-action="edit-asset">${icon('note')}Edit asset</button>` : ''}</header><div class="native-asset-detail-body"><section><h2>Record details</h2><dl class="asset-record-fields">${values.filter(([, value]) => value).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${asset.description ? `<h2>Notes</h2><div class="ticket-description">${esc(asset.description)}</div>` : ''}</section><section class="asset-linked-tickets" aria-label="Linked tickets"><div class="panel-header"><div><h2 class="panel-title">Linked tickets<span class="count-badge">${tickets.length}</span></h2><p class="panel-subtitle">Every request involving this asset, in one place.</p></div></div>${tickets.length ? tickets.map(ticket => `<button class="asset-ticket-row" data-ticket="${esc(ticket.key)}"><span><strong>${esc(ticket.subject)}</strong><small class="mono">${esc(ticket.key)} · ${esc(shortDate(ticket.created_at))}</small></span>${pill(ticket.status)}</button>`).join('') : '<p class="empty-small">Tickets that mention or link this asset will appear here automatically.</p>'}</section></div></section>`;
}
async function openAssetForm(asset = null, preferredCategory = '') {
  try {
    const [categories, people] = await Promise.all([fetchCategories(), api('/api/desk/assets?type=personnel&limit=100')]);
    const editable = categories.filter(category => category.kind === 'assets' && canEditCategory(category));
    if (!editable.length) { toast('You do not have permission to create or edit assets in an accessible asset category.', true); return; }
    const defaultCategory = editable.some(category => category.id === preferredCategory) ? preferredCategory : editable[0].id;
    const record = asset || { ref: '', name: '', type: 'hardware', category_id: defaultCategory, status: 'active' };
    const personOptions = (people.assets || []).filter(person => person.id !== record.id);
    showModal(`<form id="asset-form"><header class="modal-header"><div><h2>${asset ? 'Edit asset' : 'Create an asset'}</h2><p>${asset ? 'Keep ownership and equipment details current.' : 'Add a person, PC, or piece of equipment to your workspace.'}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close asset form">${icon('close')}</button></header><div class="modal-body modal-form"><div class="field-grid"><div class="field"><label for="asset-ref">Asset ID</label><input class="input" name="ref" id="asset-ref" required maxlength="64" value="${esc(record.ref)}" placeholder="PC-1042 or PERSON-001"></div><div class="field"><label for="asset-name">Asset name</label><input class="input" name="name" id="asset-name" required maxlength="200" value="${esc(record.name)}" placeholder="A clear, recognizable name"></div><div class="field"><label for="asset-type">Asset type</label><select name="type" id="asset-type">${options(assetTypeLabels, record.type)}</select></div><div class="field"><label for="asset-category">Knowledge category</label><select name="category_id" id="asset-category" required>${categoryOptions(record.category_id, { editable: true, assetOnly: true })}</select></div><div class="field" id="asset-owner-field"><label for="asset-owner">Owner / personnel</label><select name="owner_id" id="asset-owner">${record.owner_restricted ? '<option value="__restricted__" selected>Restricted owner (unchanged)</option>' : ''}<option value="">No personnel record selected</option>${personOptions.map(person => `<option value="${esc(person.id)}"${person.id === record.owner_id ? ' selected' : ''}>${esc(person.name || person.ref)} · ${esc(person.ref)}</option>`).join('')}</select></div><div class="field"><label for="asset-owner-name">Owner name</label><input class="input" name="owner_name" id="asset-owner-name" maxlength="200" value="${esc(record.owner_name)}" placeholder="Optional owner or custodian"></div><div class="field"><label for="asset-email">Email</label><input class="input" name="email" id="asset-email" type="email" maxlength="254" value="${esc(record.email)}"></div><div class="field"><label for="asset-department">Department</label><input class="input" name="department" id="asset-department" maxlength="200" value="${esc(record.department)}"></div><div class="field"><label for="asset-location">Location</label><input class="input" name="location" id="asset-location" maxlength="200" value="${esc(record.location)}"></div><div class="field"><label for="asset-status">Lifecycle status</label><select name="status" id="asset-status">${options(assetStatusLabels, record.status)}</select></div></div><section id="asset-hardware-fields"><h3 class="drawer-section-label">Equipment details</h3><div class="field-grid"><div class="field"><label for="asset-serial">Serial number</label><input class="input" name="serial_number" id="asset-serial" maxlength="200" value="${esc(record.serial_number)}"></div><div class="field"><label for="asset-manufacturer">Manufacturer</label><input class="input" name="manufacturer" id="asset-manufacturer" maxlength="200" value="${esc(record.manufacturer)}"></div><div class="field span-2"><label for="asset-model">Model</label><input class="input" name="model" id="asset-model" maxlength="200" value="${esc(record.model)}"></div></div></section><div class="field"><label for="asset-description">Notes</label><textarea name="description" id="asset-description" maxlength="20000" rows="4">${esc(record.description)}</textarea></div><div class="field-error" role="alert"></div></div><footer class="modal-footer"><button class="btn" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${asset ? 'Save asset' : 'Create asset'}</button></footer></form>`);
    const syncType = () => { const personnel = $('#asset-type').value === 'personnel'; $('#asset-owner-field').hidden = personnel; $('#asset-hardware-fields').hidden = personnel; };
    $('#asset-type').addEventListener('change', syncType); syncType();
    $('#asset-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form)); body.ref = body.ref.trim(); body.name = body.name.trim(); if (body.owner_id === '__restricted__') { delete body.owner_id; if (!body.owner_name) delete body.owner_name; } else body.owner_id = body.type === 'personnel' ? null : body.owner_id || null; if (asset) body.version = asset.version;
      const button = $('button[type=submit]', form); button.disabled = true;
      try { const saved = await api(`/api/desk/assets${asset ? `/${encodeURIComponent(asset.id)}` : ''}`, { method: asset ? 'PATCH' : 'POST', body }); modal.close(); toast(asset ? 'Asset updated.' : 'Asset created.'); await openAsset((saved.asset || saved).id); }
      catch (error) { if (form.isConnected) { $('.field-error', form).textContent = error.message; button.disabled = false; } else toast(error.message, true); }
    });
  } catch (error) { toast(error.message, true); }
}
function renderActions() {
  actionsUI.open(location.hash.startsWith('#actions') ? location.hash : '#actions');
}
document.addEventListener('click', event => {
  const category = event.target.closest('[data-knowledge-category]');
  if (category) { state.knowledgeCategory = category.dataset.knowledgeCategory; state.knowledgeOffset = 0; state.article = null; loadKnowledge(); }
});
window.addEventListener('beforeunload', event => { if (state.articleEditing && state.articleDirty || actionsUI.isDirty() || aiUI.isDirty()) { event.preventDefault(); event.returnValue = ''; } });

// Reports keep draft controls separate from the last applied search so exports
// always match the result set the technician has actually reviewed.
const reportDateLabels = { created_at: 'Date submitted', updated_at: 'Last updated', first_response_at: 'First response recorded', resolved_at: 'Date resolved', response_due_at: 'Response due', resolution_due_at: 'Resolution due', paused_until: 'Paused until' };
const reportSortLabels = { newest: 'Submitted: newest first', oldest: 'Submitted: oldest first', updated: 'Most recently updated', priority: 'Priority', due: 'Next SLA due', requester: 'Requester' };
const reportSlaLabels = { pending: 'Pending', overdue: 'Overdue', met: 'Met', breached: 'Breached' };
function reportInput(name, label, { type = 'text', placeholder = '', wide = false } = {}) {
  return `<div class="field${wide ? ' report-wide' : ''}"><label for="report-${name}">${label}</label><input class="input" id="report-${name}" name="${name}" type="${type}" value="${esc(state.reports.draft[name] || '')}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${type === 'number' ? ` min="0" step="${name.includes('_count_') ? '1' : 'any'}"` : type === 'text' ? ' maxlength="200"' : ''}></div>`;
}
function reportSelect(name, label, values, allLabel = 'Any') {
  return `<div class="field"><label for="report-${name}">${label}</label><select id="report-${name}" name="${name}">${allLabel !== null ? `<option value="">${allLabel}</option>` : ''}${options(values, state.reports.draft[name])}</select></div>`;
}
function reportTechnicianOptions() {
  const selected = state.reports.draft.assignee || '';
  return `<option value="">All technicians</option><option value="unassigned"${selected === 'unassigned' ? ' selected' : ''}>Unassigned</option>${state.reports.technicians.map(person => `<option value="${esc(person.id)}"${selected === person.id ? ' selected' : ''}>${esc(person.name)}${person.active ? '' : ' (inactive)'}</option>`).join('')}`;
}
function reportDraft(form) {
  return Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, value.trim()]).filter(([, value]) => value !== ''));
}
function reportSignature(filters) { return JSON.stringify(Object.entries(filters).filter(([, value]) => value !== '').sort(([a], [b]) => a.localeCompare(b))); }
function updateReportDraft() {
  const form = $('#report-filters'); if (!form) return;
  const report = state.reports; report.draft = reportDraft(form);
  const dirty = reportSignature(report.draft) !== reportSignature(report.applied);
  $('#report-draft-status').textContent = dirty ? 'Filters changed. Search to update the results. CSV export uses your last search.' : 'Search applies all filters together. CSV export includes every matching ticket.';
  $('#report-draft-status').classList.toggle('report-dirty', dirty);
}
function renderReports() {
  const report = state.reports;
  $('#breadcrumb-current').textContent = 'Reports'; document.title = 'Reports · AssetDesk';
  $('#main-content').innerHTML = `<div class="page-heading report-page-heading"><div><div class="eyebrow">Explore your support history</div><h1>Reports</h1><p>Find the tickets you need, then export the complete results.</p></div></div><section class="panel report-search-panel" aria-label="Ticket report search"><header class="panel-header"><div><h2 class="panel-title">Find tickets</h2><p class="panel-subtitle">Combine filters to answer a specific question about your support desk.</p></div><span class="report-access-note">${icon('shield')}Your workspace access applies</span></header><form id="report-filters" aria-label="Ticket report filters"><div class="report-filter-grid">${reportInput('search', 'Search tickets', { placeholder: 'Ticket ID, requester, subject, notes, tags…', wide: true })}${reportSelect('date_field', 'Date field', reportDateLabels, null)}<div class="report-date-note">${icon('calendar')}Dates include the whole selected day in UTC.</div>${reportInput('date_from', 'From date (UTC)', { type: 'date' })}${reportInput('date_to', 'Through date (UTC)', { type: 'date' })}${reportSelect('category', 'Type / category', categoryLabels, 'All types / categories')}${reportSelect('status', 'Status', statusLabels, 'All statuses')}${reportSelect('priority', 'Priority', priorityLabels, 'All priorities')}<div class="field"><label for="report-assignee">Technician</label><select id="report-assignee" name="assignee">${reportTechnicianOptions()}</select></div>${reportSelect('source', 'Source', { email: 'Email', manual: 'Manual' }, 'All sources')}${reportInput('asset', 'Linked asset', { placeholder: 'Asset ID or name' })}${reportInput('tag', 'Tag', { placeholder: 'Exact tag name' })}</div><details class="report-advanced"${report.advanced ? ' open' : ''}><summary>${icon('filter')}Advanced filters<span>Ticket details, assets, response times & SLA</span>${icon('down')}</summary><div class="report-advanced-body"><h3>Ticket details</h3><div class="report-filter-grid">${reportInput('ticket_key', 'Ticket ID')}${reportInput('subject', 'Subject contains')}${reportInput('description', 'Description contains')}${reportInput('requester', 'Requester contains', { placeholder: 'Name or email address' })}${reportInput('location', 'Location contains', { placeholder: 'Ticket location' })}${reportInput('resolution', 'Resolution contains')}${reportInput('note', 'Note contains', { placeholder: 'Internal note or email text' })}${reportSelect('asset_type', 'Asset type', assetTypeLabels, 'All asset types')}${reportSelect('has_assets', 'Has linked assets', { yes: 'Yes', no: 'No' }, 'Either')}</div><h3>Response & resolution</h3><div class="report-filter-grid">${reportSelect('response_state', 'First response', { recorded: 'Recorded', unrecorded: 'Not recorded' }, 'Either')}${reportSelect('resolution_state', 'Resolved date', { recorded: 'Recorded', unrecorded: 'Not recorded' }, 'Either')}${reportSelect('response_sla', 'Response SLA', reportSlaLabels, 'Any response SLA')}${reportSelect('resolution_sla', 'Resolution SLA', reportSlaLabels, 'Any resolution SLA')}${reportInput('response_minutes_min', 'Min. response minutes', { type: 'number' })}${reportInput('response_minutes_max', 'Max. response minutes', { type: 'number' })}${reportInput('resolution_minutes_min', 'Min. resolution minutes', { type: 'number' })}${reportInput('resolution_minutes_max', 'Max. resolution minutes', { type: 'number' })}${reportInput('note_count_min', 'Min. internal notes', { type: 'number' })}${reportInput('note_count_max', 'Max. internal notes', { type: 'number' })}${reportInput('email_count_min', 'Min. email replies', { type: 'number' })}${reportInput('email_count_max', 'Max. email replies', { type: 'number' })}${reportInput('asset_count_min', 'Min. linked assets', { type: 'number' })}${reportInput('asset_count_max', 'Max. linked assets', { type: 'number' })}</div><p class="report-filter-help">Response and resolution minutes measure completed milestones from submission. Asset filters and counts include only records you can access. Pending SLA targets have no completed milestone; overdue targets are still active and past due.</p></div></details><div class="report-form-footer"><div class="report-sort-controls">${reportSelect('sort', 'Sort results', reportSortLabels, null)}${reportSelect('limit', 'Results per page', { 25: '25 tickets', 50: '50 tickets', 100: '100 tickets' }, null)}</div><div class="report-search-actions"><button class="btn" type="button" id="report-clear">Clear filters</button><button class="btn primary" type="submit">${icon('search')}Search tickets</button></div></div><p class="report-draft-status" id="report-draft-status" role="status"></p></form></section><section class="panel report-results" id="report-results" aria-label="Ticket report results"></section>`;
  const form = $('#report-filters');
  form.addEventListener('input', updateReportDraft); form.addEventListener('change', updateReportDraft);
  $('.report-advanced').addEventListener('toggle', event => { state.reports.advanced = event.currentTarget.open; });
  form.addEventListener('submit', event => { event.preventDefault(); updateReportDraft(); report.applied = { ...report.draft }; report.offset = 0; updateReportDraft(); loadReports(); });
  $('#report-clear').addEventListener('click', () => { const defaults = newReportState(); report.draft = defaults.draft; report.applied = defaults.applied; report.offset = 0; report.advanced = false; renderReports(); loadReports(); });
  const tagInput = $('#report-tag'); tagInput.setAttribute('list', 'report-tag-suggestions'); tagInput.insertAdjacentHTML('afterend', '<datalist id="report-tag-suggestions"></datalist>'); bindTagSuggestions(tagInput, $('#report-tag-suggestions'));
  updateReportDraft(); renderReportResults();
}
function reportQuery({ exportCsv = false } = {}) {
  const report = state.reports, params = new URLSearchParams(report.applied);
  if (exportCsv) { params.delete('limit'); params.delete('offset'); }
  else params.set('offset', String(report.offset));
  return params;
}
async function loadReports() {
  const report = state.reports, generation = ++report.generation;
  if (state.current !== 'reports' || !state.session) return;
  report.loading = true; report.error = ''; renderReportResults();
  try {
    const [result, choices] = await Promise.all([api(`/api/desk/reports/tickets?${reportQuery()}`), api('/api/desk/reports/options')]);
    if (state.current !== 'reports' || !state.session || state.reports !== report || generation !== report.generation) return;
    report.tickets = result.tickets || []; report.total = result.total || 0; report.limit = result.limit || Number(report.applied.limit || 25);
    report.initialized = true; report.loading = false;
    if (choices) { if (choices.workflow) { applyWorkflow(choices.workflow); for (const [field, labels, all] of [['status', statusLabels, 'All statuses'], ['priority', priorityLabels, 'All priorities'], ['category', categoryLabels, 'All types / categories']]) { const select = $(`#report-${field}`); if (select) select.innerHTML = `<option value="">${all}</option>${options(labels, report.draft[field])}`; } } report.technicians = choices.technicians || []; state.technicians = report.technicians; const select = $('#report-assignee'); if (select) select.innerHTML = reportTechnicianOptions(); }
    renderReportResults();
  } catch (error) {
    if (state.current !== 'reports' || !state.session || state.reports !== report || generation !== report.generation) return;
    report.loading = false; report.error = error.message; renderReportResults();
  }
}
function reportTimestamp(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function reportMinutes(value) { return value === null || value === undefined ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`; }
function reportSla(value) { return `<span class="report-sla ${Object.hasOwn(reportSlaLabels, value) ? value : 'pending'}">${esc(reportSlaLabels[value] || 'Pending')}</span>`; }
function renderReportResults() {
  const container = $('#report-results'); if (!container || state.current !== 'reports') return;
  const report = state.reports;
  const active = Object.keys(report.applied).filter(key => !['date_field', 'sort', 'limit'].includes(key)).length;
  container.setAttribute('aria-busy', String(report.loading));
  container.innerHTML = `<header class="panel-header report-result-header"><div><h2 class="panel-title">Search results<span class="count-badge">${report.initialized && !report.loading && !report.error ? report.total : '—'}</span></h2><p class="panel-subtitle">${active ? `${active} filter${active === 1 ? '' : 's'} applied` : 'All tickets'} · Dates shown in UTC</p></div><div class="report-export-actions"><button class="btn" type="button" id="report-refresh"${report.loading ? ' disabled' : ''} aria-label="Refresh report results">${icon('refresh')}</button><button class="btn" type="button" id="report-export"${!report.initialized || report.loading || report.error || report.exporting || report.total === 0 ? ' disabled' : ''}>${report.exporting ? '<span class="spinner"></span>Preparing CSV…' : `${icon('download')}Export CSV`}</button></div></header>${report.loading ? '<div class="table-loading"><span class="spinner"></span>Searching tickets…</div>' : report.error ? `<div class="error-panel" role="alert">${icon('alert')}<div><strong>The report could not be loaded.</strong><p>${esc(report.error)}</p></div><button class="btn" type="button" id="report-retry">Try again</button></div>` : report.tickets.length ? `<div class="report-table-scroll"><table class="report-table" aria-label="Report tickets"><thead><tr><th scope="col">Ticket / requester</th><th scope="col">Status / priority</th><th scope="col">Type / source</th><th scope="col">Technician</th><th scope="col">Submitted (UTC)</th><th scope="col">Response SLA</th><th scope="col">Resolution SLA</th><th scope="col">Assets</th><th scope="col">Activity</th></tr></thead><tbody>${report.tickets.map(ticket => `<tr><td class="report-ticket-cell"><button class="ticket-title" data-ticket="${esc(ticket.key)}">${esc(ticket.subject)}</button><div class="mono report-ticket-id">${esc(ticket.key)}</div>${renderTagLabels(ticket.tags, 'report-ticket-tags')}<div class="report-cell-secondary">${esc(ticket.requester_name || ticket.requester)}</div>${ticket.requester_name ? `<div class="report-cell-secondary">${esc(ticket.requester)}</div>` : ''}</td><td>${pill(ticket.status)}<div class="report-cell-secondary">${esc(priorityLabels[ticket.priority] || cap(ticket.priority))}</div></td><td>${esc(categoryLabels[ticket.category] || cap(ticket.category))}<div class="report-cell-secondary">${ticket.source === 'manual' ? 'Manual' : 'Email'}</div></td><td>${ticket.assignee ? `<div class="person">${avatar(ticket.assignee.name)}<span>${esc(ticket.assignee.name)}</span></div>` : '<span class="muted">Unassigned</span>'}</td><td class="report-date-cell">${esc(reportTimestamp(ticket.created_at))}</td><td>${reportSla(ticket.response_sla)}<div class="report-cell-secondary">${reportMinutes(ticket.response_minutes)}</div></td><td>${reportSla(ticket.resolution_sla)}<div class="report-cell-secondary">${reportMinutes(ticket.resolution_minutes)}</div></td><td>${(ticket.assets || []).length ? ticket.assets.map(asset => `<span class="report-asset-ref" title="${esc(asset.name)}">${esc(asset.ref)}</span>`).join('') : '<span class="muted">—</span>'}</td><td><span class="nowrap">${Number(ticket.note_count || 0)} notes</span><div class="report-cell-secondary nowrap">${Number(ticket.email_count || 0)} emails</div></td></tr>`).join('')}</tbody></table></div>` : emptyState('No tickets match this search.', 'Try a wider date range, remove a filter, or clear the search.', { symbol: 'reports' })}<footer class="table-footer report-result-footer"><div><span>${report.initialized && !report.error && !report.loading && report.total ? `${report.offset + 1}–${Math.min(report.offset + report.tickets.length, report.total)} of ${report.total} tickets` : 'No results to show'}</span><small>CSV includes all matching tickets, across every page.</small></div><div class="pagination"><button class="icon-button" type="button" id="report-prev" aria-label="Previous report page"${report.loading || report.offset === 0 || report.error ? ' disabled' : ''}>${icon('left')}</button><span>Page ${Math.floor(report.offset / report.limit) + 1}</span><button class="icon-button" type="button" id="report-next" aria-label="Next report page"${report.loading || report.offset + report.limit >= report.total || report.error ? ' disabled' : ''}>${icon('chevron')}</button></div></footer>`;
  $('#report-refresh').addEventListener('click', loadReports);
  $('#report-retry')?.addEventListener('click', loadReports);
  $('#report-export').addEventListener('click', exportReport);
  $('#report-prev').addEventListener('click', () => { report.offset = Math.max(0, report.offset - report.limit); loadReports(); });
  $('#report-next').addEventListener('click', () => { report.offset += report.limit; loadReports(); });
}
async function exportReport() {
  const report = state.reports, userId = state.session?.user.id;
  if (report.exporting || report.loading || !report.initialized || !report.total) return;
  const query = reportQuery({ exportCsv: true }); report.exporting = true; renderReportResults();
  try {
    const response = await fetch(`/api/desk/reports/tickets.csv?${query}`, { credentials: 'same-origin', headers: { Accept: 'text/csv' } });
    if (!response.ok) {
      if (response.status === 401) { state.session = null; state.ticketTag = null; state.reports = newReportState(); closeDialogs(); renderLogin(); }
      const data = await response.json().catch(() => ({})); throw new Error(data.error || 'The CSV could not be exported. Try again.');
    }
    const blob = await response.blob();
    if (state.session?.user.id !== userId || state.reports !== report) return;
    const supplied = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1];
    const filename = supplied && /^[A-Za-z0-9_.-]+\.csv$/.test(supplied) ? supplied : 'assetdesk-tickets.csv';
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('CSV exported with all matching tickets.');
  } catch (error) { if (state.session?.user.id === userId) toast(error.message, true); }
  finally { report.exporting = false; if (state.reports === report) renderReportResults(); }
}
