import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DeskStore } from '../src/desk-store.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { buildRelatedContext, relatedSourcesAreCurrent, presentRelated } from '../src/ai-related.js';

const NOW = '2035-05-10T12:00:00.000Z';
const admin = { id: 'context-admin', name: 'Context administrator', role: 'admin', active: true };
const technician = { id: 'context-technician', name: 'Context technician', role: 'technician', active: true };

function fixture(t) {
  const store = new Store(':memory:'), desk = new DeskStore(store), workspace = new WorkspaceStore(desk);
  t.after(() => store.close());
  function ticket(key = 'HD-CURRENT', input = {}) {
    const created = input.created_at || NOW;
    store.saveTicket({ key, requester: 'requester-private@example.test', subject: input.subject || `Display flickers on ${key}`, page_id: 0, page_url: '', created_at: created });
    desk.initializeRows();
    desk.db.prepare(`UPDATE tickets SET description=?,resolution=?,status=?,created_at=?,updated_at=?,paused_until=? WHERE key=?`)
      .run(input.description || 'The display flickers when the docking station is attached.', input.resolution || '', input.status || 'open', created,
        input.updated_at || created, input.status === 'paused' ? '2036-01-01T00:00:00.000Z' : null, key);
    return key;
  }
  function asset(ref, input = {}) {
    return workspace.createAsset({ ref, name: input.name || ref, type: 'laptop', ...input }, admin);
  }
  const build = (key = 'HD-CURRENT', now = NOW) => buildRelatedContext({ desk, ticketKey: key, now });
  const current = (source, now = NOW) => relatedSourcesAreCurrent({ desk, workspace, ticketKey: source.provenance.ticket_key, provenance: source.provenance, now });
  const display = (source, matches = {}, now = NOW, status = 'ready') => presentRelated({ desk, workspace, ticketKey: source.provenance.ticket_key, user: technician, now,
    saved: { status, reviewed_at: NOW, window: source.context.window, coverage: source.context.coverage,
      recent_tickets: [], asset_issues: [], ...matches, provenance: source.provenance } });
  return { store, desk, workspace, ticket, asset, build, current, display };
}

test('related candidates use submitted UTC dates with inclusive72h boundaries, not recent edits of old tickets', t => {
  const h = fixture(t); h.ticket();
  h.ticket('HD-LOWER', { created_at: '2035-05-07T08:00:00-04:00' });
  h.ticket('HD-UPPER', { created_at: NOW });
  h.ticket('HD-TOO-OLD', { created_at: '2035-05-07T11:59:59.999Z', updated_at: NOW });
  h.ticket('HD-FUTURE', { created_at: '2035-05-10T12:00:00.001Z' });
  h.ticket('HD-PAUSED', { status: 'paused' });
  const source = h.build();
  assert.deepEqual(source.context.window, { from: '2035-05-07T12:00:00.000Z', to: NOW, hours: 72 });
  assert.deepEqual(source.context.recent_tickets.map(ticket => ticket.ticket_key), ['HD-UPPER', 'HD-LOWER']);
  assert.equal(source.context.coverage.recent_candidates, 2);
  assert.equal(source.context.coverage.recent_total, 2);
  assert.equal(h.current(source), true);
});

