// Read-only legacy export client. Loaded only by scripts/import-bookstack.mjs.
// The native AssetDesk server never imports this file.
function safeError(message, status) {
  const error = new Error(message);
  error.safeMessage = message;
  if (status !== undefined) error.status = status;
  return error;
}
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

  async request(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw safeError('Invalid legacy API path');
    let response;
    try {
      response = await this.fetch(`${this.url}/api${path}`, {
        method: 'GET', headers: { Authorization: this.authorization, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
    } catch { throw safeError('Legacy API connection failed; check its service address, network, and TLS configuration.'); }
    if (!response.ok) {
      const status = response.status;
      const reason = {401:'the API token was rejected',403:'the API account lacks permission',404:'the requested record was not found',429:'the API rate limit was reached'}[status] || 'the legacy API request failed';
      throw safeError(`Legacy API request failed (HTTP ${status}): ${reason}.`, status);
    }
    try { return await response.json(); } catch { throw safeError('Legacy API returned invalid JSON.'); }
  }

  async list(path) {
    const entries = [];
    const search = path.startsWith('/search?') || path.startsWith('/search/');
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
  async readImage(path) {
    if (typeof path !== 'string' || !path.startsWith('/uploads/images/') || path.length > 2048
      || /[\\%?#\x00-\x1f]/.test(path) || path.split('/').some(part => part === '.' || part === '..')
      || !/\.(?:png|jpe?g|gif|webp)$/i.test(path)) throw safeError('Invalid BookStack image path', 400);
    const url = `${this.publicUrl}${path}`;
    let response;
    try {
      response = await this.fetch(`${this.url}/api/image-gallery/url/data?url=${encodeURIComponent(url)}`, {
        headers: { Authorization: this.authorization, Accept: 'image/png,image/jpeg,image/gif,image/webp' },
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
    } catch { throw safeError('BookStack image connection failed.', 502); }
    if (!response.ok) throw safeError(`BookStack image request failed (HTTP ${response.status}).`, response.status);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)) {
      await response.body?.cancel();
      throw safeError('BookStack returned an unsupported image type.', 415);
    }
    const maximum = 10 * 1024 * 1024;
    const expectedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(expectedLength) && expectedLength > maximum) {
      await response.body?.cancel();
      throw safeError('BookStack image exceeds 10 MiB.', 413);
    }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum) { await response.body.cancel().catch(() => {}); throw safeError('BookStack image exceeds 10 MiB.', 413); }
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) { if (error.safeMessage) throw error; throw safeError('BookStack image could not be read.', 502); }
    const data = Buffer.concat(chunks);
    const signature = contentType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : contentType === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : contentType === 'image/gif' ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))
          : data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!signature) throw safeError('BookStack returned invalid image data.', 415);
    return { data, contentType };
  }

}
