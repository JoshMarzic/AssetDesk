import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAssetRefs, parseRawEmail } from '../src/email.js';

const mail = (headers = '', body = 'My LAPTOP-123 does not start.') =>
  `From: Alice Example <ALICE@example.com>\r\nSubject: Cannot log in\r\n${headers}\r\n${body}`;

test('detects and normalizes asset tags in order, without duplicate references', () => {
  assert.deepEqual(extractAssetRefs('laptop-123 and PC-999; LAPTOP-123 [asset: custom_serial] Asset: ABC.'),
    ['LAPTOP-123', 'PC-999', 'CUSTOM_SERIAL', 'ABC']);
});

test('does not treat ordinary hyphenated words, emails, URLs or partial tags as inventory', () => {
  assert.deepEqual(extractAssetRefs('SERVER-ROOM help@PC-123.example.com https://help.example/ASSET-99 www.PC-432.com XPC-12 /PC-13'), []);
});

test('supports explicit serial numbers and configurable automatic prefixes', () => {
  assert.deepEqual(extractAssetRefs('Asset tag: serial-ABC [asset: sn123] IT-004 PC-123', { prefixes: ['IT'] }),
    ['SERIAL-ABC', 'SN123', 'IT-004']);
});

test('limits asset references to 25 distinct IDs and refuses oversized IDs', () => {
  assert.equal(extractAssetRefs(Array.from({ length: 50 }, (_, i) => `PC-${i}`).join(' ')).length, 25);
  assert.deepEqual(extractAssetRefs(`ASSET-${'1'.repeat(70)}`), []);
});

test('parses text MIME, identity and message threading', async () => {
  const result = await parseRawEmail(mail('Message-ID: <one@example.com>\r\nIn-Reply-To: <old@example.com>\r\nReferences: <older@example.com> <old@example.com>\r\n'));
  assert.equal(result.messageId, '<one@example.com>');
  assert.equal(result.inReplyTo, '<old@example.com>');
  assert.deepEqual(result.references, ['<older@example.com>', '<old@example.com>']);
  assert.deepEqual(result.from, { name: 'Alice Example', address: 'alice@example.com' });
  assert.equal(result.text, 'My LAPTOP-123 does not start.');
  assert.deepEqual(result.assetRefs, ['LAPTOP-123']);
  assert.ok(Number.isFinite(Date.parse(result.receivedAt)));
});

test('uses deterministic content identity when a Message-ID is absent', async () => {
  const first = await parseRawEmail(mail());
  const second = await parseRawEmail(Buffer.from(mail()));
  assert.match(first.messageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.messageId, second.messageId);
});

test('parses encoded headers and quoted printable content', async () => {
  const raw = 'From: =?UTF-8?Q?Alice_=C3=89?= <alice@example.com>\r\nSubject: =?UTF-8?Q?Broken_PC-123?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nIt won=E2=80=99t boot.';
  const result = await parseRawEmail(raw);
  assert.equal(result.from.name, 'Alice É');
  assert.equal(result.subject, 'Broken PC-123');
  assert.equal(result.text, 'It won’t boot.');
  assert.deepEqual(result.assetRefs, ['PC-123']);
});

test('prefers the plain part of a multipart message and never returns HTML', async () => {
  const raw = mail('Content-Type: multipart/alternative; boundary=boundary\r\n',
    '--boundary\r\nContent-Type: text/plain\r\n\r\nPC-123 is broken.\r\n--boundary\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script><p>PC-999</p>\r\n--boundary--');
  const result = await parseRawEmail(raw);
  assert.equal(result.text, 'PC-123 is broken.');
  assert.deepEqual(result.assetRefs, ['PC-123']);
  assert.equal(result.html, undefined);
});

test('converts an HTML-only email to plain text', async () => {
  const result = await parseRawEmail(mail('Content-Type: text/html\r\n', '<p>Help with <b>ASSET-12</b></p><script>alert(1)</script>'));
  assert.match(result.text, /Help with ASSET-12/);
  assert.doesNotMatch(result.text, /<p>|<script>|alert\(1\)/);
  assert.deepEqual(result.assetRefs, ['ASSET-12']);
});

test('rejects missing/invalid/ambiguous sender identities and empty bodies', async () => {
  for (const raw of ['Subject: Hi\r\n\r\nHelp', 'From: nope\r\n\r\nHelp', 'From: a@example.com, b@example.com\r\n\r\nHelp', 'From: a@example.com\r\nFrom: b@example.com\r\n\r\nHelp', mail('', '  ')]) {
    await assert.rejects(parseRawEmail(raw), error => error.statusCode === 400);
  }
});

test('enforces raw and decoded body limits', async () => {
  await assert.rejects(parseRawEmail(mail(), { maxBytes: 10 }), error => error.statusCode === 413);
  await assert.rejects(parseRawEmail(mail('', 'a'.repeat(100_001))), error => error.statusCode === 413);
});

test('sender addresses are parsed metadata, not authenticated identities', async () => {
  const result = await parseRawEmail('From: CEO <ceo@example.com>\r\n\r\nPlease fix PC-123.');
  assert.equal(result.from.address, 'ceo@example.com');
  assert.equal(result.authenticated, undefined);
});
