#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, '.env');
let contents = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(resolve(root, '.env.example'), 'utf8');
const values = {
  BOOKSTACK_APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
  DB_PASSWORD: randomBytes(24).toString('hex'),
  DB_ROOT_PASSWORD: randomBytes(24).toString('hex'),
  BOOKSTACK_TOKEN_ID: randomBytes(20).toString('hex'),
  BOOKSTACK_TOKEN_SECRET: randomBytes(20).toString('hex'),
  BOOKSTACK_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  INBOUND_EMAIL_TOKEN: randomBytes(32).toString('hex'),
  ADMIN_TOKEN: randomBytes(32).toString('hex'),
};
for (const [name, value] of Object.entries(values)) {
  const line = new RegExp(`^${name}=(.*)$`, 'm');
  const current = contents.match(line);
  if (!current) contents += `\n${name}=${value}\n`;
  else if (!current[1].trim() || current[1].trim() === '""' || current[1].trim() === "''") contents = contents.replace(line, `${name}=${value}`);
}
writeFileSync(path, contents, { mode: 0o600 });
chmodSync(path, 0o600);
console.log('Local .env prepared (mode 0600). Existing nonempty values preserved. No credentials printed.');
