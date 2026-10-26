import 'server-only';
import { createHmac } from 'node:crypto';
import { PlatformError, num, requestJson } from './http';

// TikTok Shop Partner API (version 202309) with OAuth ("Connect TikTok Shop" popup). App keys
// come only from the server's environment: TIKTOK_APP_KEY, TIKTOK_APP_SECRET and
// TIKTOK_SERVICE_ID (Partner Center → App & Service → your app).
// Set the app's redirect URL to <app>/api/integrations/callback/tiktok
// Requests are signed with HMAC-SHA256 of the app secret.

const P = 'TikTok Shop';
const API = 'https://open-api.tiktokglobalshop.com';
const AUTH_API = 'https://auth.tiktok-shops.com';

/** The app keys: the store's own (typed in the connect window) or the server's TIKTOK_* variables. */
function app(creds = {}) {
  const appKey = creds.appKey || process.env.TIKTOK_APP_KEY;
  const appSecret = creds.appSecret || process.env.TIKTOK_APP_SECRET;
  const serviceId = creds.serviceId || process.env.TIKTOK_SERVICE_ID;
  if (!appKey || !appSecret) throw new PlatformError('Enter the TikTok Shop App Key and App Secret in the store’s connect window.');
  return { appKey, appSecret, serviceId };
}

/** For webhook checks: the app secret and key (server environment). */
/** For webhook checks: a store's app keys, or the server's. */
export const tiktokApp = (creds) => app(creds);

function sign(path, params, body, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  const base = `${secret}${path}${keys.map((k) => `${k}${params[k]}`).join('')}${body || ''}${secret}`;
  return createHmac('sha256', secret).update(base).digest('hex');
}

async function call(creds, method, path, { query = {}, body, shop = true } = {}) {
  const { appKey, appSecret } = app(creds);
  const params = { ...query, app_key: appKey, timestamp: Math.floor(Date.now() / 1000) };
  if (shop && creds.shopCipher) params.shop_cipher = creds.shopCipher;
  const bodyText = body ? JSON.stringify(body) : '';
  params.sign = sign(path, params, bodyText, appSecret);
  const { data } = await requestJson(`${API}${path}`, {
    platform: P,
    method,
    headers: { 'x-tts-access-token': creds.accessToken },
    query: params,
    body: bodyText || undefined,
  });
  if (data?.code !== 0) {
    const auth = [105001, 105002, 105005, 106001].includes(data?.code);
    throw new PlatformError(`TikTok Shop: ${data?.message || 'request failed'} (${data?.code}).`, { code: data?.code, auth });
  }
  return data.data;
}

async function token(creds, query) {
  const { appKey, appSecret } = app(creds);
  const { data } = await requestJson(`${AUTH_API}${query.grant_type === 'refresh_token' ? '/api/v2/token/refresh' : '/api/v2/token/get'}`, {
    platform: P,
    query: { app_key: appKey, app_secret: appSecret, ...query },
  });
  if (data?.code !== 0) throw new PlatformError(`TikTok Shop: ${data?.message || 'token request failed'}.`, { auth: true });
  return data.data;
}

const tokens = (d, previous = {}) => ({
  ...previous,
  accessToken: d.access_token,
  refreshToken: d.refresh_token,
  expiresAt: num(d.access_token_expire_in) * 1000,
  refreshExpiresAt: num(d.refresh_token_expire_in) * 1000,
});

const STATUS = {
  UNPAID: 'unfulfilled',
  ON_HOLD: 'unfulfilled',
  AWAITING_SHIPMENT: 'unfulfilled',
  PARTIALLY_SHIPPING: 'processing',
  AWAITING_COLLECTION: 'processing',
  IN_TRANSIT: 'processing',
  DELIVERED: 'fulfilled',
  COMPLETED: 'fulfilled',
  CANCELLED: 'cancelled',
};

