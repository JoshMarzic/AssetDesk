import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { parseRawEmail } from './email.js';
import { createKnowledgeRouter } from './knowledge.js';
import { createAssetsRouter } from './workspace-routes.js';

const COOKIE = 'assetdesk_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const MAX_LOGIN_IPS = 1000;
const STATUSES = new Set(['open', 'in_progress', 'waiting', 'resolved', 'closed']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const CATEGORIES = new Set(['general', 'hardware', 'software', 'network', 'access']);
const VIEWS = new Set(['all', 'open', 'my', 'unassigned', 'overdue', 'resolved']);

function invalid(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sameString(value, expected) {
  const a = Buffer.from(typeof value === 'string' ? value : '');
  const b = Buffer.from(typeof expected === 'string' ? expected : '');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req) {
  for (const entry of (req.headers.cookie || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator !== -1 && entry.slice(0, separator).trim() === COOKIE) {
      const value = entry.slice(separator + 1).trim();
      return value.length <= 256 ? value : '';
    }
  }
  return '';
}

function scalarQuery(value, name, max = 200) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw invalid(`Invalid ${name} filter.`);
  return value;
}

function objectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('A JSON object is required.');
  return body;
}

function onlyFields(body, allowed) {
  const fields = Object.keys(body);
  if (fields.some(field => !allowed.includes(field))) throw invalid('Request contains an unsupported field.');
}

