import { createHash, randomBytes, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => value === null || value === undefined ? null : JSON.parse(value);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
const own = (object, name) => Object.hasOwn(object, name);
const TERMINAL = new Set(['completed', 'rejected', 'cancelled']);
const RETRYABLE = new Set(['failed', 'blocked', 'needs_attention']);
const RUN_STATES = new Set(['queued', 'running', 'waiting_approval', 'waiting_task', 'waiting_delay', ...TERMINAL, ...RETRYABLE]);
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const TOKEN = /{{\s*([a-z][a-z0-9_]{0,39})\s*}}/g;
const EMAIL = /^[^\s<>@,;"\\\x00-\x1f\x7f-\x9f]+@[^\s<>@,;"\\\x00-\x1f\x7f-\x9f]+\.[^\s<>@,;"\\\x00-\x1f\x7f-\x9f]+$/;

export const ACTION_TYPES = Object.freeze([
  { type: 'approval', name: 'Approval', label: 'Approval', description: 'Email a request and wait for an explicit approval or rejection.', fields: ['to', 'subject', 'body', 'expires_hours'] },
  { type: 'email', name: 'Send email', label: 'Send email', description: 'Send a notification to one recipient, then continue.', fields: ['to', 'subject', 'body'] },
  { type: 'api', name: 'API call', label: 'API call', description: 'Call an administrator-configured connection.', fields: ['connection', 'method', 'path', 'body'] },
  { type: 'power_automate', name: 'Power Automate', label: 'Power Automate', description: 'POST JSON to a configured HTTP-triggered flow and continue when the trigger accepts it.', fields: ['connection', 'body'] },
  { type: 'task', name: 'Manual task', label: 'Manual task', description: 'Wait for an assigned technician to complete a task.', fields: ['instructions', 'assignee_email'] },
  { type: 'delay', name: 'Wait', label: 'Wait', description: 'Pause for a duration and resume automatically.', fields: ['minutes'] },
]);
const TYPES = new Map(ACTION_TYPES.map(type => [type.type, type]));

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(`Provide valid ${label} fields.`);
  return value;
}
function text(value, label, max, empty = false, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(value)) throw fail(`${label} must be ${empty ? 'at most' : 'between 1 and'} ${max} characters.`);
  const result = value.trim();
  if (!empty && !result) throw fail(`${label} is required.`);
  return result;
}
function email(value, label = 'Recipient') {
  const result = text(value, label, 254).toLowerCase();
  if (!EMAIL.test(result)) throw fail(`${label} must be one valid email address.`);
  return result;
}
function tokens(value, keys) {
  const remainder = value.replace(TOKEN, (_match, key) => {
    if (!keys.has(key)) throw fail(`Declare the variable ${key} before using it.`);
    return '';
  });
  if (remainder.includes('{{') || remainder.includes('}}')) throw fail('Use variables in the format {{variable_key}}.');
}
function literal(value) { return !value.includes('{{'); }
function safePath(path) {
  if (typeof path !== 'string' || path.length > 3000 || !path.startsWith('/') || path.startsWith('//') || /[\\#\x00-\x20\x7f-\x9f]/.test(path)) throw fail('API paths must start with one / and contain no spaces, backslashes, or fragments.');
  let decoded = path.split('?')[0];
  try { for (let index = 0; index < 3; index++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } } catch { throw fail('Provide a valid API path.'); }
  if (decoded.split(/[\\/]/).some(part => part === '.' || part === '..') || decoded.startsWith('//')) throw fail('API paths cannot traverse outside the configured connection.');
  return path;
}
function jsonTemplate(value) {
  if (!value) return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw fail('API body must be valid JSON. Put variable tokens inside JSON string values.'); }
  if (!parsed || typeof parsed !== 'object') throw fail('API body must be a JSON object or array.');
  function check(node) {
    if (Array.isArray(node)) return node.forEach(check);
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) { if (key.includes('{{') || key.includes('}}')) throw fail('Use variables in JSON values, not JSON property names.'); check(child); }
  }
  check(parsed); return parsed;
}

