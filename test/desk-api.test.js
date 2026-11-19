import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { createDeskRouter } from '../src/desk-routes.js';

const password = 'correct horse battery staple';

async function harness(t, { cookieSecure = false } = {}) {
  const store = new Store(':memory:');
  const desk = new DeskStore(store);
  const workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Alex Admin', email: 'admin@example.com', password });
  const technician = await desk.createTechnician({ name: 'Taylor Tech', email: 'tech@example.com', password, role: 'technician' });
  const worker = { wakeCalls: 0, accept(message) { return store.accept(message); }, wake() { this.wakeCalls++; } };
  const config = { cookieSecure };
  const app = express();
  app.use('/api/desk', createDeskRouter({ desk, workspace, store, worker, config }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/desk`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  async function request(path, { method = 'GET', body, session, csrf = true, headers = {} } = {}) {
    const response = await fetch(`${url}${path}`, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Cookie: session.cookie } : {}),
      ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}), ...headers,
    }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function login(email = 'admin@example.com', loginPassword = password) {
    const response = await request('/login', { method: 'POST', body: { email, password: loginPassword } });
    return { ...response, cookie: response.headers.get('set-cookie')?.split(';')[0], csrfToken: response.body.csrfToken };
  }
  function ticket(key = 'HD-TEST-1', requester = 'person@example.com') {
    store.saveTicket({ key, requester, subject: 'Laptop screen is flickering', page_id: 42, page_url: 'https://wiki.example.com/link/42' });
    desk.captureEmail(key, { from: { name: 'Pat Person', address: requester }, subject: 'Laptop screen is flickering',
      text: 'LAPTOP-123 needs attention.', receivedAt: new Date().toISOString() }, { receiptId: key, isReply: false });
    return desk.getTicket(key);
  }
  return { store, desk, worker, request, login, ticket, admin, technician };
}

test('dashboard requires a session and sign-in issues an HttpOnly strict cookie without API secrets', async t => {
  const { request, login } = await harness(t);
  assert.equal((await request('/session')).status, 401);
  assert.equal((await request('/dashboard')).status, 401);
  const session = await login();
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.ok(session.csrfToken.length >= 32);
  assert.equal(session.body.user.role, 'admin');
  assert.equal(session.body.bookstackUrl, undefined);
  assert.doesNotMatch(JSON.stringify(session.body), /password_hash|tokenSecret|adminToken/);
  assert.equal((await request('/session', { session })).body.user.email, 'admin@example.com');
  const dashboard = await request('/dashboard', { session });
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.intake.counts, []);
});

test('secure deployment cookies are marked Secure', async t => {
  const { login } = await harness(t, { cookieSecure: true });
  assert.match((await login()).headers.get('set-cookie'), /; Secure/);
});

test('session mutations require CSRF and logout invalidates the server session', async t => {
  const { request, login } = await harness(t);
  const session = await login();
  assert.equal((await request('/logout', { method: 'POST', body: {}, session, csrf: false })).status, 403);
  assert.equal((await request('/logout', { method: 'POST', body: {}, session, headers: { 'X-CSRF-Token': 'invalid' } })).status, 403);
  const result = await request('/logout', { method: 'POST', body: {}, session });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await request('/dashboard', { session })).status, 401);
});

test('technicians can work tickets while account management remains administrator-only', async t => {
  const { request, login, ticket, technician } = await harness(t);
  const initial = ticket();
  const session = await login('tech@example.com');
  assert.equal((await request('/technicians', { session })).status, 200);
  assert.equal((await request('/technicians', { method: 'POST', session, body: { name: 'Other', email: 'other@example.com', password } })).status, 403);
  assert.equal((await request(`/technicians/${technician.id}`, { method: 'PATCH', session, body: { role: 'admin' } })).status, 403);
  const changed = await request(`/tickets/${initial.key}`, { method: 'PATCH', session,
    body: { version: initial.version, assignee_id: technician.id, status: 'in_progress' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.assignee.id, technician.id);
  const note = await request(`/tickets/${initial.key}/notes`, { method: 'POST', session, body: { body: 'Investigating the display connection.' } });
  assert.equal(note.status, 201);
  const detail = await request(`/tickets/${initial.key}`, { session });
  assert.ok(detail.body.notes.some(note => note.body === 'Investigating the display connection.'));
});

test('ticket updates use optimistic versions and require a resolution before resolving', async t => {
  const { request, login, ticket } = await harness(t);
  const initial = ticket();
  const session = await login();
  assert.equal((await request(`/tickets/${initial.key}`, { method: 'PATCH', session, body: { priority: 'high' } })).status, 400);
  const changed = await request(`/tickets/${initial.key}`, { method: 'PATCH', session, body: { version: initial.version, priority: 'high' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.priority, 'high');
  assert.equal((await request(`/tickets/${initial.key}`, { method: 'PATCH', session, body: { version: initial.version, status: 'waiting' } })).status, 409);
  assert.equal((await request(`/tickets/${initial.key}`, { method: 'PATCH', session, body: { version: changed.body.version, status: 'resolved' } })).status, 400);
  const resolved = await request(`/tickets/${initial.key}`, { method: 'PATCH', session,
    body: { version: changed.body.version, status: 'resolved', resolution: 'Replaced the display cable and verified the screen.' } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, 'resolved');
  assert.ok(resolved.body.resolved_at);
});

test('manual ticket creation validates metadata and queues original text without header injection', async t => {
  const { request, login, worker, store, technician } = await harness(t);
  const session = await login();
  const body = { subject: 'Écran LAPTOP-123', requester: 'pat@example.com', requester_name: 'Pat Person',
    description: '<script>untrusted</script>\nLAPTOP-123 screen flickers.', priority: 'high', category: 'hardware', assignee_id: technician.id };
  const created = await request('/tickets', { method: 'POST', session, body });
  assert.equal(created.status, 202);
  assert.equal(created.body.statusUrl, `/api/desk/receipts/${created.body.id}`);
  assert.equal(worker.wakeCalls, 1);
  const queued = store.next();
  assert.equal(queued.message.text, body.description);
  assert.equal(queued.message.from.name, 'Pat Person');
  assert.deepEqual(queued.message.assetRefs, ['LAPTOP-123']);
  assert.equal(queued.message.desk.priority, 'high');
  assert.equal(queued.message.desk.assignee_id, technician.id);
  assert.equal(queued.message.desk.actor.id, session.body.user.id);
  assert.equal((await request(`/receipts/${created.body.id}`, { session })).status, 200);
  for (const patch of [{ subject: 'Help\r\nInjected: yes' }, { requester: 'bad-address' }, { description: '' }, { priority: 'critical' }, { assignee_id: 'unknown' }, { admin: true }]) {
    assert.equal((await request('/tickets', { method: 'POST', session, body: { ...body, ...patch } })).status, 400);
  }
});

test('filters validate values and My tickets uses the current authenticated technician', async t => {
  const { request, login, ticket, desk, technician } = await harness(t);
  const first = ticket('HD-ONE');
  ticket('HD-TWO');
  desk.updateTicket(first.key, { assignee_id: technician.id }, { actor: technician, version: first.version });
  const session = await login('tech@example.com');
  const mine = await request('/tickets?view=my', { session });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.total, 1);
  assert.equal(mine.body.tickets[0].key, first.key);
  assert.equal((await request('/tickets?view=unassigned', { session })).body.total, 1);
  for (const query of ['status=not-real', 'priority=critical', 'category=unknown', 'view=unknown', 'limit=100000', 'offset=-1']) {
    assert.equal((await request(`/tickets?${query}`, { session })).status, 400);
  }
});

test('failed sign-ins use generic errors and eventually rate-limit the client', async t => {
  const { login, request } = await harness(t);
  for (let i = 0; i < 10; i++) {
    const result = await login(i % 2 ? 'unknown@example.com' : 'admin@example.com', 'incorrect password');
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Email or password is incorrect.');
  }
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await request('/login', { method: 'POST', body: { email: 'admin@example.com', password: 12 } })).status, 400);
});

test('parallel invalid sign-ins cannot bypass the login attempt limit', async t => {
  const { login } = await harness(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => login('admin@example.com', 'incorrect password')));
  assert.equal(responses.filter(response => response.status === 401).length, 10);
  assert.equal(responses.filter(response => response.status === 429).length, 2);
});

test('admin account changes do not expose password hashes and the last admin cannot be disabled', async t => {
  const { request, login, admin } = await harness(t);
  const session = await login();
  const created = await request('/technicians', { method: 'POST', session,
    body: { name: 'Morgan Support', email: 'morgan@example.com', password, role: 'technician' } });
  assert.equal(created.status, 201);
  assert.doesNotMatch(JSON.stringify(created.body), /password|scrypt|hash/);
  const changed = await request(`/technicians/${created.body.id}`, { method: 'PATCH', session, body: { active: false } });
  assert.equal(changed.status, 200);
  assert.equal(Boolean(changed.body.active), false);
  assert.equal((await request(`/technicians/${admin.id}`, { method: 'PATCH', session, body: { active: false } })).status, 409);
});

test('saved responses are readable by technicians but only administrators can maintain them', async t => {
  const { request, login } = await harness(t);
  const admin = await login();
  const technician = await login('tech@example.com');
  const body = { title: 'Collect device details', body: 'Please confirm the asset ID and attach a screenshot of the error.' };
  assert.equal((await request('/responses', { method: 'POST', session: technician, body })).status, 403);
  assert.equal((await request('/responses', { method: 'POST', session: admin, csrf: false, body })).status, 403);
  const created = await request('/responses', { method: 'POST', session: admin, body });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, body.title);
  const listed = await request('/responses', { session: technician });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.responses.some(response => response.id === created.body.id));
  assert.equal((await request(`/responses/${created.body.id}`, { method: 'PATCH', session: technician, body: { active: false } })).status, 403);
  const updated = await request(`/responses/${created.body.id}`, { method: 'PATCH', session: admin,
    body: { title: 'Confirm the device', body: 'Please confirm your asset ID.', active: true } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.body, 'Please confirm your asset ID.');
  assert.equal((await request('/responses', { method: 'POST', session: admin, body: { title: '', body: '' } })).status, 400);
  assert.equal((await request(`/responses/${created.body.id}`, { method: 'PATCH', session: admin, body: { title: 'Changed', unexpected: true } })).status, 400);
});

test('technicians link native assets immediately without overwriting ticket content', async t => {
  const { request, login, ticket, desk, worker } = await harness(t);
  const initial = ticket();
  const session = await login('tech@example.com');
  assert.equal((await request(`/tickets/${initial.key}/assets`, { method: 'POST', session, csrf: false, body: { ref: 'PC-88' } })).status, 403);
  const queued = await request(`/tickets/${initial.key}/assets`, { method: 'POST', session, body: { ref: ' pc-88 ' } });
  assert.equal(queued.status, 201);
  assert.equal(worker.wakeCalls, 0);
  const detail = desk.getTicket(initial.key);
  assert.equal(detail.description, initial.description);
  const visible = await request(`/tickets/${initial.key}`, { session });
  assert.ok(visible.body.assets.some(asset => asset.ref === 'PC-88'));
  for (const ref of ['', 'X'.repeat(65), '<script>', 'PC-88/../private']) {
    assert.equal((await request(`/tickets/${initial.key}/assets`, { method: 'POST', session, body: { ref } })).status, 400);
  }
  assert.equal((await request('/tickets/does-not-exist/assets', { method: 'POST', session, body: { ref: 'PC-88' } })).status, 404);
});
