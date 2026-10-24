import 'server-only';
import { PlatformError, basic, num, requestJson } from './http';

// eBay with OAuth ("Sign in with eBay" popup). The app keys come only from the server's
// environment: EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID) and EBAY_RUNAME, whose
// "auth accepted URL" must be <app>/api/integrations/callback/ebay. EBAY_ENV=sandbox for the
// sandbox. Tokens refresh automatically (access 2 hours, refresh about 18 months).
//
// Listings: every active listing comes from the Trading API (GetMyeBaySelling), so items
// listed in Seller Hub are included; listings managed by the Inventory API are marked so
// edits go through that API. Orders come from the Fulfillment API.
// Edits sent back: title, price and quantity; deleting ends the listing; marking an order
// fulfilled marks it shipped on eBay.

const SANDBOX = process.env.EBAY_ENV === 'sandbox';
const AUTH = SANDBOX ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';
const API = SANDBOX ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const APIZ = SANDBOX ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com';
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ');

// Region → Trading API site, REST marketplace and listing language.
const SITES = {
  'United States': { siteId: '0', marketplace: 'EBAY_US', lang: 'en-US' },
  'United Kingdom': { siteId: '3', marketplace: 'EBAY_GB', lang: 'en-GB' },
  Germany: { siteId: '77', marketplace: 'EBAY_DE', lang: 'de-DE' },
  Australia: { siteId: '15', marketplace: 'EBAY_AU', lang: 'en-AU' },
};
const siteOf = (store) => SITES[store?.region] || SITES['United States'];

const P = 'eBay';
const INVENTORY = 'ebay_inventory'; // listing managed by the Inventory API (edited by SKU)
const LISTING = 'ebay_listing'; // classic listing (edited by item ID through the Trading API)

// ---- Keys and tokens ---------------------------------------------------------------

function app() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;
  if (!clientId || !clientSecret || !ruName) throw new PlatformError('eBay isn’t set up on the server yet: add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME.');
  return { clientId, clientSecret, ruName };
}

const tokenRequest = (keys, form) =>
  requestJson(`${API}/identity/v1/oauth2/token`, { platform: P, method: 'POST', headers: { Authorization: basic(keys.clientId, keys.clientSecret) }, form }).then((r) => r.data);

function withTokens(creds, data) {
  return {
    ...creds,
    accessToken: data.access_token,
    expiresAt: Date.now() + num(data.expires_in) * 1000,
    refreshToken: data.refresh_token || creds.refreshToken,
    refreshExpiresAt: data.refresh_token_expires_in ? Date.now() + num(data.refresh_token_expires_in) * 1000 : creds.refreshExpiresAt,
  };
}

// ---- REST and Trading API calls ------------------------------------------------------

const rest = (creds, store, url, { method = 'GET', query, body } = {}) =>
  requestJson(url, {
    platform: P,
    method,
    query,
    body,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'X-EBAY-C-MARKETPLACE-ID': siteOf(store).marketplace,
      ...(body !== undefined ? { 'Content-Language': siteOf(store).lang } : {}),
    },
  }).then((r) => r.data);

