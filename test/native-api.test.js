import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore, ASSETS_CATEGORY_ID, GENERAL_CATEGORY_ID } from '../src/workspace-store.js';
import { createDeskRouter } from '../src/desk-routes.js';
import { cleanKnowledgeHtml } from '../src/knowledge.js';

const PASSWORD = 'Native-api-test-password-2026';
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
async function harness(t) {
  const store = new Store(':memory:');
  const desk = new DeskStore(store);
  const admin = await desk.ensureAdmin({name:'Administrator',email:'admin@example.test',password:PASSWORD});
  const reader = await desk.createTechnician({name:'Reader',email:'reader@example.test',password:PASSWORD});
  const editor = await desk.createTechnician({name:'Editor',email:'editor@example.test',password:PASSWORD});
  const outsider = await desk.createTechnician({name:'Other technician',email:'other@example.test',password:PASSWORD});
  const workspace = new WorkspaceStore(desk);
  const app = express();
  const worker = {accept: message => store.accept(message),wake(){}};
  app.use('/api/desk', createDeskRouter({desk,store,worker,workspace,config:{cookieSecure:false}}));
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const origin = `http://127.0.0.1:${server.address().port}/api/desk`;
  async function request(path,{method='GET',body,session,csrf=true}={}) {
    const response = await fetch(origin+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},body:body!==undefined?JSON.stringify(body):undefined});
    const value = response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
    return {status:response.status,body:value,headers:response.headers};
  }
  async function login(user=admin) {
    const response=await request('/login',{method:'POST',body:{email:user.email,password:PASSWORD}});assert.equal(response.status,200);
    return {cookie:response.headers.get('set-cookie').split(';')[0],csrfToken:response.body.csrfToken};
  }
  return {store,desk,workspace,admin,reader,editor,outsider,request,login};
}
async function category(h,session,fields={}) {
  const response=await h.request('/knowledge/categories',{method:'POST',session,body:{name:'Confidential knowledge',visibility:'restricted',reader_ids:[h.reader.id],editor_ids:[h.editor.id],allow_staff_edit:false,...fields}});
  assert.equal(response.status,201,JSON.stringify(response.body));return response.body;
}
async function article(h,session,category_id,name='Confidential procedures') {
  const response=await h.request('/knowledge/articles',{method:'POST',session,body:{name,category_id,html:'<h2>Protected content</h2><p>Secret category information.</p>'}});
  assert.equal(response.status,201,JSON.stringify(response.body));return response.body;
}

test('native categories and articles require the existing session and reject missing CSRF',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/knowledge')).status,401);
  assert.equal((await h.request('/assets')).status,401);
  const session=await h.login();
  assert.equal((await h.request('/knowledge/categories',{method:'POST',session,csrf:false,body:{name:'Unauthorized CSRF'}})).status,403);
  assert.equal((await h.request('/assets',{method:'POST',session,csrf:false,body:{ref:'PC-123',name:'Desktop'}})).status,403);
  const index=await h.request('/knowledge',{session});assert.equal(index.status,200);
  assert.ok(index.body.categories.some(category=>category.id===ASSETS_CATEGORY_ID));
  assert.ok(index.body.categories.some(category=>category.id===GENERAL_CATEGORY_ID));
});

test('category ACL hides names, article content, counts, search results and direct routes from unrelated staff',async t=>{
  const h=await harness(t),admin=await h.login(),other=await h.login(h.outsider),reader=await h.login(h.reader);
  const restricted=await category(h,admin),page=await article(h,admin,restricted.id);
  const visible=await h.request('/knowledge',{session:reader});assert.ok(visible.body.categories.some(row=>row.id===restricted.id));assert.equal(visible.body.total,1);
  const hidden=await h.request('/knowledge?search=Secret',{session:other});assert.equal(hidden.status,200);assert.equal(hidden.body.total,0);assert.equal(hidden.body.articles.length,0);
  assert.ok(!hidden.body.categories.some(row=>row.id===restricted.id));assert.ok(!JSON.stringify(hidden.body).includes('Confidential'));
  assert.equal((await h.request('/knowledge/articles/'+page.id,{session:other})).status,404);
  assert.equal((await h.request('/knowledge?category_id='+restricted.id,{session:other})).status,404);
  assert.equal((await h.request('/knowledge/categories/'+restricted.id,{method:'PATCH',session:other,body:{version:restricted.version,visibility:'all'}})).status,403);
  const result=await h.request('/knowledge/articles/'+page.id,{session:reader});assert.equal(result.status,200);assert.equal(result.body.canEdit,false);
});

