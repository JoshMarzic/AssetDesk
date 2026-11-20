import express from 'express';
import { ACTION_TYPES } from './actions-store.js';
import { createWorkflowsRouter } from './workflows-routes.js';

const RUN_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'waiting_task', 'waiting_delay', 'completed', 'rejected', 'cancelled', 'failed', 'blocked', 'needs_attention']);
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function body(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Provide valid action fields.');
  return input;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw invalid('Invalid action ID.');
  return value;
}
function runFilters(query) {
  const filters = {};
  for (const [key, value] of Object.entries(query)) {
    if (!['limit', 'offset', 'status'].includes(key) || typeof value !== 'string') throw invalid('Provide valid action search filters.');
    if (key === 'status') {
      if (value && !RUN_STATUSES.has(value)) throw invalid('Choose a valid action status.');
      if (value) filters.status = value;
    } else {
      if (!/^\d{1,7}$/.test(value)) throw invalid('Provide valid action pagination.');
      filters[key] = Number(value);
    }
  }
  if ((filters.limit !== undefined && (filters.limit < 1 || filters.limit > 100)) || (filters.offset !== undefined && filters.offset > 1_000_000)) throw invalid('Provide valid action pagination.');
  return filters;
}
function wake(runner) {
  // Mutations are durable before scheduling execution; the server scheduler
  // also discovers queued work after a restart or a temporarily unavailable wake.
  try { Promise.resolve(runner?.wake()).catch(() => {}); } catch { /* A later scheduler tick resumes persisted work. */ }
}

/** Authenticated Actions API; the parent router enforces session and CSRF. */
export function createActionsRouter({ actions, runner, transports, workflows }) {
  const router = express.Router();
  router.use((req, res, next) => req.deskSession?.user ? next() : res.status(401).json({ error: 'Sign in to continue.' }));
  const user = req => req.deskSession.user;
  const runResult = (run, req) => {
    const composition = workflows?.getRunComposition(run.id, user(req));
    return composition ? { ...run, workflow: composition } : run;
  };
  if (workflows) router.use('/workflows', createWorkflowsRouter({ workflows, runner }));
  router.get('/types', (req, res) => res.json({ types: ACTION_TYPES, capabilities: transports.capabilities(user(req)) }));
  router.get('/templates', (req, res) => {
    if (Object.keys(req.query).length) throw invalid('Template search filters are not supported.');
    res.json({ templates: actions.listTemplates(user(req)) });
  });
  router.get('/templates/:id', (req, res) => res.json(actions.getTemplate(id(req.params.id), user(req))));
  router.post('/templates', (req, res) => {
    const input = body(req.body, ['name', 'description', 'variables', 'steps']);
    res.status(201).json(actions.createTemplate(input, user(req)));
  });
  router.patch('/templates/:id', (req, res) => {
    const input = body(req.body, ['version', 'name', 'description', 'variables', 'steps', 'active']);
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw invalid('The current template version is required. Reload and try again.');
    if (Object.keys(input).length < 2) throw invalid('Provide a template change.');
    res.json(actions.updateTemplate(id(req.params.id), input, user(req)));
  });
  router.get('/runs', (req, res) => {
    const result = actions.listRuns(user(req), runFilters(req.query));
    res.json({ ...result, runs: result.runs.map(run => runResult(run, req)) });
  });
  router.get('/runs/:id', (req, res) => res.json(runResult(actions.getRun(id(req.params.id), user(req)), req)));
  router.post('/runs', (req, res) => {
    const input = body(req.body, ['name', 'template_id', 'template_version', 'definition', 'values', 'ticket_key']);
    const run = actions.createRun(input, user(req));
    wake(runner);
    res.status(202).json(runResult(run, req));
  });
  router.post('/runs/:id/cancel', (req, res) => {
    body(req.body, []);
    const run = actions.cancelRun(id(req.params.id), user(req));
    res.json(runResult(run, req));
  });
  router.post('/runs/:id/retry', (req, res) => {
    body(req.body, []);
    const run = actions.retryRun(id(req.params.id), user(req));
    wake(runner); res.json(runResult(run, req));
  });
  router.post('/runs/:id/complete-task', (req, res) => {
    const input = body(req.body, ['comment']);
    if (input.comment !== undefined && (typeof input.comment !== 'string' || input.comment.length > 1000)) throw invalid('Task comments must be at most 1,000 characters.');
    const run = actions.completeTask(id(req.params.id), input, user(req));
    wake(runner); res.json(runResult(run, req));
  });
  return router;
}

