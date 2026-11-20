import { randomUUID } from 'node:crypto';
import { validateActionDefinition, resolveActionValues } from './actions-store.js';

const TOKEN = /{{\s*([a-z][a-z0-9_]{0,39})\s*}}/g;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeMessage: message });
const own = (value, key) => Object.hasOwn(value, key);
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(`Provide valid ${label} fields.`);
  return value;
}
function text(value, label, max, { empty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(value)) throw fail(`${label} must contain at most ${max} valid characters.`);
  const clean = value.trim();
  if (!empty && !clean) throw fail(`${label} is required.`);
  return clean;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw fail(`Provide a valid ${label}.`);
  return value;
}
function checkTokens(value, keys) {
  const remainder = value.replace(TOKEN, (_match, key) => {
    if (!keys.has(key)) throw fail(`Declare the workflow variable ${key} before using it in a step binding.`);
    return '';
  });
  if (remainder.includes('{{') || remainder.includes('}}')) throw fail('Use workflow bindings in the format {{variable_key}}.');
}
function replaceTokens(input, values) {
  if (typeof input === 'number') return input;
  const whole = input.match(/^{{\s*([a-z][a-z0-9_]{0,39})\s*}}$/);
  if (whole) return values[whole[1]];
  // String.replace makes one pass over the original binding. Token-like text in
  // a person's name is data and is never interpreted as another expression.
  return input.replace(TOKEN, (_match, key) => String(values[key]));
}
function rewriteTokens(input, keys) {
  return typeof input === 'string' ? input.replace(TOKEN, (_match, key) => `{{${keys.get(key)}}}`) : input;
}