test('readers cannot write, selected editors can save, stale versions conflict, and moving requires both category permissions',async t=>{
  const h=await harness(t),admin=await h.login(),reader=await h.login(h.reader),editor=await h.login(h.editor);
  const restricted=await category(h,admin),page=await article(h,admin,restricted.id);
  const change={name:'Updated protected guide',html:'<p>Updated safely.</p>',category_id:restricted.id,version:page.version};
  assert.equal((await h.request('/knowledge/articles/'+page.id,{method:'PATCH',session:reader,body:change})).status,403);
  const changed=await h.request('/knowledge/articles/'+page.id,{method:'PATCH',session:editor,body:change});assert.equal(changed.status,200);
  assert.equal((await h.request('/knowledge/articles/'+page.id,{method:'PATCH',session:editor,body:change})).status,409);
  const target=await category(h,admin,{name:'Read only destination',reader_ids:[h.editor.id],editor_ids:[]});
  assert.equal((await h.request('/knowledge/articles/'+page.id,{method:'PATCH',session:editor,body:{...change,version:changed.body.version,category_id:target.id}})).status,403);
  assert.equal((await h.request('/knowledge/articles',{method:'POST',session:reader,body:{name:'Attempt',html:'<p>No write access.</p>',category_id:restricted.id}})).status,403);
});

test('administrators can change category visibility and account grants with optimistic versions',async t=>{
  const h=await harness(t),admin=await h.login(),reader=await h.login(h.reader);
  const restricted=await category(h,admin),page=await article(h,admin,restricted.id);
  const updated=await h.request('/knowledge/categories/'+restricted.id,{method:'PATCH',session:admin,body:{version:restricted.version,reader_ids:[],editor_ids:[]}});assert.equal(updated.status,200);
  assert.equal((await h.request('/knowledge/articles/'+page.id,{session:reader})).status,404);
  assert.equal((await h.request('/knowledge/categories/'+restricted.id,{method:'PATCH',session:admin,body:{version:restricted.version,visibility:'all'}})).status,409);
  assert.equal((await h.request('/knowledge/categories/'+restricted.id,{method:'PATCH',session:admin,body:{version:updated.body.version,reader_ids:['does-not-exist']}})).status,400);
  assert.equal((await h.request('/knowledge/articles/'+page.id,{session:admin})).status,200);
});

test('native personnel and PC records keep ownership and show linked tickets under their asset',async t=>{
  const h=await harness(t),admin=await h.login();
  const person=await h.request('/assets',{method:'POST',session:admin,body:{ref:'EMPLOYEE-123',name:'Taylor Person',type:'personnel',email:'taylor@example.test',department:'Support',status:'active'}});assert.equal(person.status,201);
  const pc=await h.request('/assets',{method:'POST',session:admin,body:{ref:'PC-ABC',name:'Taylor workstation',type:'pc',owner_id:person.body.id,serial_number:'SERIAL-ABC',model:'Workstation',location:'Floor 2',status:'active'}});assert.equal(pc.status,201);assert.equal(pc.body.owner.name,'Taylor Person');
  h.store.saveTicket({key:'HD-123',requester:'taylor@example.test',subject:'Screen issue',page_id:0,page_url:''});
  h.workspace.linkTicket('HD-123',pc.body.id,h.admin);h.workspace.linkTicket('HD-123',pc.body.id,h.admin);
  const detail=await h.request('/assets/'+pc.body.id,{session:admin});assert.equal(detail.status,200);assert.equal(detail.body.linked_tickets.length,1);assert.equal(detail.body.linked_tickets[0].key,'HD-123');
  const personnel=await h.request('/assets?type=personnel',{session:admin});assert.equal(personnel.body.total,1);assert.equal(personnel.body.assets[0].id,person.body.id);
  const area=await h.request('/knowledge?category_id='+ASSETS_CATEGORY_ID,{session:admin});assert.equal(area.status,200);assert.equal(area.body.asset_total,2);assert.ok(area.body.assets.some(asset=>asset.ref==='PC-ABC'));
  const edit=await h.request('/assets/'+pc.body.id,{method:'PATCH',session:admin,body:{version:pc.body.version,location:'Floor 3'}});assert.equal(edit.status,200);assert.equal(edit.body.location,'Floor 3');
  assert.equal((await h.request('/assets/'+pc.body.id,{method:'PATCH',session:admin,body:{version:pc.body.version,location:'Stale edit'}})).status,409);
});

