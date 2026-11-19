#!/usr/bin/env node
// Explicit legacy migration only. The AssetDesk server never loads BookStack.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { BookStackClient } from '../migration/legacy-bookstack.js';
import { importLegacyWorkspace } from '../migration/importer.js';

function option(args, name) { const index=args.indexOf(name); return index<0?undefined:args[index+1]; }
function credentials(env) {
  for(const name of ['BOOKSTACK_URL','BOOKSTACK_TOKEN_ID','BOOKSTACK_TOKEN_SECRET']) if(!env[name]) throw new Error(`Legacy import requires ${name}; use the original private .env.`);
  return {url:env.BOOKSTACK_URL,publicUrl:env.BOOKSTACK_PUBLIC_URL||env.BOOKSTACK_URL,tokenId:env.BOOKSTACK_TOKEN_ID,tokenSecret:env.BOOKSTACK_TOKEN_SECRET,
    knowledgeBookId:env.BOOKSTACK_KNOWLEDGE_BOOK_ID ? Number(env.BOOKSTACK_KNOWLEDGE_BOOK_ID):undefined};
}
export async function runImport(args=process.argv.slice(2)) {
  try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(args.includes('--container')) {
    const config=credentials(process.env);
    const stop=spawnSync('docker',['compose','stop','assetdesk'],{stdio:'inherit'});
    if(stop.status!==0)throw new Error('Could not stop AssetDesk before importing.');
    let code=1;
    try {
      const result=spawnSync('docker',['compose','run','--rm','--no-deps','-T','--entrypoint','node','assetdesk','scripts/import-bookstack.mjs','--database','/data/assetdesk.sqlite','--credentials-stdin'],
        {input:JSON.stringify(config),stdio:['pipe','inherit','inherit']});
      code=result.status??1;
    }finally{
      const restart=spawnSync('docker',['compose','up','-d','--wait','assetdesk'],{stdio:'inherit'});
      if(restart.status!==0)code=1;
    }
    if(code!==0)throw new Error('Import did not complete. Existing legacy volumes were retained; correct the prerequisite and rerun.');
    return;
  }
  let config;
  if(args.includes('--credentials-stdin')) {
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>16384)throw new Error('Invalid import configuration.');}
    try { config=JSON.parse(input); } catch { throw new Error('Invalid legacy import configuration.'); }
  }else config=credentials(process.env);
  const filename=resolve(option(args,'--database')||process.env.DATABASE_PATH||'./data/assetdesk.sqlite');
  if(!existsSync(filename))throw new Error('Start native AssetDesk once before importing so its database and administrator exist.');
  // SQLite creates a consistent backup including committed WAL data. No original
  // database/legacy volume is removed, and secrets never enter this backup path.
  const backup=`${filename}.pre-native-import-${Date.now()}.sqlite`;
  const db=new DatabaseSync(filename);
  try{db.prepare('VACUUM INTO ?').run(backup);}finally{db.close();}
  console.log('Created a consistent pre-import SQLite backup beside the database.');
  const store=new Store(filename);
  try{
    const desk=new DeskStore(store),workspace=new WorkspaceStore(desk);
    const user=desk.listTechnicians().find(user=>user.role==='admin'&&user.active);
    if(!user)throw new Error('An active AssetDesk administrator is required before import.');
    const legacy=new BookStackClient(config);
    const counts=await importLegacyWorkspace({legacy,workspace,user,knowledgeBookId:config.knowledgeBookId,
      onProgress:message=>console.log(message)});
    console.log(JSON.stringify({status:'completed',...counts},null,2));
    console.log('Imported categories are administrator-only. Review content and grant category access in AssetDesk before sharing.');
    if(counts.imagesUnavailable||counts.unresolvedLinks)console.log('Some legacy images or links could not be imported. Keep legacy volumes/backups until you have reviewed them.');
  }finally{store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){runImport().catch(error=>{console.error(error.safeMessage||error.message||'Legacy import failed.');process.exitCode=1;});}
