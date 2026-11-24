import { createHash } from 'node:crypto';
import { ticketInputHash } from './ai-context.js';

const HOURS = 72;
const MAX_RECENT = 50;
const MAX_ASSETS = 10;
const MAX_HISTORY = 50;
const MAX_CONTEXT = 59500;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const clip = (value, maximum) => String(value ?? '').slice(0, maximum);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => Object.assign(new Error(message), { statusCode: 404, safeMessage: message });
const joins = `FROM tickets t LEFT JOIN ticket_statuses s ON s.id=t.status
  LEFT JOIN ticket_priorities p ON p.id=t.priority LEFT JOIN ticket_categories c ON c.id=t.category`;
const fields = `t.key,t.subject,t.description,t.resolution,t.status,t.priority,t.category,t.created_at,
  COALESCE(s.name,t.status) AS status_name,COALESCE(s.kind,'active') AS status_kind,
  COALESCE(p.name,t.priority) AS priority_name,COALESCE(c.name,t.category) AS category_name`;
const visible = "t.status!='paused' AND COALESCE(s.kind,'active')!='paused'";

function instant(value) {
  const date = new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('A valid related-ticket review time is required.');
  return date.toISOString();
}

function ticketRow(desk, key) {
  return validId(key) ? desk.db.prepare(`SELECT ${fields} ${joins} WHERE t.key=?`).get(key) : null;
}

function snapshot(desk, row) {
  if (!row || !validId(row.key)) return null;
  const digest = createHash('sha256').update(JSON.stringify([row, ticketInputHash(desk, row.key)]));
  const tags = []; let tagCount = 0;
  for (const tag of desk.db.prepare('SELECT name,normalized FROM ticket_tags WHERE ticket_key=? ORDER BY normalized').iterate(row.key)) {
    digest.update(JSON.stringify(tag));
    if (tags.length < 10) tags.push(clip(tag.name, 50));
    tagCount++;
  }
  return { row, hash: digest.digest('hex'), tags, tagCount };
}

function ticketEvidence(source, target = false) {
  const { row, tags } = source;
  return {
    ticket_key: row.key, subject: clip(row.subject, 240), description: clip(row.description, target ? 4000 : 700),
    resolution: clip(row.resolution, target ? 2000 : 700), status: clip(row.status_name, 100),
    priority: clip(row.priority_name, 100), category: clip(row.category_name, 100), tags,
    created_at: row.created_at,
  };
}

function shortened(source, target = false) {
  return source.tagCount > 10 || source.row.description.length > (target ? 4000 : 700)
    || source.row.resolution.length > (target ? 2000 : 700);
}

function linkedAssets(desk, ticketKey) {
  const digest = createHash('sha256'), assets = []; let total = 0;
  const statement = desk.db.prepare(`SELECT a.id,a.ref,a.name,a.type,a.category_id,a.version,c.version AS category_version
    FROM native_asset_tickets n JOIN native_assets a ON a.id=n.asset_id JOIN knowledge_categories c ON c.id=a.category_id
    WHERE n.ticket_key=? AND c.visibility='all' ORDER BY a.ref COLLATE NOCASE,a.id`);
  for (const asset of statement.iterate(ticketKey)) {
    // The graph fingerprint includes shared links outside the sample so that
    // adding or removing a link never leaves an apparently current review.
    digest.update(JSON.stringify(asset)); total++;
    if (assets.length < MAX_ASSETS && validId(asset.id)) assets.push(asset);
  }
  return { assets, total, hash: digest.digest('hex') };
}