/** Reusable compositions compile into one existing durable, sequential action run. */
export class WorkflowsStore {
  constructor(actions) {
    this.actions = actions; this.desk = actions.desk; this.db = actions.db;
    this.desk.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_workflows(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,definition TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_by_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_workflow_runs(run_id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,workflow_version INTEGER NOT NULL,composition TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES action_runs(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS action_workflow_runs_workflow ON action_workflow_runs(workflow_id,run_id);
    `));
  }
  user(actor) { return this.actions.user(actor); }
  row(id) { return typeof id === 'string' ? this.db.prepare('SELECT * FROM action_workflows WHERE id=?').get(id) : null; }
  result(row, user) {
    if (!row) throw fail('Workflow not found.', 404);
    const canEdit = user.role === 'admin' || row.created_by === user.id;
    if (!row.active && !canEdit) throw fail('Workflow not found.', 404);
    return { id: row.id, ...JSON.parse(row.definition), active: Boolean(row.active), version: row.version, canEdit, created_by: row.created_by, created_by_name: row.created_by_name, created_at: row.created_at, updated_at: row.updated_at };
  }
  listWorkflows(actor) {
    const user = this.user(actor);
    return this.db.prepare("SELECT * FROM action_workflows WHERE active=1 OR created_by=? OR ?='admin' ORDER BY name COLLATE NOCASE,id").all(user.id, user.role).map(row => this.result(row, user));
  }
  getWorkflow(id, actor) { return this.result(this.row(id), this.user(actor)); }
  reference(step, user, { checkVersion = true, parentName = '' } = {}) {
    const reference = step.type === 'template' ? this.actions.getTemplate(step.ref_id, user) : this.getWorkflow(step.ref_id, user);
    if (!reference.active) throw fail(`The referenced ${step.type} is archived. Edit the workflow and choose an available reference.`, 409);
    if (checkVersion && reference.version !== step.ref_version) throw fail(`The referenced ${step.type} "${reference.name}" changed${parentName ? ` inside workflow "${parentName}"` : ''}. Edit that workflow and refresh its references, then refresh any outer workflow references before starting.`, 409);
    return reference;
  }
  validate(input, user) {
    object(input, ['name', 'description', 'variables', 'steps'], 'workflow');
    // Reuse the action variable validator, including typed defaults and limits.
    const base = validateActionDefinition({ name: input.name, description: input.description ?? '', variables: input.variables, steps: [{ type: 'task', config: { instructions: 'Validate workflow variables.', assignee_email: '' } }] });
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 50) throw fail('A workflow needs between 1 and 50 template or workflow steps.');
    const keys = new Set(base.variables.map(variable => variable.key)), ids = new Set();
    const steps = input.steps.map(step => {
      object(step, ['id', 'type', 'ref_id', 'ref_version', 'name', 'bindings'], 'workflow step');
      const id = identifier(step.id || randomUUID(), 'workflow step ID');
      if (ids.has(id)) throw fail('Each workflow step needs a unique identifier.');
      ids.add(id);
      if (!['template', 'workflow'].includes(step.type)) throw fail('Choose an action template or a nested workflow for every step.');
      const ref_id = identifier(step.ref_id, 'workflow reference ID');
      if (!Number.isSafeInteger(step.ref_version) || step.ref_version < 1) throw fail('Choose the current version of every referenced template or workflow.');
      const reference = this.reference({ type: step.type, ref_id, ref_version: step.ref_version }, user);
      const name = text(step.name || reference.name, 'Step title', 200); checkTokens(name, keys);
      const supplied = step.bindings ?? {};
      object(supplied, reference.variables.map(variable => variable.key), 'step binding');
      const bindings = Object.fromEntries(Object.entries(supplied).map(([key, value]) => {
        if (typeof value === 'number' && Number.isFinite(value)) return [key, value];
        const binding = text(value, 'Step binding', 4000, { empty: true, multiline: true }); checkTokens(binding, keys); return [key, binding];
      }));
      return { id, type: step.type, ref_id, ref_version: step.ref_version, name, bindings };
    });
    return { name: base.name, description: base.description, variables: base.variables, steps };
  }
  checkGraph(definition, user, candidateId) {
    const visited = { nodes: 0, operations: 0, variables: 0 };
    const walk = (source, stack, depth) => {
      if (depth > 5) throw fail('Workflows can be nested at most five levels deep.');
      for (const step of source.steps) {
        if (++visited.nodes > 100) throw fail('A workflow can expand to at most 100 referenced nodes.');
        if (step.type === 'workflow' && stack.has(step.ref_id)) throw fail('Workflows cannot contain themselves or circular nested references.');
        const reference = this.reference(step, user, { parentName: source.name });
        if (step.type === 'workflow') walk(reference, new Set([...stack, step.ref_id]), depth + 1);
        else {
          visited.operations += reference.steps.length; visited.variables += reference.variables.length;
          if (visited.operations > 50) throw fail('A workflow can expand to at most 50 executable action steps.');
          if (visited.variables > 100) throw fail('A workflow can expand to at most 100 template variable values.');
        }
      }
    };
    walk(definition, new Set(candidateId ? [candidateId] : []), 1);
  }
  createWorkflow(input, actor) {
    const user = this.user(actor);
    return this.desk.transaction(() => {
      const definition = this.validate(input, user), id = randomUUID(), timestamp = now();
      this.checkGraph(definition, user, id);
      this.db.prepare('INSERT INTO action_workflows(id,name,description,definition,created_by,created_by_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, definition.name, definition.description, JSON.stringify(definition), user.id, user.name, timestamp, timestamp);
      return this.getWorkflow(id, user);
    });
  }
  updateWorkflow(id, input, actor) {
    const user = this.user(actor); object(input, ['version', 'name', 'description', 'variables', 'steps', 'active'], 'workflow');
    return this.desk.transaction(() => {
      const row = this.row(id); this.result(row, user);
      if (user.role !== 'admin' && row.created_by !== user.id) throw fail('Only the workflow owner or an administrator can edit this workflow.', 403);
      if (!Number.isSafeInteger(input.version) || input.version !== row.version) throw fail('This workflow changed. Reload its latest version before saving.', 409);
      if (input.active !== undefined && typeof input.active !== 'boolean') throw fail('Workflow availability must be true or false.');
      const changes = Object.fromEntries(Object.entries(input).filter(([key]) => !['version', 'active'].includes(key)));
      const active = input.active ?? Boolean(row.active);
      const definition = !active && !Object.keys(changes).length ? JSON.parse(row.definition) : this.validate({ ...JSON.parse(row.definition), ...changes }, user);
      if (active) this.checkGraph(definition, user, id);
      this.db.prepare('UPDATE action_workflows SET name=?,description=?,definition=?,active=?,version=version+1,updated_at=? WHERE id=?').run(definition.name, definition.description, JSON.stringify(definition), active ? 1 : 0, now(), id);
      return this.getWorkflow(id, user);
    });
  }
  createRun(input, actor) {
    const user = this.user(actor); object(input, ['workflow_id', 'workflow_version', 'values', 'name', 'ticket_key'], 'workflow run');
    return this.desk.transaction(() => {
      const workflow = this.getWorkflow(identifier(input.workflow_id, 'workflow ID'), user);
      if (!workflow.active) throw fail('This workflow is archived. Choose an available workflow.', 409);
      if (input.workflow_version !== workflow.version) throw fail('This workflow changed. Reload it before starting.', 409);
      this.checkGraph(workflow, user, workflow.id);
      const values = resolveActionValues(workflow, input.values ?? {});
      const definition = { name: workflow.name, description: workflow.description, variables: [], steps: [] }, supplied = {};
      let occurrence = 0;
      const expand = (source, parentValues, path = []) => source.steps.map(node => {
        const reference = this.reference(node, user), childValues = resolveActionValues(reference, Object.fromEntries(Object.entries(node.bindings).map(([key, value]) => [key, replaceTokens(value, parentValues)])));
        const title = text(String(replaceTokens(node.name, parentValues)).replace(/\s+/gu, ' '), 'Resolved step title', 500);
        const item = { id: node.id, instance_id: [...path, node.id].join('/'), type: node.type, name: title, ref_id: reference.id, ref_version: reference.version, start_index: definition.steps.length };
        if (node.type === 'workflow') item.steps = expand(reference, childValues, [...path, node.id]);
        else {
          const index = occurrence++, keys = new Map(reference.variables.map((variable, variableIndex) => [variable.key, `w${index}_v${variableIndex}`]));
          for (const variable of reference.variables) {
            const key = keys.get(variable.key);
            definition.variables.push({ ...variable, key, label: `${title}: ${variable.label}`.slice(0, 100), default: '' }); supplied[key] = childValues[variable.key];
          }
          for (const [operationIndex, operation] of reference.steps.entries()) definition.steps.push({ ...operation, id: `w${index}_s${operationIndex}`, name: rewriteTokens(operation.name, keys), config: Object.fromEntries(Object.entries(operation.config).map(([key, value]) => [key, rewriteTokens(value, keys)])) });
        }
        item.end_index = definition.steps.length - 1;
        return item;
      });
      const steps = expand(workflow, values);
      const composition = { id: workflow.id, name: workflow.name, version: workflow.version, values, variables: clone(workflow.variables), steps, definition: { name: workflow.name, description: workflow.description, variables: clone(workflow.variables), steps: clone(workflow.steps) } };
      const run = this.actions.createRun({ definition, values: supplied, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.ticket_key !== undefined ? { ticket_key: input.ticket_key } : {}) }, user);
      this.db.prepare('INSERT INTO action_workflow_runs(run_id,workflow_id,workflow_version,composition) VALUES(?,?,?,?)').run(run.id, workflow.id, workflow.version, JSON.stringify(composition));
      return { ...run, workflow: composition };
    });
  }
  getRunComposition(runId, actor) {
    this.actions.getRun(runId, this.user(actor));
    const row = this.db.prepare('SELECT composition FROM action_workflow_runs WHERE run_id=?').get(runId);
    return row ? JSON.parse(row.composition) : null;
  }
}
