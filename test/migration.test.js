import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { importLegacyWorkspace } from '../migration/importer.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store);
  const user = await desk.ensureAdmin({name:'Migration administrator',email:'admin@example.test',password:'Migration-test-password-123'});
  const tech = await desk.createTechnician({name:'Technician',email:'tech@example.test',password:'Migration-test-password-123'});
  store.saveTicket({key:'HD-EXISTING',requester:'person@example.test',subject:'Screen issue',page_id:30,page_url:'http://legacy.example/link/30'});
  store.db.prepare('INSERT INTO ticket_assets(ticket_key,ref,page_id,url) VALUES (?,?,?,?)').run('HD-EXISTING','PC-123',11,'http://legacy.example/link/11');
  const workspace = new WorkspaceStore(desk);
  const books=[{id:1,name:'Knowledge Base',slug:'knowledge-base'},{id:2,name:'Assets',slug:'assets'},{id:3,name:'Tickets',slug:'tickets'}];
  const pages=[
    {id:10,name:'Printer guide',slug:'printer-guide',book_id:1,chapter_id:4,html:'<h2 id="printer-check">Check printer</h2><p><a href="http://legacy.example/link/11">PC equipment</a> <a href="/link/30">Original ticket</a> <a href="/books/tickets/page/ticket-mirror">Canonical ticket</a> <a href="#knowledge/article/12">Embedded article</a> <a href="#printer-check">This section</a> <a href="#tickets/HD-EXISTING">Native ticket</a></p><img src="http://legacy.example/uploads/images/gallery/smoke.png"><script>window.bad=true</script>'},
    {id:11,name:'PC-123',slug:'pc-123',book_id:2,tags:[{name:'Asset ID',value:'PC-123'}],html:'<table><tr><td>Owner / assigned user</td><td>Ada Example</td></tr><tr><td>Location</td><td>Room 14</td></tr><tr><td>Serial number</td><td>SN123</td></tr></table>'},
    {id:12,name:'Second guide',slug:'second-guide',book_id:1,html:'<p>See <a href="/books/knowledge-base/page/printer-guide">printer guide</a>.</p>'},
    {id:30,name:'Ticket mirror',slug:'ticket-mirror',book_id:3,html:'<p>Generated ticket mirror</p>'},
  ];
  const legacy={url:'http://legacy-internal',publicUrl:'http://legacy.example',reads:0,failImage:false,
    async list(path){return path==='/books'?books:path==='/chapters'?[{id:4,book_id:1,name:'Printers'}]:pages.map(({html,tags,...page})=>page);},
    async getPage(id){return structuredClone(pages.find(page=>page.id===id));},
    async readImage(){this.reads++;if(this.failImage)throw new Error('Image unavailable');return{data:png,contentType:'image/png'};},
  };
  t.after(()=>store.close());
  return {store,desk,workspace,user,tech,legacy};
}

test('legacy migration preserves documents, images, asset ownership and ticket backlinks under restricted categories',async t=>{
  const h=await fixture(t);
  const counts=await importLegacyWorkspace(h);
  assert.equal(counts.assets,1);assert.equal(counts.articles,3);assert.equal(counts.images,1);assert.equal(counts.ticketMirrorsSkipped,1);assert.equal(counts.unresolvedLinks,0);
  const imported=h.workspace.listCategories(h.user).filter(category=>category.name.startsWith('Imported /'));
  assert.equal(imported.length,3);assert.ok(imported.every(category=>category.visibility==='restricted'&&!category.allow_staff_edit));
  assert.equal(h.workspace.listArticles(h.tech).total,0);assert.equal(h.workspace.listAssets(h.tech).total,0);
  const asset=h.workspace.getAsset('PC-123',h.user);
  assert.equal(asset.owner_name,'Ada Example');assert.equal(asset.location,'Room 14');assert.equal(asset.serial_number,'SN123');
  assert.equal(asset.tickets[0].key,'HD-EXISTING');
  const guide=h.workspace.listArticles(h.user,{search:'Printer guide'}).articles.find(article=>article.name==='Printer guide');
  const page=h.workspace.getArticle(guide.id,h.user);
  assert.ok(page.html.includes(`#assets/${asset.id}`));assert.ok(page.html.includes('#tickets/HD-EXISTING'));assert.ok(!page.html.includes('<script'));
  const mediaId=page.html.match(/\/knowledge\/media\/([a-f0-9-]+)/)[1];
  assert.deepEqual(h.workspace.getMedia(mediaId,h.user).data,png);
  assert.throws(()=>h.workspace.getMedia(mediaId,h.tech),error=>error.statusCode===404);
  const second=h.workspace.listArticles(h.user,{search:'Second guide'}).articles[0];
  assert.ok(h.workspace.getArticle(second.id,h.user).html.includes(`#knowledge/article/${guide.id}`));
  assert.ok(page.html.includes(`href="#knowledge/article/${second.id}"`));
  assert.ok(page.html.includes('href="#printer-check"'));
  assert.equal((page.html.match(/href="#tickets\/HD-EXISTING"/g)||[]).length,3);
});

