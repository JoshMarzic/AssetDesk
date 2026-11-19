import { Store } from './store.js';
import { Worker } from './worker.js';
import { BookStackClient } from './bookstack.js';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { DeskStore } from './desk-store.js';

const config = configFromEnv();
const store = new Store(config.databasePath);
const desk = new DeskStore(store);
if (config.dashboardAdminPassword) {
  await desk.ensureAdmin({ email: config.dashboardAdminEmail, name: 'Desk administrator', password: config.dashboardAdminPassword });
}
const bookstack = new BookStackClient(config.bookstack);
const worker = new Worker({ store, bookstack, desk, supportEmails: config.supportEmails });
const app = createApp({ store, worker, bookstack, config, desk });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`AssetDesk service desk listening on port ${config.port}`);
  worker.start();
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await worker.stop();
  store.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
