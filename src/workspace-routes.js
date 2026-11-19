import express from 'express';
import { bodyFields, listFilters, recordId, workspaceError, workspaceErrorHandler } from './knowledge.js';

const ASSET_FIELDS = ['ref','name','type','category_id','owner_id','owner_name','email','department','location','serial_number','manufacturer','model','status','description'];

export function createAssetsRouter({ workspace }) {
  const router = express.Router();
  const user = req => req.deskSession.user;
  router.get('/', (req, res) => res.json(workspace.listAssets(user(req), listFilters(req.query, ['type']))));
  router.post('/', (req, res) => {
    bodyFields(req.body, ASSET_FIELDS);
    res.status(201).json(workspace.createAsset(req.body, user(req)));
  });
  router.get('/:id', (req, res) => res.json(workspace.getAsset(recordId(req.params.id), user(req))));
  router.patch('/:id', (req, res) => {
    const body = bodyFields(req.body, [...ASSET_FIELDS, 'version']);
    if (!Number.isSafeInteger(body.version) || body.version < 1) throw workspaceError('The current asset version is required. Reload and try again.');
    const {version, ...patch} = body;
    res.json(workspace.updateAsset(recordId(req.params.id), patch, user(req), {version}));
  });
  router.use(workspaceErrorHandler);
  return router;
}
