import nodemailer from 'nodemailer';
import { isIP } from 'node:net';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ROLES = ['admin', 'technician'];
const MAX_RESPONSE = 1024 * 1024;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const SINGLE_EMAIL = /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/u;
const error = (message, statusCode = 400, extra = {}) => Object.assign(new Error(message), { statusCode, safeMessage: message, ...extra });
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function threadId(value) {
  if (typeof value !== 'string' || !/^<[^<>\s\x00-\x1f\x7f-\x9f]{1,990}>$/u.test(value)) throw error('Provide valid email threading identifiers.');
  return value;
}
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(error('The external request timed out.', 504, { uncertain: true }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(error('The external request timed out.', 504, { uncertain: true }));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, failure => { signal.removeEventListener('abort', abort); reject(failure); });
  });
}

function address(value, label) {
  if (typeof value !== 'string' || value.length > 254 || CONTROLS.test(value) || !SINGLE_EMAIL.test(value.trim())) throw error(`Provide one valid ${label} email address.`);
  return value.trim();
}
function webUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw error(`Provide a valid ${label}.`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw error(`Provide a valid ${label} without credentials, query parameters, or a fragment.`);
  return url;
}

function flowUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /\s|\\|[\x00-\x1f\x7f-\x9f]/.test(value)) throw error('Provide a valid Power Automate trigger URL.');
  let url;
  try { url = new URL(value); } catch { throw error('Provide a valid Power Automate trigger URL.'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash) throw error('Power Automate triggers require HTTPS without URL credentials or a fragment.');
  // Signed query parameters are credentials. Keep the complete configured URL
  // private and send it unchanged rather than rebuilding its signature query.
  return value;
}

export function normalizeActionPublicUrl(value = '') {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2000 || CONTROLS.test(value) || value.includes('\\')) throw error('Provide a valid public approval URL.');
  return webUrl(value, 'public approval URL').href.replace(/\/$/, '');
}

/** Admin-configured destinations are the complete outbound API allowlist. */
export function normalizeActionConnections(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw error('Configure API connections as a list of at most 100 destinations.');
  const ids = new Set();
  return value.map(input => {
    if (!plainObject(input) || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id) || ids.has(input.id)) throw error('Give each API connection a unique valid identifier.');
    ids.add(input.id);
    if (typeof input.name !== 'string' || !input.name.trim() || [...input.name].length > 100 || CONTROLS.test(input.name)) throw error('Give each API connection a name of at most 100 characters.');
    const kind = input.kind ?? 'api';
    if (!['api', 'power_automate'].includes(kind)) throw error('Choose API or Power Automate for each connection kind.');
    let destination;
    if (kind === 'power_automate') destination = { triggerUrl: flowUrl(input.triggerUrl) };
    else {
      if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2000 || CONTROLS.test(input.baseUrl) || input.baseUrl.includes('\\')) throw error('Provide a valid API connection base URL.');
      destination = { baseUrl: webUrl(input.baseUrl, 'API connection base URL').href.replace(/\/$/, '') };
    }
    const methods = input.methods ?? (kind === 'power_automate' ? ['POST'] : ['GET', 'POST']), roles = input.roles ?? ['admin'];
    if (!Array.isArray(methods) || !methods.length || methods.some(method => !METHODS.includes(method))) throw error('Choose valid HTTP methods for each API connection.');
    if (kind === 'power_automate' && (methods.length !== 1 || methods[0] !== 'POST')) throw error('Power Automate connections use POST only.');
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !ROLES.includes(role))) throw error('Choose valid account roles for each API connection.');
    const timeoutMs = input.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw error('API connection timeouts must be between 100 and 30000 milliseconds.');
    const headers = input.headers ?? {};
    if (!plainObject(headers) || Object.keys(headers).length > 30) throw error('Provide valid API connection headers.');
    const cleanHeaders = {};
    for (const [name, header] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^(?:host|cookie|set-cookie|content-length|connection|transfer-encoding|proxy-.+|forwarded|x-forwarded-.+)$/i.test(name)
        || typeof header !== 'string' || header.length > 8192 || CONTROLS.test(header)) throw error('Provide valid API connection headers without routing overrides or control characters.');
      cleanHeaders[name] = header;
    }
    return { id: input.id, name: input.name.trim(), kind, ...destination, headers: cleanHeaders,
      methods: [...new Set(methods)], roles: [...new Set(roles)], timeoutMs };
  });
}

