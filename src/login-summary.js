import express from 'express';
import { createHash } from 'node:crypto';
import { validateAiResult } from './ai-provider.js';

const MAX_TICKETS = 50;
const MAX_CONTEXT = 50000;
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const clip = (value, maximum) => String(value ?? '').slice(0, maximum);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
const messages = Object.freeze({
  unconfigured: 'Your AI ticket summary will appear here after an administrator configures an API key for the active provider in Settings → AI.',
  ai_disabled: 'AI assistance is disabled. An administrator can enable it in Settings → AI to generate your ticket summary.',
  unavailable: 'The AI ticket summary is unavailable right now. You can continue to your dashboard or try again later.',
  settings_changed: 'AI settings changed while this summary was being prepared. Try again to use the current settings.',
  context_changed: 'Ticket activity changed while this summary was being prepared. Try again for an up-to-date summary.',
});

/** Read-only, bounded ticket summaries. This service never runs ticket automation. */
export class LoginSummaryService {
  constructor({ desk, settings, providers }) {
    Object.assign(this, { desk, settings, providers });
    this.db = desk.db;
    this.inFlight = new Map();
  }
  auth(user) {
    const current = user?.id ? this.desk.user(user.id) : null;
    if (!current?.active) throw fail('Sign in to continue.', 401);
    return current;
  }
  generate(user) {
    const current = this.auth(user);
    if (this.inFlight.has(current.id)) return this.inFlight.get(current.id);
    const pending = this.prepare(current).finally(() => {
      if (this.inFlight.get(current.id) === pending) this.inFlight.delete(current.id);
    });
    this.inFlight.set(current.id, pending);
    return pending;
  }
  window(config, to = new Date().toISOString()) {
    const hours = Number.isSafeInteger(config.summary_hours) && config.summary_hours >= 1 && config.summary_hours <= 720 ? config.summary_hours : 24;
    return { hours, from: new Date(Date.parse(to) - hours * 3600000).toISOString(), to };
  }
  collect(window) {
    this.desk.resumeDueTickets();
    this.desk.initializeRows();
    const joins = `FROM tickets t LEFT JOIN ticket_statuses s ON s.id=t.status
      LEFT JOIN ticket_priorities p ON p.id=t.priority LEFT JOIN ticket_categories c ON c.id=t.category
      LEFT JOIN technicians u ON u.id=t.assignee_id`;
    const where = `WHERE t.status!='paused' AND COALESCE(s.kind,'active')!='paused' AND (
      julianday(t.created_at) BETWEEN julianday(?) AND julianday(?)
      OR julianday(COALESCE(t.updated_at,t.created_at)) BETWEEN julianday(?) AND julianday(?))`;
    const range = [window.from, window.to, window.from, window.to];
    const active = "COALESCE(s.kind,'active')='active'";
    const overdue = `${active} AND (julianday(t.resolution_due_at)<julianday(?) OR (t.first_response_at IS NULL AND julianday(t.response_due_at)<julianday(?)))`;
    const metrics = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(julianday(t.created_at) BETWEEN julianday(?) AND julianday(?)),0) AS new,
      COALESCE(SUM(${active}),0) AS active,
      COALESCE(SUM(COALESCE(s.kind,'active') IN ('resolved','closed')),0) AS resolved,
      COALESCE(SUM(${active} AND t.assignee_id IS NULL),0) AS unassigned,
      COALESCE(SUM(${overdue}),0) AS overdue ${joins} ${where}`)
      .get(window.from, window.to, window.to, window.to, ...range);
    const rows = this.db.prepare(`SELECT t.key,t.version,t.subject,SUBSTR(t.description,1,1200) AS description,
      LENGTH(t.description)>1200 AS description_truncated,t.status,COALESCE(s.name,t.status) AS status_name,
      t.priority,COALESCE(p.name,t.priority) AS priority_name,t.category,COALESCE(c.name,t.category) AS category_name,
      u.name AS assignee,t.created_at,t.updated_at,t.first_response_at,t.resolved_at,t.response_due_at,t.resolution_due_at,
      CASE WHEN ${overdue} THEN 1 ELSE 0 END AS is_overdue
      ${joins} ${where} ORDER BY julianday(COALESCE(t.updated_at,t.created_at)) DESC,t.key LIMIT ?`)
      .all(window.to, window.to, ...range, MAX_TICKETS);
    const context = { window: { ...window }, metrics: { ...metrics }, tickets: [] }, versions = [];
    const tags = this.db.prepare('SELECT name FROM ticket_tags WHERE ticket_key=? ORDER BY normalized LIMIT 11');
    let truncated = metrics.total > rows.length;
    for (const row of rows) {
      if (!validKey(row.key)) { truncated = true; continue; }
      const ticketTags = tags.all(row.key);
      if (ticketTags.length > 10) truncated = true;
      const item = {
        ticket_key: row.key, subject: clip(row.subject, 240), description: clip(row.description, 1200),
        status: clip(row.status_name, 100), priority: clip(row.priority_name, 100), category: clip(row.category_name, 100),
        assignee: row.assignee ? clip(row.assignee, 100) : null,
        created_at: row.created_at, updated_at: row.updated_at || row.created_at,
        first_response_at: row.first_response_at, resolved_at: row.resolved_at,
        response_due_at: row.response_due_at, resolution_due_at: row.resolution_due_at,
        is_overdue: Boolean(row.is_overdue), tags: ticketTags.slice(0, 10).map(tag => clip(tag.name, 50)),
      };
      context.tickets.push(item);
      if (JSON.stringify(context).length > MAX_CONTEXT - 128) { context.tickets.pop(); truncated = true; break; }
      versions.push([row.key, row.version]);
      if (row.description_truncated) truncated = true;
    }
    context.sample_count = context.tickets.length;
    context.truncated = truncated || context.sample_count < metrics.total;
    const signature = createHash('sha256').update(JSON.stringify({ context, versions })).digest('hex');
    return { context, signature };
  }
  response(status, data, reason, extra = {}) {
    const { context } = data;
    return { status, ...(reason ? { reason } : {}), ...context.window,
      generated_at: new Date().toISOString(), metrics: { ...context.metrics }, sample_count: context.sample_count,
      truncated: context.truncated, summary: reason ? messages[reason] : '', highlights: [], ...extra };
  }
  async prepare(user) {
    const config = this.settings.snapshot(), window = this.window(config), data = this.collect(window);
    if (config.login_summary_enabled === false) return this.response('disabled', data);
    if (!config.providers[config.provider]?.key_configured) return this.response('placeholder', data, 'unconfigured');
    if (!config.enabled) return this.response('placeholder', data, 'ai_disabled');
    if (!data.context.metrics.total) return this.response('empty', data, undefined, { summary: `No tickets were created or updated in the past ${window.hours} hours.` });
    let result;
    try {
      const runtime = this.settings.runtime(), selected = runtime.providers[runtime.provider];
      result = validateAiResult('summary', await this.providers.review({ kind: 'summary', provider: runtime.provider,
        apiKey: selected.api_key, model: selected.model, systemPrompt: runtime.prompts.system,
        prompt: runtime.prompts.summary, context: structuredClone(data.context) }));
      const keys = new Set(data.context.tickets.map(ticket => ticket.ticket_key));
      if (result.highlights.some(item => !keys.has(item.ticket_key)) || Object.values(runtime.providers).some(profile => profile.api_key && JSON.stringify(result).includes(profile.api_key))) throw new Error('Unsupported summary content.');
    } catch {
      this.auth(user);
      const current = this.settings.snapshot();
      if (current.version !== config.version) {
        const latest = this.collect(this.window(current));
        return this.response(current.login_summary_enabled === false ? 'disabled' : 'placeholder', latest, 'settings_changed');
      }
      return this.response('placeholder', data, 'unavailable');
    }
    this.auth(user);
    const current = this.settings.snapshot();
    if (current.version !== config.version) {
      const latest = this.collect(this.window(current));
      return this.response(current.login_summary_enabled === false ? 'disabled' : 'placeholder', latest, 'settings_changed');
    }
    if (this.collect(window).signature !== data.signature) return this.response('placeholder', data, 'context_changed');
    return this.response('ready', data, undefined, result);
  }
}

/** Mount after the desk's authenticated-session and CSRF middleware. */
export function createLoginSummaryRouter({ summary }) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    if (!req.deskSession?.user) throw fail('Sign in to continue.', 401);
    if (Object.keys(req.query).length || !req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) throw fail('Provide an empty ticket summary request. Configure its hours and prompt in AI settings.');
    res.set('Cache-Control', 'no-store').json(await summary.generate(req.deskSession.user));
  });
  router.use((error, _req, res, _next) => {
    const code = [400, 401, 403].includes(error.statusCode) ? error.statusCode : 500;
    res.status(code).json({ error: code === 500 ? 'The ticket summary could not be prepared. Try again later.' : error.safeMessage });
  });
  return router;
}
