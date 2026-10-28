import 'server-only';
import { PlatformError, num, requestJson } from './http';

// Etsy Open API v3, connected with the store's own app keys: no sign-in pop-up.
// - Keystring + Shared secret + shop name: the shop and its listings sync with the API key alone
//   (Etsy expects the x-api-key header as "keystring:shared_secret").
// - Orders (receipts): Etsy only shares them with an OAuth token. If a refresh token from the
//   same Etsy app is pasted, Digital Hub swaps it for access tokens itself (1 hour, renewed
//   automatically; the refresh token lasts 90 days and is renewed with each use).

const API = 'https://api.etsy.com/v3';
const P = 'Etsy';

const apiKey = (creds) => `${creds.keystring}:${creds.sharedSecret}`;

function tokens(data, previous = {}) {
  return {
    ...previous,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + num(data.expires_in || 3600) * 1000,
    refreshExpiresAt: Date.now() + 90 * 864e5,
  };
}

const get = (creds, path, query) =>
  requestJson(`${API}${path}`, {
    platform: P,
    headers: { 'x-api-key': apiKey(creds), ...(creds.accessToken ? { Authorization: `Bearer ${creds.accessToken}` } : {}) },
    query,
  }).then((r) => r.data);

const money = (m) => (m ? num(m.amount) / (num(m.divisor) || 100) : 0);

/** "MyShop", "12345678", "etsy.com/shop/MyShop" or "myshop.etsy.com" → { id } or { name }. */
function shopRef(value) {
  const v = String(value || '').trim();
  if (/^\d+$/.test(v)) return { id: v };
  const fromUrl = v.match(/etsy\.com\/(?:[a-z-]+\/)?shop\/([A-Za-z0-9]+)/i) || v.match(/^(?:https?:\/\/)?([A-Za-z0-9]+)\.etsy\.com/i);
  const name = fromUrl ? fromUrl[1] : v.replace(/^@/, '');
  return /^[A-Za-z0-9]+$/.test(name) ? { name } : null;
}

async function findShop(creds, value) {
  const ref = shopRef(value);
  if (!ref) throw new PlatformError('Enter the Etsy shop name (as in etsy.com/shop/YourShop) or the shop ID.');
  if (ref.id) return get(creds, `/application/shops/${ref.id}`);
  const found = await get(creds, '/application/shops', { shop_name: ref.name, limit: 25 });
  const shop = (found.results || []).find((s) => s.shop_name.toLowerCase() === ref.name.toLowerCase());
  if (!shop) throw new PlatformError(`Etsy has no shop called “${ref.name}”. Check the name in your shop’s address (etsy.com/shop/…).`);
  return shop;
}

function orderStatus(r) {
  const s = String(r.status || '').toLowerCase();
  if (s === 'canceled') return 'cancelled';
  if (s === 'fully refunded') return 'refunded';
  if (r.is_shipped || s === 'completed') return 'fulfilled';
  return 'unfulfilled';
}

const needsShop = (creds) => {
  if (!creds.shopId || !creds.keystring) throw new PlatformError('Edit this Etsy store and enter the app keys and shop name.', { auth: true });
};

export default {
  platform: P,
  auth: 'key',

  /** Checks the app keys with Etsy, finds the shop, and (optionally) swaps the refresh token for access. */
  async connect({ keystring, sharedSecret, shop, refreshToken }) {
    const keys = { keystring: keystring?.trim(), sharedSecret: sharedSecret?.trim() };
    if (!keys.keystring || !keys.sharedSecret) throw new PlatformError('Enter the Etsy Keystring and Shared Secret.');
    try {
      await get(keys, '/application/openapi-ping');
    } catch (err) {
      throw new PlatformError(`Etsy didn’t accept the app keys. If the app still shows “Pending” on etsy.com/developers, wait for Etsy to approve it. (${err.message})`, {
        auth: true,
      });
    }
    const found = await findShop(keys, shop);
    let creds = { ...keys, shopId: found.shop_id, account: found.shop_name };
    if (refreshToken?.trim()) {
      creds = await this.refresh({ ...creds, refreshToken: refreshToken.trim() });
      // The token must belong to the same shop's owner.
      await get(creds, `/application/shops/${creds.shopId}/receipts`, { limit: 1 });
    }
    return creds;
  },

  async refresh(creds) {
    const { data } = await requestJson(`${API}/public/oauth/token`, {
      platform: P,
      method: 'POST',
      form: { grant_type: 'refresh_token', client_id: creds.keystring, refresh_token: creds.refreshToken },
    });
    return tokens(data, creds);
  },

  async test({ creds }) {
    needsShop(creds);
    const shop = await get(creds, `/application/shops/${creds.shopId}`);
    const orders = creds.refreshToken ? '' : ' Listings sync; orders need a refresh token (edit the store to add one).';
    return { ok: true, message: `Connected to ${shop.shop_name} (${shop.listing_active_count} active listings).${orders}`, account: shop.shop_name };
  },

  async syncProducts({ store, creds }) {
    needsShop(creds);
    // With a token every listing state is readable; with the API key alone, active listings.
    const states = creds.accessToken ? ['active', 'draft', 'sold_out', 'inactive'] : ['active'];
    const listings = [];
    for (const state of states) {
      for (let offset = 0; offset < 3000; offset += 100) {
        const page = creds.accessToken
          ? await get(creds, `/application/shops/${creds.shopId}/listings`, { state, limit: 100, offset, includes: 'Images' })
          : await get(creds, `/application/shops/${creds.shopId}/listings/active`, { limit: 100, offset });
        (page.results || []).forEach((l) => listings.push({ ...l, state }));
        if ((page.results || []).length < 100) break;
      }
    }
    // The public listing list has no images: fetch them in batches of 100.
    if (!creds.accessToken) {
      for (let i = 0; i < listings.length; i += 100) {
        const batch = listings.slice(i, i + 100);
        const full = await get(creds, '/application/listings/batch', { listing_ids: batch.map((l) => l.listing_id).join(','), includes: 'Images' }).catch(() => null);
        const images = new Map((full?.results || []).map((l) => [l.listing_id, l.images]));
        batch.forEach((l) => (l.images = images.get(l.listing_id) || l.images));
      }
    }
    return listings.map((l) => ({
      storeId: store.id,
      externalId: String(l.listing_id),
      title: l.title,
      sku: l.skus?.[0] || '',
      category: '',
      price: money(l.price),
      stock: l.quantity ?? null,
      status: l.state === 'active' ? (l.quantity === 0 ? 'out_of_stock' : 'active') : l.state === 'sold_out' ? 'out_of_stock' : 'draft',
      image: l.images?.[0]?.url_570xN || '',
      permalink: l.url || '',
      updatedAt: num(l.updated_timestamp) * 1000 || null,
    }));
  },

  async syncOrders({ store, creds }, { since }) {
    needsShop(creds);
    if (!creds.accessToken) return []; // Etsy shares receipts only with an OAuth token.
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
