import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { Worker } from '../src/worker.js';
import { parseRawEmail } from '../src/email.js';
import { createReportsRouter } from '../src/reports.js';

const password = 'Ticket AI data password 2026';
const email = ({ id = 'initial', from = 'requester@example.test', reference = '', headers = '', text = 'My workstation cannot connect.' } = {}) =>
  `From: ${from}\r\nSubject: Workstation issue\r\nMessage-ID: <${id}@example.test>\r\n${reference ? `In-Reply-To: ${reference}\r\nReferences: ${reference}\r\n` : ''}${headers}\r\n${text}`;
async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  const admin = await desk.ensureAdmin({ name: 'Data administrator', email: 'admin@example.test', password });
  t.after(() => store.close());
  return { store, desk, workspace, admin };
}

test('ticket location migrates, captures the initial manual value, and uses optimistic audited edits without duplicate intake replacement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assetdesk-ticket-location-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'desk.sqlite');
  let store = new Store(filename);
  store.saveTicket({ key: 'HD-LEGACY', requester: 'requester@example.test', subject: 'Legacy issue', page_id: 0, page_url: '' });
  let desk = new DeskStore(store);
  assert.equal(desk.getTicket('HD-LEGACY').location, '', 'Existing databases must get a usable empty location.');
  const actor = await desk.ensureAdmin({ name: 'Admin', email: 'admin@example.test', password });
  const message = await parseRawEmail(email());
  message.desk = { source: 'manual', actor, location: '  São Paulo, "East"  ' };
  desk.captureEmail('HD-LEGACY', message, { receiptId: 'manual-location', source: 'manual' });
  let ticket = desk.getTicket('HD-LEGACY');
  assert.equal(ticket.location, 'São Paulo, "East"');
  const changed = desk.updateTicket(ticket.key, { location: 'North campus' }, { actor, version: ticket.version });
  assert.equal(changed.location, 'North campus');
  assert.ok(changed.events.some(event => event.type === 'location' && event.body.includes('São Paulo, "East" → North campus')));
  assert.throws(() => desk.updateTicket(ticket.key, { location: 'Stale' }, { actor, version: ticket.version }), error => error.statusCode === 409);
  desk.captureEmail(ticket.key, { ...message, desk: { location: 'Duplicate replacement' } }, { receiptId: 'manual-location', source: 'manual' });
  assert.equal(desk.getTicket(ticket.key).location, 'North campus');
  assert.throws(() => desk.updateTicket(ticket.key, { location: 'x'.repeat(301) }, { actor, version: changed.version }), /300/);
  assert.throws(() => desk.updateTicket(ticket.key, { location: 'bad\0location' }, { actor, version: changed.version }), /Location/);
  ticket = desk.updateTicket(ticket.key, { location: null }, { actor, version: changed.version });
  assert.equal(ticket.location, '');
  ticket = desk.updateTicket(ticket.key, { location: 'Persisted location' }, { actor, version: ticket.version });
  store.recordOutboundMessage({ messageId: '<persisted-ai@assetdesk.local>', ticketKey: ticket.key, recipient: ticket.requester });
  store.close();
  store = new Store(filename); desk = new DeskStore(store);
  try {
    assert.equal(desk.getTicket(ticket.key).location, 'Persisted location');
    assert.equal(store.findThread({ from: { address: ticket.requester }, references: ['<persisted-ai@assetdesk.local>'] }).key, ticket.key);
  }
  finally { store.close(); }
});