/** Validate token-bearing workflow definitions without executing any step. */
export function validateActionDefinition(input) {
  object(input, ['name', 'description', 'variables', 'steps'], 'workflow');
  const name = text(input.name, 'Workflow name', 200), description = text(input.description ?? '', 'Description', 2000, true, true);
  if (!Array.isArray(input.variables) || input.variables.length > 100 || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 50) throw fail('A workflow needs 1 to 50 steps and at most 100 variables.');
  const keys = new Set();
  const variables = input.variables.map(variable => {
    object(variable, ['key', 'label', 'type', 'required', 'default', 'description'], 'variable');
    if (typeof variable.key !== 'string' || !KEY.test(variable.key) || variable.key === 'approval_url' || keys.has(variable.key)) throw fail('Variable keys must be unique lowercase names using letters, numbers, and underscores.');
    keys.add(variable.key);
    if (!['text', 'email', 'number', 'date'].includes(variable.type)) throw fail('Choose text, email, number, or date for each variable.');
    if (variable.required !== undefined && typeof variable.required !== 'boolean') throw fail('Variable required must be true or false.');
    const defaultValue = own(variable, 'default') ? variable.default : '';
    if (typeof defaultValue !== 'string' && (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))) throw fail('Variable defaults must be text or a finite number.');
    return { key: variable.key, label: text(variable.label || variable.key, 'Variable label', 100), type: variable.type, required: variable.required ?? true,
      default: text(String(defaultValue), 'Default value', 4000, true, variable.type === 'text'), description: text(variable.description ?? '', 'Variable description', 1000, true, true) };
  });
  const ids = new Set();
  const steps = input.steps.map(step => {
    object(step, ['id', 'type', 'name', 'config'], 'step');
    if (!TYPES.has(step.type)) throw fail('Choose a supported action step type.');
    const id = step.id || randomUUID();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw fail('Each step needs a unique identifier.');
    ids.add(id);
    const name = text(step.name || TYPES.get(step.type).name, 'Step name', 200); tokens(name, keys);
    const config = object(step.config, TYPES.get(step.type).fields, 'step configuration');
    let clean;
    if (step.type === 'email' || step.type === 'approval') {
      clean = { to: text(config.to, 'Recipient', 500), subject: text(config.subject, 'Email subject', 500), body: text(config.body, 'Email body', 20000, false, true) };
      if (literal(clean.to)) email(clean.to);
      if (literal(clean.subject)) text(clean.subject, 'Email subject', 240);
      if (step.type === 'approval') {
        const expires = config.expires_hours ?? 168;
        if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0 || expires > 720) throw fail('Approval expiry must be between 0 and 720 hours.');
        clean.expires_hours = expires;
      }
    } else if (step.type === 'task') {
      clean = { instructions: text(config.instructions, 'Task instructions', 20000, false, true), assignee_email: text(config.assignee_email ?? '', 'Assigned technician', 500, true) };
      if (clean.assignee_email && literal(clean.assignee_email)) email(clean.assignee_email, 'Assigned technician');
    } else if (step.type === 'api' || step.type === 'power_automate') {
      const connection = text(config.connection ?? '', 'API connection', 100, true);
      if (connection && !/^[A-Za-z0-9_-]{1,100}$/.test(connection)) throw fail('Choose a configured API connection.');
      const body = text(config.body ?? '', 'API JSON body', 30000, true, true) || (step.type === 'power_automate' ? '{}' : '');
      jsonTemplate(body);
      if (step.type === 'power_automate') clean = { connection, body };
      else {
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(config.method)) throw fail('Choose a supported API method.');
        clean = { connection, method: config.method, path: text(config.path, 'API path', 3000), body };
        safePath(clean.path.replace(TOKEN, 'variable'));
        if (clean.method === 'GET' && clean.body) throw fail('GET API steps cannot have a request body.');
      }
    } else {
      const minutes = typeof config.minutes === 'number' ? String(config.minutes) : text(config.minutes, 'Wait duration', 100);
      if (literal(minutes) && (!Number.isFinite(Number(minutes)) || Number(minutes) <= 0 || Number(minutes) > 43200)) throw fail('Wait duration must be greater than zero and at most 43,200 minutes.');
      clean = { minutes };
    }
    for (const value of Object.values(clean)) if (typeof value === 'string') tokens(value, keys);
    return { id, type: step.type, name, config: clean };
  });
  // Defaults are validated independently; optional empty values remain valid.
  resolveActionValues({ variables }, {}, { defaultsOnly: true });
  return { name, description, variables, steps };
}

