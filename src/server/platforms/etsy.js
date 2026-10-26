import 'server-only';
import { PlatformError, num, requestJson } from './http';

// Etsy Open API v3 with OAuth 2.0 + PKCE ("Sign in with Etsy" popup). App keys come only from
// the server's environment: ETSY_KEYSTRING and ETSY_SHARED_SECRET (Etsy expects the x-api-key
// header as "keystring:shared_secret"). Callback URL on the Etsy app:
// <app>/api/integrations/callback/etsy. Access tokens 1 hour; refresh tokens 90 days (automatic).

const API = 'https://api.etsy.com/v3';
const P = 'Etsy';
const SCOPES = 'shops_r listings_r transactions_r';

/** The app keys: the store's own (typed in the connect window) or the server's ETSY_* variables. */
function app(creds = {}) {
  const keystring = creds.keystring || process.env.ETSY_KEYSTRING || process.env.ETSY_API_KEY;
  const sharedSecret = creds.sharedSecret || process.env.ETSY_SHARED_SECRET;
  if (!keystring) throw new PlatformError('Enter the Etsy Keystring and Shared Secret in the store’s connect window.');
  return { keystring, sharedSecret };
}

const apiKey = (creds) => {
  const { keystring, sharedSecret } = app(creds);
  return sharedSecret ? `${keystring}:${sharedSecret}` : keystring;
};

function tokens(data, previous = {}) {
  return {
    ...previous,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + num(data.expires_in || 3600) * 1000,
    refreshExpiresAt: Date.now() + 90 * 864e5,
    userId: String(data.access_token).split('.')[0] || previous.userId,
  };
}

const get = (creds, path, query) =>
  requestJson(`${API}${path}`, { platform: P, headers: { 'x-api-key': apiKey(creds), Authorization: `Bearer ${creds.accessToken}` }, query }).then((r) => r.data);

const money = (m) => (m ? num(m.amount) / (num(m.divisor) || 100) : 0);

function orderStatus(r) {
  const s = String(r.status || '').toLowerCase();
  if (s === 'canceled') return 'cancelled';
  if (s === 'fully refunded') return 'refunded';
  if (r.is_shipped || s === 'completed') return 'fulfilled';
  return 'unfulfilled';
}