/** Build two bounded candidate sets without exposing inventory or internal notes. */
export function buildRelatedContext({ desk, ticketKey, now }) {
  const to = instant(now), from = new Date(Date.parse(to) - HOURS * 3600000).toISOString();
  desk.resumeDueTickets(to);
  desk.initializeRows();
  const target = snapshot(desk, ticketRow(desk, ticketKey));
  if (!target) throw invalid('Ticket not found.');
  const graph = linkedAssets(desk, ticketKey), assets = graph.assets;
  const recentWhere = `WHERE t.key<>? AND ${visible} AND julianday(t.created_at) BETWEEN julianday(?) AND julianday(?)`;
  const recentTotal = desk.db.prepare(`SELECT COUNT(*) AS total ${joins} ${recentWhere}`).get(ticketKey, from, to).total;
  const recentRows = desk.db.prepare(`SELECT ${fields} ${joins} ${recentWhere} ORDER BY julianday(t.created_at) DESC,t.key LIMIT ?`).all(ticketKey, from, to, MAX_RECENT);
  const historyJoins = `${joins} JOIN native_asset_tickets other ON other.ticket_key=t.key
    JOIN native_assets a ON a.id=other.asset_id JOIN knowledge_categories ac ON ac.id=a.category_id
    JOIN native_asset_tickets mine ON mine.asset_id=other.asset_id AND mine.ticket_key=?`;
  const historyWhere = `WHERE t.key<>? AND ${visible} AND ac.visibility='all' AND julianday(t.created_at)<=julianday(?)`;
  const historyTotal = desk.db.prepare(`SELECT COUNT(*) AS total ${historyJoins} ${historyWhere}`).get(ticketKey, ticketKey, to).total;
  const historyRows = assets.length ? desk.db.prepare(`SELECT ${fields},other.asset_id ${historyJoins} ${historyWhere}
    AND other.asset_id IN (${assets.map(() => '?').join(',')}) ORDER BY julianday(t.created_at) DESC,t.key,other.asset_id LIMIT ?`)
    .all(ticketKey, ticketKey, to, ...assets.map(asset => asset.id), MAX_HISTORY) : [];
  const coverage = { recent_candidates: 0, asset_candidates: 0, recent_total: recentTotal, asset_total: historyTotal,
    linked_assets_reviewed: assets.length, linked_assets_total: graph.total, truncated: false };
  const context = { ticket: ticketEvidence(target, true), window: { from, to, hours: HOURS },
    linked_assets: assets.map(asset => ({ asset_id: asset.id, ref: clip(asset.ref, 100), name: clip(asset.name, 200), type: clip(asset.type, 100) })),
    recent_tickets: [], asset_issues: [], coverage };
  const provenance = { v: 1, ticket_key: ticketKey, target: { key: ticketKey, hash: target.hash }, graph_hash: graph.hash,
    assets: assets.map(({ id, category_id, version, category_version }) => ({ id, category_id, version, category_version })),
    tickets: [], recent_keys: [], associations: [] };
  const sources = new Map([[ticketKey, target]]), included = new Map();
  let truncated = shortened(target, true) || graph.total > assets.length;
  const sourceFor = row => {
    if (!validId(row.key)) return null;
    if (!sources.has(row.key)) {
      const { asset_id: _association, ...ticket } = row;
      sources.set(row.key, snapshot(desk, ticket));
    }
    return sources.get(row.key);
  };
  function add(row, kind) {
    const source = sourceFor(row);
    if (!source) { truncated = true; return; }
    const item = { ...(kind === 'asset_issues' ? { asset_id: row.asset_id } : {}), ...ticketEvidence(source) };
    context[kind].push(item);
    if (JSON.stringify(context).length > MAX_CONTEXT) { context[kind].pop(); truncated = true; return; }
    included.set(row.key, { key: row.key, hash: source.hash, created_at: row.created_at });
    if (kind === 'recent_tickets') provenance.recent_keys.push(row.key);
    else provenance.associations.push({ asset_id: row.asset_id, ticket_key: row.key });
    if (shortened(source)) truncated = true;
  }
  // Alternating avoids filling the text budget with recent tickets before any
  // linked-asset history can be considered.
  for (let index = 0; index < Math.max(recentRows.length, historyRows.length); index++) {
    if (recentRows[index]) add(recentRows[index], 'recent_tickets');
    if (historyRows[index]) add(historyRows[index], 'asset_issues');
  }
  provenance.tickets = [...included.values()];
  coverage.recent_candidates = context.recent_tickets.length;
  coverage.asset_candidates = context.asset_issues.length;
  coverage.truncated = truncated || recentTotal > context.recent_tickets.length || historyTotal > context.asset_issues.length;
  return { context, provenance };
}

/** Recheck every supplied source, including sources the model did not cite. */
export function relatedSourcesAreCurrent({ desk, workspace, ticketKey, provenance, now }) {
  try {
    if (!provenance || provenance.v !== 1 || provenance.ticket_key !== ticketKey || provenance.target?.key !== ticketKey
      || !Array.isArray(provenance.assets) || !Array.isArray(provenance.tickets) || !Array.isArray(provenance.recent_keys)
      || !Array.isArray(provenance.associations)) return false;
    const to = Date.parse(instant(now)), from = to - HOURS * 3600000;
    const target = snapshot(desk, ticketRow(desk, ticketKey));
    if (!target || target.hash !== provenance.target.hash || linkedAssets(desk, ticketKey).hash !== provenance.graph_hash) return false;
    const assetIds = new Set();
    for (const source of provenance.assets) {
      if (!validId(source.id)) return false;
      const asset = workspace.assetRow(source.id), category = asset && workspace.categoryRow(asset.category_id);
      if (!asset || !category || category.visibility !== 'all' || asset.category_id !== source.category_id
        || asset.version !== source.version || category.version !== source.category_version) return false;
      assetIds.add(source.id);
    }
    const recent = new Set(provenance.recent_keys), ticketKeys = new Set();
    for (const source of provenance.tickets) {
      const current = snapshot(desk, ticketRow(desk, source.key)), created = current && Date.parse(current.row.created_at);
      if (!current || current.hash !== source.hash || current.row.status === 'paused' || current.row.status_kind === 'paused'
        || !Number.isFinite(created) || created > to || (recent.has(source.key) && created < from)) return false;
      ticketKeys.add(source.key);
    }
    if ([...recent].some(key => !ticketKeys.has(key))) return false;
    for (const source of provenance.associations) {
      if (!assetIds.has(source.asset_id) || !ticketKeys.has(source.ticket_key)
        || !desk.db.prepare('SELECT 1 FROM native_asset_tickets WHERE asset_id=? AND ticket_key=?').get(source.asset_id, source.ticket_key)) return false;
    }
    return true;
  } catch { return false; }
}

