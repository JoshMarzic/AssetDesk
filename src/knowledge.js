import express from 'express';
import sanitizeHtml from 'sanitize-html';
import { createHash } from 'node:crypto';

const ARTICLE_LIMIT = 300_000;
const IMAGE_PREFIX = '/uploads/images/';
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode, safeMessage: message }); }
function positive(value, field = 'ID') {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw fail(`Invalid ${field}.`);
  return Number(value);
}
function scalar(value, max = 200) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw fail('Invalid knowledge-base query.');
  return value.trim();
}
function bodyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !allowed.includes(name))) throw fail('Provide valid article fields.');
}
function title(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\x00-\x1f]/.test(value)) throw fail('An article title of 1 to 255 characters is required.');
  return value.trim();
}
const revision = page => createHash('sha256').update(JSON.stringify([page.updated_at, page.name, page.raw_html ?? page.html, page.chapter_id])).digest('hex');
const plain = html => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();

function configuredPaths(bookstack) {
  const bases = [bookstack.publicUrl, bookstack.url].filter(Boolean).map(value => new URL(value));
  return input => {
    let url;
    try { url = new URL(input, `${bookstack.publicUrl || bookstack.url}/`); } catch { return null; }
    for (const base of bases) {
      const prefix = base.pathname.replace(/\/$/, '');
      if (url.origin === base.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
        return { path: url.pathname.slice(prefix.length) || '/', hash: url.hash, search: url.search };
      }
    }
    return null;
  };
}

export function imagePath(value, bookstack) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\\%\x00-\x1f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null;
  const owned = value.startsWith(IMAGE_PREFIX) ? { path: value, search: '', hash: '' } : configuredPaths(bookstack)(value);
  if (!owned || owned.search || owned.hash) return null;
  let path;
  try { path = decodeURIComponent(owned.path); } catch { return null; }
  if (!path.startsWith(IMAGE_PREFIX) || /[\\%?#\x00-\x1f]/.test(path)
    || path.split('/').some(part => part === '.' || part === '..') || !/\.(?:png|jpe?g|gif|webp)$/i.test(path)) return null;
  return path;
}

/** Wiki content is data, never executable application markup. */
export function cleanKnowledgeHtml(html, { bookstack, articleId, storage = false, pageLinks = new Map(), imagePaths } = {}) {
  const ownedPath = configuredPaths(bookstack);
  const anchorId = value => {
    let id = String(value || '').replace(/^kb-\d+-/, '');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(id)) return null;
    return storage ? id : `kb-${articleId}-${id}`;
  };
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'div', 'span', 'details', 'summary'],
    allowedAttributes: { '*': ['id'], a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'width', 'height', 'loading'], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'], ol: ['start'] },
    allowedSchemes: ['http', 'https', 'mailto'], allowedSchemesByTag: { img: ['http', 'https'] }, allowProtocolRelative: false,
    transformTags: {
      '*': (tagName, attributes) => {
        const attribs = { ...attributes };
        if (attribs.id) { const id = anchorId(attribs.id); if (id) attribs.id = id; else delete attribs.id; }
        return { tagName, attribs };
      },
      a: (_tagName, attributes) => {
        const attribs = { title: attributes.title };
        const input = attributes.href || '';
        const embedded = input.match(/^#knowledge\/article\/(\d+)(?:#(.*))?$/);
        if (embedded) {
          attribs.href = storage ? bookstack.pageUrl(Number(embedded[1])) : `#knowledge/article/${embedded[1]}`;
        } else if (input.startsWith('#') && !input.startsWith('#knowledge/')) {
          const id = anchorId(input.slice(1)); if (id) attribs.href = `#${id}`;
        } else {
          const owned = ownedPath(input);
          if (owned) {
            const direct = owned.path.match(/^\/link\/(\d+)\/?$/);
            const id = direct ? Number(direct[1]) : pageLinks.get(owned.path.replace(/\/$/, ''));
            if (id) attribs.href = storage ? bookstack.pageUrl(id) : `#knowledge/article/${id}`;
            else return { tagName: 'span', attribs: {} };
          } else {
            let url; try { url = new URL(input); } catch { url = null; }
            if (url && ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) {
              attribs.href = url.href; attribs.target = '_blank'; attribs.rel = 'noopener noreferrer';
            }
          }
        }
        return { tagName: 'a', attribs };
      },
      img: (_tagName, attributes) => {
        const attribs = { alt: attributes.alt || '' };
        let path = imagePath(attributes.src, bookstack);
        // An editor may send back the same-origin image URL obtained from the reader.
        if (!path && storage && typeof attributes.src === 'string' && attributes.src.startsWith('/api/desk/knowledge/images?')) {
          try { path = imagePath(`${bookstack.publicUrl}${new URL(attributes.src, 'http://assetdesk.invalid').searchParams.get('path')}`, bookstack); } catch { /* rejected below */ }
        }
        if (path) {
          imagePaths?.add(path);
          attribs.src = storage ? `${bookstack.publicUrl}${path}` : `/api/desk/knowledge/images?article_id=${articleId}&path=${encodeURIComponent(path)}`;
          attribs.loading = 'lazy';
          for (const dimension of ['width', 'height']) if (/^\d{1,4}$/.test(attributes[dimension] || '') && Number(attributes[dimension]) <= 4096) attribs[dimension] = attributes[dimension];
        }
        return { tagName: 'img', attribs };
      },
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
  });
}

