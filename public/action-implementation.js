const TOKEN = /{{\s*([a-z][a-z0-9_]{0,39})\s*}}/g;

function valuesFor(variables, values) {
  if (values === null) return null;
  return Object.fromEntries(variables.map(variable => {
    let value = String(Object.hasOwn(values, variable.key) ? values[variable.key] : variable.default ?? '').trim();
    if (variable.type === 'email') value = value.toLowerCase();
    return [variable.key, variable.type === 'number' && value && Number.isFinite(Number(value)) ? Number(value) : value];
  }));
}

function render(value, values, path = false) {
  const input = String(value ?? '');
  if (values === null) return input;
  return input.replace(TOKEN, (token, key) => Object.hasOwn(values, key)
    ? path ? encodeURIComponent(String(values[key])) : String(values[key]) : token);
}

function renderJson(value, values) {
  if (typeof value === 'string') {
    const whole = value.match(/^{{\s*([a-z][a-z0-9_]{0,39})\s*}}$/);
    if (whole && values !== null && Object.hasOwn(values, whole[1])) return values[whole[1]];
    return render(value, values);
  }
  if (Array.isArray(value)) return value.map(item => renderJson(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJson(item, values)]));
  return value;
}

function jsonBody(body, values) {
  if (body === '' || body === undefined || body === null) return '';
  try { return JSON.stringify(renderJson(typeof body === 'string' ? JSON.parse(body) : body, values), null, 2); }
  catch { return String(body); }
}

/** A readable view of the same stored step configuration that the server executes.
 * Only public connection metadata belongs here. Private URLs and headers stay on
 * the server, including when callers accidentally supply a complete profile.
 */
export function formatActionImplementation(step, { connections = [], values = null, variables = [], assigneeEmail = '', publicUrl = '' } = {}) {
  const config = step.config || {}, supplied = valuesFor(variables, values);
  const text = value => supplied === null ? render(value, supplied) : render(value, supplied).trim();
  const connection = connections.find(item => item.id === config.connection);
  const profile = connection ? `${connection.name} (${connection.id})` : config.connection || '[choose a connection]';

  if (step.type === 'email' || step.type === 'approval') {
    const body = text(config.body);
    const recipient = text(config.to);
    const lines = ['SMTP SEND', 'From: [configured SMTP sender]', `To: ${supplied === null ? recipient : recipient.toLowerCase()}`, `Subject: ${text(config.subject)}`, 'Content-Type: text/plain', '', body];
    if (step.type === 'approval') lines.push('', 'Review this request and explicitly approve or reject it:', publicUrl ? `${publicUrl.replace(/\/$/, '')}/approve/[private single-use token]` : '[public AssetDesk URL]/approve/[private single-use token]', '', 'This review link expires at [generated expiry timestamp]. Replies to this email do not record an approval.', '', `WAIT FOR APPROVAL (expires after ${config.expires_hours ?? 168} hours)`, 'Approve: continue to the next step.', 'Reject: stop the workflow.');
    else lines.push('', 'Continue after the SMTP service accepts the recipient.');
    return lines.join('\n');
  }
  if (step.type === 'api') {
    // API base URLs are public metadata, but never echo query credentials or
    // user information even if a complete server profile was supplied here.
    let base = '[configured API base URL]';
    if (connection?.baseUrl) try {
      const parsed = new URL(connection.baseUrl);
      if (['http:', 'https:'].includes(parsed.protocol)) base = parsed.origin + parsed.pathname.replace(/\/$/, '');
    } catch { /* An unconfigured destination remains visibly unresolved. */ }
    const path = render(config.path, supplied, true), body = jsonBody(config.body, supplied);
    return [`${config.method || 'POST'} ${base}${path}`, `Connection: ${profile}`, 'Authentication: [connection headers applied privately by the server]', ...(body ? ['Content-Type: application/json', '', body] : []), '', 'Continue after an HTTP 2xx response.'].join('\n');
  }
  if (step.type === 'power_automate') {
    const body = jsonBody(config.body, supplied);
    return ['POST [private Power Automate trigger URL]', `Connection: ${profile}`, 'Content-Type: application/json', '', body || '{}', '', 'Continue after an HTTP 2xx response.', 'HTTP acceptance confirms the trigger request, not completion of the Power Automate flow.'].join('\n');
  }
  if (step.type === 'task') {
    const assigned = text(config.assignee_email).trim();
    return ['WAIT FOR MANUAL TASK', `Assigned technician: ${(supplied === null ? assigned : assigned.toLowerCase()) || assigneeEmail || '[person starting the action]'}`, '', text(config.instructions), '', 'Continue when the assigned technician marks this task complete.'].join('\n');
  }
  if (step.type === 'delay') return [`WAIT ${supplied === null ? text(config.minutes) : Number(text(config.minutes))} minutes`, 'Persist the due time and continue automatically after it is reached.'].join('\n');
  return 'This step type is unavailable.';
}