export function resolveActionValues(definition, supplied, { defaultsOnly = false } = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw fail('Provide workflow variable values.');
  const variables = new Map(definition.variables.map(variable => [variable.key, variable]));
  for (const key of Object.keys(supplied)) if (!variables.has(key)) throw fail(`Unknown workflow variable: ${key}.`);
  return Object.fromEntries(definition.variables.map(variable => {
    const raw = own(supplied, variable.key) ? supplied[variable.key] : variable.default;
    if (typeof raw !== 'string' && (typeof raw !== 'number' || !Number.isFinite(raw))) throw fail(`Provide a valid value for ${variable.label}.`);
    let value = text(String(raw), variable.label, 4000, true, variable.type === 'text');
    if (!value) { if (!defaultsOnly && variable.required) throw fail(`${variable.label} is required.`); return [variable.key, '']; }
    if (variable.type === 'email') value = email(value, variable.label);
    if (variable.type === 'number') { if (!Number.isFinite(Number(value))) throw fail(`${variable.label} must be a finite number.`); value = Number(value); }
    if (variable.type === 'date') { const parsed = new Date(value + 'T00:00:00.000Z'); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fail(`${variable.label} must be a valid calendar date.`); }
    return [variable.key, value];
  }));
}
function renderString(input, values, path = false) {
  return input.replace(TOKEN, (_token, key) => {
    if (!own(values, key)) throw fail(`Missing workflow variable: ${key}.`);
    return path ? encodeURIComponent(String(values[key])) : String(values[key]);
  });
}
function renderJson(node, values) {
  if (typeof node === 'string') {
    const whole = node.match(/^{{\s*([a-z][a-z0-9_]{0,39})\s*}}$/);
    return whole ? values[whole[1]] : renderString(node, values);
  }
  if (Array.isArray(node)) return node.map(child => renderJson(child, values));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, renderJson(child, values)]));
  return node;
}
export function renderActionSteps(definition, values, user, desk) {
  return definition.steps.map(step => {
    const source = step.config;
    let config;
    if (step.type === 'email' || step.type === 'approval') {
      config = { to: email(renderString(source.to, values)), subject: text(renderString(source.subject, values), 'Email subject', 240), body: text(renderString(source.body, values), 'Email body', 30000, false, true) };
      if (step.type === 'approval') config.expires_hours = source.expires_hours;
    } else if (step.type === 'task') {
      const assignee = source.assignee_email ? renderString(source.assignee_email, values).trim() : '';
      const assigned = email(assignee || user.email, 'Assigned technician');
      if (!desk.listTechnicians().some(person => person.active && person.email.toLowerCase() === assigned)) throw fail('Manual tasks must be assigned to an active AssetDesk technician.');
      config = { instructions: text(renderString(source.instructions, values), 'Task instructions', 30000, false, true), assignee_email: assigned };
    } else if (step.type === 'api' || step.type === 'power_automate') {
      config = { connection: source.connection, ...(step.type === 'api' ? { method: source.method, path: safePath(renderString(source.path, values, true)) } : {}), body: source.body ? renderJson(jsonTemplate(source.body), values) : null };
      if (config.body !== null && Buffer.byteLength(JSON.stringify(config.body)) > 1024 * 1024) throw fail('The rendered API request body must be at most one megabyte.');
    } else {
      const minutes = Number(renderString(source.minutes, values));
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 43200) throw fail('Wait duration must be greater than zero and at most 43,200 minutes.');
      config = { minutes };
    }
    return { id: step.id, type: step.type, name: text(renderString(step.name, values).replace(/\s+/gu, ' '), 'Step name', 500), config };
  });
}

const SEEDS = [
  { id: 'template-access-approval', name: 'Access request approval', description: 'Request approval for a person and a specific access change.', variables: [
    { key: 'person_name', label: 'Person being approved', type: 'text', required: true }, { key: 'request_details', label: 'What needs approval', type: 'text', required: true }, { key: 'approver_email', label: 'Approver email', type: 'email', required: true },
  ], steps: [{ id: 'request-approval', type: 'approval', name: 'Approve request for {{person_name}}', config: { to: '{{approver_email}}', subject: 'Approval needed: {{person_name}}', body: 'Please review the following request for {{person_name}}:\n\n{{request_details}}', expires_hours: 168 } }] },
  { id: 'template-equipment-preparation', name: 'Equipment preparation', description: 'Assign repeatable preparation work with details for each person.', variables: [
    { key: 'person_name', label: 'Person receiving equipment', type: 'text', required: true }, { key: 'equipment_details', label: 'Equipment and preparation details', type: 'text', required: true }, { key: 'technician_email', label: 'Assigned technician email (optional)', type: 'email', required: false },
  ], steps: [{ id: 'prepare-equipment', type: 'task', name: 'Prepare equipment for {{person_name}}', config: { instructions: 'Prepare the following equipment for {{person_name}}:\n\n{{equipment_details}}\n\nConfirm the handover details before completing this task.', assignee_email: '{{technician_email}}' } }] },
];