function smtpSettings(value = {}) {
  if (!plainObject(value)) throw error('Provide valid SMTP settings.');
  const smtp = { host: value.host ?? '', port: value.port ?? 587, secure: value.secure ?? false, user: value.user ?? '', pass: value.pass ?? '', from: value.from ?? '' };
  if (typeof smtp.host !== 'string' || smtp.host.length > 253 || smtp.host && (!isIP(smtp.host) && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(smtp.host))) throw error('Provide a valid SMTP host.');
  if (!Number.isSafeInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535 || typeof smtp.secure !== 'boolean') throw error('Provide a valid SMTP port and encryption setting.');
  for (const field of ['user', 'pass']) if (typeof smtp[field] !== 'string' || smtp[field].length > 8192 || smtp[field].includes('\0')) throw error('Provide valid SMTP authentication settings.');
  if (Boolean(smtp.user) !== Boolean(smtp.pass)) throw error('Configure both SMTP username and password, or neither.');
  if (smtp.from) smtp.from = address(smtp.from, 'sender');
  return smtp;
}

function requestUrl(baseUrl, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 4000 || CONTROLS.test(path) || /[\\#]/.test(path)) throw error('Use a relative API path beginning with one slash.', 400, { blocked: true });
  // Decode repeatedly before checking segments: downstream web servers may
  // decode an escaped slash or percent sign again after the URL parser runs.
  let decoded = path.split('?')[0];
  for (let depth = 0; depth < 8; depth++) {
    if (decoded.startsWith('//') || /[\\?#]/.test(decoded) || CONTROLS.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) throw error('API paths cannot escape the configured connection.', 400, { blocked: true });
    let next;
    try { next = decodeURIComponent(decoded); } catch { throw error('Provide a valid encoded API path.', 400, { blocked: true }); }
    if (next === decoded) break;
    decoded = next;
    if (depth === 7) throw error('API paths cannot contain nested URL escapes.', 400, { blocked: true });
  }
  const base = new URL(baseUrl), prefix = base.pathname.replace(/\/$/, '');
  const url = new URL(base.origin + prefix + path);
  if (url.origin !== base.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) throw error('API paths must remain within the configured connection.', 400, { blocked: true });
  return url.href;
}

async function discardResponse(response, signal) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE) {
    response.body?.cancel().catch(() => {});
    throw error('The API response exceeded the one-megabyte limit.', 502, { uncertain: true });
  }
  if (!response.body) return;
  const reader = response.body.getReader(); let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw error('The API request timed out. Check the remote service before retrying.', 504, { uncertain: true });
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw error('The API response exceeded the one-megabyte limit.', 502, { uncertain: true });
    }
  } catch (failure) {
    reader.cancel().catch(() => {});
    throw failure;
  } finally { reader.releaseLock(); }
}

