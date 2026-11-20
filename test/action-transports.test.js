import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ActionTransports, normalizeActionConnections, normalizeActionPublicUrl } from '../src/action-transports.js';

const SMTP = { host: 'smtp.example.test', port: 587, secure: false, user: 'service@example.test', pass: 'private-smtp-value', from: 'helpdesk@example.test' };
const PROFILE = { id: 'people', name: 'People directory', baseUrl: 'https://api.example.test/v1', headers: { Authorization: 'Bearer private-api-value' } };
const ADMIN = { id: 'admin-test', role: 'admin', active: true }, TECH = { id: 'technician-test', role: 'technician', active: true };
const message = { to: 'approver@example.test', subject: 'Review equipment request', text: 'Please review the proposed equipment.', messageId: '<action-run-step@assetdesk.local>' };
const privateText = /private-smtp-value|private-api-value|raw-secret-response/;

test('capabilities expose only configured, role-permitted destinations and no credentials', async () => {
  const empty = new ActionTransports();
  assert.deepEqual(empty.capabilities(ADMIN), { email: { configured: false }, approval: { configured: false }, connections: [], publicUrl: '' });
  const transport = new ActionTransports({ smtp: SMTP, publicUrl: 'https://helpdesk.example.test/', connections: [PROFILE] });
  const admin = transport.capabilities(ADMIN), technician = transport.capabilities(TECH);
  assert.equal(admin.email.configured, true); assert.equal(admin.approval.configured, true);
  assert.deepEqual(admin.connections, [{ id: PROFILE.id, name: PROFILE.name, kind: 'api', baseUrl: PROFILE.baseUrl, methods: ['GET', 'POST'] }]);
  assert.equal(technician.connections.length, 0);
  assert.equal(transport.capabilities({ ...ADMIN, active: false }).connections.length, 0);
  assert.doesNotMatch(JSON.stringify(admin), /headers|Authorization|auth|pass/);
  assert.doesNotMatch(JSON.stringify(transport), privateText);
  await assert.rejects(empty.sendEmail(message), failure => failure.blocked && failure.statusCode === 409);
  assert.equal(new ActionTransports({ smtp: SMTP }).capabilities(ADMIN).approval.configured, false);
});

