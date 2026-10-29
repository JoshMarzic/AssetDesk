import { Store } from './store.js';
import { Worker } from './worker.js';
import { BookStackClient } from './bookstack.js';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();
const store = new Store(config.databasePath);
const bookstack = new BookStackClient(config.bookstack);
const worker = new Worker({ store, bookstack, supportEmails: config.supportEmails });
const app = createApp({ store, worker, bookstack, config });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`AssetDesk intake listening on port ${config.port}`);
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
