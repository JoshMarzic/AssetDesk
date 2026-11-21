import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';

const plain = value => sanitizeHtml(String(value ?? ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/gu, ' ').trim();
const clip = (value, size) => String(value ?? '').slice(0, size);
const skipWords = new Set('about after again also asset before being cannot could description does error from have help issue just more need please problem submitted support system that their there these this ticket user using when where which will with work working would your'.split(' '));
const genericNames = new Set(['computer', 'desktop', 'hardware', 'keyboard', 'laptop', 'monitor', 'network', 'peripheral', 'personnel', 'phone', 'printer', 'server']);

function ticketSource(desk, key, { payload = true } = {}) {
  const ticket = desk.db.prepare('SELECT key,subject,description,requester,requester_name,location,status FROM tickets WHERE key=?').get(key);
  if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404, safeMessage: 'Ticket not found.' });
  const messages = desk.db.prepare(`SELECT id${payload ? ',payload,created_at' : ''} FROM messages WHERE ticket_key=? AND sender=? COLLATE NOCASE ORDER BY rowid DESC LIMIT ${payload ? 5 : 20}`).all(key, ticket.requester);
  return { ticket, messages };
}

export function ticketInputHash(desk, key) {
  const { ticket, messages } = ticketSource(desk, key, { payload: false });
  // Tags, assignment, and the location enrichment itself do not change the
  // requester-provided problem. New mail and manual subject edits do.
  return createHash('sha256').update(JSON.stringify([ticket.key, ticket.subject, ticket.description, ticket.requester, ticket.requester_name, messages.map(message => message.id)])).digest('hex');
}

function literalMention(input, value, identifier = false) {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = identifier ? '\\p{L}\\p{N}_.-' : '\\p{L}\\p{N}_';
  return new RegExp(`(?<![${boundary}])${escaped}(?![${boundary}])`, 'iu').test(input);
}

function sharedAssetCandidates(desk, original) {
  const input = original.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/giu, ' ').replace(/[^\s<>@]+@[^\s<>@]+/gu, ' ');
  const rows = desk.db.prepare(`SELECT a.id,a.ref,a.name,a.type,a.category_id,a.serial_number,a.version FROM native_assets a
    JOIN knowledge_categories c ON c.id=a.category_id WHERE c.visibility='all' AND
    ((length(a.ref)>=3 AND instr(lower(?),lower(a.ref))>0) OR
     (length(a.name)>=5 AND instr(lower(?),lower(a.name))>0) OR
     (length(a.serial_number)>=4 AND instr(lower(?),lower(a.serial_number))>0))
    ORDER BY a.ref COLLATE NOCASE,a.id LIMIT 100`).all(input, input, input);
  return rows.filter(row => {
    if (row.ref.length >= 3 && literalMention(input, row.ref, true)) return true;
    if (row.serial_number.length >= 4 && literalMention(input, row.serial_number, true) && desk.db.prepare("SELECT COUNT(*) AS count FROM native_assets a JOIN knowledge_categories c ON c.id=a.category_id WHERE c.visibility='all' AND a.serial_number=? COLLATE NOCASE").get(row.serial_number).count === 1) return true;
    return row.name.length >= 5 && !genericNames.has(row.name.trim().toLowerCase()) && literalMention(input, row.name)
      && desk.db.prepare("SELECT COUNT(*) AS count FROM native_assets a JOIN knowledge_categories c ON c.id=a.category_id WHERE c.visibility='all' AND a.name=? COLLATE NOCASE").get(row.name).count === 1;
  }).slice(0, 25).map(({ serial_number, ...row }) => ({ ...row }));
}

function documents(desk, input) {
  const words = [...new Set((input.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) || []).filter(word => !skipWords.has(word)))].slice(0, 12);
  if (!words.length) return [];
  const escaped = words.map(word => '%' + word.replace(/[\\%_]/g, char => '\\' + char) + '%');
  const where = words.map(() => "(a.name LIKE ? ESCAPE '\\' OR a.html LIKE ? ESCAPE '\\')").join(' OR ');
  const rows = desk.db.prepare(`SELECT a.id,a.name,a.html,a.version,a.category_id FROM knowledge_articles a JOIN knowledge_categories c ON c.id=a.category_id
    WHERE c.visibility='all' AND (${where}) ORDER BY a.updated_at DESC,a.id LIMIT 50`).all(...escaped.flatMap(word => [word, word]));
  return rows.map(row => {
    const text = plain(row.html), title = row.name.toLocaleLowerCase(), body = text.toLocaleLowerCase();
    const score = words.reduce((total, word) => total + (title.includes(word) ? 4 : 0) + (body.includes(word) ? 1 : 0), 0);
    return { id: row.id, name: row.name, text: clip(text, 5000), version: row.version, category_id: row.category_id, score };
  }).filter(row => row.score).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, 8).map(({ score, ...row }) => row);
}

export function buildAiContext({ desk, ticketKey }) {
  const { ticket, messages } = ticketSource(desk, ticketKey);
  const requester_messages = messages.slice(0, 5).toReversed().flatMap(message => {
    try {
      const payload = JSON.parse(message.payload);
      return [{ text: clip(payload.text, 5000), received_at: payload.receivedAt || message.created_at }];
    } catch { return []; }
  });
  const original = clip(`${ticket.subject}\n${ticket.description}`, 30000);
  const people = desk.db.prepare(`SELECT a.id,a.location,a.category_id FROM native_assets a JOIN knowledge_categories c ON c.id=a.category_id
    WHERE a.type='personnel' AND c.visibility='all' AND a.email=? COLLATE NOCASE ORDER BY a.id LIMIT 2`).all(ticket.requester);
  const person = people.length === 1 && people[0].location.trim() ? people[0] : null;
  return {
    input_hash: ticketInputHash(desk, ticketKey),
    ticket: { ...ticket, description: clip(ticket.description, 20000), requester_messages },
    requester_location: person ? { asset_id: person.id, category_id: person.category_id, location: person.location } : null,
    asset_candidates: sharedAssetCandidates(desk, original),
    documentation: documents(desk, `${original}\n${requester_messages.map(message => message.text).join('\n')}`),
  };
}

export function sharedSourceIsCurrent(workspace, source, kind = 'article') {
  if (!source?.id || !source.category_id) return false;
  const category = workspace.categoryRow(source.category_id);
  if (category?.visibility !== 'all') return false;
  const table = kind === 'asset' ? 'native_assets' : 'knowledge_articles';
  const row = workspace.db.prepare(`SELECT category_id,version FROM ${table} WHERE id=?`).get(source.id);
  return Boolean(row && row.category_id === source.category_id && row.version === source.version);
}
