const validTicketKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

/** A login-only, dismissible summary with no ticket mutations or stored content. */
export function createLoginSummaryUI({ api, esc, icon, getUser, openTicket, openSettings }) {
  let dialog = null, generation = 0;

  function close() {
    generation++;
    if (dialog?.open) dialog.close();
    if (dialog) { dialog.innerHTML = ''; dialog.removeAttribute('aria-busy'); }
  }
  function ensureDialog() {
    if (dialog?.isConnected) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'login-summary-dialog';
    dialog.className = 'modal login-summary-dialog';
    dialog.setAttribute('aria-label', 'Ticket activity summary');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) { generation++; dialog.innerHTML = ''; } });
    document.body.append(dialog);
    return dialog;
  }
  function localDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }
  function windowCaption(data) {
    const from = localDate(data?.from), to = localDate(data?.to);
    return from && to ? `<p class="login-summary-window"><time datetime="${esc(data.from)}">${esc(from)}</time><span aria-hidden="true"> → </span><span class="sr-only"> through </span><time datetime="${esc(data.to)}">${esc(to)}</time></p>` : '';
  }
  function metrics(data) {
    if (!data?.metrics || typeof data.metrics !== 'object') return '';
    const fields = [['total', 'Tickets in period'], ['new', 'New tickets'], ['active', 'Active'], ['resolved', 'Resolved or closed'], ['unassigned', 'Unassigned'], ['overdue', 'Overdue']];
    return `<section class="login-summary-totals" aria-label="Ticket activity totals"><h3>Ticket activity</h3><p>Live counts for tickets submitted or updated in this period.</p><dl class="login-summary-metrics">${fields.map(([key, label]) => `<div><dt>${label}</dt><dd>${Number.isSafeInteger(data.metrics[key]) && data.metrics[key] >= 0 ? data.metrics[key] : '—'}</dd></div>`).join('')}</dl></section>`;
  }
  function placeholder(data) {
    let text = 'AI could not prepare this summary. You can continue working and try again later.';
    if (data.reason === 'unconfigured') text = 'Your AI ticket summary will appear here once an API key is saved for the selected provider and AI assistance is enabled.';
    else if (data.reason === 'ai_disabled') text = 'Your AI ticket summary will appear here when AI assistance is enabled in Settings → AI.';
    else if (data.reason === 'settings_changed') text = 'AI settings changed while this summary was being prepared. Try again to use the latest settings.';
    else if (data.reason === 'context_changed') text = 'Ticket activity changed while this summary was being prepared. Try again for an up-to-date summary.';
    return `<section class="login-summary-placeholder" aria-label="AI summary placeholder"><span class="login-summary-placeholder-icon">${icon('spark')}</span><h3>AI summary placeholder</h3><p>${text}</p>${getUser()?.role !== 'admin' && ['unconfigured', 'ai_disabled'].includes(data.reason) ? '<p>Ask your workspace administrator to configure AI assistance.</p>' : ''}${!['unconfigured', 'ai_disabled'].includes(data.reason) ? '<button type="button" class="btn" data-summary-retry>Try again</button>' : ''}</section>`;
  }
  function content(data) {
    if (data.status === 'placeholder') return placeholder(data);
    if (data.status === 'empty') return '<section class="login-summary-empty"><span class="login-summary-placeholder-icon">' + icon('circleCheck') + '</span><h3>No recent ticket activity</h3><p>No tickets were submitted or updated in this period.</p></section>';
    const highlights = Array.isArray(data.highlights) ? data.highlights.filter(item => item && validTicketKey(item.ticket_key) && typeof item.text === 'string').slice(0, 8) : [];
    const total = Number.isSafeInteger(data.metrics?.total) ? data.metrics.total : 0;
    const sample = Number.isSafeInteger(data.sample_count) ? data.sample_count : 0;
    return `<section class="login-summary-narrative" aria-label="AI ticket summary"><h3>AI ticket summary</h3><p>${esc(data.summary || '')}</p>${highlights.length ? `<h3>Ticket highlights</h3><ul class="login-summary-highlights">${highlights.map(item => `<li><button type="button" class="login-summary-ticket" data-summary-ticket="${esc(item.ticket_key)}">${icon('ticket')}${esc(item.ticket_key)}${icon('chevron')}</button><p>${esc(item.text)}</p></li>`).join('')}</ul>` : ''}<p class="login-summary-coverage">${data.truncated ? `AI reviewed the ${sample} most recently updated tickets out of ${total} matching tickets. Ticket text may be shortened.` : `Based on ${sample} ${sample === 1 ? 'ticket' : 'tickets'} in this period.`} Review AI findings before acting.</p></section>`;
  }
  function render(data = null) {
    const root = ensureDialog();
    const hadFocus = root.contains(document.activeElement);
    const hours = Number.isSafeInteger(data?.hours) && data.hours >= 1 && data.hours <= 720 ? data.hours : null;
    root.setAttribute('aria-busy', String(!data));
    root.innerHTML = `<header class="modal-header login-summary-header"><div><div class="login-summary-eyebrow">${icon('spark')}Your support briefing</div><h2>${hours ? `Past ${hours} ${hours === 1 ? 'hour' : 'hours'}` : 'Ticket activity summary'}</h2><p>Catch up on your team’s recent tickets.</p>${windowCaption(data)}</div><button type="button" class="icon-button" aria-label="Close ticket summary" data-summary-close>${icon('close')}</button></header><div class="modal-body login-summary-body">${data ? content(data) + metrics(data) : '<div class="login-summary-loading" role="status"><span class="spinner"></span><h3>Preparing your ticket summary…</h3><p>You can dismiss this window and keep working while AI is busy.</p></div>'}</div><footer class="modal-footer login-summary-footer">${data && getUser()?.role === 'admin' ? `<button type="button" class="btn" data-summary-settings>${icon('settings')}AI settings</button>` : ''}<button type="button" class="btn primary" data-summary-close>Continue to dashboard${icon('arrow')}</button></footer>`;
    for (const button of root.querySelectorAll('[data-summary-close]')) button.addEventListener('click', close);
    root.querySelector('[data-summary-settings]')?.addEventListener('click', () => { close(); openSettings?.(); });
    root.querySelector('[data-summary-retry]')?.addEventListener('click', show);
    for (const button of root.querySelectorAll('[data-summary-ticket]')) button.addEventListener('click', () => { const key = button.dataset.summaryTicket; close(); if (validTicketKey(key)) openTicket?.(key); });
    if (root.open && hadFocus) root.querySelector('[data-summary-close]')?.focus({ preventScroll: true });
  }
  async function show() {
    const user = getUser()?.id;
    if (!user) { close(); return; }
    const currentGeneration = ++generation;
    render();
    if (!dialog.open) dialog.showModal();
    const current = () => currentGeneration === generation && getUser()?.id === user && dialog?.open;
    try {
      const result = await api('/api/desk/login-summary', { method: 'POST', body: {} });
      if (!current()) return;
      if (result?.status === 'disabled') { close(); return; }
      if (!['ready', 'placeholder', 'empty'].includes(result?.status)) throw new Error('Invalid summary result');
      render(result);
    } catch {
      if (current()) render({ status: 'placeholder', reason: 'unavailable' });
    }
  }
  return { show, close, reset: close };
}