test('requester replies to an automatic outbound Message-ID stay threaded, while unrelated senders cannot join and collisions never replace a mapping', async t => {
  const h = await fixture(t);
  const worker = new Worker({ ...h, supportEmails: ['support@example.test'], logger: { error() {} } });
  t.after(() => worker.stop());
  const first = worker.accept(await parseRawEmail(email()));
  const messageId = '<ai-ticket-first@assetdesk.local>';
  const mapping = h.store.recordOutboundMessage({ messageId, ticketKey: first.ticketKey, recipient: 'REQUESTER@example.test' });
  assert.equal(mapping.recipient, 'requester@example.test');
  assert.deepEqual(h.store.recordOutboundMessage({ messageId, ticketKey: first.ticketKey, recipient: 'requester@example.test' }), mapping);
  const reply = worker.accept(await parseRawEmail(email({ id: 'requester-reply', reference: messageId, text: 'The error code is 403.' })));
  assert.equal(reply.ticketKey, first.ticketKey);
  assert.equal(h.desk.getTicket(first.ticketKey).notes[0].body, 'The error code is 403.');
  const support = worker.accept(await parseRawEmail(email({ id: 'support-reply', from: 'support@example.test', reference: messageId, text: 'Investigating access.' })));
  assert.equal(support.ticketKey, first.ticketKey);
  const stranger = worker.accept(await parseRawEmail(email({ id: 'stranger-reply', from: 'stranger@example.test', reference: messageId, text: 'A separate issue.' })));
  assert.notEqual(stranger.ticketKey, first.ticketKey);
  assert.throws(() => h.store.recordOutboundMessage({ messageId: '<wrong-recipient@assetdesk.local>', ticketKey: first.ticketKey, recipient: 'elsewhere@example.test' }), /original requester/);
  assert.throws(() => h.store.recordOutboundMessage({ messageId, ticketKey: stranger.ticketKey, recipient: 'stranger@example.test' }), error => error.statusCode === 409);
  assert.throws(() => h.store.recordOutboundMessage({ messageId: '<bad@example.test>\r\nBcc:bad@example.test', ticketKey: first.ticketKey, recipient: 'requester@example.test' }), /valid/);
  assert.throws(() => h.store.recordOutboundMessage({ messageId: '<unknown@assetdesk.local>', ticketKey: 'HD-MISSING', recipient: 'requester@example.test' }), error => error.statusCode === 404);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM ticket_outbound_messages').get().count, 1);
  assert.equal(h.store.findThread({ from: { address: 'requester@example.test' }, references: [messageId] }).key, first.ticketKey);
  assert.equal(h.store.findThread({ from: { address: 'other@example.test' }, references: [messageId] }), null);
});

test('email parsing allows human replies but suppresses automated, list, bulk, and daemon response loops', async () => {
  for (const headers of ['', 'Auto-Submitted: no\r\n', 'Precedence: normal\r\n', 'X-Auto-Response-Suppress: None\r\n']) {
    assert.equal((await parseRawEmail(email({ headers }))).autoReplyAllowed, true, headers);
  }
  for (const headers of ['Auto-Submitted: auto-generated\r\n', 'Auto-Submitted: auto-replied\r\n', 'Auto-Submitted: auto-generated\r\nAuto-Submitted: no\r\n', 'Precedence: bulk\r\n', 'Precedence: list\r\n', 'Precedence: junk\r\n', 'X-Auto-Response-Suppress: All\r\n', 'X-Auto-Response-Suppress: All\r\nX-Auto-Response-Suppress: None\r\n', 'X-Auto-Response-Suppress: OOF, AutoReply\r\n', 'List-Id: newsletter.example.test\r\n', 'List-Unsubscribe: <https://example.test/unsubscribe>\r\n', 'Return-Path: <>\r\n']) {
    const parsed = await parseRawEmail(email({ headers }));
    assert.equal(parsed.autoReplyAllowed, false, headers);
    assert.equal(parsed.text, 'My workstation cannot connect.', 'Loop metadata must not discard the original support request.');
  }
  for (const from of ['mailer-daemon@example.test', 'postmaster@example.test', 'no-reply@example.test', 'noreply-alerts@example.test', 'do.not.reply@example.test']) {
    assert.equal((await parseRawEmail(email({ from }))).autoReplyAllowed, false, from);
  }
});

test('Reports searches ticket locations and exports the Location column with CSV formula protection', async t => {
  const h = await fixture(t);
  for (const [key, location] of [['HD-PERCENT', 'North 100% campus'], ['HD-OTHER', 'North 100X campus'], ['HD-FORMULA', '=HQ()']]) {
    h.store.saveTicket({ key, requester: 'requester@example.test', subject: 'Issue', page_id: 0, page_url: '' });
    const ticket = h.desk.getTicket(key);
    h.desk.updateTicket(key, { location }, { actor: h.admin, version: ticket.version });
  }
  const app = express(); app.use((req, _res, next) => { req.deskSession = { user: h.admin }; next(); }); app.use('/reports', createReportsRouter({ desk: h.desk, workspace: h.workspace }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const filtered = await (await fetch(origin + '/reports/tickets?' + new URLSearchParams({ location: '100%' }))).json();
  assert.equal(filtered.total, 1); assert.equal(filtered.tickets[0].key, 'HD-PERCENT');
  const searched = await (await fetch(origin + '/reports/tickets?' + new URLSearchParams({ search: '100% campus' }))).json();
  assert.equal(searched.total, 1); assert.equal(searched.tickets[0].location, 'North 100% campus');
  const csv = await (await fetch(origin + '/reports/tickets.csv?' + new URLSearchParams({ ticket_key: 'HD-FORMULA' }))).text();
  const rows = csv.trim().replace(/^\uFEFF/, '').split('\r\n').map(row => row.match(/"(?:[^"]|"")*"/g).map(cell => cell.slice(1, -1).replaceAll('""', '"')));
  assert.equal(rows[0].filter(name => name === 'Location').length, 1);
  assert.equal(rows[1][rows[0].indexOf('Location')], "'=HQ()");
});
