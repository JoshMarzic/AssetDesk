#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(resolve(root, '.env'));
const config = {
  tokenId: process.env.BOOKSTACK_TOKEN_ID,
  tokenSecret: process.env.BOOKSTACK_TOKEN_SECRET,
  adminPassword: process.env.BOOKSTACK_ADMIN_PASSWORD,
};
if (Object.values(config).some(value => !value || value.length < 32)) {
  console.error('Run node scripts/setup.mjs first.'); process.exit(1);
}
// Script and secrets travel on stdin; no credentials in command arguments or logs.
const php = readFileSync(resolve(root, 'scripts/bootstrap-bookstack.php'));
const copy = spawnSync('docker', ['compose', 'exec', '-T', 'bookstack', 'sh', '-c', 'umask 077; cat > /tmp/assetdesk-bootstrap.php'], { cwd: root, input: php, stdio: ['pipe', 'inherit', 'inherit'] });
if (copy.status !== 0) process.exit(copy.status ?? 1);
const result = spawnSync('docker', ['compose', 'exec', '-T', 'bookstack', 'php', '/tmp/assetdesk-bootstrap.php'], { cwd: root, input: JSON.stringify(config), stdio: ['pipe', 'inherit', 'inherit'] });
spawnSync('docker', ['compose', 'exec', '-T', 'bookstack', 'rm', '-f', '/tmp/assetdesk-bootstrap.php'], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