test('asset history uses actual shared linked assets and retains older resolved issues without private inventory or notes', t => {
  const h = fixture(t), target = h.ticket();
  const shared = h.asset('LAPTOP-1', { name: 'Shared display laptop', serial_number: 'PRIVATE-SERIAL-NOT-CONTEXT', owner_name: 'PRIVATE-OWNER-NOT-CONTEXT' });
  const other = h.asset('LAPTOP-OTHER');
  const privateCategory = h.workspace.createCategory({ name: 'Restricted inventory', kind: 'assets', visibility: 'restricted' }, admin);
  const restricted = h.asset('LAPTOP-SECRET', { name: 'PRIVATE-ASSET-NOT-CONTEXT', category_id: privateCategory.id });
  for (const asset of [shared, restricted]) h.workspace.linkTicket(target, asset.id, admin);
  h.ticket('HD-HISTORY', { created_at: '2035-01-01T12:00:00.000Z', status: 'resolved', resolution: 'Replacing the docking cable stopped the display flicker.' });
  h.ticket('HD-UNRELATED-ASSET', { created_at: '2035-01-02T12:00:00.000Z' });
  h.ticket('HD-SECRET-HISTORY', { created_at: '2035-01-03T12:00:00.000Z', subject: 'PRIVATE-HISTORY-NOT-CONTEXT' });
  h.ticket('HD-PAUSED-HISTORY', { status: 'paused' });
  h.ticket('HD-FUTURE-HISTORY', { created_at: '2035-05-11T12:00:00.000Z' });
  h.workspace.linkTicket('HD-HISTORY', shared.id, admin);
  h.workspace.linkTicket('HD-UNRELATED-ASSET', other.id, admin);
  h.workspace.linkTicket('HD-SECRET-HISTORY', restricted.id, admin);
  h.workspace.linkTicket('HD-PAUSED-HISTORY', shared.id, admin);
  h.workspace.linkTicket('HD-FUTURE-HISTORY', shared.id, admin);
  h.desk.addNote('HD-HISTORY', { body: 'PRIVATE-INTERNAL-NOTE-NOT-CONTEXT', actor: admin });
  const source = h.build();
  assert.deepEqual(source.context.linked_assets, [{ asset_id: shared.id, ref: shared.ref, name: shared.name, type: 'laptop' }]);
  assert.deepEqual(source.context.asset_issues.map(issue => [issue.asset_id, issue.ticket_key]), [[shared.id, 'HD-HISTORY']]);
  assert.match(source.context.asset_issues[0].resolution, /Replacing the docking cable/);
  assert.doesNotMatch(JSON.stringify(source.context), /PRIVATE-|requester-private@example\.test/);
  assert.ok([...source.context.recent_tickets, ...source.context.asset_issues].every(ticket => ticket.ticket_key !== target));
  assert.equal(source.context.coverage.asset_candidates, 1);
});

test('display resolves subjects, statuses, assets and native links locally and withholds all provenance', t => {
  const h = fixture(t), target = h.ticket(), asset = h.asset('DISPLAY-1', { name: 'Docked workstation' });
  h.ticket('HD-RECENT', { created_at: '2035-05-09T12:00:00.000Z', status: 'in_progress' });
  h.ticket('HD-OLDER', { created_at: '2034-10-01T00:00:00.000Z', status: 'closed', resolution: 'Installed a replacement cable.' });
  h.workspace.linkTicket(target, asset.id, admin); h.workspace.linkTicket('HD-OLDER', asset.id, admin);
  const source = h.build(), reason = '<img src="broken" onerror="unsafe()"> is literal model text';
  const shown = h.display(source, { recent_tickets: [{ ticket_key: 'HD-RECENT', reason }], asset_issues: [{ asset_id: asset.id, ticket_key: 'HD-OLDER', reason: 'The same display symptom was fixed by replacing its cable.' }] });
  assert.equal(shown.status, 'ready');
  assert.deepEqual(shown.recent_tickets[0], { key: 'HD-RECENT', subject: 'Display flickers on HD-RECENT', status: 'in_progress', status_name: 'In progress', created_at: '2035-05-09T12:00:00.000Z', reason, url: '#tickets/HD-RECENT' });
  assert.deepEqual(shown.asset_issues[0].asset, { id: asset.id, ref: asset.ref, name: asset.name, url: '#assets/' + asset.id });
  assert.equal(shown.asset_issues[0].tickets[0].url, '#tickets/HD-OLDER');
  assert.equal(shown.asset_issues[0].tickets[0].resolution, 'Installed a replacement cable.');
  assert.equal(Object.hasOwn(shown, 'provenance'), false);
  assert.doesNotMatch(JSON.stringify(shown), /graph_hash|category_version|requester-private/);
});

