import { Store } from './store.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { DeskStore } from './desk-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { ActionsStore } from './actions-store.js';
import { ActionsRunner } from './actions-runner.js';
import { ActionTransports } from './action-transports.js';
import { WorkflowsStore } from './workflows-store.js';

const config = configFromEnv();
const store = new Store(config.databasePath);
const desk = new DeskStore(store);
const workspace = new WorkspaceStore(desk);
if (config.dashboardAdminPassword) {
  await desk.ensureAdmin({ email: config.dashboardAdminEmail, name: 'Desk administrator', password: config.dashboardAdminPassword });
}
const worker = new Worker({ store, desk, workspace, supportEmails: config.supportEmails });
const actions = new ActionsStore(desk);
const workflows = new WorkflowsStore(actions);
const actionTransports = new ActionTransports(config.actions);
const actionRunner = new ActionsRunner({ actions, transports: actionTransports });
const app = createApp({ store, worker, workspace, config, desk, actions, actionTransports, actionRunner, workflows });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`AssetDesk service desk listening on port ${config.port}`);
  worker.start();
  actionRunner.start();
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await worker.stop();
  await actionRunner.stop();
  store.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
