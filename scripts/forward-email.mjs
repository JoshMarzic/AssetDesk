#!/usr/bin/env node
// Run with node --env-file=/secure/path/assetdesk.env scripts/forward-email.mjs
// MTA retries on exit 75; do not acknowledge mail until the durable queue accepts it.
const url = process.env.ASSETDESK_INBOUND_URL ?? 'http://127.0.0.1:3000/api/inbound/email';
const token = process.env.INBOUND_EMAIL_TOKEN;
if (!token) { console.error('INBOUND_EMAIL_TOKEN is required.'); process.exit(78); }
try {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 10 * 1024 * 1024) {
      const error = new Error('Message exceeds 10 MiB intake limit');
      error.exitCode = 65;
      throw error;
    }
    chunks.push(chunk);
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'message/rfc822' },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const error = new Error(`Intake returned HTTP ${response.status}`);
    if ([400, 413, 415].includes(response.status)) error.exitCode = 65;
    throw error;
  }
  console.log('Message accepted by AssetDesk.');
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 75;
}