/** Browser session API. The mail/API bearer credentials never enter the UI. */
export function createDeskRouter({ desk, store, worker, config, workspace }) {
  const router = express.Router();
  const loginFailures = new Map();
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: Boolean(config.cookieSecure), path: '/' };
  const sessionBody = session => ({ user: session.user, csrfToken: session.csrfToken });

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Use Content-Type: application/json.' });
    }
    next();
  });
  const jsonBody = express.json({ limit: '512kb' });
  const imageBody = express.json({ limit: '15mb' });
  router.use((req, res, next) => {
    const imageUpload = req.method === 'POST' && /^\/knowledge\/articles\/[^/]+\/images$/.test(req.path);
    return (imageUpload ? imageBody : jsonBody)(req, res, next);
  });

  router.post('/login', async (req, res) => {
    const body = objectBody(req.body);
    const { email, password } = body;
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 1024) {
      throw invalid('Enter your email address and password.');
    }
    const now = Date.now();
    const ip = req.ip || 'unknown';
    for (const [key, value] of loginFailures) {
      if (value.expires <= now) loginFailures.delete(key);
    }
    const failures = loginFailures.get(ip);
    if (failures && failures.count >= MAX_LOGIN_FAILURES) {
      res.set('Retry-After', String(Math.ceil((failures.expires - now) / 1000)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    // Reserve the attempt before asynchronous password hashing so parallel
    // requests cannot all pass the limiter before their failures are recorded.
    if (!loginFailures.has(ip) && loginFailures.size >= MAX_LOGIN_IPS) {
      loginFailures.delete(loginFailures.keys().next().value);
    }
    loginFailures.set(ip, { count: (failures?.count || 0) + 1, expires: failures?.expires || now + LOGIN_WINDOW_MS });
    const user = await desk.verifyUser(email.trim().toLowerCase(), password);
    if (!user) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    loginFailures.delete(ip);
    const previous = cookieToken(req);
    if (previous) desk.deleteSession(previous);
    const created = desk.createSession(user.id);
    res.cookie(COOKIE, created.token, { ...cookieOptions, maxAge: SESSION_MS });
    return res.json(sessionBody({ ...created, user }));
  });

  router.use((req, res, next) => {
    const token = cookieToken(req);
    const session = token && desk.session(token);
    if (!session) return res.status(401).json({ error: 'Sign in to continue.' });
    req.deskSession = session;
    req.deskToken = token;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameString(req.get('X-CSRF-Token'), session.csrfToken)) {
      return res.status(403).json({ error: 'Your session could not be verified. Refresh and try again.' });
    }
    next();
  });

  const adminOnly = (req, res, next) => req.deskSession.user.role === 'admin'
    ? next() : res.status(403).json({ error: 'Administrator access is required.' });

  router.use('/knowledge', createKnowledgeRouter({ workspace, config }));
  router.use('/assets', createAssetsRouter({ workspace }));

  router.get('/session', (req, res) => res.json(sessionBody(req.deskSession)));
  router.post('/logout', (req, res) => {
    desk.deleteSession(req.deskToken);
    res.clearCookie(COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  const visibleEvents = (events, user) => events.filter(event => {
    if (event.type !== 'asset_link') return true;
    const ref = event.body.match(/^Linked asset (.+)$/)?.[1];
    if (!ref) return false;
    const asset = workspace.assetRow(ref);
    return Boolean(asset && workspace.canReadCategory(workspace.categoryRow(asset.category_id), user));
  });
  const presentTicket = (ticket, user) => ticket && ({ ...ticket,
    assets: workspace.ticketAssets(ticket.key, user), related_tickets: workspace.relatedTickets(ticket.key, user),
    events: visibleEvents(ticket.events || [], user) });
  router.get('/dashboard', (req, res) => {
    const dashboard = desk.dashboard();
    dashboard.activity = visibleEvents(dashboard.activity, req.deskSession.user);
    dashboard.recentActivity = dashboard.activity;
    res.json({ ...dashboard, intake: { counts: store.counts() } });
  });
  router.get('/responses', (_req, res) => res.json({ responses: desk.listResponses() }));
  router.post('/responses', adminOnly, (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['title', 'body']);
    res.status(201).json(desk.createResponse(body, req.deskSession.user));
  });
  router.patch('/responses/:id', adminOnly, (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['title', 'body', 'active']);
    if (!Object.keys(body).length) throw invalid('Provide a saved response change.');
    res.json(desk.updateResponse(req.params.id, body, req.deskSession.user));
  });
  router.get('/technicians', (req, res) => {
    const all = desk.listTechnicians();
    res.json({ technicians: req.deskSession.user.role === 'admin' ? all : all.filter(user => user.active) });
  });
  router.post('/technicians', adminOnly, async (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['name', 'email', 'password', 'role']);
    const user = await desk.createTechnician(body);
    res.status(201).json(user);
  });
  router.patch('/technicians/:id', adminOnly, async (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['name', 'role', 'password', 'active']);
    res.json(await desk.updateTechnician(req.params.id, body));
  });

  router.get('/tickets', (req, res) => {
    const filters = {};
    for (const name of ['search', 'status', 'priority', 'assignee', 'category', 'view']) {
      filters[name] = scalarQuery(req.query[name], name);
    }
    if (filters.view && !VIEWS.has(filters.view)) throw invalid('Invalid ticket view.');
    if (filters.status && !STATUSES.has(filters.status)) throw invalid('Invalid status filter.');
    if (filters.priority && !PRIORITIES.has(filters.priority)) throw invalid('Invalid priority filter.');
    if (filters.category && !CATEGORIES.has(filters.category)) throw invalid('Invalid category filter.');
    if (filters.view === 'my') {
      filters.assignee = req.deskSession.user.id;
      filters.view = 'all';
    }
    for (const name of ['limit', 'offset']) {
      const value = scalarQuery(req.query[name], name, 8);
      if (value !== undefined) {
        if (!/^\d+$/.test(value)) throw invalid(`Invalid ${name}.`);
        filters[name] = Number(value);
      }
    }
    if (filters.limit !== undefined && (filters.limit < 1 || filters.limit > 100)) throw invalid('Limit must be between 1 and 100.');
    if (filters.offset !== undefined && filters.offset > 1_000_000) throw invalid('Offset is too large.');
    res.json(desk.listTickets(filters));
  });
  router.post('/tickets', async (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['subject', 'requester', 'requester_name', 'description', 'priority', 'category', 'assignee_id']);
    const { subject, requester, description } = body;
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 240 || /[\x00-\x1f\x7f]/.test(subject)
      || typeof requester !== 'string' || requester.length > 254 || !/^[^\s<>\x00-\x1f@]+@[^\s<>\x00-\x1f@]+\.[^\s<>\x00-\x1f@]+$/.test(requester)
      || typeof description !== 'string' || !description.trim() || description.length > 100_000
      || (body.requester_name !== undefined && (typeof body.requester_name !== 'string' || body.requester_name.length > 200 || /[\x00-\x1f\x7f]/.test(body.requester_name)))
      || (body.priority !== undefined && !PRIORITIES.has(body.priority))
      || (body.category !== undefined && !CATEGORIES.has(body.category))) {
      throw invalid('Provide a subject, valid requester email, description, and valid ticket fields.');
    }
    if (body.assignee_id !== undefined && body.assignee_id !== null
      && (typeof body.assignee_id !== 'string' || !desk.listTechnicians().some(user => user.id === body.assignee_id && user.active))) {
      throw invalid('Choose an active technician.');
    }
    const raw = `From: ${requester}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@assetdesk.local>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(description).toString('base64')}`;
    const message = await parseRawEmail(raw, { prefixes: config.prefixes });
    message.from.name = (body.requester_name || '').trim();
    message.desk = {
      priority: body.priority || 'normal', category: body.category || 'general',
      assignee_id: body.assignee_id || null, source: 'manual', actor: req.deskSession.user,
    };
    const receipt = worker.accept(message);
    worker.wake();
    res.status(202).json({ ...receipt, statusUrl: `/api/desk/receipts/${receipt.id}` });
  });
  router.get('/receipts/:id', (req, res) => {
    const receipt = store.receipt(req.params.id);
    if (!receipt) throw invalid('Receipt not found.', 404);
    res.json(receipt);
  });
  router.get('/tickets/:key', (req, res) => {
    const ticket = desk.getTicket(req.params.key);
    if (!ticket) throw invalid('Ticket not found.', 404);
    res.json(presentTicket(ticket, req.deskSession.user));
  });
  router.patch('/tickets/:key', (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['version', 'status', 'priority', 'category', 'assignee_id', 'subject', 'resolution', 'first_response']);
    if (!Number.isSafeInteger(body.version) || body.version < 1) throw invalid('The ticket version is required. Refresh and try again.');
    const { version, ...patch } = body;
    if (!Object.keys(patch).length) throw invalid('Provide a ticket change.');
    res.json(presentTicket(desk.updateTicket(req.params.key, patch, { actor: req.deskSession.user, version }), req.deskSession.user));
  });
  router.post('/tickets/:key/notes', (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['body']);
    res.status(201).json(presentTicket(desk.addNote(req.params.key, { body: body.body, actor: req.deskSession.user }), req.deskSession.user));
  });
  router.post('/tickets/:key/assets', (req, res) => {
    const body = objectBody(req.body);
    onlyFields(body, ['ref']);
    if (typeof body.ref !== 'string') throw invalid('Provide an asset ID.');
    const ref = body.ref.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(ref)) throw invalid('Asset IDs must contain 1 to 64 letters, numbers, dots, underscores, or hyphens.');
    if (!desk.getTicket(req.params.key)) throw invalid('Ticket not found.', 404);
    const result = workspace.transaction(() => {
      let asset;
      try { asset = workspace.getAsset(ref, req.deskSession.user); }
      catch (error) {
        if (error.statusCode !== 404 || workspace.assetRow(ref)) throw error;
        asset = workspace.createAsset({ ref, name: ref, type: 'hardware' }, req.deskSession.user);
      }
      return workspace.linkTicket(req.params.key, asset.id, req.deskSession.user);
    });
    res.status(201).json({ ...result, queued: false });
  });

  router.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  router.use((error, _req, res, _next) => {
    const status = error.statusCode || error.status;
    if ([400, 401, 403, 404, 409, 413, 415, 429].includes(status)) {
      const message = error instanceof SyntaxError ? 'Malformed JSON.' : status === 413 ? 'Request is too large.' : error.safeMessage || error.message;
      return res.status(status).json({ error: message });
    }
    res.status(500).json({ error: 'The request could not be completed. Try again.' });
  });
  return router;
}
