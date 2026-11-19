#!/usr/bin/env node
// Creates three labeled development tickets and measures durable local intake.
// Never use this to load-test production.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3000';
const login = await fetch(`${base}/api/desk/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.DASHBOARD_ADMIN_EMAIL || 'admin@assetdesk.local', password: process.env.DASHBOARD_ADMIN_PASSWORD }) });
assert.ok(login.ok, 'Dashboard login must succeed');
const session = await login.json();
const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
const timings = [];
for (let sample = 0; sample < 3; sample++) {
  const run = Date.now();
  const started = performance.now();
  const response = await fetch(`${base}/api/desk/tickets`, { method: 'POST', headers,
    body: JSON.stringify({ subject: `[Performance test] Ticket creation ${run}`, requester: 'benchmark@assetdesk.example',
      description: `Diagnose LAPTOP-${run} and PC-${run}.`, priority: 'normal', category: 'hardware' }) });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  const acceptedMs = performance.now() - started;
  let key = receipt.ticketKey;
  let availableMs;
  let completedMs;
  for (let i = 0; i < 1200; i++) {
    if (key && availableMs === undefined) {
      const ticket = await fetch(`${base}/api/desk/tickets/${key}`, { headers });
      assert.equal(ticket.status, 200);
      assert.ok((await ticket.json()).description.includes('Diagnose'));
      availableMs = performance.now() - started;
    }
    const status = await (await fetch(`${base}${receipt.statusUrl}`, { headers })).json();
    assert.notEqual(status.state, 'failed', status.error || 'Local intake failed');
    key ||= status.ticketKey;
    if (status.state === 'done') { completedMs = performance.now() - started; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(completedMs !== undefined, 'Local processing must complete');
  if (availableMs === undefined) availableMs = performance.now() - started;
  timings.push({ acceptedMs: Math.round(acceptedMs), ticketAvailableMs: Math.round(availableMs), processingCompletedMs: Math.round(completedMs) });
}
await fetch(`${base}/api/desk/logout`, { method: 'POST', headers, body: '{}' });
console.log(JSON.stringify({ samples: timings }, null, 2));