export default {
  platform: P,
  auth: 'oauth',

  requiredEnv: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_SERVICE_ID'],
  appKeyFields: ['appKey', 'appSecret', 'serviceId'],

  /** The store's TikTok Shop app keys (TikTok can only check them when the seller approves). */
  async connect({ appKey, appSecret, serviceId }) {
    const keys = { appKey: appKey?.trim(), appSecret: appSecret?.trim(), serviceId: serviceId?.trim() };
    if (!keys.appKey || !keys.appSecret || !keys.serviceId) throw new PlatformError('Enter the TikTok Shop App Key, App Secret and Service ID.');
    if (!/^[0-9]+$/.test(keys.serviceId)) throw new PlatformError('The Service ID is a number (Partner Center → App & Service → your app).');
    return { ...keys, clientId: keys.appKey };
  },

  authorizeUrl({ state, creds }) {
    const { serviceId } = app(creds);
    if (!serviceId) throw new PlatformError('TikTok Shop isn’t set up on the server yet: add TIKTOK_SERVICE_ID.');
    const base = process.env.TIKTOK_AUTHORIZE_URL || 'https://services.tiktokshop.com/open/authorize';
    return `${base}?${new URLSearchParams({ service_id: serviceId, state })}`;
  },

  async exchangeCode({ query, creds = {} }) {
    if (!query.code) throw new PlatformError('TikTok Shop didn’t send an authorization code.');
    const next = tokens(await token(creds, { auth_code: query.code, grant_type: 'authorized_code' }), { ...creds });
    const shops = await call(next, 'GET', '/authorization/202309/shops', { shop: false });
    const shop = shops?.shops?.[0];
    if (!shop) throw new PlatformError('This TikTok Shop account has no shops authorized.');
    return { ...next, shopId: shop.id, shopCipher: shop.cipher, account: shop.name };
  },

  async refresh(creds) {
    return tokens(await token(creds, { refresh_token: creds.refreshToken, grant_type: 'refresh_token' }), creds);
  },

  async test({ creds }) {
    const shops = await call(creds, 'GET', '/authorization/202309/shops', { shop: false });
    const names = (shops?.shops || []).map((s) => s.name);
    return { ok: true, message: `Connected to TikTok Shop (${names.join(', ')}).`, account: names[0] };
  },

  async syncProducts({ store, creds }) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 30; page++) {
      const data = await call(creds, 'POST', '/product/202309/products/search', {
        query: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        body: { status: 'ALL' },
      });
      (data.products || []).forEach((p) => {
        const sku = p.skus?.[0] || {};
        const stock = (p.skus || []).reduce((sum, s) => sum + (s.inventory || []).reduce((n, i) => n + num(i.quantity), 0), 0);
        out.push({
          storeId: store.id,
          externalId: String(p.id),
          title: p.title,
          sku: sku.seller_sku || '',
          category: '',
          price: num(sku.price?.sale_price || sku.price?.tax_exclusive_price),
          stock,
          status: p.status === 'ACTIVATE' ? (stock === 0 ? 'out_of_stock' : 'active') : 'draft',
          updatedAt: num(p.update_time) * 1000 || null,
        });
      });
      pageToken = data.next_page_token;
      if (!pageToken) break;
    }
    return out;
  },

  async syncOrders({ store, creds }, { since }) {
    const orders = [];
    let pageToken;
    const body = since ? { update_time_ge: Math.floor((since - 120000) / 1000) } : { create_time_ge: Math.floor((Date.now() - 90 * 864e5) / 1000) };
    for (let page = 0; page < 40; page++) {
      const data = await call(creds, 'POST', '/order/202309/orders/search', {
        query: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
        body,
      });
      orders.push(...(data.orders || []));
      pageToken = data.next_page_token;
      if (!pageToken) break;
    }
    return orders.map((o) => {
      // TikTok lists one line per unit; group them by product.
      const grouped = new Map();
      (o.line_items || []).forEach((li) => {
        const key = li.sku_id || li.product_id || li.product_name;
        const prev = grouped.get(key);
        if (prev) prev.qty += 1;
        else grouped.set(key, { productId: li.product_id ? `${store.id}_p${li.product_id}` : null, title: li.product_name, qty: 1, price: num(li.sale_price) });
      });
      const pay = o.payment || {};
      return {
        storeId: store.id,
        externalId: String(o.id),
        number: String(o.id),
        items: [...grouped.values()],
        subtotal: num(pay.sub_total),
        shipping: num(pay.shipping_fee),
        tax: num(pay.tax),
        total: num(pay.total_amount),
        currency: pay.currency || 'USD',
        status: STATUS[o.status] || 'unfulfilled',
        shippingInfo: {
          status: ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(o.status) ? 'shipped' : o.status === 'CANCELLED' ? null : 'awaiting',
          carrier: o.shipping_provider || null,
          tracking: o.tracking_number || null,
          shippedAt: num(o.rts_time || o.collection_time) * 1000 || null,
        },
        placedAt: num(o.create_time) * 1000,
        updatedAt: num(o.update_time) * 1000,
        customer: { externalId: o.user_id ? String(o.user_id) : null, name: o.recipient_address?.name || 'TikTok Shop buyer', email: o.buyer_email || '' },
      };
    });
  },
};