test('SMTP uses verified TLS, a fixed single-recipient envelope and deterministic message identifiers', async () => {
  const messages = []; let options, factories = 0;
  const transport = new ActionTransports({ smtp: SMTP }, { createTransport: value => { options = value; factories++; return { async sendMail(mail) { messages.push(mail); return { accepted: [mail.to], rejected: [], messageId: mail.messageId }; } }; } });
  assert.deepEqual(await transport.sendEmail(message), { messageId: message.messageId });
  await transport.sendEmail({ ...message, text: 'Second delivery.' });
  assert.equal(factories, 1); assert.equal(messages.length, 2);
  assert.equal(options.secure, false); assert.equal(options.requireTLS, true);
  assert.deepEqual(options.tls, { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
  assert.deepEqual(messages[0].envelope, { from: SMTP.from, to: [message.to] });
  assert.equal(messages[0].from, SMTP.from); assert.equal(messages[0].text, message.text);
  assert.equal(messages[0].disableFileAccess, true); assert.equal(messages[0].disableUrlAccess, true);
  for (const bad of [{ to: 'one@example.test,two@example.test' }, { to: 'One <one@example.test>' }, { subject: 'Review\r\nBcc: other@example.test' }, { messageId: '<valid>\r\ninvalid' }]) {
    await assert.rejects(transport.sendEmail({ ...message, ...bad }), failure => failure.statusCode === 400);
  }
  assert.equal(messages.length, 2, 'Invalid message fields must not reach SMTP');
});

test('SMTP failures are sanitized and distinguish rejected credentials from uncertain delivery', async () => {
  const make = failure => new ActionTransports({ smtp: SMTP }, { createTransport: () => ({ async sendMail() { throw failure; } }) });
  await assert.rejects(make(Object.assign(new Error('private-smtp-value'), { code: 'EAUTH' })).sendEmail(message), failure => {
    assert.doesNotMatch(failure.message, privateText); assert.equal(failure.uncertain, false); return true;
  });
  await assert.rejects(make(Object.assign(new Error('private-smtp-value'), { code: 'ETIMEDOUT' })).sendEmail(message), failure => {
    assert.doesNotMatch(failure.safeMessage, privateText); assert.equal(failure.uncertain, true); return true;
  });
  const rejected = new ActionTransports({ smtp: SMTP }, { createTransport: () => ({ async sendMail() { return { rejected: [message.to], accepted: [] }; } }) });
  await assert.rejects(rejected.sendEmail(message), /mail server did not accept/i);
});

test('API calls use a configured base path, permitted role/method and JSON without exposing response bodies', async () => {
  let actual;
  const profile = { ...PROFILE, roles: ['admin', 'technician'] };
  const transport = new ActionTransports({ connections: [profile] }, { fetchImpl: async (url, options) => { actual = { url, options }; return new Response('raw-secret-response', { status: 201 }); } });
  const body = { person: 'Alex "Quoted" Café', days: 3 };
  assert.deepEqual(await transport.callApi({ connection: 'people', method: 'POST', path: '/employees?department=Design%20team', body }, TECH), { status: 201 });
  assert.equal(actual.url, 'https://api.example.test/v1/employees?department=Design%20team');
  assert.equal(actual.options.redirect, 'error'); assert.equal(actual.options.headers.Authorization, PROFILE.headers.Authorization);
  assert.equal(actual.options.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(actual.options.body), body);
  assert.ok(actual.options.signal instanceof AbortSignal);
});

test('API origin, encoded traversal, method and role violations are rejected before any network request', async () => {
  let requests = 0;
  const transport = new ActionTransports({ connections: [PROFILE] }, { fetchImpl: async () => { requests++; return new Response('ok'); } });
  const call = (data, user = ADMIN) => transport.callApi({ connection: 'people', method: 'GET', path: '/employees', ...data }, user);
  await assert.rejects(call({}, TECH), failure => failure.blocked && failure.statusCode === 403);
  await assert.rejects(call({}, { ...ADMIN, active: false }), failure => failure.blocked);
  await assert.rejects(call({ connection: 'missing' }), failure => failure.blocked);
  await assert.rejects(call({ method: 'DELETE' }), failure => failure.blocked);
  for (const path of ['https://other.example.test', '//other.example.test', '/../admin', '/%2e%2e/admin', '/%252e%252e/admin', '/people/../admin', '/people/%252e%252e%252fadmin', '/people\\..\\admin', '/people%255c..%255cadmin', '/%252f%252fother.example.test', '/%250a', '/people#fragment', '/bad%escape']) {
    await assert.rejects(call({ path }), failure => failure.statusCode === 400 && failure.blocked, path);
  }
  await assert.rejects(call({ body: { notAllowed: true } }), /GET actions cannot/);
  assert.equal(requests, 0);
});

test('real HTTP delivery remains within its configured base path and never follows redirects', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
    if (req.url === '/v1/redirect') { res.writeHead(302, { Location: '/unconfigured' }); res.end(); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"private":"raw-secret-response"}'); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const transport = new ActionTransports({ connections: [{ ...PROFILE, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }] });
  assert.deepEqual(await transport.callApi({ connection: 'people', method: 'POST', path: '/employees', body: { name: 'Alex' } }, ADMIN), { status: 200 });
  assert.deepEqual(requests[0], { url: '/v1/employees', method: 'POST', body: '{"name":"Alex"}' });
  await assert.rejects(transport.callApi({ connection: 'people', method: 'GET', path: '/redirect' }, ADMIN), failure => {
    assert.equal(failure.uncertain, true); assert.doesNotMatch(failure.message, /raw-secret-response|unconfigured|127\.0\.0\.1/); return true;
  });
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.url.startsWith('/v1/')));
});

test('API deadlines bound both a stalled fetch and a stalled response stream', async () => {
  const profile = { ...PROFILE, timeoutMs: 100 };
  const stalled = new ActionTransports({ connections: [profile] }, { fetchImpl: () => new Promise(() => {}) });
  let started = Date.now();
  await assert.rejects(stalled.callApi({ connection: 'people', method: 'GET', path: '/' }, ADMIN), failure => failure.statusCode === 504 && failure.uncertain);
  assert.ok(Date.now() - started < 1000);
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const reading = new ActionTransports({ connections: [profile] }, { fetchImpl: async () => new Response(stream) });
  started = Date.now();
  await assert.rejects(reading.callApi({ connection: 'people', method: 'GET', path: '/' }, ADMIN), failure => failure.statusCode === 504 && failure.uncertain);
  assert.ok(Date.now() - started < 1000); assert.equal(cancelled, true);
});

