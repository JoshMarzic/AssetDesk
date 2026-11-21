import { createHash, randomUUID } from 'node:crypto';
import { normalizeTicketTags } from './desk-store.js';
import { validateAiResult } from './ai-provider.js';
import { buildAiContext, sharedSourceIsCurrent, ticketInputHash } from './ai-context.js';

const stamp = () => new Date().toISOString();
const parse = value => value ? JSON.parse(value) : null;
const fail = (message, statusCode = 400, flags = {}) => Object.assign(new Error(message), { statusCode, safeMessage: message, ...flags });
const actor = Object.freeze({ name: 'AssetDesk AI' });
const messageId = value => typeof value === 'string' && /^<[^<>\s\x00-\x1f]{1,990}>$/.test(value);
const emptySuggestions = () => ({ status: 'pending', summary: '', steps: [], articles: [] });
const emptyResult = () => ({ tags_added: [], location_set: null, assets_linked: [], suggestions: emptySuggestions(), reply: null });
const tagKey = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

/** Durable AI assistance runs outside intake transactions and never executes fixes. */
export class AiService {
  constructor({ desk, workspace, settings, providers, mail, logger = console, supportEmails = [] }) {
    Object.assign(this, { desk, workspace, settings, providers, mail, logger, supportEmails });
    this.db = desk.db; this.running = false; this.stopping = false; this.started = false; this.requested = false;
    desk.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_ticket_jobs(id TEXT PRIMARY KEY,ticket_key TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,receipt_id TEXT,source TEXT NOT NULL,is_reply INTEGER NOT NULL,auto_reply_allowed INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',claim_token TEXT,input_hash TEXT NOT NULL,settings_version INTEGER,attempts INTEGER NOT NULL DEFAULT 0,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(ticket_key) REFERENCES tickets(key));
      CREATE INDEX IF NOT EXISTS ai_ticket_jobs_queue ON ai_ticket_jobs(state,created_at);
      CREATE INDEX IF NOT EXISTS ai_ticket_jobs_ticket ON ai_ticket_jobs(ticket_key,created_at);
      CREATE TABLE IF NOT EXISTS ai_ticket_replies(ticket_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,body TEXT NOT NULL DEFAULT '',questions_json TEXT NOT NULL DEFAULT '[]',error TEXT,sent_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(ticket_key) REFERENCES tickets(key));
    `));
  }
  auth(user) {
    const current = user?.id ? this.desk.user(user.id) : null;
    if (!current?.active) throw fail('Sign in to continue.', 401);
    return current;
  }
  exists(key) { if (typeof key !== 'string' || !this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(key)) throw fail('Ticket not found.', 404); }
  enqueue(key, options = {}) {
    this.exists(key);
    if (!this.settings.snapshot().enabled) return null;
    const receipt = typeof options.receipt_id === 'string' ? options.receipt_id : null;
    const dedupe = receipt ? 'receipt:' + receipt : 'review:' + randomUUID(), id = randomUUID(), time = stamp();
    this.desk.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM ai_ticket_jobs WHERE dedupe_key=?').get(dedupe)) return;
      this.db.prepare("UPDATE ai_ticket_jobs SET state='superseded',updated_at=? WHERE ticket_key=? AND state='queued'").run(time, key);
      this.db.prepare(`INSERT INTO ai_ticket_jobs(id,ticket_key,dedupe_key,receipt_id,source,is_reply,auto_reply_allowed,input_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, key, dedupe, receipt, options.source === 'manual' ? 'manual' : options.source === 'review' ? 'review' : 'email', options.is_reply ? 1 : 0, options.auto_reply_allowed !== false ? 1 : 0, ticketInputHash(this.desk, key), time, time);
    });
    // The current synchronous intake transaction finishes before this runs.
    queueMicrotask(() => this.wake());
    return { queued: true, job_id: this.db.prepare('SELECT id FROM ai_ticket_jobs WHERE dedupe_key=?').get(dedupe).id };
  }
  reviewTicket(key, user) {
    this.auth(user); this.exists(key);
    if (!this.settings.snapshot().enabled) throw fail('Enable AI in Settings before reviewing tickets.', 409, { blocked: true });
    this.enqueue(key, { source: 'review', is_reply: true, auto_reply_allowed: false });
    return this.ticketState(key, user);
  }
  start() {
    if (this.started) return this.active;
    this.started = true; this.stopping = false;
    this.desk.transaction(() => {
      const time = stamp();
      this.db.prepare("UPDATE ai_ticket_replies SET state='needs_attention',error='The previous email delivery could not be confirmed. Check the mail service before sending another reply.',updated_at=? WHERE state='sending'").run(time);
      this.db.prepare("UPDATE ai_ticket_jobs SET state='queued',claim_token=NULL,updated_at=? WHERE state='running'").run(time);
    });
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref?.();
    return this.wake();
  }
  wake() {
    if (this.stopping) return this.active;
    this.requested = true;
    if (!this.running) {
      this.running = true;
      this.active = Promise.resolve().then(() => this.drain()).catch(() => this.logger.error?.({ error: 'An AI ticket scheduler operation failed.' })).finally(() => {
        this.running = false;
        if (this.requested && !this.stopping) this.wake();
      });
    }
    return this.active;
  }
  async stop() { this.stopping = true; clearInterval(this.timer); await this.active; }
  async drain() {
    do {
      this.requested = false;
      let job;
      while (!this.stopping && (job = this.claim())) await this.execute(job);
    } while (this.requested && !this.stopping);
  }
  claim() {
    return this.desk.transaction(() => {
      const job = this.db.prepare("SELECT rowid AS sequence,* FROM ai_ticket_jobs WHERE state='queued' ORDER BY rowid LIMIT 1").get();
      if (!job) return null;
      const claim = randomUUID();
      this.db.prepare("UPDATE ai_ticket_jobs SET state='running',claim_token=?,attempts=attempts+1,error=NULL,updated_at=? WHERE id=?").run(claim, stamp(), job.id);
      return { ...job, state: 'running', claim_token: claim };
    });
  }
  current(job, config) {
    const saved = this.db.prepare('SELECT state,claim_token FROM ai_ticket_jobs WHERE id=?').get(job.id);
    const latest = this.db.prepare('SELECT id FROM ai_ticket_jobs WHERE ticket_key=? ORDER BY rowid DESC LIMIT 1').get(job.ticket_key);
    if (saved?.state !== 'running' || saved.claim_token !== job.claim_token || latest?.id !== job.id) throw fail('A newer AI review replaced this one.', 409, { superseded: true });
    const settings = this.settings.snapshot();
    if (!settings.enabled || settings.version !== config.version) throw fail('AI settings changed while this review was running. Review the ticket again with the current settings.', 409, { blocked: true });
    if (ticketInputHash(this.desk, job.ticket_key) !== job.input_hash) throw fail('The ticket changed while AI was reviewing it. Review again for current suggestions.', 409, { blocked: true });
    return settings;
  }
  save(job, result, state = 'running', error = null) {
    return this.db.prepare('UPDATE ai_ticket_jobs SET result_json=?,state=?,error=?,updated_at=? WHERE id=? AND claim_token=? AND state=\'running\'').run(JSON.stringify(result), state, error, stamp(), job.id, job.claim_token).changes;
  }
  safeError(error, config) {
    let message = typeof error?.safeMessage === 'string' && error.safeMessage.length <= 600 ? error.safeMessage : 'AI processing could not be completed. Check the provider settings and try again.';
    for (const provider of Object.values(config?.providers || {})) if (provider.api_key && message.includes(provider.api_key)) message = 'AI processing could not be completed. Check the provider settings and try again.';
    return message;
  }
  async request(kind, config, context) {
    const selected = config.providers[config.provider];
    if (!selected?.api_key) throw fail('Configure an API key for the selected AI provider in Settings.', 409, { blocked: true });
    return validateAiResult(kind, await this.providers.review({ provider: config.provider, apiKey: selected.api_key, model: selected.model, systemPrompt: config.prompts.system, prompt: config.prompts[kind], context, kind }));
  }
  localEnrichment(job, config, context, result) {
    this.desk.transaction(() => {
      this.current(job, config);
      const ticket = this.desk.getTicket(job.ticket_key);
      if (config.auto_location && !ticket.location?.trim() && context.requester_location) {
        const person = this.workspace.assetRow(context.requester_location.asset_id);
        if (person && this.workspace.categoryRow(person.category_id)?.visibility === 'all' && person.email.toLowerCase() === ticket.requester.toLowerCase()) {
          this.desk.updateTicket(ticket.key, { location: context.requester_location.location }, { actor, version: ticket.version });
          result.location_set = context.requester_location.location;
        }
      }
      if (config.auto_assets) for (const candidate of context.asset_candidates) {
        if (!sharedSourceIsCurrent(this.workspace, candidate, 'asset')) continue;
        const link = this.workspace.linkTicket(job.ticket_key, candidate.id);
        if (!link.duplicate) result.assets_linked.push({ id: candidate.id, ref: candidate.ref, name: candidate.name });
      }
      this.save(job, result);
    });
  }
  async execute(job) {
    let config, result = emptyResult();
    try {
      config = this.settings.runtime();
      this.current(job, config);
      const context = buildAiContext({ desk: this.desk, ticketKey: job.ticket_key });
      const originalTags = new Set(this.desk.ticketTags(job.ticket_key).map(tagKey));
      this.db.prepare('UPDATE ai_ticket_jobs SET settings_version=? WHERE id=? AND claim_token=?').run(config.version, job.id, job.claim_token);
      this.localEnrichment(job, config, context, result);
      if (config.auto_tags) {
        const triage = await this.request('triage', config, { ticket: context.ticket, asset_candidates: context.asset_candidates.map(({ id, ref, name, type }) => ({ id, ref, name, type })) });
        const tags = normalizeTicketTags(triage.tags);
        this.desk.transaction(() => {
          this.current(job, config);
          if (!context.asset_candidates.every(candidate => sharedSourceIsCurrent(this.workspace, candidate, 'asset'))) throw fail('Asset information changed during AI review. Review again for current information.', 409, { blocked: true });
          const currentTags = new Set(this.desk.ticketTags(job.ticket_key).map(tagKey));
          for (const tag of tags) {
            const normalized = tagKey(tag);
            if (currentTags.has(normalized) || originalTags.has(normalized)) continue;
            this.desk.addTicketTag(job.ticket_key, tag, actor); result.tags_added.push(tag); currentTags.add(normalized);
          }
          this.save(job, result);
        });
      }
      if (config.suggest_fixes) {
        if (!context.documentation.length) result.suggestions = { status: 'no_documentation', summary: 'No matching shared documentation was found. Add a relevant knowledge article and review this ticket again.', steps: [], articles: [] };
        else {
          const suggestions = await this.request('suggestions', config, { ticket: context.ticket, documentation: context.documentation });
          this.current(job, config);
          const provided = new Map(context.documentation.map(article => [article.id, article]));
          if (suggestions.article_ids.some(id => !provided.has(id))) throw fail('The AI response referenced documentation that was not supplied. Review again for verified sources.', 502);
          if (!context.documentation.every(article => sharedSourceIsCurrent(this.workspace, article))) throw fail('Knowledge content or access changed during AI review. Review again for current sources.', 409, { blocked: true });
          const ids = [...new Set(suggestions.article_ids)];
          result.suggestions = ids.length ? { status: 'ready', summary: suggestions.summary, steps: suggestions.steps,
            articles: ids.map(id => ({ id, name: provided.get(id).name, url: '#knowledge/article/' + encodeURIComponent(id) })),
            provenance: context.documentation.map(({ id, category_id, version }) => ({ id, category_id, version })) }
            : { status: 'no_documentation', summary: 'AI did not identify a documentation-backed fix for this ticket.', steps: [], articles: [] };
        }
        this.save(job, result);
      } else result.suggestions = { status: 'disabled', summary: '', steps: [], articles: [] };
      this.current(job, config);
      await this.autoReply(job, config, context, result);
      this.current(job, config);
      this.save(job, result, 'completed');
    } catch (error) {
      const state = error?.superseded ? 'superseded' : error?.blocked || error?.statusCode === 503 ? 'blocked' : 'failed';
      this.save(job, result, state, this.safeError(error, config));
    }
  }
  replyRow(key) { return this.db.prepare('SELECT * FROM ai_ticket_replies WHERE ticket_key=?').get(key); }
  publicReply(row) {
    return { status: row.state === 'sending' ? 'queued' : row.state, body: row.body, questions: parse(row.questions_json) || [], error: row.error || null, sent_at: row.sent_at || null };
  }
  safeRequester(ticket) {
    const requester = ticket.requester.trim().toLowerCase();
    if (!/^[^\s<>@,;"\\\x00-\x1f]+@[^\s<>@,;"\\\x00-\x1f]+\.[^\s<>@,;"\\\x00-\x1f]+$/.test(requester)) return false;
    if (/^(?:mailer-daemon|postmaster|no-?reply|donotreply)(?:[+._-].*)?@/i.test(requester)) return false;
    return !this.supportEmails.some(email => email.toLowerCase() === requester) && !this.mail?.isSender?.(requester);
  }
  async autoReply(job, config, context, result) {
    const existing = this.replyRow(job.ticket_key);
    if (existing) { result.reply = this.publicReply(existing); return; }
    if (!config.auto_reply) { result.reply = { status: 'disabled' }; return; }
    const ticket = this.desk.getTicket(job.ticket_key);
    if (job.is_reply || !job.auto_reply_allowed || job.source === 'review' || !this.safeRequester(ticket) || !this.desk.settings.isActiveStatus(ticket.status)) { result.reply = { status: 'suppressed' }; return; }
    // Internal notes, inventory context, and knowledge are never sent to the
    // responder model. The destination and headers are chosen locally.
    const reply = await this.request('reply', config, { ticket: context.ticket });
    this.current(job, config);
    if (!reply.needs_information) { result.reply = { status: 'not_needed', questions: [] }; return; }
    const currentTicket = this.desk.getTicket(job.ticket_key);
    if (!this.safeRequester(currentTicket) || !this.desk.settings.isActiveStatus(currentTicket.status)) { result.reply = { status: 'suppressed' }; return; }
    const text = `We received your ticket ${currentTicket.key}: ${currentTicket.subject}.\n\n${reply.body}\n\nAdditional information requested:\n${reply.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`;
    const id = '<ai-ticket-' + createHash('sha256').update(job.ticket_key).digest('hex').slice(0, 40) + '@assetdesk.local>';
    const capabilities = this.mail?.capabilities?.({ role: 'admin', active: true });
    const configured = Boolean(capabilities?.email?.configured);
    let shouldSend = false;
    this.desk.transaction(() => {
      this.current(job, config);
      const time = stamp();
      const changes = this.db.prepare('INSERT OR IGNORE INTO ai_ticket_replies(ticket_key,job_id,state,message_id,body,questions_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(job.ticket_key, job.id, configured ? 'sending' : 'blocked', id, text, JSON.stringify(reply.questions), configured ? null : 'Outbound email is not configured. Configure SMTP before enabling automatic replies.', time, time).changes;
      if (changes && configured) { this.desk.store.recordOutboundMessage({ messageId: id, ticketKey: job.ticket_key, recipient: currentTicket.requester }); shouldSend = true; }
    });
    if (!shouldSend) { result.reply = this.publicReply(this.replyRow(job.ticket_key)); return; }
    try {
      this.current(job, config);
      const inbound = job.receipt_id ? this.desk.store.message(job.receipt_id)?.message : null;
      const inReplyTo = messageId(inbound?.messageId) ? inbound.messageId : undefined;
      const references = [...new Set([...(inbound?.references || []).filter(messageId), ...(inReplyTo ? [inReplyTo] : [])])].slice(-50);
      await this.mail.sendEmail({ to: currentTicket.requester, subject: `[${currentTicket.key}] Re: ${currentTicket.subject}`.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240), text, messageId: id, ...(inReplyTo ? { inReplyTo } : {}), ...(references.length ? { references } : {}), autoReply: true });
      this.db.prepare("UPDATE ai_ticket_replies SET state='sent',sent_at=?,updated_at=?,error=NULL WHERE ticket_key=? AND state='sending'").run(stamp(), stamp(), job.ticket_key);
      this.desk.event(job.ticket_key, 'ai_reply', 'AI acknowledgement and a request for additional information were accepted by the mail service.', actor);
    } catch (error) {
      const state = error?.blocked ? 'blocked' : error?.uncertain || !error?.safeMessage ? 'needs_attention' : 'failed';
      const message = state === 'needs_attention' ? 'Email delivery could not be confirmed. Check the mail service before sending another reply.' : this.safeError(error, config);
      this.db.prepare('UPDATE ai_ticket_replies SET state=?,error=?,updated_at=? WHERE ticket_key=? AND state=\'sending\'').run(state, message, stamp(), job.ticket_key);
    }
    result.reply = this.publicReply(this.replyRow(job.ticket_key));
  }
  ticketState(key, user) {
    const currentUser = this.auth(user); this.exists(key);
    const settings = this.settings.snapshot(), job = this.db.prepare('SELECT * FROM ai_ticket_jobs WHERE ticket_key=? ORDER BY rowid DESC LIMIT 1').get(key);
    const result = parse(job?.result_json) || emptyResult();
    const replyRow = this.replyRow(key), reply = replyRow ? this.publicReply(replyRow) : result.reply || { status: settings.auto_reply ? 'not_needed' : 'disabled' };
    let suggestions = result.suggestions || emptySuggestions();
    if (suggestions.provenance?.some(source => !sharedSourceIsCurrent(this.workspace, source)) || job && job.input_hash !== ticketInputHash(this.desk, key)) suggestions = { status: 'stale', summary: 'The ticket or its documentation has changed. Review again for current suggestions.', steps: [], articles: [] };
    const { provenance, ...visibleSuggestions } = suggestions;
    const linked = (result.assets_linked || []).flatMap(asset => { try { const record = this.workspace.getAsset(asset.id, currentUser); return [{ id: record.id, ref: record.ref, name: record.name }]; } catch { return []; } });
    let status = settings.enabled ? job?.state || 'not_reviewed' : 'disabled';
    if (status === 'superseded') status = 'queued';
    if (settings.enabled && ['blocked', 'failed', 'needs_attention'].includes(reply.status)) status = reply.status;
    return { enabled: settings.enabled, status, updated_at: job?.updated_at || null, error: job?.error || reply.error || null, tags_added: result.tags_added || [], location_set: result.location_set || null, assets_linked: linked, suggestions: visibleSuggestions, reply, can_review: settings.enabled && !['queued', 'running'].includes(job?.state) };
  }
}
