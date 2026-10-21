// WooCommerce REST API (v3) client. Runs only on the server: keys never reach the browser.

export class WooError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const baseUrl = (url) => url.trim().replace(/\/+$/, '');

/**
 * creds: { url, consumerKey, consumerSecret }
 * Tries HTTP Basic auth first. Some hosts strip the Authorization header,
 * so on a 401 it retries once with the keys as query parameters (allowed over HTTPS).
 */
export async function wooFetch(creds, path, { method = 'GET', body, query = {} } = {}) {
  const attempt = async (mode) => {
    const url = new URL(`${baseUrl(creds.url)}/wp-json/wc/v3${path}`);
    Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));
    const headers = { Accept: 'application/json', 'User-Agent': 'DigitalHub/1.0' };
    if (mode === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}`;
    } else {
      url.searchParams.set('consumer_key', creds.consumerKey);
      url.searchParams.set('consumer_secret', creds.consumerSecret);
    }
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { res, data, text };
  };

  if (!/^https:\/\//i.test(creds.url) && !process.env.FUNCTIONS_EMULATOR) {
    throw new WooError('The store address must start with https://', 400);
  }

  let { res, data, text } = await attempt('basic');
  if (res.status === 401) ({ res, data, text } = await attempt('query'));

  if (!res.ok) {
    const message =
      res.status === 401
        ? 'WooCommerce rejected the keys. Check the consumer key and secret, and that they have Read/Write permission.'
        : res.status === 404 && !data?.code
          ? 'No WooCommerce API found at this address. Check the site URL and that permalinks are not set to “Plain”.'
          : data?.message || `WooCommerce answered ${res.status}.`;
    throw new WooError(message, res.status, data?.code);
  }
  if (data === null && text) throw new WooError('The store answered with something that isn’t JSON. A security plugin may be blocking the API.', 502);

  return {
    data,
    total: Number(res.headers.get('x-wp-total') || 0),
    totalPages: Number(res.headers.get('x-wp-totalpages') || 1),
  };
}

// Every page of a list endpoint (100 per page, capped so a huge store can't run forever).
export async function wooFetchAll(creds, path, query = {}, maxPages = 30) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, totalPages } = await wooFetch(creds, path, { query: { per_page: 100, page, ...query } });
    all.push(...(data || []));
    if (page >= totalPages || !data?.length) break;
  }
  return all;
}
