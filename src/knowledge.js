import express from 'express';
import sanitizeHtml from 'sanitize-html';

const ARTICLE_LIMIT = 300_000;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const MEDIA_PATH = new RegExp(`^/api/desk/knowledge/media/(${ID})$`);
const ARTICLE_LINK = new RegExp(`^#knowledge/article/(${ID})(?:#([A-Za-z][A-Za-z0-9_-]{0,199}))?$`);
const ASSET_LINK = new RegExp(`^#assets/(${ID})$`);
const TICKET_LINK = new RegExp(`^#tickets/(${ID})$`);
const ALLOWED_TAGS = ['h1','h2','h3','h4','h5','h6','p','br','hr','strong','b','em','i','u','s','del','ins','sub','sup','ul','ol','li','blockquote','pre','code','a','img','table','thead','tbody','tfoot','tr','th','td','caption','div','span','details','summary'];

export function workspaceError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, safeMessage: message });
}
export function bodyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw workspaceError('Provide valid record fields.');
  }
  return body;
}
function scalar(value, field, max = 200) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw workspaceError(`Invalid ${field}.`);
  return value.trim();
}
export function recordId(value) {
  if (typeof value !== 'string' || !new RegExp(`^${ID}$`).test(value)) throw workspaceError('Invalid record ID.');
  return value;
}
export function listFilters(query, extra = []) {
  const filters = {};
  for (const name of ['search', 'category_id', ...extra]) if (query[name] !== undefined && query[name] !== '') {
    filters[name] = scalar(query[name], `${name} filter`, name === 'search' ? 200 : 100);
  }
  for (const name of ['limit', 'offset']) if (query[name] !== undefined) {
    if (typeof query[name] !== 'string' || !/^\d{1,7}$/.test(query[name])) throw workspaceError(`Invalid ${name}.`);
    filters[name] = Number(query[name]);
  }
  if (filters.limit !== undefined && (filters.limit < 1 || filters.limit > 100)) throw workspaceError('Limit must be between 1 and 100.');
  if (filters.offset !== undefined && filters.offset > 1_000_000) throw workspaceError('Offset is too large.');
  return filters;
}
export function workspaceErrorHandler(error, _req, res, _next) {
  const status = error.statusCode || error.status;
  if ([400,401,403,404,409,413,415,429].includes(status)) {
    return res.status(status).json({ error: error instanceof SyntaxError ? 'Malformed JSON.' : status === 413 ? 'Request is too large.' : error.safeMessage || error.message });
  }
  return res.status(500).json({ error: 'The record could not be saved or loaded. Try again.' });
}
const plain = html => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();

/** Persist and render a constrained document, never executable application HTML. */
export function cleanKnowledgeHtml(html, { articleId = '', storage = false, mediaIds } = {}) {
  const prefix = articleId ? `doc-${articleId}-` : 'doc-';
  const anchor = value => {
    let id = String(value || '');
    if (articleId && id.startsWith(prefix)) id = id.slice(prefix.length);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(id)) return null;
    return storage ? id : `${prefix}${id}`;
  };
  return sanitizeHtml(String(html || ''), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { '*': ['id'], a: ['href','title','target','rel'], img: ['src','alt','width','height','loading'], th: ['colspan','rowspan','scope'], td: ['colspan','rowspan'], ol: ['start'] },
    allowedSchemes: ['http','https','mailto'], allowProtocolRelative: false,
    transformTags: {
      '*': (tagName, attributes) => {
        const attribs = { ...attributes };
        if (attribs.id) { const id = anchor(attribs.id); if (id) attribs.id = id; else delete attribs.id; }
        return { tagName, attribs };
      },
      a: (_tagName, attributes) => {
        const attribs = {};
        if (attributes.title) attribs.title = attributes.title;
        const input = attributes.href || '';
        if (ARTICLE_LINK.test(input) || ASSET_LINK.test(input) || TICKET_LINK.test(input)) attribs.href = input;
        else if (input.startsWith('#') && !input.startsWith('#knowledge/') && !input.startsWith('#assets/')) {
          const id = anchor(input.slice(1)); if (id) attribs.href = `#${id}`;
        } else {
          let url; try { url = new URL(input); } catch { url = null; }
          if (url && ['http:','https:','mailto:'].includes(url.protocol) && !url.username && !url.password) {
            attribs.href = url.href; attribs.target = '_blank'; attribs.rel = 'noopener noreferrer';
          }
        }
        return { tagName: 'a', attribs };
      },
      img: (_tagName, attributes) => {
        const match = MEDIA_PATH.exec(attributes.src || '');
        if (!match) return { tagName: 'img', attribs: {} };
        mediaIds?.add(match[1]);
        const attribs = { src: `/api/desk/knowledge/media/${match[1]}`, alt: attributes.alt || '', loading: 'lazy' };
        for (const dimension of ['width','height']) if (/^\d{1,4}$/.test(attributes[dimension] || '') && Number(attributes[dimension]) <= 4096) attribs[dimension] = attributes[dimension];
        return { tagName: 'img', attribs };
      },
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
  });
}
function validVersion(body) {
  if (!Number.isSafeInteger(body.version) || body.version < 1) throw workspaceError('The current record version is required. Reload and try again.');
  return body.version;
}
function prepareHtml(body, { workspace, user, articleId } = {}) {
  if (typeof body.html !== 'string' || body.html.length > ARTICLE_LIMIT) throw workspaceError('Article content must be at most 300,000 characters.');
  const mediaIds = new Set();
  const html = cleanKnowledgeHtml(body.html, { articleId, storage: true, mediaIds });
  if (!plain(html) && !/<img\s/.test(html)) throw workspaceError('Add article content before saving.');
  for (const id of mediaIds) {
    if (!articleId) throw workspaceError('Save the article before uploading images.');
    const media = workspace.getMedia(id, user);
    if (media.article_id !== articleId) throw workspaceError('Images must be uploaded to this article.');
  }
  return html;
}
function articleResponse(article) {
  return { ...article, html: cleanKnowledgeHtml(article.html, { articleId: article.id }), kind: 'knowledge' };
}
function decodeImage(body) {
  bodyFields(body, ['filename','mime','data']);
  const {filename,mime,data} = body;
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 180 || /[\/\\\x00-\x1f]/.test(filename)) throw workspaceError('Provide a valid image filename.');
  if (!['image/png','image/jpeg','image/gif','image/webp'].includes(mime)) throw workspaceError('Use a PNG, JPEG, GIF, or WebP image.', 415);
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(IMAGE_LIMIT / 3) * 4
    || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) throw workspaceError('Provide valid base64 image data of at most 10 MiB.');
  const padding = data.indexOf('=');
  if (padding !== -1 && (padding < data.length - 2 || !/^={1,2}$/.test(data.slice(padding)))) throw workspaceError('Provide valid base64 image data of at most 10 MiB.');
  const decoded = Buffer.from(data, 'base64');
  if (!decoded.length || decoded.length > IMAGE_LIMIT || decoded.toString('base64') !== data) throw workspaceError('Provide valid base64 image data of at most 10 MiB.');
  const signature = mime === 'image/png' ? decoded.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? decoded[0] === 255 && decoded[1] === 216 && decoded[2] === 255
      : mime === 'image/gif' ? /^GIF8[79]a$/.test(decoded.subarray(0,6).toString('ascii'))
        : decoded.subarray(0,4).toString('ascii') === 'RIFF' && decoded.subarray(8,12).toString('ascii') === 'WEBP';
  if (!signature) throw workspaceError('The image content does not match its type.', 415);
  return {filename: filename.trim(), mime, data: decoded};
}

