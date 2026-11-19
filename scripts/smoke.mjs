#!/usr/bin/env node
// Full RFC822 intake and local asset history smoke; no external email is sent.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sessionClient,base} from './smoke-helper.mjs';
const client=await sessionClient(),run=Date.now(),ref=`LAPTOP-${run}`;
const raw=(id,body,reply='')=>`From: Smoke requester <smoke@assetdesk.example>\r\nSubject: [Smoke test] ${ref}\r\nMessage-ID: <${id}@assetdesk.example>\r\n${reply?`In-Reply-To: <${reply}@assetdesk.example>\r\n`:''}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
async function send(message){const r=await fetch(base+'/api/inbound/email',{method:'POST',headers:{Authorization:`Bearer ${process.env.INBOUND_EMAIL_TOKEN}`,'Content-Type':'message/rfc822'},body:message});assert.ok([200,202].includes(r.status));return r.json();}
const id='native-smoke-'+run,message=raw(id,`${ref} cannot start.`),first=await send(message);assert.equal(first.state,'done');assert.ok(first.ticketKey);
const duplicate=await send(message);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.ticketKey,first.ticketKey);
const reply=await send(raw('reply-'+run,`Also check PC-${run}.`,id));assert.equal(reply.ticketKey,first.ticketKey);
const ticket=await client.request('/tickets/'+first.ticketKey);assert.equal(ticket.notes.filter(note=>note.kind==='email').length,1);assert.equal(ticket.assets.length,2);
const asset=await client.request('/assets/'+ticket.assets.find(asset=>asset.ref===ref).id);assert.ok(asset.tickets.some(row=>row.key===ticket.key));
const bridge=spawnSync(process.execPath,['scripts/forward-email.mjs'],{input:message,env:{...process.env,ASSETDESK_INBOUND_URL:base+'/api/inbound/email'},encoding:'utf8'});assert.equal(bridge.status,0,bridge.stderr);
await client.logout();console.log('PASS: native email intake, duplicate protection, reply threading, typed assets, reverse ticket links and delivery pipe.');