function publicMetadata(saved) {
  const coverage = saved?.coverage;
  const countKeys = ['recent_candidates', 'asset_candidates', 'recent_total', 'asset_total', 'linked_assets_reviewed', 'linked_assets_total'];
  const cleanCoverage = coverage && countKeys.every(key => coverage[key] === undefined || Number.isSafeInteger(coverage[key]) && coverage[key] >= 0)
    ? { ...Object.fromEntries(countKeys.filter(key => coverage[key] !== undefined).map(key => [key, coverage[key]])), truncated: Boolean(coverage.truncated) } : null;
  const window = saved?.window;
  return { reviewed_at: typeof saved?.reviewed_at === 'string' && Number.isFinite(Date.parse(saved.reviewed_at)) ? saved.reviewed_at : null,
    window: window?.hours === HOURS && typeof window.from === 'string' && typeof window.to === 'string'
      && Number.isFinite(Date.parse(window.from)) && Date.parse(window.to) - Date.parse(window.from) === HOURS * 3600000
      ? { from: window.from, to: window.to, hours: HOURS } : null,
    coverage: cleanCoverage };
}

const staleMessage = 'Ticket or asset information changed. Review this ticket again for current related issues.';
function publicTicket(desk, key, reason, history = false) {
  const row = ticketRow(desk, key);
  return { key: row.key, subject: row.subject, status: row.status, status_name: row.status_name, created_at: row.created_at,
    ...(history ? { resolution: clip(row.resolution, 2000) } : {}), reason, url: '#tickets/' + encodeURIComponent(row.key) };
}

/** Resolve all links/titles from current local records; never expose provenance. */
export function presentRelated({ desk, workspace, ticketKey, saved, user, now }) {
  const statuses = ['pending', 'ready', 'no_matches', 'disabled', 'stale', 'unavailable'];
  const status = statuses.includes(saved?.status) ? saved.status : 'pending';
  const base = { status, recent_tickets: [], asset_issues: [], ...publicMetadata(saved) };
  if (!['ready', 'no_matches'].includes(status)) return { ...base, ...(status === 'stale' ? { coverage: null } : {}),
    ...(status === 'stale' ? { message: staleMessage } : status === 'unavailable' ? { message: 'Related issue review is unavailable. Review the ticket again to retry.' } : {}) };
  const stale = () => ({ ...base, status: 'stale', coverage: null, message: staleMessage });
  if (!relatedSourcesAreCurrent({ desk, workspace, ticketKey, provenance: saved.provenance, now })) return stale();
  const recentKeys = new Set(saved.provenance.recent_keys);
  const pairs = new Set(saved.provenance.associations.map(item => item.asset_id + '\0' + item.ticket_key));
  const validReason = reason => typeof reason === 'string' && reason.trim() && [...reason].length <= 1500
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(reason);
  if (!Array.isArray(saved.recent_tickets) || saved.recent_tickets.length > 8 || !Array.isArray(saved.asset_issues) || saved.asset_issues.length > 12
    || saved.recent_tickets.some(item => !recentKeys.has(item?.ticket_key) || !validReason(item?.reason))
    || saved.asset_issues.some(item => !pairs.has(item?.asset_id + '\0' + item?.ticket_key) || !validReason(item?.reason))) return stale();
  try {
    const recent = new Map();
    for (const item of saved.recent_tickets) if (!recent.has(item.ticket_key)) recent.set(item.ticket_key, publicTicket(desk, item.ticket_key, item.reason));
    const groups = new Map(), seenPairs = new Set();
    for (const item of saved.asset_issues) {
      const pair = item.asset_id + '\0' + item.ticket_key;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      const asset = workspace.assetRow(item.asset_id), category = workspace.categoryRow(asset.category_id);
      if (!workspace.canReadCategory(category, user)) return stale();
      if (!groups.has(asset.id)) groups.set(asset.id, { asset: { id: asset.id, ref: asset.ref, name: asset.name, url: '#assets/' + encodeURIComponent(asset.id) }, tickets: [] });
      groups.get(asset.id).tickets.push(publicTicket(desk, item.ticket_key, item.reason, true));
    }
    return { ...base, status: recent.size || groups.size ? 'ready' : 'no_matches', recent_tickets: [...recent.values()], asset_issues: [...groups.values()] };
  } catch { return stale(); }
}