test('rerunning an import is idempotent and never overwrites manually edited native content',async t=>{
  const h=await fixture(t);await importLegacyWorkspace(h);
  const article=h.workspace.listArticles(h.user,{search:'Printer guide'}).articles.find(article=>article.name==='Printer guide');
  h.workspace.updateArticle(article.id,{html:'<p>Native edits must remain</p>'},h.user,{version:article.version});
  const asset=h.workspace.getAsset('PC-123',h.user);
  h.workspace.updateAsset(asset.id,{owner_name:'Grace Example'},h.user,{version:asset.version});
  const before=h.store.db.prepare('SELECT COUNT(*) AS count FROM knowledge_articles').get().count;
  const rerun=await importLegacyWorkspace(h);
  assert.equal(rerun.articles,0);assert.equal(rerun.assets,0);assert.equal(rerun.images,0);assert.equal(rerun.skipped,3);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM knowledge_articles').get().count,before);
  assert.ok(h.workspace.getArticle(article.id,h.user).html.includes('Native edits must remain'));
  assert.equal(h.workspace.getAsset(asset.id,h.user).owner_name,'Grace Example');
});

test('a temporarily unavailable image can resume later without duplicate article or media records',async t=>{
  const h=await fixture(t);h.legacy.failImage=true;
  const first=await importLegacyWorkspace(h);assert.equal(first.imagesUnavailable,1);assert.equal(first.images,0);
  h.legacy.failImage=false;
  const resumed=await importLegacyWorkspace(h);assert.equal(resumed.images,1);assert.equal(resumed.articles,0);
  const guide=h.workspace.listArticles(h.user,{search:'Printer guide'}).articles.find(article=>article.name==='Printer guide');
  assert.ok(h.workspace.getArticle(guide.id,h.user).html.includes('/api/desk/knowledge/media/'));
  await importLegacyWorkspace(h);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM workspace_media').get().count,1);
});

test('first import preserves an already maintained native asset while importing legacy documentation privately',async t=>{
  const h=await fixture(t);const initial=h.workspace.getAsset('PC-123',h.user);
  h.workspace.updateAsset(initial.id,{owner_name:'Native owner',location:'New office'},h.user,{version:initial.version});
  await importLegacyWorkspace(h);
  const asset=h.workspace.getAsset(initial.id,h.user);
  assert.equal(asset.owner_name,'Native owner');assert.equal(asset.location,'New office');assert.equal(asset.category_id,initial.category_id);
  const imported=h.workspace.listArticles(h.user).articles.filter(article=>article.name.includes('imported documentation'));
  assert.ok(imported.length);assert.ok(imported.every(article=>article.category.visibility==='restricted'));
});

test('improved link translation repairs untouched earlier imports and retains subsequent native edits',async t=>{
  const h=await fixture(t);await importLegacyWorkspace(h);
  const guide=h.workspace.listArticles(h.user,{search:'Printer guide'}).articles.find(article=>article.name==='Printer guide');
  const second=h.workspace.listArticles(h.user,{search:'Second guide'}).articles[0];
  // Represent an earlier importer revision that stripped recognized links.
  h.store.db.prepare('UPDATE knowledge_articles SET html=? WHERE id=?').run('<p>Earlier import without links</p>',guide.id);
  h.workspace.updateArticle(second.id,{html:'<p>Manually maintained native content</p>'},h.user,{version:second.version});
  h.store.db.prepare("UPDATE legacy_import_state SET link_revision=1 WHERE target_type='article'").run();
  const counts=await importLegacyWorkspace(h);
  const repaired=h.workspace.getArticle(guide.id,h.user);
  assert.ok(repaired.html.includes('#tickets/HD-EXISTING'));
  assert.ok(repaired.html.includes(`#knowledge/article/${second.id}`));
  assert.ok(h.workspace.getArticle(second.id,h.user).html.includes('Manually maintained native content'));
  const sourceVersion=h.store.db.prepare("SELECT native_version FROM legacy_import_state WHERE source_id='12' AND target_type='article'").get().native_version;
  assert.equal(sourceVersion,second.version);
  assert.equal(counts.articles,0);assert.equal(counts.images,0);assert.equal(counts.unresolvedLinks,0);
  const version=repaired.version;
  await importLegacyWorkspace(h);
  assert.equal(h.workspace.getArticle(guide.id,h.user).version,version);
});