test('invented keys and cross-product asset-ticket references cannot become clickable AI matches', t => {
  const h = fixture(t), target = h.ticket(), first = h.asset('PC-1'), second = h.asset('PC-2');
  h.ticket('HD-FIRST', { created_at: '2035-01-01T00:00:00.000Z' });
  h.ticket('HD-SECOND', { created_at: '2035-02-01T00:00:00.000Z' });
  for (const asset of [first, second]) h.workspace.linkTicket(target, asset.id, admin);
  h.workspace.linkTicket('HD-FIRST', first.id, admin); h.workspace.linkTicket('HD-SECOND', second.id, admin);
  const source = h.build();
  for (const matches of [
    { recent_tickets: [{ ticket_key: 'HD-INVENTED', reason: 'Invented match.' }] },
    { asset_issues: [{ asset_id: first.id, ticket_key: 'HD-SECOND', reason: 'The independent IDs exist, but this association does not.' }] },
    { asset_issues: [{ asset_id: second.id, ticket_key: target, reason: 'Self reference.' }] },
  ]) {
    const result = h.display(source, matches);
    assert.equal(result.status, 'stale'); assert.deepEqual(result.recent_tickets, []); assert.deepEqual(result.asset_issues, []);
  }
});

test('uncited supplied assets becoming restricted invalidate the entire retained narrative and hidden counts', t => {
  const h = fixture(t), target = h.ticket(), first = h.asset('PC-1'), uncited = h.asset('PC-2');
  h.ticket('HD-RECENT', { created_at: '2035-05-09T00:00:00.000Z' });
  for (const asset of [first, uncited]) h.workspace.linkTicket(target, asset.id, admin);
  const source = h.build();
  const restricted = h.workspace.createCategory({ name: 'Restricted after review', kind: 'assets', visibility: 'restricted' }, admin);
  h.workspace.updateAsset(uncited.id, { category_id: restricted.id, version: uncited.version }, admin);
  assert.equal(h.current(source), false);
  const shown = h.display(source, { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'A narrative influenced by all supplied assets.' }] });
  assert.equal(shown.status, 'stale'); assert.equal(shown.coverage, null);
  assert.deepEqual(shown.recent_tickets, []); assert.deepEqual(shown.asset_issues, []);
  assert.doesNotMatch(JSON.stringify(shown), /PC-2|influenced/);
  assert.equal(h.display(source, {}, NOW, 'stale').coverage, null, 'Stored stale reviews must not retain inaccessible inventory counts either.');
});

test('changed ticket evidence, asset metadata, category grants, and either side of an asset link invalidate retained sources', t => {
  const changes = [
    h => h.desk.db.prepare("UPDATE tickets SET subject='A different symptom' WHERE key='HD-HISTORY'").run(),
    h => h.desk.db.prepare("UPDATE tickets SET resolution='A different resolution' WHERE key='HD-HISTORY'").run(),
    h => h.desk.addTicketTag('HD-HISTORY', 'new issue evidence', admin),
    h => h.desk.db.prepare("UPDATE tickets SET status='paused',paused_until='2036-01-01T00:00:00.000Z' WHERE key='HD-HISTORY'").run(),
    h => h.desk.db.prepare("DELETE FROM native_asset_tickets WHERE ticket_key='HD-HISTORY'").run(),
    h => h.desk.db.prepare("DELETE FROM native_asset_tickets WHERE ticket_key='HD-CURRENT'").run(),
    h => h.workspace.linkTicket('HD-CURRENT', h.asset('PC-ADDITIONAL').id, admin),
    h => h.workspace.updateAsset(h.linked.id, { name: 'Renamed hardware', version: h.linked.version }, admin),
    h => h.workspace.updateCategory(h.linked.category_id, { allow_staff_edit: false, version: h.workspace.categoryRow(h.linked.category_id).version }, admin),
  ];
  for (const change of changes) {
    const h = fixture(t), target = h.ticket(); h.linked = h.asset('PC-1');
    h.ticket('HD-HISTORY', { created_at: '2034-01-01T00:00:00.000Z' });
    h.workspace.linkTicket(target, h.linked.id, admin); h.workspace.linkTicket('HD-HISTORY', h.linked.id, admin);
    const source = h.build(); assert.equal(h.current(source), true);
    change(h); assert.equal(h.current(source), false);
  }
});

test('unrelated internal notes do not enter context or invalidate semantic issue evidence', t => {
  const h = fixture(t); h.ticket(); h.ticket('HD-RECENT', { created_at: '2035-05-09T00:00:00.000Z' });
  const source = h.build();
  h.desk.addNote('HD-RECENT', { body: 'INTERNAL-PRIVATE-CANDIDATE', actor: admin });
  h.desk.addNote('HD-CURRENT', { body: 'INTERNAL-PRIVATE-TARGET', actor: admin });
  assert.equal(h.current(source), true);
  assert.doesNotMatch(JSON.stringify(source.context), /INTERNAL-PRIVATE/);
});