test('asset categories protect inventory detail, owner names and knowledge area results',async t=>{
  const h=await harness(t),admin=await h.login(),other=await h.login(h.outsider),reader=await h.login(h.reader);
  const restricted=await category(h,admin,{name:'Protected personnel',kind:'assets'});
  const person=await h.request('/assets',{method:'POST',session:admin,body:{ref:'PERSONNEL-SECRET',name:'Private employee',type:'personnel',category_id:restricted.id,status:'active'}});assert.equal(person.status,201);
  const publicPc=await h.request('/assets',{method:'POST',session:admin,body:{ref:'PC-OPEN',name:'Public PC',type:'pc',owner_id:person.body.id}});assert.equal(publicPc.status,201);
  const assets=await h.request('/assets?search=Private',{session:other});assert.equal(assets.body.total,0);
  assert.equal((await h.request('/assets/'+person.body.id,{session:other})).status,404);
  assert.equal((await h.request('/assets?category_id='+restricted.id,{session:other})).status,404);
  assert.equal((await h.request('/knowledge?category_id='+restricted.id,{session:other})).status,404);
  const visiblePc=await h.request('/assets/'+publicPc.body.id,{session:other});assert.equal(visiblePc.body.owner,null);assert.equal(visiblePc.body.owner_id,null);assert.equal(visiblePc.body.owner_name,'');
  const restrictedList=await h.request('/assets?category_id='+restricted.id,{session:reader});assert.equal(restrictedList.body.total,1);assert.equal(restrictedList.body.assets[0].canEdit,false);
});

test('native article HTML strips active content and allows only local knowledge/asset media references',async t=>{
  const h=await harness(t),admin=await h.login();
  const created=await h.request('/knowledge/articles',{method:'POST',session:admin,body:{name:'Safe formatting',html:'<h2 id="global-search">Steps</h2><table><tr><td>Safe</td></tr></table><script>steal()</script><iframe src="https://example.test"></iframe><a href="javascript:steal()">Bad</a><img src="https://outside.example/private.png"><a href="#assets/asset-123">Asset</a>'}});
  assert.equal(created.status,201);assert.ok(created.body.html.includes('<table>'));assert.ok(created.body.html.includes('#assets/asset-123'));
  assert.doesNotMatch(created.body.html,/<script|<iframe|javascript:|outside\.example|id="global-search"/);assert.ok(created.body.html.includes(`id="doc-${created.body.id}-global-search"`));
  assert.equal((await h.request('/knowledge/articles',{method:'POST',session:admin,body:{name:'Empty active content',html:'<script>steal()</script>'}})).status,400);
  const cleaned=cleanKnowledgeHtml('<form><input name="app"></form><a href="//evil.example">No protocol relative</a><p style="position:fixed" onclick="steal()">Text</p>');
  assert.doesNotMatch(cleaned,/<form|<input|onclick|style=|evil\.example/);
});

test('native image access follows current category permissions and media cannot be copied into another article',async t=>{
  const h=await harness(t),admin=await h.login(),other=await h.login(h.outsider),reader=await h.login(h.reader);
  const page=await article(h,admin,GENERAL_CATEGORY_ID,'Public image guide');
  const image=await h.request('/knowledge/articles/'+page.id+'/images',{method:'POST',session:admin,body:{filename:'pixel.png',mime:'image/png',data:PNG.toString('base64')}});assert.equal(image.status,201);
  const saved=await h.request('/knowledge/articles/'+page.id,{method:'PATCH',session:admin,body:{name:page.name,html:`<p>Guide image.</p><img src="${image.body.url}">`,category_id:GENERAL_CATEGORY_ID,version:page.version}});assert.equal(saved.status,200);
  const publicImage=await h.request('/knowledge/media/'+image.body.id,{session:other});assert.equal(publicImage.status,200);assert.deepEqual(publicImage.body,PNG);assert.equal(publicImage.headers.get('cache-control'),'no-store');
  const restricted=await category(h,admin);
  const moved=await h.request('/knowledge/articles/'+page.id,{method:'PATCH',session:admin,body:{name:page.name,html:saved.body.html,category_id:restricted.id,version:saved.body.version}});assert.equal(moved.status,200);
  assert.equal((await h.request('/knowledge/media/'+image.body.id,{session:other})).status,404);assert.equal((await h.request('/knowledge/media/'+image.body.id,{session:reader})).status,200);
  const destination=await article(h,admin,GENERAL_CATEGORY_ID,'Copy target');
  assert.equal((await h.request('/knowledge/articles/'+destination.id,{method:'PATCH',session:admin,body:{name:destination.name,html:`<p>Copy</p><img src="${image.body.url}">`,version:destination.version}})).status,400);
  assert.equal((await h.request('/knowledge/articles/'+page.id+'/images',{method:'POST',session:reader,body:{filename:'new.png',mime:'image/png',data:PNG.toString('base64')}})).status,403);
  assert.equal((await h.request('/knowledge/articles/'+page.id+'/images',{method:'POST',session:admin,body:{filename:'unsafe.svg',mime:'image/svg+xml',data:Buffer.from('<svg/>').toString('base64')}})).status,415);
  assert.equal((await h.request('/knowledge/articles/'+page.id+'/images',{method:'POST',session:admin,body:{filename:'fake.png',mime:'image/png',data:Buffer.from('<script/>').toString('base64')}})).status,415);
});