export function createKnowledgeRouter({ bookstack, config = {} }) {
  const router = express.Router();
  let bookPromise, scopePromise;
  const linkCache = new Map(), linksInFlight = new Map(), lookupWaiters = [];
  let activeLookups = 0;
  const ensureBook = () => {
    if (!bookPromise) bookPromise = Promise.resolve().then(() => bookstack.ensureKnowledgeBook({ bookId: config.knowledgeBookId }))
      .catch(error => { bookPromise = null; throw error; });
    return bookPromise;
  };
  const scopes = () => {
    if (!scopePromise) scopePromise = Promise.all([ensureBook(), bookstack.ensureWorkspace()]).then(([book, workspace]) => ({ book, workspace }))
      .catch(error => { scopePromise = null; throw error; });
    return scopePromise;
  };
  async function scopedPage(id) {
    const [{ book, workspace }, page] = await Promise.all([scopes(), bookstack.getPage(id)]);
    const type = Number(page.book_id) === Number(book.id) ? 'knowledge' : Number(page.book_id) === Number(workspace.assetBook.id) ? 'asset' : Number(page.book_id) === Number(workspace.ticketBook.id) ? 'ticket' : null;
    if (!type) throw fail('Article not found in the AssetDesk knowledge base.', 404);
    return { page, type, book };
  }
  async function withLookupSlot(action) {
    if (activeLookups >= 3) await new Promise(resolve => lookupWaiters.push(resolve));
    else activeLookups++;
    try { return await action(); }
    finally { if (lookupWaiters.length) lookupWaiters.shift()(); else activeLookups--; }
  }
  function resolveCanonical(book, slug) {
    const key = `${book.id}:${slug}`;
    const cached = linkCache.get(key);
    if (cached && cached.expires > Date.now()) {
      linkCache.delete(key); linkCache.set(key, cached);
      return Promise.resolve(cached.id);
    }
    if (cached) linkCache.delete(key);
    if (linksInFlight.has(key)) return linksInFlight.get(key);
    // Bound pending lookup work as well as retained cache entries.
    if (linksInFlight.size >= 256) return Promise.resolve(null);
    const pending = withLookupSlot(async () => {
      const result = await bookstack.request(`/pages?filter[book_id]=${Number(book.id)}&filter[slug]=${encodeURIComponent(slug)}&count=2&offset=0`);
      const matches = Array.isArray(result.data) ? result.data.filter(page => Number(page.book_id) === Number(book.id) && page.slug === slug) : [];
      const id = matches.length === 1 && Number.isSafeInteger(Number(matches[0].id)) && Number(matches[0].id) > 0 ? Number(matches[0].id) : null;
      if (linkCache.size >= 256) linkCache.delete(linkCache.keys().next().value);
      linkCache.set(key, { id, expires: Date.now() + 5 * 60_000 });
      return id;
    }).catch(() => null).finally(() => linksInFlight.delete(key));
    linksInFlight.set(key, pending);
    return pending;
  }
  async function canonicalLinks(html) {
    const links = new Map();
    if (!/\/books\/[^/\s"']+\/page\//.test(html)) return links;
    const referenced = new Set(), ownedPath = configuredPaths(bookstack);
    sanitizeHtml(html, { allowedTags: ['a'], allowedAttributes: { a: ['href'] }, transformTags: {
      a: (tagName, attributes) => {
        const owned = ownedPath(attributes.href || '');
        if (referenced.size < 32 && owned && /^\/books\/[^/]+\/page\/[^/]+\/?$/.test(owned.path)) referenced.add(owned.path.replace(/\/$/, ''));
        return { tagName, attribs: {} };
      },
    } });
    if (!referenced.size) return links;
    const { book, workspace } = await scopes(), books = [book, workspace.assetBook, workspace.ticketBook];
    await Promise.all([...referenced].map(async path => {
      const [, rawBook, rawSlug] = path.match(/^\/books\/([^/]+)\/page\/([^/]+)$/);
      let bookSlug, slug;
      try { bookSlug = decodeURIComponent(rawBook); slug = decodeURIComponent(rawSlug); } catch { return; }
      if (!slug || slug.length > 255 || /[\\/\x00-\x1f]/.test(slug)) return;
      const targetBook = books.find(item => item.slug === bookSlug);
      if (!targetBook) return;
      const id = await resolveCanonical(targetBook, slug);
      if (id) links.set(path, id);
    }));
    return links;
  }
  async function articleResponse(page, type) {
    const html = page.raw_html ?? page.html ?? '';
    return { id: page.id, name: page.name, book_id: page.book_id, chapter_id: page.chapter_id,
      updated_at: page.updated_at, revision: revision(page), kind: type, canEdit: type !== 'ticket',
      html: cleanKnowledgeHtml(html, { bookstack, articleId: page.id, pageLinks: await canonicalLinks(html) }) };
  }
  async function chapterInBook(id, bookId) {
    const chapter = await bookstack.request(`/chapters/${id}`);
    if (Number(chapter.book_id) !== Number(bookId)) throw fail('Choose a chapter in this knowledge base.');
    return chapter;
  }

  router.get('/', async (req, res) => {
    const book = await ensureBook();
    const limit = req.query.limit === undefined ? 50 : positive(req.query.limit, 'page size');
    const offset = req.query.offset === undefined ? 0 : /^\d+$/.test(String(req.query.offset)) ? Number(req.query.offset) : NaN;
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw fail('Invalid knowledge-base pagination.');
    const search = req.query.search === undefined ? '' : scalar(req.query.search, 200);
    const chapter = req.query.chapter_id === undefined || req.query.chapter_id === '' ? null : positive(req.query.chapter_id, 'chapter');
    const chapters = (await bookstack.list(`/chapters?filter[book_id]=${Number(book.id)}`)).filter(value => Number(value.book_id) === Number(book.id));
    if (chapter && !chapters.some(value => Number(value.id) === chapter)) throw fail('Choose a chapter in this knowledge base.');
    let listing;
    if (search) {
      if (offset % limit) throw fail('Search offset must be a multiple of page size.');
      listing = await bookstack.request(`/search/${chapter ? `chapter/${chapter}` : `book/${Number(book.id)}`}?query=${encodeURIComponent(`${search} {type:page}`)}&count=${limit}&page=${offset / limit + 1}`);
    } else {
      listing = await bookstack.request(`/pages?filter[book_id]=${Number(book.id)}${chapter ? `&filter[chapter_id]=${chapter}` : ''}&sort=-updated_at&count=${limit}&offset=${offset}`);
    }
    if (!Array.isArray(listing.data) || !Number.isSafeInteger(listing.total) || listing.total < 0) throw fail('BookStack returned an invalid article listing.', 502);
    const articles = listing.data.filter(page => Number(page.book_id) === Number(book.id) && (!page.type || page.type === 'page') && (!chapter || Number(page.chapter_id) === chapter)).map(page => ({
      id: page.id, name: page.name, chapter_id: page.chapter_id, updated_at: page.updated_at,
      excerpt: plain(page.preview_html?.content || page.description || '').slice(0, 240),
    }));
    res.json({ book: { id: book.id, name: book.name, description: book.description || '' },
      chapters: chapters.map(value => ({ id: value.id, name: value.name, description: value.description || '' })),
      articles, total: listing.total, limit, offset });
  });
  router.get('/articles/:id', async (req, res) => {
    const { page, type } = await scopedPage(positive(req.params.id, 'article'));
    res.json(await articleResponse(page, type));
  });
  router.post('/articles', async (req, res) => {
    bodyFields(req.body, ['name', 'html', 'chapter_id']);
    const name = title(req.body.name), book = await ensureBook();
    if (typeof req.body.html !== 'string' || req.body.html.length > ARTICLE_LIMIT) throw fail('Article content must be at most 300,000 characters.');
    const images = new Set();
    const html = cleanKnowledgeHtml(req.body.html, { bookstack, storage: true, pageLinks: await canonicalLinks(req.body.html), imagePaths: images });
    if (images.size) throw fail('Image insertion is not available in AssetDesk yet. Existing article images can be retained when editing.');
    if (!plain(html) && !/<img\s/.test(html)) throw fail('Add article content before saving.');
    const data = { book_id: book.id, name, html };
    if (req.body.chapter_id !== undefined && req.body.chapter_id !== null && req.body.chapter_id !== '') {
      data.chapter_id = positive(req.body.chapter_id, 'chapter'); await chapterInBook(data.chapter_id, book.id); delete data.book_id;
    }
    const page = await bookstack.createPage(data);
    linkCache.clear();
    res.status(201).json(await articleResponse(page, 'knowledge'));
  });
  router.patch('/articles/:id', async (req, res) => {
    bodyFields(req.body, ['name', 'html', 'updated_at', 'revision']);
    const { page, type } = await scopedPage(positive(req.params.id, 'article'));
    if (type === 'ticket') throw fail('Manage ticket workflow and notes in the ticket dashboard.', 403);
    if (typeof req.body.updated_at !== 'string' || req.body.updated_at !== page.updated_at
      || (req.body.revision !== undefined && req.body.revision !== revision(page))) throw fail('This article changed. Reload it before saving your edits.', 409);
    const name = title(req.body.name);
    if (typeof req.body.html !== 'string' || req.body.html.length > ARTICLE_LIMIT) throw fail('Article content must be at most 300,000 characters.');
    const existingImages = new Set(), incomingImages = new Set();
    cleanKnowledgeHtml(page.raw_html ?? page.html ?? '', { bookstack, articleId: page.id, imagePaths: existingImages });
    const html = cleanKnowledgeHtml(req.body.html, { bookstack, storage: true, pageLinks: await canonicalLinks(req.body.html), imagePaths: incomingImages });
    if ([...incomingImages].some(path => !existingImages.has(path))) throw fail('Only images already present in this article can be retained. Image insertion is not available in AssetDesk yet.');
    if (!plain(html) && !/<img\s/.test(html)) throw fail('Add article content before saving.');
    const saved = await bookstack.updatePage(page.id, { name, html, changelog: `Edited in AssetDesk by ${String(req.deskSession.user.name || 'technician').slice(0, 80)}` });
    linkCache.clear();
    res.json(await articleResponse(saved, type));
  });
  router.post('/chapters', async (req, res) => {
    if (req.deskSession.user.role !== 'admin') throw fail('Administrator access is required to manage knowledge categories.', 403);
    bodyFields(req.body, ['name', 'description']);
    const book = await ensureBook(), name = title(req.body.name);
    const description = req.body.description === undefined ? '' : scalar(req.body.description, 2000);
    const chapter = await bookstack.request('/chapters', { method: 'POST', body: { book_id: book.id, name, description } });
    res.status(201).json({ id: chapter.id, name: chapter.name, description: chapter.description || '' });
  });
  router.get('/images', async (req, res) => {
    const id = positive(req.query.article_id, 'article');
    const { page } = await scopedPage(id);
    const path = imagePath(req.query.path, bookstack);
    if (!path) throw fail('Invalid knowledge image path.');
    const referenced = new Set();
    cleanKnowledgeHtml(page.raw_html ?? page.html ?? '', { bookstack, articleId: id, imagePaths: referenced });
    if (!referenced.has(path)) throw fail('Image is not referenced by this article.', 404);
    const image = await bookstack.readImage(path);
    res.set('Cache-Control', 'private, max-age=300');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(image.contentType).send(image.data);
  });
  router.use((error, _req, res, _next) => {
    const status = error.statusCode || error.status;
    if ([400, 403, 404, 409, 413, 415].includes(status)) return res.status(status).json({ error: error.safeMessage || error.message });
    res.status(503).json({ error: 'The knowledge base is temporarily unavailable. Your ticket dashboard remains available.' });
  });
  return router;
}