function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw invalid('This approval link was not found.', 404);
  return value;
}
function publicPage(view, { error = '', token: value = '' } = {}) {
  const state = ['approved', 'rejected'].includes(view?.decision) ? view.decision
    : ['expired', 'cancelled'].includes(view?.status) ? view.status : view?.decision || view?.status;
  const outcome = state === 'approved' ? 'Approved' : state === 'rejected' ? 'Rejected' : state === 'expired' ? 'Approval expired' : state === 'cancelled' ? 'Approval cancelled' : 'Approval unavailable';
  const title = view?.can_decide ? 'Review approval request' : outcome;
  const expires = view?.expires_at && Number.isFinite(Date.parse(view.expires_at))
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(view.expires_at)) + ' UTC'
    : view?.expires_at || 'at the configured deadline';
  const result = view?.can_decide ? '' : `<div class="approval-result" role="status"><strong>${html(outcome)}</strong><p>${state === 'approved' ? 'Your approval has been recorded. The workflow can continue.' : state === 'rejected' ? 'Your rejection has been recorded. The workflow will not continue.' : 'This link cannot be used to submit another decision.'}</p></div>`;
  const request = view ? `<div class="approval-details"><p class="eyebrow">${html(view.run_name)}</p><h2>${html(view.subject || view.step_name || 'Approval request')}</h2><div class="approval-meta"><p>Requested from <strong>${html(view.recipient)}</strong></p><p>Expires ${html(expires)}</p></div><div class="approval-message">${html(view.body || '')}</div></div>` : '';
  const form = view?.can_decide ? `<form class="approval-decision-form" method="post" action="/approve/${encodeURIComponent(value)}"><div class="field"><label for="approval-comment">Comment (optional)</label><textarea class="input" id="approval-comment" name="comment" maxlength="1000" rows="3"></textarea></div><p>Approving continues this workflow. Rejecting stops it. Your decision can be submitted once.</p><div class="approval-buttons"><button class="btn primary" type="submit" name="decision" value="approved">Approve request</button><button class="btn danger" type="submit" name="decision" value="rejected">Reject request</button></div></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${html(title)} · AssetDesk</title><link rel="stylesheet" href="/styles.css"></head><body><main class="approval-page"><section class="approval-card"><div class="approval-brand">AssetDesk</div><h1>${html(title)}</h1>${error ? `<div class="field-error" role="alert">${html(error)}</div>` : ''}${request}${result}${form}<p class="approval-meta">Only the recipient of this private approval link should submit a decision. Opening this page does not approve the request.</p></section></main></body></html>`;
}

/** Private capability links let an email recipient decide without an app login. */
export function createApprovalRouter({ actions, runner, publicUrl = '' }) {
  const router = express.Router();
  router.param('token', (req, _res, next, value) => { req.actionApprovalToken = token(value); next(); });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Keep private token paths out of referrers while preserving the page's
    // canonical Origin on native form POSTs (no-referrer produces Origin:null).
    res.set('Referrer-Policy', 'strict-origin');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  router.get('/:token', (req, res) => {
    const value = token(req.params.token);
    res.type('html').send(publicPage(actions.resolveApproval(value), { token: value }));
  });
  router.post('/:token', (req, _res, next) => {
    if (!req.is('application/x-www-form-urlencoded')) throw invalid('Submit the approval using the review form.', 415);
    const origin = req.get('Origin');
    let expected;
    try { expected = publicUrl ? new URL(publicUrl).origin : `${req.protocol}://${req.get('host')}`; } catch { throw invalid('The approval address is not configured correctly.', 503); }
    if (origin && origin !== expected) throw invalid('Submit the approval from its original review page.', 403);
    next();
  }, express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 4 }), (req, res) => {
    const value = token(req.params.token), input = body(req.body, ['decision', 'comment']);
    if (!['approved', 'rejected'].includes(input.decision)) throw invalid('Choose Approve request or Reject request.');
    if (input.comment !== undefined && (typeof input.comment !== 'string' || input.comment.length > 1000 || input.comment.includes('\0'))) throw invalid('Approval comments must be at most 1,000 characters.');
    const view = actions.decideApproval(value, { decision: input.decision, comment: input.comment || '' });
    wake(runner);
    res.type('html').send(publicPage(view));
  });
  router.use((error, req, res, _next) => {
    const code = error.statusCode || error.status || 500;
    const status = [400, 403, 404, 409, 410, 413, 415, 503].includes(code) ? code : 500;
    const message = status === 500 ? 'The approval request could not be loaded. Try again later.' : status === 413 ? 'The approval form is too large.' : error.safeMessage || error.message;
    let view = null;
    if ([400, 409, 410].includes(status) && req.actionApprovalToken) { try { view = actions.resolveApproval(req.actionApprovalToken); } catch {} }
    res.status(status).type('html').send(publicPage(view, { error: message, token: req.actionApprovalToken || '' }));
  });
  return router;
}
