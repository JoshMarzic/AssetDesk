#!/usr/bin/env node
// Exercises a development instance and leaves labeled test records, not real mail.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BookStackClient } from '../src/bookstack.js';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3000';
let cookie, csrf;
async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api/desk${path}`, { method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${data.error || ''}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (data.csrfToken) csrf = data.csrfToken;
  return data;
}
const run = Date.now();
const ref = `LAPTOP-${run}`;
await request('/login', { method: 'POST', body: {
  email: process.env.DASHBOARD_ADMIN_EMAIL || 'admin@assetdesk.local', password: process.env.DASHBOARD_ADMIN_PASSWORD,
} });
const technician = await request('/technicians', { method: 'POST', body: {
  name: `Smoke technician ${run}`, email: `smoke-${run}@assetdesk.example`,
  password: randomBytes(24).toString('hex'), role: 'technician',
} });
assert.ok((await request('/responses')).responses.length >= 3);
const responseTemplate = await request('/responses', { method: 'POST', body: {
  title: `Smoke response ${run}`, body: 'Hi {{requester}}, we are investigating {{ticket_id}}: {{subject}}. — {{technician}}',
} });
const receipt = await request('/tickets', { method: 'POST', body: {
  subject: `[Smoke test] Intermittent display on ${ref}`, requester: 'smoke-requester@assetdesk.example',
  requester_name: 'Smoke requester', description: `${ref} loses its external display. Please investigate.`,
  priority: 'high', category: 'hardware', assignee_id: technician.id,
} });
let key;
for (let i = 0; i < 100; i++) {
  const current = await request(`/receipts/${receipt.id}`);
  assert.notEqual(current.state, 'failed', current.error || 'Ticket creation failed');
  if (current.state === 'done') { key = current.ticketKey; break; }
  await new Promise(resolve => setTimeout(resolve, 300));
}
assert.ok(key, 'Manual ticket must finish processing');
let ticket = await request(`/tickets/${key}`);
assert.equal(ticket.priority, 'high');
assert.equal(ticket.assignee_id, technician.id);
assert.ok(ticket.assets.some(asset => asset.ref === ref));
const manualRef = `MONITOR-${run}`;
assert.equal((await request(`/tickets/${key}/assets`, { method: 'POST', body: { ref: manualRef } })).queued, true);
for (let i = 0; i < 100; i++) {
  ticket = await request(`/tickets/${key}`);
  if (ticket.assets.some(asset => asset.ref === manualRef)) break;
  await new Promise(resolve => setTimeout(resolve, 300));
}
assert.ok(ticket.assets.some(asset => asset.ref === manualRef), 'Manual asset links must finish processing');
ticket = await request(`/tickets/${key}`, { method: 'PATCH', body: { version: ticket.version, status: 'in_progress', first_response: true } });
assert.ok(ticket.first_response_at);
ticket = await request(`/tickets/${key}/notes`, { method: 'POST', body: { body: 'Internal smoke note: replacement cable confirmed.' } });
assert.ok(ticket.notes.some(note => note.body.includes('replacement cable')));
ticket = await request(`/tickets/${key}`, { method: 'PATCH', body: { version: ticket.version, status: 'resolved', resolution: 'Replaced the display cable and verified the external monitor.' } });
assert.equal(ticket.status, 'resolved');
assert.ok(ticket.events.some(event => event.type === 'assignment'));
const wiki = new BookStackClient({ url: process.env.SMOKE_BOOKSTACK_URL || 'http://127.0.0.1:6875',
  tokenId: process.env.BOOKSTACK_TOKEN_ID, tokenSecret: process.env.BOOKSTACK_TOKEN_SECRET });
let mirrored = false;
for (let i = 0; i < 100; i++) {
  const page = await wiki.getPage(ticket.page_id);
  assert.ok(!page.html.includes('Internal smoke note'), 'Internal notes must remain in the service desk');
  if (page.tags.some(tag => tag.name === 'Desk status' && tag.value === 'resolved')
    && page.tags.some(tag => tag.name === 'Assigned technician' && tag.value === technician.name)) { mirrored = true; break; }
  await new Promise(resolve => setTimeout(resolve, 300));
}
assert.ok(mirrored, 'BookStack tags must mirror dashboard status and assignee');
const manualAsset = await wiki.findAsset(manualRef);
assert.ok((await wiki.getPage(ticket.page_id)).html.includes(`/link/${manualAsset.id}`));
assert.ok((await wiki.getPage(manualAsset.id)).html.includes(key));
const overview = await request('/dashboard');
assert.ok(overview.stats.resolvedToday >= 1);
await request('/technicians/' + technician.id, { method: 'PATCH', body: { active: false } });
await request('/responses/' + responseTemplate.id, { method: 'PATCH', body: { active: false } });
await request('/logout', { method: 'POST', body: {} });
console.log('PASS: dashboard login, technician creation, manual intake, assignment, response templates, manual asset links, SLA response, internal notes, resolution, audit history, BookStack metadata sync, and logout.');
console.log(`Created labeled smoke ticket ${key} with asset ${ref}; the temporary technician account was deactivated.`);