test('API responses and request bodies are bounded and remote errors never become application messages', async () => {
  const call = response => new ActionTransports({ connections: [PROFILE] }, { fetchImpl: async () => response }).callApi({ connection: 'people', method: 'GET', path: '/' }, ADMIN);
  await assert.rejects(call(new Response('raw-secret-response', { status: 500 })), failure => failure.httpStatus === 500 && failure.uncertain && !privateText.test(failure.message));
  await assert.rejects(call(new Response('raw-secret-response', { headers: { 'Content-Length': String(2 * 1024 * 1024) } })), /one-megabyte/);
  const chunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(700000)); controller.enqueue(new Uint8Array(700000)); controller.close(); } });
  await assert.rejects(call(new Response(chunks)), /one-megabyte/);
  const transport = new ActionTransports({ connections: [PROFILE] }, { fetchImpl: async () => assert.fail('Oversized JSON must not be sent') });
  await assert.rejects(transport.callApi({ connection: 'people', method: 'POST', path: '/', body: { text: 'x'.repeat(1024 * 1024) } }, ADMIN), /one megabyte/);
});

test('connection configuration rejects unsafe destinations and invalid credentials without echoing values', () => {
  assert.equal(normalizeActionPublicUrl('https://desk.example.test/app/'), 'https://desk.example.test/app');
  for (const publicUrl of ['javascript:alert(1)', 'https://user:private-api-value@example.test', 'https://example.test/?token=private-api-value']) assert.throws(() => normalizeActionPublicUrl(publicUrl), failure => !privateText.test(failure.message));
  for (const profile of [{ ...PROFILE, baseUrl: 'https://user:private-api-value@example.test' }, { ...PROFILE, roles: ['owner'] }, { ...PROFILE, methods: ['TRACE'] }, { ...PROFILE, headers: { Host: 'other.example.test' } }, { ...PROFILE, headers: { Authorization: 'Bearer private-api-value\r\nInjected: yes' } }, { ...PROFILE, timeoutMs: 1 }]) {
    assert.throws(() => normalizeActionConnections([profile]), failure => failure.statusCode === 400 && !privateText.test(failure.message));
  }
  assert.throws(() => normalizeActionConnections([PROFILE, PROFILE]), /unique/);
  assert.throws(() => new ActionTransports({ smtp: { ...SMTP, pass: '' } }), /both SMTP/);
  assert.throws(() => new ActionTransports({ smtp: { ...SMTP, from: 'Name <sender@example.test>' } }), /one valid sender/);
});

const FLOW = { id: 'equipment_flow', name: 'Equipment flow', kind: 'power_automate', triggerUrl: 'https://flow.example.test/workflows/private-flow-path/triggers/manual/invoke?api-version=2016-06-01&sig=private-flow-signature' };
const flowPrivate = /private-flow-signature|private-flow-path|triggerUrl|Authorization|raw-secret-response/;

test('Power Automate sends JSON to the exact private signed trigger and never follows redirects', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), contentType: req.headers['content-type'], authorization: req.headers.authorization });
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/unconfigured' }); res.end(); }
    else { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{"private":"raw-secret-response"}'); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = '/private-flow-path/invoke?api-version=2016-06-01&sig=private-flow-signature%2B%2F%3D';
  const profile = { ...FLOW, triggerUrl: origin + path, headers: { Authorization: 'Bearer private-api-value' } };
  const transport = new ActionTransports({ connections: [profile, { ...FLOW, id: 'redirect_flow', triggerUrl: origin + '/redirect?sig=private-flow-signature' }] });
  const body = { name: 'Alex "Quoted" Café', days: 3 };
  assert.deepEqual(await transport.triggerFlow({ connection: FLOW.id, body }, ADMIN), { status: 202 });
  assert.deepEqual(requests[0], { url: path, method: 'POST', body: JSON.stringify(body), contentType: 'application/json', authorization: 'Bearer private-api-value' });
  assert.deepEqual(transport.capabilities(ADMIN).connections[0], { id: FLOW.id, name: FLOW.name, kind: 'power_automate', methods: ['POST'] });
  assert.doesNotMatch(JSON.stringify(transport.capabilities(ADMIN)), flowPrivate);
  assert.doesNotMatch(JSON.stringify(transport), flowPrivate);
  assert.deepEqual(await transport.triggerFlow({ connection: FLOW.id, body: '' }, ADMIN), { status: 202 });
  assert.equal(requests[1].body, '{}'); assert.equal(requests[1].contentType, 'application/json');
  await assert.rejects(transport.triggerFlow({ connection: 'redirect_flow', body: {} }, ADMIN), failure => failure.uncertain && !flowPrivate.test(failure.message));
  assert.equal(requests.length, 3, 'A redirect must not replay the signed trigger at another destination.');
});

