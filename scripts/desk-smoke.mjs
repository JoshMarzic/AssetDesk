#!/usr/bin/env node
// Creates labeled development records; no external email is sent.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {sessionClient} from './smoke-helper.mjs';
const client=await sessionClient(),request=client.request,run=Date.now();
const technician=await request('/technicians',{method:'POST',body:{name:`Smoke technician ${run}`,email:`smoke-${run}@assetdesk.example`,password:randomBytes(24).toString('hex'),role:'technician'}});
const person=await request('/assets',{method:'POST',body:{ref:`PERSONNEL-${run}`,name:'Smoke employee',type:'personnel',email:'smoke-employee@assetdesk.example',department:'IT',status:'active'}});
const pc=await request('/assets',{method:'POST',body:{ref:`PC-${run}`,name:'Smoke workstation',type:'pc',owner_id:person.id,location:'Test lab',serial_number:'SMOKE-'+run,status:'active'}});
const accepted=await request('/tickets',{method:'POST',body:{subject:`[Smoke test] Workstation issue ${run}`,requester:'requester@assetdesk.example',description:`Please check ${pc.ref}.`,priority:'high',category:'hardware',assignee_id:technician.id}});
assert.equal(accepted.state,'done');assert.ok(accepted.ticketKey);
let ticket=await request('/tickets/'+accepted.ticketKey);assert.equal(ticket.assignee_id,technician.id);assert.ok(ticket.assets.some(asset=>asset.id===pc.id));
const asset=await request('/assets/'+pc.id);assert.equal(asset.owner.id,person.id);assert.ok(asset.tickets.some(row=>row.key===ticket.key));
const linked=await request('/tickets/'+ticket.key+'/assets',{method:'POST',body:{ref:`MONITOR-${run}`}});assert.equal(linked.linked,true);assert.equal(linked.queued,false);
ticket=await request('/tickets/'+ticket.key);ticket=await request('/tickets/'+ticket.key,{method:'PATCH',body:{version:ticket.version,status:'in_progress',first_response:true}});
ticket=await request('/tickets/'+ticket.key+'/notes',{method:'POST',body:{body:'Replaced the workstation display cable.'}});
ticket=await request('/tickets/'+ticket.key,{method:'PATCH',body:{version:ticket.version,status:'resolved',resolution:'Replaced the cable and verified the display.'}});assert.equal(ticket.status,'resolved');
assert.ok((await request('/responses')).responses.length>=3);
await request('/technicians/'+technician.id,{method:'PATCH',body:{active:false}});await client.logout();
console.log('PASS: native login, named technicians, personnel/PC ownership, immediate tickets, asset ticket history, asset linking, notes, response tracking and resolution.');
console.log(`Created labeled ticket ${ticket.key} and assets ${person.ref}, ${pc.ref}.`);
