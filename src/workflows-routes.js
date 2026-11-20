import express from 'express';

const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });

function body(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Provide valid workflow fields.');
  return input;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw invalid('Invalid workflow ID.');
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('The current workflow version is required. Reload and try again.');
  return value;
}
function wake(runner) {
  // The run and its composition are committed before execution is scheduled.
  // The normal scheduler also discovers queued runs after a restart.
  try { Promise.resolve(runner?.wake()).catch(() => {}); } catch { /* A later scheduler tick resumes durable work. */ }
}

/** Reusable workflow compositions; the parent desk router enforces session CSRF. */
export function createWorkflowsRouter({ workflows, runner }) {
  const router = express.Router();
  router.use((req, res, next) => req.deskSession?.user ? next() : res.status(401).json({ error: 'Sign in to continue.' }));
  router.use((req, _res, next) => {
    if (Object.keys(req.query).length) throw invalid('Workflow search filters are not supported.');
    next();
  });
  const user = req => req.deskSession.user;
  router.get('/', (req, res) => res.json({ workflows: workflows.listWorkflows(user(req)) }));
  router.get('/:id', (req, res) => res.json(workflows.getWorkflow(id(req.params.id), user(req))));
  router.post('/', (req, res) => {
    const input = body(req.body, ['name', 'description', 'variables', 'steps']);
    res.status(201).json(workflows.createWorkflow(input, user(req)));
  });
  router.patch('/:id', (req, res) => {
    const input = body(req.body, ['version', 'name', 'description', 'variables', 'steps', 'active']);
    version(input.version);
    if (Object.keys(input).length < 2) throw invalid('Provide a workflow change.');
    res.json(workflows.updateWorkflow(id(req.params.id), input, user(req)));
  });
  router.post('/:id/runs', (req, res) => {
    const input = body(req.body, ['workflow_version', 'values', 'name', 'ticket_key']);
    version(input.workflow_version);
    const run = workflows.createRun({ ...input, workflow_id: id(req.params.id) }, user(req));
    const composition = workflows.getRunComposition(run.id, user(req));
    wake(runner);
    res.status(202).json({ ...run, workflow: composition });
  });
  return router;
}