/** Durable workflow definitions, immutable runs, and guarded step transitions. */
export class ActionsStore {
  constructor(desk) {
    this.desk = desk; this.db = desk.db;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS action_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,definition TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by TEXT,created_by_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS action_runs(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,template_id TEXT,template_version INTEGER,definition TEXT NOT NULL,values_json TEXT NOT NULL,status TEXT NOT NULL,current_step INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_by_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,ticket_key TEXT,error TEXT);
        CREATE TABLE IF NOT EXISTS action_run_steps(run_id TEXT NOT NULL,step_index INTEGER NOT NULL,id TEXT NOT NULL,type TEXT NOT NULL,name TEXT NOT NULL,config TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt INTEGER NOT NULL DEFAULT 0,claim_token TEXT,output TEXT,error TEXT,due_at TEXT,started_at TEXT,completed_at TEXT,PRIMARY KEY(run_id,step_index),FOREIGN KEY(run_id) REFERENCES action_runs(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS action_events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL,actor_id TEXT,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS action_approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,step_index INTEGER NOT NULL,claim_token TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,expires_at TEXT NOT NULL,decision TEXT NOT NULL DEFAULT 'pending',delivery_state TEXT NOT NULL DEFAULT 'created',decided_at TEXT,comment TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS action_runs_status ON action_runs(status,created_at);
        CREATE INDEX IF NOT EXISTS action_steps_due ON action_run_steps(status,due_at);
        CREATE INDEX IF NOT EXISTS action_events_run ON action_events(run_id,created_at);
        CREATE INDEX IF NOT EXISTS action_approvals_run ON action_approvals(run_id,step_index,created_at);
      `);
      for (const seed of SEEDS) {
        const { id, ...input } = seed, definition = validateActionDefinition(input), timestamp = now();
        this.db.prepare('INSERT OR IGNORE INTO action_templates(id,name,description,definition,created_by_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, definition.name, definition.description, JSON.stringify(definition), 'AssetDesk', timestamp, timestamp);
      }
    });
  }
  transaction(action) { return this.desk.transaction(action); }
  user(user) { const current = user?.id ? this.desk.user(user.id) : null; if (!current?.active) throw fail('Sign in to continue.', 401); return current; }
  templateRow(id) { return typeof id === 'string' ? this.db.prepare('SELECT * FROM action_templates WHERE id=?').get(id) : null; }
  templateResult(row, user) {
    if (!row) throw fail('Action template not found.', 404);
    const canEdit = user.role === 'admin' || row.created_by === user.id;
    if (!row.active && !canEdit) throw fail('Action template not found.', 404);
    return { id: row.id, ...parse(row.definition), active: Boolean(row.active), version: row.version, created_by: row.created_by, created_by_name: row.created_by_name, created_at: row.created_at, updated_at: row.updated_at, canEdit };
  }
  listTemplates(actor) { const user = this.user(actor); return this.db.prepare("SELECT * FROM action_templates WHERE active=1 OR created_by=? OR ?='admin' ORDER BY name COLLATE NOCASE,id").all(user.id, user.role).map(row => this.templateResult(row, user)); }
  getTemplate(id, actor) { return this.templateResult(this.templateRow(id), this.user(actor)); }
  createTemplate(input, actor) {
    const user = this.user(actor); object(input, ['name', 'description', 'variables', 'steps', 'active'], 'template');
    if (input.active !== undefined && typeof input.active !== 'boolean') throw fail('Template availability must be true or false.');
    const { active = true, ...source } = input, definition = validateActionDefinition(source), id = randomUUID(), timestamp = now();
    this.db.prepare('INSERT INTO action_templates(id,name,description,definition,active,created_by,created_by_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, definition.name, definition.description, JSON.stringify(definition), active ? 1 : 0, user.id, user.name, timestamp, timestamp);
    return this.getTemplate(id, user);
  }
  updateTemplate(id, input, actor) {
    const user = this.user(actor); object(input, ['version', 'name', 'description', 'variables', 'steps', 'active'], 'template');
    return this.transaction(() => {
      const row = this.templateRow(id); this.templateResult(row, user);
      if (user.role !== 'admin' && row.created_by !== user.id) throw fail('Only the template owner or an administrator can edit this template.', 403);
      if (!Number.isSafeInteger(input.version) || input.version !== row.version) throw fail('This template changed. Reload its latest version before saving.', 409);
      if (input.active !== undefined && typeof input.active !== 'boolean') throw fail('Template availability must be true or false.');
      const definition = validateActionDefinition({ ...parse(row.definition), ...Object.fromEntries(Object.entries(input).filter(([key]) => !['version', 'active'].includes(key))) });
      this.db.prepare('UPDATE action_templates SET name=?,description=?,definition=?,active=?,version=version+1,updated_at=? WHERE id=?').run(definition.name, definition.description, JSON.stringify(definition), (input.active ?? Boolean(row.active)) ? 1 : 0, now(), id);
      return this.getTemplate(id, user);
    });
  }
  runRow(id) { return typeof id === 'string' ? this.db.prepare('SELECT * FROM action_runs WHERE id=?').get(id) : null; }
  stepRow(id, index) { return this.db.prepare('SELECT * FROM action_run_steps WHERE run_id=? AND step_index=?').get(id, index); }
  event(id, type, message, actor) { this.db.prepare('INSERT INTO action_events(id,run_id,type,message,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, type, message, actor?.id || null, actor?.name || actor?.email || 'AssetDesk', now()); }
  getRun(id, actor) {
    const user = this.user(actor), row = this.runRow(id); if (!row) throw fail('Action not found.', 404);
    const owner = user.role === 'admin' || row.created_by === user.id;
    const steps = this.db.prepare('SELECT * FROM action_run_steps WHERE run_id=? ORDER BY step_index').all(id).map(step => {
      const approval = this.db.prepare('SELECT recipient,expires_at,decision,delivery_state,decided_at,comment FROM action_approvals WHERE run_id=? AND step_index=? ORDER BY rowid DESC LIMIT 1').get(id, step.step_index);
      const config = parse(step.config);
      return { id: step.id, type: step.type, name: step.name, config, status: step.status, attempt: step.attempt, output: parse(step.output), error: step.error, due_at: step.due_at, started_at: step.started_at, completed_at: step.completed_at, assignee_email: step.type === 'task' ? config.assignee_email : null, ...(approval ? { approval: { ...approval } } : {}) };
    });
    const current = steps[row.current_step];
    const canCompleteTask = row.status === 'waiting_task' && current?.status === 'waiting_task' && (user.role === 'admin' || current.assignee_email.toLowerCase() === user.email.toLowerCase());
    return { id: row.id, name: row.name, description: row.description, status: row.status, current_step: row.current_step, definition: parse(row.definition), values: parse(row.values_json), template_id: row.template_id, template_version: row.template_version, ticket_key: row.ticket_key, created_by: row.created_by, created_by_name: row.created_by_name, created_at: row.created_at, updated_at: row.updated_at, version: row.version, error: row.error,
      steps, progress: { completed: steps.filter(step => step.status === 'completed').length, total: steps.length }, events: this.db.prepare('SELECT id,type,message,actor_id,actor_name,created_at FROM action_events WHERE run_id=? ORDER BY created_at,rowid').all(id).map(event => ({ ...event })),
      canCancel: owner && !TERMINAL.has(row.status), canRetry: owner && RETRYABLE.has(row.status), canCompleteTask };
  }
  listRuns(actor, { limit = 25, offset = 0, status } = {}) {
    const user = this.user(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000 || (status && !RUN_STATES.has(status))) throw fail('Provide valid action filters.');
    const where = status ? 'WHERE status=?' : '', args = status ? [status] : [];
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM action_runs ${where}`).get(...args).total;
    return { runs: this.db.prepare(`SELECT id FROM action_runs ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => this.getRun(row.id, user)), total, limit, offset };
  }
  createRun(input, actor) {
    const user = this.user(actor); object(input, ['name', 'template_id', 'template_version', 'definition', 'values', 'ticket_key'], 'action');
    if (Boolean(input.template_id) === Boolean(input.definition)) throw fail('Choose one template or provide one workflow definition.');
    let definition, templateId = null, templateVersion = null;
    if (input.template_id) {
      const template = this.getTemplate(input.template_id, user);
      if (!template.active) throw fail('This template is archived. Choose an available template.');
      if (input.template_version !== template.version) throw fail('This template changed. Reload it before starting an action.', 409);
      definition = validateActionDefinition({ name: template.name, description: template.description, variables: template.variables, steps: template.steps }); templateId = template.id; templateVersion = template.version;
    } else definition = validateActionDefinition(input.definition);
    if (input.ticket_key !== undefined && input.ticket_key !== null && (typeof input.ticket_key !== 'string' || !this.db.prepare('SELECT 1 FROM tickets WHERE key=?').get(input.ticket_key))) throw fail('Linked ticket not found.', 404);
    const values = resolveActionValues(definition, input.values ?? {}), rendered = renderActionSteps(definition, values, user, this.desk);
    const id = randomUUID(), timestamp = now(), name = input.name === undefined ? definition.name : text(input.name, 'Action name', 200);
    this.transaction(() => {
      this.db.prepare("INSERT INTO action_runs(id,name,description,template_id,template_version,definition,values_json,status,created_by,created_by_name,created_at,updated_at,ticket_key) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)").run(id, name, definition.description, templateId, templateVersion, JSON.stringify(definition), JSON.stringify(values), user.id, user.name, timestamp, timestamp, input.ticket_key || null);
      for (const [index, step] of rendered.entries()) this.db.prepare('INSERT INTO action_run_steps(run_id,step_index,id,type,name,config) VALUES(?,?,?,?,?,?)').run(id, index, step.id, step.type, step.name, JSON.stringify(step.config));
      this.event(id, 'created', 'Action started with a saved workflow snapshot.', user);
    });
    return this.getRun(id, user);
  }
  ownerRun(id, actor) {
    const user = this.user(actor), row = this.runRow(id); if (!row) throw fail('Action not found.', 404);
    if (user.role !== 'admin' && row.created_by !== user.id) throw fail('Only the action creator or an administrator can change this action.', 403);
    return { user, row };
  }
  cancelRun(id, actor) {
    return this.transaction(() => {
      const { user, row } = this.ownerRun(id, actor);
      if (TERMINAL.has(row.status)) throw fail('This action has already finished.', 409);
      this.db.prepare("UPDATE action_runs SET status='cancelled',error=NULL,version=version+1,updated_at=? WHERE id=?").run(now(), id);
      this.db.prepare("UPDATE action_run_steps SET status='cancelled',claim_token=NULL WHERE run_id=? AND status NOT IN ('completed','rejected')").run(id);
      this.revokeApprovals(id); this.event(id, 'cancelled', 'Action cancelled.', user);
      return this.getRun(id, user);
    });
  }
  retryRun(id, actor) {
    return this.transaction(() => {
      const { user, row } = this.ownerRun(id, actor);
      if (!RETRYABLE.has(row.status)) throw fail('Only failed, blocked, or attention-needed actions can be retried.', 409);
      this.revokeApprovals(id);
      this.db.prepare("UPDATE action_run_steps SET status='pending',claim_token=NULL,error=NULL,due_at=NULL WHERE run_id=? AND step_index=?").run(id, row.current_step);
      this.db.prepare("UPDATE action_runs SET status='queued',error=NULL,version=version+1,updated_at=? WHERE id=?").run(now(), id);
      this.event(id, 'retry', 'The current step was explicitly retried.', user);
      return this.getRun(id, user);
    });
  }
  completeTask(id, { comment = '' } = {}, actor) {
    const user = this.user(actor), note = text(comment, 'Completion note', 1000, true, true);
    return this.transaction(() => {
      const run = this.getRun(id, user);
      if (!run.canCompleteTask) throw fail(run.status === 'waiting_task' ? 'Only the assigned technician or an administrator can complete this task.' : 'This action is not waiting for task completion.', run.status === 'waiting_task' ? 403 : 409);
      const row = this.runRow(id), step = this.stepRow(id, row.current_step);
      this.advanceStep(id, step.step_index, step.claim_token, { completed_by: user.name, comment: note }, 'waiting_task');
      this.event(id, 'task_completed', note ? `Task completed: ${note}` : 'Task completed.', user);
      return this.getRun(id, user);
    });
  }
  revokeApprovals(id) { this.db.prepare("UPDATE action_approvals SET decision='cancelled' WHERE run_id=? AND decision='pending'").run(id); }
  claimNext() {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM action_runs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get(); if (!row) return null;
      const step = this.stepRow(row.id, row.current_step); if (!step || step.status !== 'pending') return null;
      const claim = randomUUID(), timestamp = now();
      this.db.prepare("UPDATE action_run_steps SET status='running',claim_token=?,attempt=attempt+1,error=NULL,started_at=?,completed_at=NULL WHERE run_id=? AND step_index=?").run(claim, timestamp, row.id, row.current_step);
      this.db.prepare("UPDATE action_runs SET status='running',error=NULL,version=version+1,updated_at=? WHERE id=?").run(timestamp, row.id);
      this.event(row.id, 'step_started', `Started ${step.name}.`);
      return { run: { ...row, status: 'running' }, step: { ...step, config: parse(step.config), status: 'running', claim_token: claim, attempt: step.attempt + 1 } };
    });
  }
  validClaim(id, index, claim, state = 'running') {
    const run = this.runRow(id), step = this.stepRow(id, index);
    return Boolean(run && run.status === state && run.current_step === index && step?.status === state && step.claim_token === claim);
  }
  waitStep(id, index, claim, state, { due_at = null } = {}) {
    return this.transaction(() => {
      if (!this.validClaim(id, index, claim)) return false;
      this.db.prepare('UPDATE action_run_steps SET status=?,due_at=? WHERE run_id=? AND step_index=?').run(state, due_at, id, index);
      this.db.prepare('UPDATE action_runs SET status=?,version=version+1,updated_at=? WHERE id=?').run(state, now(), id);
      this.event(id, 'waiting', state === 'waiting_task' ? 'Waiting for the assigned technician to complete the task.' : state === 'waiting_delay' ? 'Waiting until the scheduled resume time.' : 'Approval email sent; waiting for a decision.');
      return true;
    });
  }
  advanceStep(id, index, claim, output = {}, state = 'running') {
    return this.transaction(() => {
      if (!this.validClaim(id, index, claim, state)) return false;
      const next = this.stepRow(id, index + 1), timestamp = now();
      this.db.prepare("UPDATE action_run_steps SET status='completed',claim_token=NULL,output=?,error=NULL,completed_at=? WHERE run_id=? AND step_index=?").run(JSON.stringify(output), timestamp, id, index);
      this.db.prepare('UPDATE action_runs SET status=?,current_step=?,error=NULL,version=version+1,updated_at=? WHERE id=?').run(next ? 'queued' : 'completed', next ? index + 1 : index, timestamp, id);
      this.event(id, next ? 'step_completed' : 'completed', next ? 'Step completed.' : 'Action completed.');
      return true;
    });
  }
  failStep(id, index, claim, state, message) {
    return this.transaction(() => {
      if (!this.validClaim(id, index, claim)) return false;
      if (!RETRYABLE.has(state)) throw fail('Invalid action failure state.');
      this.db.prepare('UPDATE action_run_steps SET status=?,error=?,claim_token=NULL WHERE run_id=? AND step_index=?').run(state, message, id, index);
      this.db.prepare('UPDATE action_runs SET status=?,error=?,version=version+1,updated_at=? WHERE id=?').run(state, message, now(), id);
      this.revokeApprovals(id); this.event(id, state, message);
      return true;
    });
  }
  createApproval(id, index, claim, config) {
    return this.transaction(() => {
      if (!this.validClaim(id, index, claim)) return null;
      const token = randomBytes(40).toString('hex'), approvalId = randomUUID(), expires = new Date(Date.now() + config.expires_hours * 3600000).toISOString();
      this.db.prepare('INSERT INTO action_approvals(id,run_id,step_index,claim_token,token_hash,recipient,subject,body,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(approvalId, id, index, claim, hash(token), config.to, config.subject, config.body, expires, now());
      return { id: approvalId, token, expires_at: expires };
    });
  }
  markApprovalSent(id, index, claim, approvalId) {
    return this.transaction(() => {
      if (!this.validClaim(id, index, claim)) return false;
      const approval = this.db.prepare("SELECT id FROM action_approvals WHERE id=? AND run_id=? AND step_index=? AND claim_token=? AND decision='pending'").get(approvalId, id, index, claim);
      if (!approval) return false;
      this.db.prepare("UPDATE action_approvals SET delivery_state='sent' WHERE id=?").run(approvalId);
      return this.waitStep(id, index, claim, 'waiting_approval');
    });
  }
  approvalRow(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{80}$/.test(token)) throw fail('Approval request not found.', 404);
    const row = this.db.prepare('SELECT * FROM action_approvals WHERE token_hash=?').get(hash(token));
    if (!row) throw fail('Approval request not found.', 404);
    return row;
  }
  resolveApproval(token) {
    const row = this.approvalRow(token), run = this.runRow(row.run_id), step = this.stepRow(row.run_id, row.step_index);
    const expired = Date.parse(row.expires_at) <= Date.now();
    const canDecide = row.decision === 'pending' && !expired && row.delivery_state === 'sent' && run?.status === 'waiting_approval' && run.current_step === row.step_index && step?.status === 'waiting_approval' && step.claim_token === row.claim_token;
    return { run_name: run?.name || 'Approval request', step_name: step?.name || 'Approval', recipient: row.recipient, subject: row.subject, body: row.body, expires_at: row.expires_at,
      decision: row.decision === 'pending' && expired ? 'expired' : row.decision, status: canDecide ? 'pending' : expired && row.decision === 'pending' ? 'expired' : row.decision !== 'pending' ? row.decision : run?.status || 'unavailable', can_decide: canDecide };
  }
  decideApproval(token, input) {
    object(input, ['decision', 'comment'], 'approval decision');
    if (!['approved', 'rejected'].includes(input.decision)) throw fail('Choose approved or rejected.');
    const comment = text(input.comment ?? '', 'Approval comment', 1000, true, true);
    return this.transaction(() => {
      const approval = this.approvalRow(token), view = this.resolveApproval(token);
      if (!view.can_decide) throw fail(view.status === 'expired' ? 'This approval request has expired.' : 'This approval request is no longer waiting for a decision.', view.status === 'expired' ? 410 : 409);
      this.db.prepare('UPDATE action_approvals SET decision=?,decided_at=?,comment=? WHERE id=?').run(input.decision, now(), comment, approval.id);
      if (input.decision === 'approved') this.advanceStep(approval.run_id, approval.step_index, approval.claim_token, { decision: 'approved', recipient: approval.recipient, comment }, 'waiting_approval');
      else {
        this.db.prepare("UPDATE action_run_steps SET status='rejected',claim_token=NULL,output=?,completed_at=? WHERE run_id=? AND step_index=?").run(JSON.stringify({ decision: 'rejected', recipient: approval.recipient, comment }), now(), approval.run_id, approval.step_index);
        this.db.prepare("UPDATE action_runs SET status='rejected',error=NULL,version=version+1,updated_at=? WHERE id=?").run(now(), approval.run_id);
      }
      this.event(approval.run_id, input.decision, `Approval ${input.decision} by ${approval.recipient}${comment ? `: ${comment}` : '.'}`, { name: approval.recipient });
      return this.resolveApproval(token);
    });
  }
  resumeDue(timestamp = now()) {
    this.transaction(() => {
      for (const step of this.db.prepare("SELECT s.* FROM action_run_steps s JOIN action_runs r ON r.id=s.run_id WHERE r.status='waiting_delay' AND s.step_index=r.current_step AND s.status='waiting_delay' AND s.due_at<=?").all(timestamp)) this.advanceStep(step.run_id, step.step_index, step.claim_token, { resumed_at: timestamp }, 'waiting_delay');
      for (const approval of this.db.prepare("SELECT a.* FROM action_approvals a JOIN action_runs r ON r.id=a.run_id WHERE r.status='waiting_approval' AND r.current_step=a.step_index AND a.decision='pending' AND a.delivery_state='sent' AND a.expires_at<=?").all(timestamp)) {
        this.db.prepare("UPDATE action_approvals SET decision='expired' WHERE id=?").run(approval.id);
        this.db.prepare("UPDATE action_run_steps SET status='failed',claim_token=NULL,error='The approval request expired.' WHERE run_id=? AND step_index=?").run(approval.run_id, approval.step_index);
        this.db.prepare("UPDATE action_runs SET status='failed',error='The approval request expired.',version=version+1,updated_at=? WHERE id=?").run(timestamp, approval.run_id);
        this.event(approval.run_id, 'expired', 'The approval request expired without a decision.');
      }
    });
  }
  recoverRunningSteps() {
    this.transaction(() => {
      for (const run of this.db.prepare("SELECT * FROM action_runs WHERE status='running'").all()) {
        const step = this.stepRow(run.id, run.current_step); if (!step) continue;
        if (['approval', 'email', 'api', 'power_automate'].includes(step.type)) this.failStep(run.id, step.step_index, step.claim_token, 'needs_attention', 'The previous delivery or API attempt may have reached its destination. Check the destination before explicitly retrying.');
        else {
          this.db.prepare("UPDATE action_run_steps SET status='pending',claim_token=NULL WHERE run_id=? AND step_index=?").run(run.id, run.current_step);
          this.db.prepare("UPDATE action_runs SET status='queued',version=version+1,updated_at=? WHERE id=?").run(now(), run.id);
        }
      }
    });
  }
}