export function createKnowledgeRouter({ workspace }) {
  const router = express.Router();
  const user = req => req.deskSession.user;
  router.get('/', (req, res) => {
    const filters = listFilters(req.query);
    const categories = workspace.listCategories(user(req));
    let assets = [], assetTotal = 0;
    if (filters.category_id) {
      const category = workspace.getCategory(filters.category_id, user(req));
      if (category.kind === 'assets') {
        const result = workspace.listAssets(user(req), filters); assets = result.assets; assetTotal = result.total;
      }
    }
    res.json({ categories, ...workspace.listArticles(user(req), filters), assets, asset_total: assetTotal });
  });
  router.get('/categories', (req, res) => res.json({ categories: workspace.listCategories(user(req)) }));
  router.post('/categories', (req, res) => {
    bodyFields(req.body, ['name','description','kind','visibility','reader_ids','editor_ids','allow_staff_edit']);
    res.status(201).json(workspace.createCategory(req.body, user(req)));
  });
  router.patch('/categories/:id', (req, res) => {
    const body = bodyFields(req.body, ['name','description','kind','visibility','reader_ids','editor_ids','allow_staff_edit','version']);
    const {version, ...patch} = body;
    validVersion(body);
    res.json(workspace.updateCategory(recordId(req.params.id), patch, user(req), {version}));
  });
  router.get('/articles/:id', (req, res) => res.json(articleResponse(workspace.getArticle(recordId(req.params.id), user(req)))));
  router.post('/articles', (req, res) => {
    bodyFields(req.body, ['name','html','category_id']);
    const html = prepareHtml(req.body, { workspace, user: user(req) });
    res.status(201).json(articleResponse(workspace.createArticle({ ...req.body, html }, user(req))));
  });
  router.patch('/articles/:id', (req, res) => {
    const body = bodyFields(req.body, ['name','html','category_id','version']);
    const id = recordId(req.params.id), version = validVersion(body);
    // Authorize the record before validating its image references or content.
    workspace.getArticle(id, user(req));
    const html = prepareHtml(body, { workspace, user: user(req), articleId: id });
    const {version: _version, ...patch} = body;
    res.json(articleResponse(workspace.updateArticle(id, { ...patch, html }, user(req), {version})));
  });
  router.post('/articles/:id/images', (req, res) => {
    const id = recordId(req.params.id);
    const article = workspace.getArticle(id, user(req));
    if (!article.canEdit) throw workspaceError('You do not have permission to edit this category.', 403);
    const image = decodeImage(req.body);
    const saved = workspace.addMedia({ ...image, article_id: id }, user(req));
    res.status(201).json({ id: saved.id, url: `/api/desk/knowledge/media/${saved.id}`, filename: saved.filename, mime: saved.mime });
  });
  router.get('/media/:id', (req, res) => {
    const media = workspace.getMedia(recordId(req.params.id), user(req));
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(media.mime).send(Buffer.from(media.data));
  });
  router.use(workspaceErrorHandler);
  return router;
}