/** Outbound delivery only. Configuration and credentials never enter the UI. */
export class ActionTransports {
  #smtp; #connections; #publicUrl; #createTransport; #fetch; #mailer;
  constructor(config = {}, { createTransport = nodemailer.createTransport, fetchImpl = fetch } = {}) {
    if (!plainObject(config)) throw error('Provide valid automation connection settings.');
    this.#smtp = smtpSettings(config.smtp);
    this.#connections = normalizeActionConnections(config.connections);
    this.#publicUrl = normalizeActionPublicUrl(config.publicUrl);
    this.#createTransport = createTransport;
    this.#fetch = fetchImpl;
  }
  capabilities(user) {
    const configured = Boolean(this.#smtp.host && this.#smtp.from);
    return { email: { configured }, approval: { configured: configured && Boolean(this.#publicUrl) },
      connections: this.#connections.filter(connection => user?.active !== false && connection.roles.includes(user?.role)).map(({ id, name, kind, baseUrl, methods }) => ({ id, name, kind, ...(kind === 'api' ? { baseUrl } : {}), methods: [...methods] })),
      publicUrl: this.#publicUrl };
  }
  isSender(value) { return typeof value === 'string' && Boolean(this.#smtp.from) && value.trim().toLowerCase() === this.#smtp.from.toLowerCase(); }
  async sendEmail({ to, subject, text, messageId, inReplyTo, references, autoReply } = {}) {
    const recipient = address(to, 'recipient');
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 240 || CONTROLS.test(subject)) throw error('Provide a subject of at most 240 characters without control characters.');
    if (typeof text !== 'string' || !text.trim() || text.length > 100000 || text.includes('\0')) throw error('Provide an email message of at most 100000 characters.');
    if (messageId !== undefined && (typeof messageId !== 'string' || !/^<[^<>\s\x00-\x1f\x7f]{1,240}>$/.test(messageId))) throw error('Provide a valid automation message identifier.');
    const replyId = inReplyTo === undefined ? undefined : threadId(inReplyTo);
    let referenceIds;
    if (references !== undefined) {
      const values = Array.isArray(references) ? references : typeof references === 'string' ? [references] : null;
      if (!values || values.length > 100) throw error('Provide valid email threading identifiers.');
      referenceIds = [...new Set(values.map(threadId))];
      if (referenceIds.join(' ').length > 8192) throw error('Email threading identifiers exceed the size limit.');
    }
    if (autoReply !== undefined && typeof autoReply !== 'boolean') throw error('Choose a valid automatic email setting.');
    if (!this.#smtp.host || !this.#smtp.from) throw error('Outbound email is not configured. Ask an administrator to configure SMTP.', 409, { blocked: true });
    let attempted = false;
    try {
      if (!this.#mailer) {
        const smtp = this.#smtp;
        this.#mailer = this.#createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, requireTLS: !smtp.secure,
          ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
          disableFileAccess: true, disableUrlAccess: true });
      }
      attempted = true;
      const sent = await this.#mailer.sendMail({ from: this.#smtp.from, to: recipient, subject, text,
        ...(messageId ? { messageId } : {}), ...(replyId ? { inReplyTo: replyId } : {}), ...(referenceIds?.length ? { references: referenceIds } : {}),
        ...(autoReply ? { headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' } } : {}),
        envelope: { from: this.#smtp.from, to: [recipient] }, disableFileAccess: true, disableUrlAccess: true });
      if (sent?.rejected?.length || Array.isArray(sent?.accepted) && !sent.accepted.some(value => String(value).toLowerCase() === recipient.toLowerCase())) throw error('The mail server did not accept the recipient.', 502);
      return { messageId: messageId || (typeof sent?.messageId === 'string' ? sent.messageId : '') };
    } catch (failure) {
      if (failure?.safeMessage) throw failure;
      const knownBeforeSend = !attempted || ['EAUTH', 'EDNS', 'ECONNECTION', 'ETLS', 'EENVELOPE'].includes(failure?.code);
      throw error(knownBeforeSend ? 'Email delivery failed. Check the SMTP configuration and recipient.' : 'Email delivery could not be confirmed. Check the mail service before retrying.', 502, { uncertain: !knownBeforeSend });
    }
  }
  async callApi({ connection: id, method, path, body } = {}, user) {
    const connection = this.#connections.find(value => value.id === id);
    if (!connection || connection.kind !== 'api' || user?.active === false || !connection.roles.includes(user?.role)) throw error('This API connection is not configured or is unavailable to your account.', 403, { blocked: true });
    if (!connection.methods.includes(method)) throw error('This HTTP method is not allowed for the API connection.', 403, { blocked: true });
    const url = requestUrl(connection.baseUrl, path);
    return this.#request(connection, url, method, body);
  }
  async triggerFlow({ connection: id, body } = {}, user) {
    const connection = this.#connections.find(value => value.id === id);
    if (!connection || connection.kind !== 'power_automate' || user?.active === false || !connection.roles.includes(user?.role)) throw error('This Power Automate connection is not configured or is unavailable to your account.', 403, { blocked: true });
    return this.#request(connection, connection.triggerUrl, 'POST', body === undefined || body === null || body === '' ? {} : body, 'Power Automate');
  }
  async #request(connection, url, method, body, label = 'API') {
    const headers = { ...connection.headers };
    let encoded;
    if (body !== undefined && body !== null && body !== '') {
      if (method === 'GET') throw error('GET actions cannot include a request body.');
      try { encoded = JSON.stringify(body); } catch { throw error('Provide a valid JSON request body.'); }
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_RESPONSE) throw error('The API request body must be valid JSON of at most one megabyte.');
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController(), signal = controller.signal;
    const deadline = setTimeout(() => controller.abort(), connection.timeoutMs);
    try {
      const response = await untilAborted(this.#fetch(url, { method, headers, ...(encoded === undefined ? {} : { body: encoded }), signal, redirect: 'error' }), signal);
      await discardResponse(response, signal);
      if (response.status < 200 || response.status > 299) throw error(`The ${label} call returned HTTP ${response.status}.`, 502, { httpStatus: response.status, uncertain: response.status >= 500 });
      return { status: response.status };
    } catch (failure) {
      if (failure?.safeMessage) throw failure;
      throw error(signal.aborted ? `The ${label} request timed out. Check the remote service before retrying.` : `The ${label} result could not be confirmed. Check the remote service before retrying.`, signal.aborted ? 504 : 502, { uncertain: true });
    } finally { clearTimeout(deadline); }
  }
}