test('native image uploads use the bounded image body limit while normal record bodies remain small',async t=>{
  const h=await harness(t),admin=await h.login();
  const page=await article(h,admin,GENERAL_CATEGORY_ID,'Larger image upload');
  const large=Buffer.alloc(1024*1024);PNG.copy(large);
  const image=await h.request('/knowledge/articles/'+page.id+'/images',{method:'POST',session:admin,body:{filename:'large.png',mime:'image/png',data:large.toString('base64')}});
  assert.equal(image.status,201,JSON.stringify(image.body));
  const result=await h.request('/knowledge/media/'+image.body.id,{session:admin});assert.equal(result.status,200);assert.deepEqual(result.body,large);
  const excessiveRecord=await h.request('/knowledge/articles',{method:'POST',session:admin,body:{name:'Oversized record',html:'a'.repeat(600000)}});assert.equal(excessiveRecord.status,413);
});

test('ticket views and activity never disclose hidden asset links and failed links do not create inventory',async t=>{
  const h=await harness(t),admin=await h.login(),other=await h.login(h.outsider);
  const restricted=await category(h,admin,{name:'Private equipment',kind:'assets'});
  const asset=h.workspace.createAsset({ref:'PC-PRIVATE',name:'Private server',type:'server',category_id:restricted.id},h.admin);
  for(const key of ['HD-ONE','HD-TWO']){h.store.saveTicket({key,requester:'person@example.test',subject:'Support request',page_id:0,page_url:''});h.workspace.linkTicket(key,asset.id,h.admin);}
  const privileged=await h.request('/tickets/HD-ONE',{session:admin});assert.equal(privileged.body.assets.length,1);assert.equal(privileged.body.related_tickets.length,1);
  const hidden=await h.request('/tickets/HD-ONE',{session:other});assert.equal(hidden.status,200);assert.equal(hidden.body.assets.length,0);assert.equal(hidden.body.related_tickets.length,0);assert.ok(!JSON.stringify(hidden.body).includes('PC-PRIVATE'));
  const dashboard=await h.request('/dashboard',{session:other});assert.ok(!JSON.stringify(dashboard.body).includes('PC-PRIVATE'));
  const updated=await h.request('/tickets/HD-ONE',{method:'PATCH',session:other,body:{version:hidden.body.version,status:'in_progress'}});assert.equal(updated.status,200);assert.ok(!JSON.stringify(updated.body).includes('PC-PRIVATE'));
  const failed=await h.request('/tickets/HD-NO-SUCH/assets',{method:'POST',session:admin,body:{ref:'PC-ORPHAN'}});assert.equal(failed.status,404);assert.equal(h.workspace.assetRow('PC-ORPHAN'),undefined);
});

test('native knowledge preserves embedded ticket links after sanitizing imported article content',async t=>{
  const h=await harness(t),admin=await h.login();
  const result=await h.request('/knowledge/articles',{method:'POST',session:admin,body:{name:'Ticket reference',html:'<p>See <a href="#tickets/HD-123">ticket 123</a>.</p>'}});
  assert.equal(result.status,201);assert.ok(result.body.html.includes('href="#tickets/HD-123"'));
});
