import express from 'express';
import { AI_DEFAULT_PROMPTS } from './ai-settings.js';

const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
function body(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Provide valid AI request fields.');
  return input;
}
function ticket(key, desk) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(key) || !desk.getTicket(key)) throw invalid('Ticket not found.', 404);
  return key;
}
function errors(error, _req, res, _next) {
  const supplied = error.statusCode || error.status;
  const status = [400, 401, 403, 404, 409, 413, 415, 429, 502, 503, 504].includes(supplied) ? supplied : 500;
  res.status(status).json({ error: error instanceof SyntaxError ? 'Malformed JSON.' : status === 500 ? 'The AI request could not be completed.' : error.safeMessage || 'The AI request could not be completed. Check the configuration and try again.' });
}

/** Provider administration. Browser sessions and CSRF are enforced upstream. */
export function createAiSettingsRouter({ settings, providers, mail }) {
  const router = express.Router();
  router.use((req, res, next) => !req.deskSession?.user ? res.status(401).json({ error: 'Sign in to continue.' }) : req.deskSession.user.role !== 'admin' ? res.status(403).json({ error: 'Administrator access is required.' }) : next());
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); if (Object.keys(req.query).length) throw invalid('AI settings search filters are not supported.'); next(); });
  const result = req => ({ ...settings.snapshot(), default_prompts: { ...AI_DEFAULT_PROMPTS }, capabilities: { email: { configured: Boolean(mail?.capabilities?.(req.deskSession.user)?.email?.configured) } } });
  router.get('/', (req, res) => res.json(result(req)));
  router.patch('/', (req, res) => { settings.update(req.body, { actor: req.deskSession.user }); res.json(result(req)); });
  router.post('/test', async (req, res) => {
    const input = body(req.body, ['provider']);
    if (!['openai', 'anthropic'].includes(input.provider)) throw invalid('Choose OpenAI or Claude to test.');
    const config = settings.runtime(), profile = config.providers[input.provider];
    if (!profile.api_key) throw invalid('Save an API key for this provider before testing the connection.', 409);
    await providers.testConnection({ provider: input.provider, apiKey: profile.api_key, model: profile.model });
    // Never forward an upstream result object: it may contain account details.
    res.json({ ok: true, provider: input.provider });
  });
  router.use(errors);
  return router;
}

/** Ticket AI state and explicit refresh; manual refresh never sends auto email. */
export function createAiTicketRouter({ ai, desk }) {
  const router = express.Router();
  router.use((req, res, next) => req.deskSession?.user ? next() : res.status(401).json({ error: 'Sign in to continue.' }));
  router.get('/:key/ai', (req, res) => {
    if (Object.keys(req.query).length) throw invalid('AI ticket search filters are not supported.');
    res.set('Cache-Control', 'no-store').json(ai.ticketState(ticket(req.params.key, desk), req.deskSession.user));
  });
  router.post('/:key/ai/review', async (req, res) => {
    if (Object.keys(req.query).length) throw invalid('AI ticket search filters are not supported.');
    body(req.body, []);
    const key = ticket(req.params.key, desk);
    await ai.reviewTicket(key, req.deskSession.user);
    res.status(202).json(ai.ticketState(key, req.deskSession.user));
  });
  router.use(errors);
  return router;
}
