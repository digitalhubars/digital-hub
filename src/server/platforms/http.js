import 'server-only';

// Shared HTTP helper for the platform adapters.

export class PlatformError extends Error {
  /** `auth` = the platform rejected the credentials (the store needs new keys or re-authorizing). */
  constructor(message, { status = 0, code, auth = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.auth = auth;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const messageOf = (data, text) =>
  data?.error_description ||
  data?.errors?.[0]?.message ||
  data?.errors?.[0]?.longMessage ||
  (typeof data?.errors === 'string' ? data.errors : null) ||
  data?.error?.message ||
  (typeof data?.error === 'string' ? data.error : null) ||
  data?.message ||
  (text && text.length < 300 ? text : null);

/**
 * fetch + JSON with readable errors. `form` sends application/x-www-form-urlencoded,
 * `body` sends JSON. Retries once on 429/5xx after a short wait.
 */
export async function requestJson(url, { platform, method = 'GET', headers = {}, body, form, query, timeout = 30000, retry = true } = {}) {
  const target = new URL(url);
  Object.entries(query || {}).forEach(([k, v]) => v != null && v !== '' && target.searchParams.set(k, String(v)));
  const init = { method, headers: { Accept: 'application/json', 'User-Agent': 'DigitalHub/1.0', ...headers }, signal: AbortSignal.timeout(timeout) };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null)).toString();
  } else if (body !== undefined) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(target, init);
  } catch (err) {
    throw new PlatformError(`Couldn’t reach ${platform}: ${err.name === 'TimeoutError' ? 'it took too long to answer' : err.message}.`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if ((res.status === 429 || res.status >= 500) && retry) {
    await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000);
    return requestJson(url, { platform, method, headers, body, form, query, timeout, retry: false });
  }
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403 || data?.error === 'invalid_grant';
    const detail = messageOf(data, text) || `answered ${res.status}`;
    throw new PlatformError(auth ? `${platform} rejected the credentials (${detail}).` : `${platform}: ${detail}`, {
      status: res.status,
      code: data?.error || data?.code,
      auth,
    });
  }
  return { data, headers: res.headers };
}

/** Basic auth header value. */
export const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** Required environment variable, with a clear error when it's missing. */
export function env(name, platform) {
  const value = process.env[name];
  if (!value) throw new PlatformError(`${platform} isn’t set up on the server yet: add ${name} to the environment variables.`);
  return value;
}

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
