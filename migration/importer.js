import sanitizeHtml from 'sanitize-html';
import { basename } from 'node:path';

const now = () => new Date().toISOString();
const plain = html => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
const normalized = value => String(value || '').trim().toUpperCase();
const isRef = value => /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(value);
const field = (page, name) => page.tags?.find(tag => normalized(tag.name) === normalized(name))?.value;
const safeName = (name, max = 100) => String(name || '').trim().slice(0, max) || 'Imported documentation';
// Reprocess untouched earlier imports when link translation improves, while
// preserving documents edited in AssetDesk after their import.
const LINK_REVISION = 2;

function originalPath(value, legacy) {
  try {
    const url = new URL(value, `${legacy.publicUrl}/`);
    for (const base of [legacy.publicUrl, legacy.url].map(value => new URL(value))) {
      const prefix = base.pathname.replace(/\/$/, '');
      if (url.origin === base.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return url.pathname.slice(prefix.length) || '/';
    }
  } catch {}
  return null;
}
function imagePath(value, legacy) {
  let path = originalPath(value, legacy);
  if (!path) return null;
  try { path = decodeURIComponent(path); } catch { return null; }
  return path.startsWith('/uploads/images/') && !/[\\%?#\x00-\x1f]/.test(path)
    && !path.split('/').some(value => value === '.' || value === '..') && /\.(?:png|jpe?g|gif|webp)$/i.test(path) ? path : null;
}
function assetDetails(page) {
  const rows = new Map();
  for (const row of (page.raw_html || page.html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => plain(match[1]));
    if (cells.length >= 2 && !/^(?:to be confirmed|unassigned|unknown)$/i.test(cells[1])) rows.set(cells[0].toLowerCase(), cells[1]);
  }
  const get = (...names) => names.map(name => rows.get(name)).find(Boolean) || '';
  const ref = normalized(field(page, 'Asset ID') || get('asset id') || page.name);
  const type = /^(PERSON|PERSONNEL|EMPLOYEE|STAFF)-/.test(ref) ? 'personnel' : /^(PC|DESKTOP)-/.test(ref) ? 'pc' : /^LAPTOP-/.test(ref) ? 'laptop'
    : /^(SRV|SERVER)-/.test(ref) ? 'server' : /^PRINTER-/.test(ref) ? 'printer' : /^(SW|SWITCH|AP|ROUTER)-/.test(ref) ? 'network' : 'hardware';
  const status = get('lifecycle status', 'status').toLowerCase();
  return { ref: isRef(ref) ? ref : `LEGACY-${page.id}`, name: safeName(page.name || ref, 200), type,
    owner_name: get('owner / assigned user', 'owner', 'assigned user').slice(0, 200), department: get('department').slice(0, 200),
    location: get('location').slice(0, 300), serial_number: get('serial number', 'serial').slice(0, 200),
    manufacturer: get('manufacturer').slice(0, 200), model: get('manufacturer / model', 'model').slice(0, 200),
    email: /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(get('email')) ? get('email').slice(0, 254) : '',
    status: ['active', 'spare', 'repair', 'retired', 'unverified'].includes(status) ? status : 'unverified',
    description: plain(page.raw_html || page.html || '').slice(0, 100000),
  };
}

/** One-time, explicit migration. This module is never imported by the server. */
export async function importLegacyWorkspace({ legacy, workspace, user, source = legacy.publicUrl, knowledgeBookId, onProgress = () => {} }) {
  if (user?.role !== 'admin' || user.active === false) throw new Error('An active AssetDesk administrator is required for import.');
  const db = workspace.db;
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_import_state (
    source TEXT NOT NULL, source_id TEXT NOT NULL, target_type TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0, native_version INTEGER NOT NULL DEFAULT 1, link_revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY(source,source_id,target_type)
  )`);
  if (!db.prepare('PRAGMA table_info(legacy_import_state)').all().some(column => column.name === 'native_version')) db.exec('ALTER TABLE legacy_import_state ADD COLUMN native_version INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare('PRAGMA table_info(legacy_import_state)').all().some(column => column.name === 'link_revision')) db.exec('ALTER TABLE legacy_import_state ADD COLUMN link_revision INTEGER NOT NULL DEFAULT 1');
  const counts = { categories: 0, assets: 0, articles: 0, images: 0, skipped: 0, imagesUnavailable: 0, unresolvedLinks: 0, ticketMirrorsSkipped: 0 };
  const lookup = (id, type) => db.prepare('SELECT target_id FROM workspace_imports WHERE source=? AND source_id=? AND target_type=?').get(source, String(id), type)?.target_id;
  const mapped = (id, type, nativeId, complete = false, nativeVersion = 1) => {
    db.prepare('INSERT OR IGNORE INTO workspace_imports (source,source_id,target_type,target_id,imported_at) VALUES (?,?,?,?,?)').run(source, String(id), type, nativeId, now());
    db.prepare('INSERT INTO legacy_import_state(source,source_id,target_type,complete,native_version,link_revision,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,source_id,target_type) DO UPDATE SET complete=excluded.complete,native_version=excluded.native_version,link_revision=excluded.link_revision,updated_at=excluded.updated_at').run(source, String(id), type, complete ? 1 : 0, nativeVersion, LINK_REVISION, now());
  };
  const complete = (id, type) => {
    const state = db.prepare('SELECT complete,link_revision FROM legacy_import_state WHERE source=? AND source_id=? AND target_type=?').get(source, String(id), type);
    return state?.complete === 1 && state.link_revision >= LINK_REVISION;
  };
  async function read(action) {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); } catch (error) {
        if (![429, 502, 503, 504].includes(error.status) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, 2000 * 2 ** attempt)));
      }
    }
  }
  const books = await read(() => legacy.list('/books'));
  const chapters = await read(() => legacy.list('/chapters'));
  const listing = await read(() => legacy.list('/pages'));
  const booksById = new Map(books.map(book => [Number(book.id), book]));
  const chaptersById = new Map(chapters.map(chapter => [Number(chapter.id), chapter]));
  const pages = [];
  for (const listed of listing) {
    const book = booksById.get(Number(listed.book_id));
    if (book?.name === 'Tickets') { counts.ticketMirrorsSkipped++; continue; }
    if (knowledgeBookId && Number(listed.book_id) !== Number(knowledgeBookId) && book?.name !== 'Assets') continue;
    pages.push(await read(() => legacy.getPage(listed.id)));
    if (pages.length % 10 === 0) onProgress(`Read ${pages.length} legacy documentation records.`);
  }
  const category = (legacyKey, name, kind) => {
    const existing = lookup(legacyKey, 'category');
    if (existing) return existing;
    // Never adopt an unrelated pre-existing category or widen its permissions.
    let candidate = safeName(`Imported / ${name}`);
    const taken = new Set(workspace.listCategories(user).filter(value => value.kind === kind).map(value => value.name.toLowerCase()));
    if (taken.has(candidate.toLowerCase())) candidate = safeName(`${candidate.slice(0, 82)} (${String(legacyKey).replace(/[^A-Za-z0-9]/g, '').slice(-12)})`);
    return workspace.transaction(() => {
    const created = workspace.createCategory({ name: candidate, description: 'Imported legacy documentation. Review category access before sharing.', kind,
      visibility: 'restricted', reader_ids: [], editor_ids: [], allow_staff_edit: false }, user);
    mapped(legacyKey, 'category', created.id, true); counts.categories++;
    return created.id;
    });
  };
  const records = [];
  for (const page of pages) {
    const book = booksById.get(Number(page.book_id));
    const chapter = chaptersById.get(Number(page.chapter_id));
    const isAsset = Boolean(field(page, 'Asset ID')) || book?.name === 'Assets';
    const categoryId = category(isAsset ? 'assets' : chapter ? `chapter-${chapter.id}` : `book-${page.book_id}`,
      isAsset ? 'Assets' : `${book?.name || 'Knowledge'}${chapter ? ` / ${chapter.name}` : ''}`, isAsset ? 'assets' : 'knowledge');
    let assetId;
    if (isAsset) {
      assetId = lookup(page.id, 'asset');
      if (!assetId) {
        assetId = workspace.transaction(() => {
        const details = assetDetails(page);
        const existing = workspace.assetRow(details.ref);
        // Auto-created legacy placeholders may be enriched. An intentionally
        // maintained native record keeps its fields and category permissions.
        const maintained = existing && (existing.created_by || existing.version > 1);
        const asset = maintained ? existing : existing
          ? workspace.updateAsset(existing.id, { ...details, category_id: categoryId }, user, { version: existing.version })
          : workspace.createAsset({ ...details, category_id: categoryId }, user);
        mapped(page.id, 'asset', asset.id, true); counts.assets++; return asset.id;
        });
      }
    }
    let articleId = lookup(page.id, 'article');
    if (!articleId) {
      articleId = workspace.transaction(() => {
      const article = workspace.createArticle({ name: safeName(isAsset ? `${page.name} — imported documentation` : page.name, 255),
        html: '<p>Import in progress. Run the import again if it was interrupted.</p>', category_id: categoryId }, user);
      mapped(page.id, 'article', article.id); counts.articles++; return article.id;
      });
    }
    records.push({ page, articleId, assetId });
  }
  const pageLinks = new Map();
  for (const { page, articleId, assetId } of records) {
    const target = assetId ? `#assets/${assetId}` : `#knowledge/article/${articleId}`;
    pageLinks.set(`/link/${page.id}`, target);
    const book = booksById.get(Number(page.book_id));
    if (book?.slug && page.slug) pageLinks.set(`/books/${book.slug}/page/${page.slug}`, target);
  }
  const ticketsByPageId = new Map(db.prepare('SELECT key,page_id FROM tickets WHERE page_id>0').all().map(ticket => [Number(ticket.page_id), ticket]));
  for (const ticket of ticketsByPageId.values()) pageLinks.set(`/link/${ticket.page_id}`, `#tickets/${encodeURIComponent(ticket.key)}`);
  for (const listed of listing) {
    const ticket = ticketsByPageId.get(Number(listed.id));
    const book = booksById.get(Number(listed.book_id));
    if (ticket && book?.slug && listed.slug) pageLinks.set(`/books/${book.slug}/page/${listed.slug}`, `#tickets/${encodeURIComponent(ticket.key)}`);
  }
  let processed = 0;
  for (const { page, articleId } of records) {
    processed++;
    if (complete(page.id, 'article')) { counts.skipped++; continue; }
    const current = workspace.getArticle(articleId, user);
    const importedVersion = db.prepare("SELECT native_version FROM legacy_import_state WHERE source=? AND source_id=? AND target_type='article'").get(source,String(page.id))?.native_version ?? 1;
    if (current.version !== importedVersion) {
      // The placeholder was edited by a person while a previous import was interrupted.
      mapped(page.id, 'article', articleId, true, importedVersion); counts.skipped++; continue;
    }
    const original = page.raw_html ?? page.html ?? '';
    const images = new Map();
    const paths = new Set();
    for (const match of original.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
      const path = imagePath(match[2].replaceAll('&amp;', '&'), legacy); if (path) paths.add(path);
    }
    let missingImages = false;
    for (const path of paths) {
      let mediaId = lookup(`${page.id}:${path}`, 'media');
      if (!mediaId) {
        try {
          const image = await read(() => legacy.readImage(path));
          mediaId = workspace.transaction(() => {
          const media = workspace.addMedia({ article_id: articleId, filename: basename(path).slice(0, 200), mime: image.contentType, data: image.data }, user);
          mapped(`${page.id}:${path}`, 'media', media.id, true); counts.images++; return media.id;
          });
        } catch { counts.imagesUnavailable++; missingImages = true; }
      }
      if (mediaId) images.set(path, `/api/desk/knowledge/media/${mediaId}`);
    }
    const html = sanitizeHtml(original, {
      allowedTags: ['h1','h2','h3','h4','h5','h6','p','br','hr','strong','b','em','i','u','s','del','ins','sub','sup','ul','ol','li','blockquote','pre','code','a','img','table','thead','tbody','tfoot','tr','th','td','caption','div','span','details','summary'],
      allowedAttributes: { '*':['id'], a:['href','title','target','rel'], img:['src','alt','width','height'], th:['colspan','rowspan','scope'], td:['colspan','rowspan'], ol:['start'] },
      allowedSchemes: ['http','https','mailto'], allowProtocolRelative: false,
      transformTags: {
        a: (_tag, attrs) => {
          const href = String(attrs.href || '');
          const embedded = href.match(/^#knowledge\/article\/(\d+)$/);
          // Hash links are local navigation, not URLs relative to the legacy
          // site's root. Translate the former numeric article route first.
          if (href.startsWith('#') && !embedded) return {tagName:'a',attribs:{href}};
          const path = embedded ? `/link/${embedded[1]}` : originalPath(href, legacy);
          const target = path ? pageLinks.get(path.replace(/\/$/, '')) : null;
          if (target) return { tagName:'a', attribs:{href:target} };
          if (path) { counts.unresolvedLinks++; return {tagName:'span',attribs:{}}; }
          try { const url = new URL(attrs.href); if (['http:','https:','mailto:'].includes(url.protocol) && !url.username && !url.password) return {tagName:'a',attribs:{href:url.href,target:'_blank',rel:'noopener noreferrer'}}; } catch {}
          return {tagName:'span',attribs:{}};
        },
        img: (_tag, attrs) => {
          const path = imagePath(attrs.src, legacy), url = path && images.get(path);
          return {tagName:'img',attribs:{...(url?{src:url}:{}),alt:attrs.alt||'Imported image unavailable'}};
        },
      },
      exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
    });
    workspace.transaction(() => {
      const latest = workspace.getArticle(articleId, user);
      if (latest.version !== importedVersion) { mapped(page.id, 'article', articleId, true, importedVersion); return; }
      const saved = workspace.updateArticle(articleId, {html: html.trim() || '<p>No text content was present in this legacy page.</p>'}, user, {version:latest.version});
      mapped(page.id, 'article', articleId, !missingImages, saved.version);
    });
    onProgress(`Processed ${processed} of ${records.length} article records; ${counts.images} image files copied.`);
  }
  return counts;
}
