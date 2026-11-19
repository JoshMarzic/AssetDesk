#!/usr/bin/env node
// Native knowledge/category permissions check against a development instance.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {sessionClient,base} from './smoke-helper.mjs';
const admin=await sessionClient(),request=admin.request,run=Date.now();
const password=randomBytes(24).toString('hex');
const tech=await request('/technicians',{method:'POST',body:{name:'Smoke knowledge reader '+run,email:`kb-${run}@assetdesk.example`,password,role:'technician'}});
const library=await request('/knowledge');assert.ok(library.categories.some(c=>c.kind==='assets'));
const category=await request('/knowledge/categories',{method:'POST',body:{name:'Smoke restricted guides '+run,visibility:'restricted',reader_ids:[],editor_ids:[],allow_staff_edit:false}});
let article=await request('/knowledge/articles',{method:'POST',body:{name:'Smoke protected procedure '+run,category_id:category.id,html:'<h2>Native guide</h2><p>Private category content.</p><script>unsafe()</script>'}});assert.ok(!article.html.includes('<script'));
const other=await sessionClient(tech.email,password);
let response=await fetch(`${base}/api/desk/knowledge/articles/${article.id}`,{headers:{Cookie:other.cookie}});assert.equal(response.status,404);
const invisible=await other.request('/knowledge?search='+run);assert.equal(invisible.total,0);assert.ok(!invisible.categories.some(c=>c.id===category.id));
await request('/knowledge/categories/'+category.id,{method:'PATCH',body:{version:category.version,reader_ids:[tech.id]}});
const visible=await other.request('/knowledge/articles/'+article.id);assert.equal(visible.canEdit,false);
article=await request('/knowledge/articles/'+article.id,{method:'PATCH',body:{name:article.name,html:'<h2>Updated native guide</h2><p>Content saved locally.</p>',version:article.version}});assert.ok(article.html.includes('Updated native guide'));
await other.logout();await request('/technicians/'+tech.id,{method:'PATCH',body:{active:false}});await admin.logout();
console.log('PASS: native knowledge categories, protected article content, ACL-filtered search, reader grants, safe HTML and optimistic edits without a second service.');