test('Power Automate enforces connection roles and kind before sending, and keeps failures private', async () => {
  let requests = 0;
  const transport = new ActionTransports({ connections: [FLOW, PROFILE] }, { fetchImpl: async () => { requests++; return new Response('raw-secret-response', { status: 503 }); } });
  assert.deepEqual(transport.capabilities(TECH).connections, []);
  for (const [connection, user] of [[FLOW.id, TECH], [FLOW.id, { ...ADMIN, active: false }], ['missing', ADMIN], [PROFILE.id, ADMIN]]) {
    await assert.rejects(transport.triggerFlow({ connection, body: {} }, user), failure => failure.blocked && failure.statusCode === 403 && !flowPrivate.test(failure.message));
  }
  await assert.rejects(transport.callApi({ connection: FLOW.id, method: 'POST', path: '/override', body: {} }, ADMIN), failure => failure.blocked && failure.statusCode === 403);
  await assert.rejects(transport.triggerFlow({ connection: FLOW.id, body: { text: 'x'.repeat(1024 * 1024) } }, ADMIN), /one megabyte/);
  assert.equal(requests, 0);
  await assert.rejects(transport.triggerFlow({ connection: FLOW.id, body: {} }, ADMIN), failure => failure.httpStatus === 503 && failure.uncertain && !flowPrivate.test(failure.message));
  assert.equal(requests, 1);
  const stalled = new ActionTransports({ connections: [{ ...FLOW, timeoutMs: 100 }] }, { fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(stalled.triggerFlow({ connection: FLOW.id, body: {} }, ADMIN), failure => failure.statusCode === 504 && failure.uncertain && !flowPrivate.test(failure.message));
  const rejected = new ActionTransports({ connections: [FLOW] }, { fetchImpl: async () => { throw new Error(FLOW.triggerUrl); } });
  await assert.rejects(rejected.triggerFlow({ connection: FLOW.id, body: {} }, ADMIN), failure => failure.uncertain && !flowPrivate.test(failure.message));
  const oversized = new ActionTransports({ connections: [FLOW] }, { fetchImpl: async () => new Response('raw-secret-response', { headers: { 'Content-Length': String(2 * 1024 * 1024) } }) });
  await assert.rejects(oversized.triggerFlow({ connection: FLOW.id, body: {} }, ADMIN), failure => failure.uncertain && /one-megabyte/.test(failure.message) && !flowPrivate.test(failure.message));
});

test('Power Automate trigger configuration validates securely without reflecting signed URLs', () => {
  const normalized = normalizeActionConnections([FLOW])[0];
  assert.equal(normalized.triggerUrl, FLOW.triggerUrl); assert.deepEqual(normalized.methods, ['POST']);
  assert.deepEqual(normalized.roles, ['admin']);
  for (const triggerUrl of ['http://flow.example.test/invoke?sig=private-flow-signature', 'https://user:private-flow-signature@flow.example.test/invoke', FLOW.triggerUrl + '#fragment', FLOW.triggerUrl + '\\escape', 'javascript:private-flow-signature', FLOW.triggerUrl + '\n', 'https://flow.example.test/invoke?sig=private flow-signature']) {
    assert.throws(() => normalizeActionConnections([{ ...FLOW, triggerUrl }]), failure => failure.statusCode === 400 && !flowPrivate.test(failure.message));
  }
  for (const profile of [{ ...FLOW, methods: ['GET'] }, { ...FLOW, kind: 'unknown' }, { ...FLOW, headers: { Host: 'flow.example.test' } }]) assert.throws(() => normalizeActionConnections([profile]));
});