test('recent matches expire beyond72h while older linked-asset history remains valid', t => {
  const h = fixture(t), target = h.ticket(), asset = h.asset('PC-1');
  h.ticket('HD-RECENT', { created_at: '2035-05-09T12:00:00.000Z' });
  let source = h.build();
  assert.equal(h.current(source, '2035-05-12T12:00:00.000Z'), true);
  assert.equal(h.current(source, '2035-05-12T12:00:00.001Z'), false);
  const expired = h.display(source, { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'Related display symptom.' }] }, '2035-05-12T12:00:00.001Z');
  assert.equal(expired.status, 'stale'); assert.deepEqual(expired.recent_tickets, []);
  h.desk.db.prepare("DELETE FROM tickets WHERE key='HD-RECENT'").run();
  h.ticket('HD-OLD', { created_at: '2030-01-01T00:00:00.000Z' });
  h.workspace.linkTicket(target, asset.id, admin); h.workspace.linkTicket('HD-OLD', asset.id, admin);
  source = h.build(); assert.equal(h.current(source, '2035-05-20T12:00:00.000Z'), true);
});

test('large recent and historical sets share a bounded context and report actual sampled candidate counts', t => {
  const h = fixture(t), target = h.ticket();
  const assets = Array.from({ length: 11 }, (_, index) => h.asset('PC-' + index));
  for (const asset of assets) h.workspace.linkTicket(target, asset.id, admin);
  for (let index = 0; index < 70; index++) {
    const key = h.ticket('HD-RECENT-' + index, { created_at: '2035-05-09T12:00:00.000Z', description: 'Long recent issue evidence. '.repeat(1000) });
    h.desk.addTicketTag(key, 'Relevant tag', admin);
    const old = h.ticket('HD-OLD-' + index, { created_at: '2034-01-01T00:00:00.000Z', description: 'Long older issue evidence. '.repeat(1000), resolution: 'Previous fix details. '.repeat(1000) });
    h.workspace.linkTicket(old, assets[0].id, admin);
  }
  const { context, provenance } = h.build();
  assert.ok(JSON.stringify(context).length <= 60000);
  assert.equal(context.linked_assets.length, 10); assert.equal(provenance.assets.length, 10);
  assert.ok(context.recent_tickets.length > 0 && context.recent_tickets.length <= 50);
  assert.ok(context.asset_issues.length > 0 && context.asset_issues.length <= 50);
  assert.equal(context.coverage.recent_candidates, context.recent_tickets.length);
  assert.equal(context.coverage.asset_candidates, context.asset_issues.length);
  assert.equal(context.coverage.recent_total, 70); assert.equal(context.coverage.asset_total, 70);
  assert.equal(context.coverage.linked_assets_total, 11); assert.equal(context.coverage.truncated, true);
  assert.ok(context.recent_tickets.every(item => item.description.length <= 700));
});

test('target issue changes and malformed retained provenance cannot expose previous AI match text', t => {
  const h = fixture(t); h.ticket(); h.ticket('HD-RECENT');
  const source = h.build();
  h.desk.db.prepare("UPDATE tickets SET description='Requester supplied a different issue.' WHERE key='HD-CURRENT'").run();
  assert.equal(h.current(source), false);
  const shown = h.display(source, { recent_tickets: [{ ticket_key: 'HD-RECENT', reason: 'OLD-REASON-MUST-NOT-APPEAR' }] });
  assert.equal(shown.status, 'stale'); assert.doesNotMatch(JSON.stringify(shown), /OLD-REASON/);
  for (const provenance of [null, {}, { ...source.provenance, recent_keys: ['HD-INVENTED'] }, { ...source.provenance, assets: null }]) {
    assert.equal(relatedSourcesAreCurrent({ desk: h.desk, workspace: h.workspace, ticketKey: 'HD-CURRENT', provenance, now: NOW }), false);
  }
  assert.throws(() => h.build('HD-MISSING'), error => error.statusCode === 404);
});