export default {
  platform: P,
  auth: 'oauth',
  pkce: true,

  requiredEnv: ['ETSY_KEYSTRING|ETSY_API_KEY', 'ETSY_SHARED_SECRET'],

  /** Etsy refuses keys that are still "Pending" review; say so before the seller signs in. */
  appKeyFields: ['keystring', 'sharedSecret'],

  /** The store's Etsy app keys; Etsy's ping checks them before they're saved. */
  async connect({ keystring, sharedSecret }) {
    const keys = { keystring: keystring?.trim(), sharedSecret: sharedSecret?.trim() };
    if (!keys.keystring || !keys.sharedSecret) throw new PlatformError('Enter the Etsy Keystring and Shared Secret.');
    await this.checkApp(keys);
    return { ...keys, clientId: keys.keystring };
  },

  async checkApp(creds) {
    try {
      await requestJson(`${API}/application/openapi-ping`, { platform: P, headers: { 'x-api-key': apiKey(creds) } });
    } catch (err) {
      throw new PlatformError(`Etsy didn’t accept the app keys. If the app still shows “Pending” on etsy.com/developers, wait for Etsy to approve it. (${err.message})`);
    }
  },

  authorizeUrl({ state, redirectUri, codeChallenge, creds }) {
    const q = new URLSearchParams({
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      client_id: app(creds).keystring,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://www.etsy.com/oauth/connect?${q}`;
  },

  async exchangeCode({ query, redirectUri, codeVerifier, creds = {} }) {
    if (!query.code) throw new PlatformError('Etsy didn’t send an authorization code.');
    const keys = app(creds);
    const { data } = await requestJson(`${API}/public/oauth/token`, {
      platform: P,
      method: 'POST',
      form: { grant_type: 'authorization_code', client_id: keys.keystring, redirect_uri: redirectUri, code: query.code, code_verifier: codeVerifier },
    });
    const next = tokens(data, { ...creds });
    const shop = await get(next, `/application/users/${next.userId}/shops`);
    const first = shop?.results ? shop.results[0] : shop;
    if (!first?.shop_id) throw new PlatformError('This Etsy account has no shop.');
    return { ...next, shopId: first.shop_id, account: first.shop_name };
  },

  async refresh(creds) {
    const { data } = await requestJson(`${API}/public/oauth/token`, {
      platform: P,
      method: 'POST',
      form: { grant_type: 'refresh_token', client_id: app(creds).keystring, refresh_token: creds.refreshToken },
    });
    return tokens(data, creds);
  },

  async test({ creds }) {
    const shop = await get(creds, `/application/shops/${creds.shopId}`);
    return { ok: true, message: `Connected to ${shop.shop_name} (${shop.listing_active_count} active listings).`, account: shop.shop_name };
  },

  async syncProducts({ store, creds }) {
    const out = [];
    for (const state of ['active', 'draft', 'sold_out', 'inactive']) {
      for (let offset = 0; offset < 3000; offset += 100) {
        const page = await get(creds, `/application/shops/${creds.shopId}/listings`, { state, limit: 100, offset, includes: 'Images' });
        (page.results || []).forEach((l) =>
          out.push({
            storeId: store.id,
            externalId: String(l.listing_id),
            title: l.title,
            sku: l.skus?.[0] || '',
            category: '',
            price: money(l.price),
            stock: l.quantity ?? null,
            status: state === 'active' ? (l.quantity === 0 ? 'out_of_stock' : 'active') : state === 'sold_out' ? 'out_of_stock' : 'draft',
            image: l.images?.[0]?.url_570xN || '',
            permalink: l.url || '',
            updatedAt: num(l.updated_timestamp) * 1000 || null,
          }),
        );
        if ((page.results || []).length < 100) break;
      }
    }
    return out;
  },

  async syncOrders({ store, creds }, { since }) {
    const receipts = [];
    const query = { limit: 100, ...(since ? { min_last_modified: Math.floor((since - 120000) / 1000) } : {}) };
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await get(creds, `/application/shops/${creds.shopId}/receipts`, { ...query, offset });
      receipts.push(...(page.results || []));
      if ((page.results || []).length < 100) break;
    }
    return receipts.map((r) => ({
      storeId: store.id,
      externalId: String(r.receipt_id),
      number: `#${r.receipt_id}`,
      items: (r.transactions || []).map((t) => ({
        productId: t.listing_id ? `${store.id}_p${t.listing_id}` : null,
        title: t.title,
        qty: num(t.quantity),
        price: money(t.price),
      })),
      subtotal: money(r.subtotal),
      shipping: money(r.total_shipping_cost),
      tax: money(r.total_tax_cost),
      total: money(r.grandtotal),
      currency: r.grandtotal?.currency_code || 'USD',
      status: orderStatus(r),
      refunded: (r.refunds || []).reduce((sum, x) => sum + money(x.amount), 0),
      shippingInfo: (() => {
        const s = (r.shipments || [])[0];
        return {
          status: r.is_shipped || s ? 'shipped' : 'awaiting',
          carrier: s?.carrier_name || null,
          tracking: s?.tracking_code || null,
          shippedAt: s?.shipment_notification_timestamp ? num(s.shipment_notification_timestamp) * 1000 : null,
        };
      })(),
      placedAt: num(r.create_timestamp) * 1000,
      updatedAt: num(r.updated_timestamp) * 1000,
      customer: { externalId: r.buyer_user_id ? String(r.buyer_user_id) : null, name: r.name || r.buyer_email || 'Etsy buyer', email: r.buyer_email || '' },
    }));
  },
};
