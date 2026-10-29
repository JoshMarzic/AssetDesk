#!/usr/bin/env node
// This intentionally creates labeled example tickets/assets in the running stack.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BookStackClient } from '../src/bookstack.js';
try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const origin = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3000';
const bookstack = new BookStackClient({
  url: process.env.SMOKE_BOOKSTACK_URL || 'http://127.0.0.1:6875',
  publicUrl: process.env.BOOKSTACK_PUBLIC_URL || 'http://localhost:6875',
  tokenId: process.env.BOOKSTACK_TOKEN_ID, tokenSecret: process.env.BOOKSTACK_TOKEN_SECRET,
});
const run = Date.now();
const laptopRef = `LAPTOP-${run}`;
const existingRef = `PC-${run}`;
const printerRef = `PRINTER-${run}`;
const firstId = `<smoke-${run}@assetdesk.example>`;
const workspace = await bookstack.ensureWorkspace();
await bookstack.checkHealth();
assert.equal((await fetch(`${origin}/readyz`)).status, 200);
const existing = await bookstack.createPage({ book_id: workspace.assetBook.id,
  name: `Smoke test existing workstation ${run}`, html: '<h2>Ownership</h2><p>Owner: Ada Example</p>',
  tags: [{ name: 'Asset ID', value: existingRef }],
});
const raw = (id, body, reply = '') => `From: Smoke Test <smoke@assetdesk.example>\r\nTo: help@assetdesk.example\r\nSubject: [Smoke test] Equipment issue\r\nMessage-ID: ${id}\r\n${reply ? `In-Reply-To: ${reply}\r\nReferences: ${reply}\r\n` : ''}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
async function send(message) {
  const result = await fetch(`${origin}/api/inbound/email`, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.INBOUND_EMAIL_TOKEN}`, 'Content-Type': 'message/rfc822' }, body: message,
  });
  assert.ok([200, 202].includes(result.status), `Intake HTTP ${result.status}`);
  return result.json();
}
async function complete(id) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${origin}/api/receipts/${id}`, { headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.notEqual(receipt.state, 'failed', receipt.error || 'Processing failed');
    if (receipt.state === 'done') return receipt;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Timed out waiting for ticket processing.');
}
const email = raw(firstId, `${laptopRef} will not start. <script>alert('untrusted')</script>`);
const first = await complete((await send(email)).id);
const laptop = await bookstack.findAsset(laptopRef);
assert.ok(laptop?.id);
assert.ok((await bookstack.getPage(first.ticket.page_id)).html.includes(bookstack.pageUrl(laptop.id)));
assert.ok(!(await bookstack.getPage(first.ticket.page_id)).html.includes('<script>'));
const duplicate = await send(email);
assert.equal(duplicate.duplicate, true);
assert.equal((await complete(duplicate.id)).ticketKey, first.ticketKey);
await bookstack.updatePage(laptop.id, { html: `${laptop.raw_html || laptop.html}<p>Owner: Grace Example</p>` });
const second = await complete((await send(raw(`<second-${run}@assetdesk.example>`, `${laptopRef} and ${existingRef} need attention.`))).id);
assert.notEqual(second.ticketKey, first.ticketKey);
assert.equal((await bookstack.findAsset(existingRef)).id, existing.id);
assert.ok((await bookstack.getPage(existing.id)).html.includes('Owner: Ada Example'));
const updatedLaptop = await bookstack.getPage(laptop.id);
assert.ok(updatedLaptop.html.includes('Owner: Grace Example'));
for (const key of [first.ticketKey, second.ticketKey]) assert.ok(updatedLaptop.html.includes(key));
const replyEmail = raw(`<reply-${run}@assetdesk.example>`, `Update: ${printerRef} is also affected.`, firstId);
const reply = await complete((await send(replyEmail)).id);
assert.equal(reply.ticketKey, first.ticketKey);
const printer = await bookstack.findAsset(printerRef);
assert.ok((await bookstack.getPage(first.ticket.page_id)).html.includes(bookstack.pageUrl(printer.id)));
assert.ok((await bookstack.getPage(printer.id)).html.includes(first.ticketKey));
const pipeResult = spawnSync(process.execPath, ['scripts/forward-email.mjs'], {
  input: replyEmail, env: { ...process.env, ASSETDESK_INBOUND_URL: `${origin}/api/inbound/email` }, encoding: 'utf8',
});
assert.equal(pipeResult.status, 0, pipeResult.stderr);
const ticketPage = await bookstack.getPage(first.ticket.page_id);
assert.equal((ticketPage.html.match(/Email update/g) || []).length, 1);
// Native BookStack moves require deletion permission. Intake deliberately lacks it.
if (process.env.SMOKE_OPERATOR_TOKEN_ID && process.env.SMOKE_OPERATOR_TOKEN_SECRET) {
  const operator = new BookStackClient({ url: bookstack.url,
    tokenId: process.env.SMOKE_OPERATOR_TOKEN_ID, tokenSecret: process.env.SMOKE_OPERATOR_TOKEN_SECRET });
  await operator.updatePage(second.ticket.page_id, { chapter_id: workspace.chapters.Resolved.id });
  assert.equal((await bookstack.getPage(second.ticket.page_id)).chapter_id, workspace.chapters.Resolved.id);
  console.log('PASS: operator moved a native ticket into the Resolved chapter.');
}
const login = await fetch(`${process.env.SMOKE_BOOKSTACK_URL || 'http://127.0.0.1:6875'}/login`);
assert.equal(login.status, 200);
assert.match(await login.text(), /<form[^>]+action="[^\"]*login"/);
console.log('PASS: native BookStack workspace/UI, email intake, new/existing assets, duplicate delivery, preserved ownership, threaded replies, safe rendering, and MTA pipe.');
console.log(`Created labeled smoke-test records: ${first.ticketKey}, ${second.ticketKey}; ${laptopRef}, ${existingRef}, ${printerRef}.`);
