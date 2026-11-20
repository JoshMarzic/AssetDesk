import express from 'express';

const invalid = message => Object.assign(new Error(message), { statusCode: 400, safeMessage: message });
function input(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Provide a settings object.');
  const { version, ...values } = body;
  return { version, values };
}

/** Administrator workflow editing; authentication and CSRF also apply upstream. */
export function createSettingsRouter({ desk }) {
  const router = express.Router();
  router.use((req, res, next) => req.deskSession?.user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access is required.' }));
  router.get('/', (_req, res) => res.json(desk.settings.snapshot()));
  router.post('/:type', (req, res) => {
    const { version, values } = input(req.body);
    res.status(201).json(desk.settings.create(req.params.type, values, { version, actor: req.deskSession.user }));
  });
  router.patch('/:type/:id', (req, res) => {
    const { version, values } = input(req.body);
    res.json(desk.settings.update(req.params.type, req.params.id, values, { version, actor: req.deskSession.user }));
  });
  return router;
}
