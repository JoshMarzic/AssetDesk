import { createHash } from 'node:crypto';

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const normalized = value => String(value).trim().toUpperCase();
const tagValue = (page, name) => (page.tags || []).find(t => normalized(t.name) === normalized(name))?.value;
// Only deliberately written messages may be persisted in receipts or service logs.
// Never attach upstream response bodies, request URLs, or underlying fetch errors.
function safeError(message, status) {
  const error = new Error(message);
  error.safeMessage = message;
  if (status !== undefined) error.status = status;
  return error;
}
const safeTag = value => {
  const result = String(value);
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(result)) throw safeError('Invalid asset or ticket identifier');
  return result;
};

export class BookStackClient {
  constructor({ url, publicUrl = url, tokenId, tokenSecret, fetchImpl = fetch }) {
    for (const input of [url, publicUrl]) {
      let parsed;
      try { parsed = new URL(input); } catch { throw safeError('Invalid BookStack URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw safeError('Invalid BookStack URL');
    }
    this.url = url.replace(/\/$/, '');
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.authorization = `Token ${tokenId}:${tokenSecret}`;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw safeError('Invalid BookStack API path');
    let response;
    try {
      response = await this.fetch(`${this.url}/api${path}`, {
        method,
        headers: { Authorization: this.authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
    } catch {
      throw safeError('BookStack API connection failed; check the service address, network, and TLS configuration.');
    }
    if (!response.ok) {
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
      const reason = {
        401: 'the API token was rejected',
        403: 'the API account lacks permission',
        404: 'the requested record or API endpoint was not found',
        422: 'the API rejected the record fields',
        429: 'the API rate limit was reached',
      }[status] || (status >= 500 ? 'BookStack reported a server error' : 'the request was rejected');
      throw safeError(`BookStack API request failed${status ? ` (HTTP ${status})` : ''}: ${reason}.`, status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw safeError('BookStack API returned invalid JSON; check the API endpoint and reverse proxy.'); }
  }

  async list(path) {
    const entries = [];
    const search = path.startsWith('/search?');
    for (let offset = 0; ; offset += 100) {
      const delimiter = path.includes('?') ? '&' : '?';
      const result = await this.request(`${path}${delimiter}count=100&${search ? `page=${offset / 100 + 1}` : `offset=${offset}`}`);
      if (!Array.isArray(result.data) || !Number.isFinite(result.total) || result.total < 0) throw safeError('Invalid BookStack listing response');
      entries.push(...result.data);
      if (entries.length >= result.total) break;
      if (!result.data.length) throw safeError('BookStack pagination ended before all results were returned');
    }
    return entries;
  }

  pageUrl(id) { return `${this.publicUrl}/link/${Number(id)}`; }
  withUrl(page) { return { ...page, url: this.pageUrl(page.id) }; }
  async getPage(id) { return this.withUrl(await this.request(`/pages/${Number(id)}`)); }
  async updatePage(id, fields) { return this.withUrl(await this.request(`/pages/${Number(id)}`, { method: 'PUT', body: fields })); }
  async createPage(fields) { return this.withUrl(await this.request('/pages', { method: 'POST', body: fields })); }

  ensureWorkspace() {
    if (!this.workspacePromise) this.workspacePromise = this.createWorkspace().catch(error => { this.workspacePromise = null; throw error; });
    return this.workspacePromise;
  }

  async checkHealth() {
    const workspace = await this.ensureWorkspace();
    await this.request(`/books/${workspace.ticketBook.id}`);
    await this.request(`/books/${workspace.assetBook.id}`);
    return workspace;
  }

  async createWorkspace() {
    const books = await this.list('/books');
    const ensureBook = async (name, description) => books.find(b => b.name === name) || this.request('/books', { method: 'POST', body: { name, description } });
    const ticketBook = await ensureBook('Tickets', 'IT support requests. Move tickets between chapters to track progress; use page tags for assignment and priority.');
    const assetBook = await ensureBook('Assets', 'Equipment inventory, ownership, support history, and lifecycle details. Keep the Asset ID tag unchanged so email intake can find each record.');
    const shelves = await this.list('/shelves');
    let shelf = shelves.find(s => s.name === 'IT Help Desk');
    if (!shelf) {
      shelf = await this.request('/shelves', { method: 'POST', body: { name: 'IT Help Desk', description: 'AssetDesk · Email-driven support and equipment records, organized in BookStack.', books: [ticketBook.id, assetBook.id] } });
    } else {
      const existing = await this.request(`/shelves/${shelf.id}`);
      const ids = new Set((existing.books || []).map(b => b.id));
      if (!ids.has(ticketBook.id) || !ids.has(assetBook.id)) {
        ids.add(ticketBook.id); ids.add(assetBook.id);
        shelf = await this.request(`/shelves/${shelf.id}`, { method: 'PUT', body: { books: [...ids] } });
      }
    }
    const allChapters = (await this.list('/chapters')).filter(c => c.book_id === ticketBook.id);
    const chapters = {};
    for (const [index, name] of ['Open', 'In Progress', 'Resolved'].entries()) {
      chapters[name] = allChapters.find(c => c.name === name) || await this.request('/chapters', { method: 'POST', body: { book_id: ticketBook.id, name, description: `${name} support requests.`, priority: index + 1 } });
    }
    return { shelf, ticketBook, assetBook, openChapter: chapters.Open, chapters };
  }

  async findTaggedPage(name, value) {
    safeTag(value);
    const result = await this.list(`/search?query=${encodeURIComponent(`[${name}=${value}] {type:page}`)}`);
    const matches = result.filter(page => page.type === 'page' && normalized(tagValue(page, name)) === normalized(value) && (name !== 'Asset ID' || !tagValue(page, 'Ticket ID')));
    if (matches.length > 1) throw safeError(name === 'Asset ID' ? 'Multiple BookStack pages have the same Asset ID; resolve the duplicate records before retrying.' : 'Multiple BookStack pages have the same Ticket ID; resolve the duplicate records before retrying.');
    return matches[0] ? this.getPage(matches[0].id) : null;
  }

  async findAsset(ref) {
    safeTag(ref);
    const tagged = await this.findTaggedPage('Asset ID', ref);
    if (tagged) return tagged;
    const candidates = (await this.list(`/search?query=${encodeURIComponent(`"${ref}" {type:page}`)}`)).filter(p => p.type === 'page' && normalized(p.name) === normalized(ref));
    if (candidates.length > 1) throw safeError('Multiple BookStack pages match this asset name; add a unique Asset ID tag.');
    if (!candidates[0]) return null;
    const page = await this.getPage(candidates[0].id);
    const existing = tagValue(page, 'Asset ID');
    if (existing && normalized(existing) !== normalized(ref)) throw safeError('Asset page title conflicts with its Asset ID tag; correct the title or tag before retrying.');
    if (!existing) return this.updatePage(page.id, { tags: [...(page.tags || []), { name: 'Asset ID', value: normalized(ref) }] });
    return page;
  }

  async ensureAsset(ref, workspace) {
    ref = normalized(safeTag(ref));
    const found = await this.findAsset(ref);
    if (found) return found;
    const rows = ['Asset ID', 'Owner / assigned user', 'Department', 'Location', 'Type', 'Manufacturer / model', 'Serial number', 'Lifecycle status', 'Purchase date', 'Warranty expiry', 'Supplier', 'Support contact'];
    return this.createPage({
      book_id: workspace.assetBook.id,
      name: ref,
      html: `<h1>${escapeHtml(ref)}</h1><p>This record was created from a support request. Select <strong>Edit</strong> to complete the ownership and equipment details. Keep the Asset ID tag unchanged.</p><h2>Ownership and equipment</h2><table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows.map((name, i) => `<tr><td>${escapeHtml(name)}</td><td>${i === 0 ? escapeHtml(ref) : i === 7 ? 'Unverified' : 'To be confirmed'}</td></tr>`).join('')}</tbody></table><h2>Notes</h2><p>Add configuration, maintenance, and handover notes here.</p><h2>Related tickets</h2>`,
      tags: [{ name: 'Asset ID', value: ref }, { name: 'Lifecycle', value: 'Unverified' }],
    });
  }

  findTicket(key) { return this.findTaggedPage('Ticket ID', key); }

  async ensureTicket({ key, subject, requester, text, assets = [], receivedAt }, workspace) {
    safeTag(key);
    const found = await this.findTicket(key);
    if (found) return found;
    const email = typeof requester === 'string' ? requester : requester?.address || '';
    const name = typeof requester === 'object' && requester?.name ? `${requester.name} (${email})` : email;
    return this.createPage({
      chapter_id: workspace.openChapter.id,
      name: `${key} · ${subject || '(No subject)'}`.slice(0, 255),
      html: `<h1>${escapeHtml(subject || '(No subject)')}</h1><table><tbody><tr><th>Ticket</th><td>${escapeHtml(key)}</td></tr><tr><th>Requester</th><td>${escapeHtml(name)}</td></tr><tr><th>Received</th><td>${escapeHtml(receivedAt || new Date().toISOString())}</td></tr><tr><th>Assigned to</th><td>Unassigned</td></tr><tr><th>Priority</th><td>Normal</td></tr></tbody></table><p>Track status by moving this page between the Open, In Progress, and Resolved chapters. Edit the assignment and priority above or add page tags. Use comments for internal discussion.</p><h2>Affected assets</h2>${assets.length ? `<ul>${assets.map(a => `<li><a href="${escapeHtml(this.pageUrl(a.id))}">${escapeHtml(a.ref)}</a></li>`).join('')}</ul>` : '<p>No asset was identified. Add an Asset ID to the request when known.</p>'}<h2>Issue reported by email</h2><pre>${escapeHtml(text)}</pre><h2>Work log and resolution</h2><p>Record investigation, actions taken, and the resolution here.</p>`,
      tags: [{ name: 'Ticket ID', value: key }, { name: 'Requester', value: email.slice(0, 255) }, { name: 'Priority', value: 'Normal' }, ...assets.map(a => ({ name: 'Affected asset', value: a.ref }))],
    });
  }

  async linkTicketToAsset(asset, ticket) {
    const current = await this.getPage(asset.id);
    const url = this.pageUrl(ticket.id);
    const html = current.raw_html ?? current.html ?? '';
    // A stable page link survives title changes and BookStack editor normalization.
    if (html.includes(`href="${escapeHtml(url)}"`) || html.includes(`href='${escapeHtml(url)}'`)) return current;
    const appended = `<p><a href="${escapeHtml(url)}">${escapeHtml(ticket.key)} · ${escapeHtml(ticket.subject || 'Support request')}</a></p>`;
    const content = current.editor === 'markdown' && current.markdown ? { markdown: `${current.markdown}\n\n${appended}` } : { html: `${html}\n${appended}` };
    return this.updatePage(current.id, { ...content, changelog: `Linked support ticket ${ticket.key}`.slice(0, 180) });
  }

  async appendReply(ticket, { id, from, text, receivedAt, assets = [] }) {
    const current = await this.getPage(ticket.id);
    const marker = `bkmrk-assetdesk-reply-${createHash('sha256').update(String(id)).digest('hex')}`;
    const html = current.raw_html ?? current.html ?? '';
    if (html.includes(marker) || current.markdown?.includes(marker)) return current;
    const requester = typeof from === 'string' ? from : from?.name ? `${from.name} (${from.address})` : from?.address || 'Unknown sender';
    const assetLinks = assets.length ? `<p><strong>Affected assets:</strong> ${assets.map(asset => `<a href="${escapeHtml(this.pageUrl(asset.id))}">${escapeHtml(asset.ref)}</a>`).join(', ')}</p>` : '';
    const appended = `<h2 id="${marker}">Email update</h2><p><strong>From:</strong> ${escapeHtml(requester)}<br><strong>Received:</strong> ${escapeHtml(receivedAt || new Date().toISOString())}</p>${assetLinks}<pre>${escapeHtml(text)}</pre>`;
    const content = current.editor === 'markdown' && current.markdown ? { markdown: `${current.markdown}\n\n${appended}` } : { html: `${html}\n${appended}` };
    return this.updatePage(current.id, { ...content, changelog: 'Appended email reply' });
  }
}