const xmlEscape = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (v) => String(v ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml || '');
  return m ? xmlUnescape(m[1].trim()) : '';
};
const blocks = (xml, name) => [...String(xml || '').matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

const AUTH_ERRORS = new Set(['931', '932', '16110', '21916984', '21917053']);

async function trading(creds, store, call, inner) {
  const body = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${inner}</${call}Request>`;
  let res;
  try {
    res = await fetch(`${API}/ws/api.dll`, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': call,
        'X-EBAY-API-SITEID': siteOf(store).siteId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
        'X-EBAY-API-IAF-TOKEN': creds.accessToken,
        'Content-Type': 'text/xml',
      },
      body,
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    throw new PlatformError(`Couldn’t reach eBay: ${err.message}.`);
  }
  const xml = await res.text();
  if (!res.ok || tag(xml, 'Ack') === 'Failure') {
    const code = tag(xml, 'ErrorCode');
    const message = tag(xml, 'LongMessage') || tag(xml, 'ShortMessage') || `answered ${res.status}`;
    throw new PlatformError(`eBay: ${message}`, { code, auth: res.status === 401 || AUTH_ERRORS.has(code) });
  }
  return xml;
}

// ---- Orders --------------------------------------------------------------------------

const orderStatus = (o) => {
  if (o.cancelStatus?.cancelState === 'CANCELED') return 'cancelled';
  if (o.orderPaymentStatus === 'FULLY_REFUNDED') return 'refunded';
  if (o.orderFulfillmentStatus === 'FULFILLED') return 'fulfilled';
  if (o.orderFulfillmentStatus === 'IN_PROGRESS') return 'processing';
  return 'unfulfilled';
};

function orderRecord(store, o) {
  const s = o.pricingSummary || {};
  const addr = o.buyer?.buyerRegistrationAddress || {};
  return {
    storeId: store.id,
    externalId: o.orderId,
    number: o.orderId,
    items: (o.lineItems || []).map((li) => ({
      productId: li.legacyItemId ? `${store.id}_p${li.legacyItemId}` : null,
      lineItemId: li.lineItemId,
      title: li.title,
      qty: num(li.quantity),
      price: num(li.lineItemCost?.value) / Math.max(1, num(li.quantity)),
    })),
    subtotal: num(s.priceSubtotal?.value),
    shipping: num(s.deliveryCost?.value),
    tax: num(s.tax?.value),
    total: num(s.total?.value),
    currency: s.total?.currency || 'USD',
    status: orderStatus(o),
    wooStatus: o.orderFulfillmentStatus,
    refunded: (o.paymentSummary?.refunds || []).reduce((sum, r) => sum + num(r.amount?.value), 0),
    shippingInfo: { status: o.orderFulfillmentStatus === 'FULFILLED' ? 'shipped' : o.cancelStatus?.cancelState === 'CANCELED' ? null : 'awaiting' },
    placedAt: Date.parse(o.creationDate),
    updatedAt: Date.parse(o.lastModifiedDate),
    customer: { externalId: o.buyer?.username || null, name: addr.fullName || o.buyer?.username || 'eBay buyer', email: addr.email || '' },
  };
}

// ---- Listings ------------------------------------------------------------------------

async function inventorySkus(creds, store) {
  const skus = new Set();
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await rest(creds, store, `${API}/sell/inventory/v1/inventory_item`, { query: { limit: 100, offset } }).catch(() => null);
    (page?.inventoryItems || []).forEach((i) => skus.add(i.sku));
    if (!page?.next || !page.inventoryItems?.length) break;
  }
  return skus;
}

async function offerFor(creds, store, sku) {
  const data = await rest(creds, store, `${API}/sell/inventory/v1/offer`, { query: { sku, marketplace_id: siteOf(store).marketplace } });
  const offer = (data.offers || [])[0];
  if (!offer) throw new PlatformError(`eBay has no offer for SKU ${sku}.`);
  return offer;
}

export default {
  platform: P,
  auth: 'oauth',
  pushEdits: true,

  requiredEnv: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME'],

  authorizeUrl({ state }) {
    const keys = app();
    const q = new URLSearchParams({ client_id: keys.clientId, redirect_uri: keys.ruName, response_type: 'code', scope: SCOPES, state });
    return `${AUTH}/oauth2/authorize?${q}`;
  },

  async exchangeCode({ query }) {
    if (!query.code) throw new PlatformError('eBay didn’t send an authorization code.');
    const keys = app();
    const next = withTokens({}, await tokenRequest(keys, { grant_type: 'authorization_code', code: query.code, redirect_uri: keys.ruName }));
    const user = await requestJson(`${APIZ}/commerce/identity/v1/user/`, { platform: P, headers: { Authorization: `Bearer ${next.accessToken}` } })
      .then((r) => r.data)
      .catch(() => null);
    return { ...next, account: user?.username || null };
  },

  async refresh(creds) {
    return withTokens(creds, await tokenRequest(app(), { grant_type: 'refresh_token', refresh_token: creds.refreshToken, scope: SCOPES }));
  },

  async test({ store, creds }) {
    const user = await requestJson(`${APIZ}/commerce/identity/v1/user/`, { platform: P, headers: { Authorization: `Bearer ${creds.accessToken}` } }).then((r) => r.data);
    const xml = await trading(creds, store, 'GetMyeBaySelling', '<ActiveList><Include>true</Include><Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination></ActiveList>');
    const active = tag(tag(xml, 'ActiveList'), 'TotalNumberOfEntries') || '0';
    return { ok: true, message: `Connected to eBay as ${user.username}. ${active} active listings.`, account: user.username };
  },

  async syncProducts({ store, creds }) {
    const managedBySku = await inventorySkus(creds, store);
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const xml = await trading(
        creds,
        store,
        'GetMyeBaySelling',
        `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`,
      );
      const list = tag(xml, 'ActiveList');
      blocks(list, 'Item').forEach((item) => {
        const itemId = tag(item, 'ItemID');
        if (!itemId) return;
        const sku = tag(item, 'SKU');
        const available = tag(item, 'QuantityAvailable');
        const stock = available !== '' ? num(available) : num(tag(item, 'Quantity'));
        out.push({
          storeId: store.id,
          externalId: itemId,
          title: tag(item, 'Title'),
          sku,
          category: tag(tag(item, 'PrimaryCategory'), 'CategoryName'),
          price: num(tag(tag(item, 'SellingStatus'), 'CurrentPrice') || tag(item, 'BuyItNowPrice')),
          stock,
          status: stock === 0 ? 'out_of_stock' : 'active',
          type: sku && managedBySku.has(sku) ? INVENTORY : LISTING,
          image: tag(tag(item, 'PictureDetails'), 'GalleryURL'),
          permalink: tag(tag(item, 'ListingDetails'), 'ViewItemURL') || `https://www.ebay.com/itm/${itemId}`,
          updatedAt: Date.now(),
        });
      });
      const pages = num(tag(tag(list, 'PaginationResult'), 'TotalNumberOfPages'));
      if (page >= pages) break;
    }
    return out;
  },

  async syncOrders({ store, creds }, { since }) {
    const filter = since ? `lastmodifieddate:[${new Date(since - 120000).toISOString()}..]` : `creationdate:[${new Date(Date.now() - 90 * 864e5).toISOString()}..]`;
    const orders = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const page = await rest(creds, store, `${API}/sell/fulfillment/v1/order`, { query: { filter, limit: 200, offset } });
      orders.push(...(page.orders || []));
      if (!page.next || !page.orders?.length) break;
    }
    return orders.map((o) => orderRecord(store, o));
  },

  // ---- Digital Hub → eBay ------------------------------------------------------------

  /** Title, price and quantity; a delete ends the listing. Returns the fields to save. */
  async pushProduct({ store, creds }, product, before) {
    if (!product.externalId || product.externalId === 'pending') {
      throw new PlatformError('New eBay listings need a category, photos and policies, so create them on eBay. They come in on the next sync.');
    }
    const changed = (key) => !before || before[key] !== product[key];

    if (product.type === INVENTORY && product.sku) {
      if (product.pendingDelete) {
        await rest(creds, store, `${API}/sell/inventory/v1/inventory_item/${encodeURIComponent(product.sku)}`, { method: 'DELETE' });
        return { deleted: true };
      }
      if (changed('title')) {
        const item = await rest(creds, store, `${API}/sell/inventory/v1/inventory_item/${encodeURIComponent(product.sku)}`);
        const { sku: _s, locale: _l, groupIds: _g, inventoryItemGroupKeys: _k, ...replacement } = item;
        replacement.product = { ...(item.product || {}), title: product.title };
        await rest(creds, store, `${API}/sell/inventory/v1/inventory_item/${encodeURIComponent(product.sku)}`, { method: 'PUT', body: replacement });
      }
      if (changed('price') || changed('stock')) {
        const offer = await offerFor(creds, store, product.sku);
        const qty = product.stock == null ? undefined : Math.max(0, Math.round(product.stock));
        const result = await rest(creds, store, `${API}/sell/inventory/v1/bulk_update_price_quantity`, {
          method: 'POST',
          body: {
            requests: [
              {
                sku: product.sku,
                ...(qty !== undefined ? { shipToLocationAvailability: { quantity: qty } } : {}),
                offers: [
                  {
                    offerId: offer.offerId,
                    ...(qty !== undefined ? { availableQuantity: qty } : {}),
                    price: { value: String(Number(product.price).toFixed(2)), currency: offer.pricingSummary?.price?.currency || 'USD' },
                  },
                ],
              },
            ],
          },
        });
        const failed = (result?.responses || []).find((r) => r.statusCode >= 400);
        if (failed) throw new PlatformError(`eBay: ${failed.errors?.[0]?.message || 'the update was refused'}.`);
      }
    } else {
      const itemId = xmlEscape(product.externalId);
      if (product.pendingDelete) {
        await trading(creds, store, 'EndFixedPriceItem', `<ItemID>${itemId}</ItemID><EndingReason>NotAvailable</EndingReason>`);
        return { deleted: true };
      }
      if (changed('title')) {
        await trading(creds, store, 'ReviseFixedPriceItem', `<Item><ItemID>${itemId}</ItemID><Title>${xmlEscape(product.title.slice(0, 80))}</Title></Item>`);
      }
      if (changed('price') || changed('stock')) {
        const qty = product.stock == null ? '' : `<Quantity>${Math.max(0, Math.round(product.stock))}</Quantity>`;
        await trading(
          creds,
          store,
          'ReviseInventoryStatus',
          `<InventoryStatus><ItemID>${itemId}</ItemID><StartPrice>${Number(product.price).toFixed(2)}</StartPrice>${qty}</InventoryStatus>`,
        );
      }
    }
    if (before && before.status !== product.status && product.status === 'draft') {
      throw new PlatformError('Saved title, price and quantity. To end the listing, delete the product here, or end it on eBay.');
    }
    return { title: product.title.slice(0, 80), price: product.price, stock: product.stock, status: product.stock === 0 ? 'out_of_stock' : 'active' };
  },

  /** Marking an order fulfilled marks it shipped on eBay. */
  async pushOrder({ store, creds }, order) {
    if (order.status !== 'fulfilled') {
      throw new PlatformError('eBay only takes “fulfilled” (marked as shipped) from Digital Hub. Make refunds and cancellations on eBay.');
    }
    const lineItems = (order.items || []).filter((i) => i.lineItemId).map((i) => ({ lineItemId: i.lineItemId, quantity: i.qty || 1 }));
    if (!lineItems.length) throw new PlatformError('This order has no eBay line items yet. Sync the store, then try again.');
    await rest(creds, store, `${API}/sell/fulfillment/v1/order/${encodeURIComponent(order.externalId)}/shipping_fulfillment`, {
      method: 'POST',
      body: { lineItems, shippedDate: new Date().toISOString() },
    });
    const fresh = await rest(creds, store, `${API}/sell/fulfillment/v1/order/${encodeURIComponent(order.externalId)}`);
    const { customer: _c, ...fields } = orderRecord(store, fresh);
    return fields;
  },
};
