import 'server-only';
import { PlatformError, env, num, requestJson } from './http';

// Amazon Selling Partner API with OAuth through Seller Central ("website authorization").
// Env: AMAZON_SP_APP_ID (amzn1.sp.solution…), AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET,
// AMAZON_SP_DRAFT_APP=true while the app is still a draft (adds version=beta),
// AMAZON_MARKETPLACE_ID to override the default marketplace for the region.
// Redirect URI to register on the app: <app>/api/integrations/callback/amazon
// Access tokens last 1 hour; the refresh token lasts until the seller revokes it.

const P = 'Amazon';
const REGIONS = {
  'North America': { host: 'https://sellingpartnerapi-na.amazon.com', consent: 'https://sellercentral.amazon.com', marketplace: 'ATVPDKIKX0DER' },
  Europe: { host: 'https://sellingpartnerapi-eu.amazon.com', consent: 'https://sellercentral-europe.amazon.com', marketplace: 'A1F83G8C2ARO7P' },
  'Far East': { host: 'https://sellingpartnerapi-fe.amazon.com', consent: 'https://sellercentral.amazon.co.jp', marketplace: 'A1VC38T7YXB528' },
};
const regionOf = (name) => REGIONS[name] || REGIONS['North America'];
const marketplaceOf = (creds) => process.env.AMAZON_MARKETPLACE_ID || regionOf(creds.region).marketplace;

async function lwa(form) {
  const { data } = await requestJson('https://api.amazon.com/auth/o2/token', {
    platform: P,
    method: 'POST',
    form: { ...form, client_id: env('AMAZON_LWA_CLIENT_ID', P), client_secret: env('AMAZON_LWA_CLIENT_SECRET', P) },
  });
  return data;
}

const get = (creds, path, query) =>
  requestJson(`${regionOf(creds.region).host}${path}`, { platform: P, headers: { 'x-amz-access-token': creds.accessToken }, query }).then((r) => r.data);

const STATUS = { Shipped: 'fulfilled', Canceled: 'cancelled', Unfulfillable: 'cancelled', PartiallyShipped: 'processing', Unshipped: 'unfulfilled', Pending: 'unfulfilled' };

export default {
  platform: P,
  auth: 'oauth',

  authorizeUrl({ state, redirectUri, store }) {
    const q = new URLSearchParams({ application_id: env('AMAZON_SP_APP_ID', P), state, redirect_uri: redirectUri });
    if (process.env.AMAZON_SP_DRAFT_APP === 'true') q.set('version', 'beta');
    return `${regionOf(store.region).consent}/apps/authorize/consent?${q}`;
  },

  async exchangeCode({ query, redirectUri, store }) {
    if (!query.spapi_oauth_code) throw new PlatformError('Amazon didn’t send an authorization code.');
    const data = await lwa({ grant_type: 'authorization_code', code: query.spapi_oauth_code, redirect_uri: redirectUri });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + num(data.expires_in) * 1000,
      sellerId: query.selling_partner_id,
      region: store.region || 'North America',
      account: query.selling_partner_id,
    };
  },

  async refresh(creds) {
    const data = await lwa({ grant_type: 'refresh_token', refresh_token: creds.refreshToken });
    return { ...creds, accessToken: data.access_token, expiresAt: Date.now() + num(data.expires_in) * 1000 };
  },

  async test({ creds }) {
    const data = await get(creds, '/sellers/v1/marketplaceParticipations');
    const names = (data.payload || []).map((p) => p.marketplace?.name).filter(Boolean);
    return { ok: true, message: `Connected to Amazon (${names.join(', ') || 'no marketplaces'}).`, account: creds.sellerId };
  },

  async syncProducts({ store, creds }) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 25; page++) {
      const data = await get(creds, `/listings/2021-08-01/items/${encodeURIComponent(creds.sellerId)}`, {
        marketplaceIds: marketplaceOf(creds),
        includedData: 'summaries,offers,fulfillmentAvailability',
        pageSize: 20,
        pageToken,
      });
      (data.items || []).forEach((i) => {
        const summary = i.summaries?.[0] || {};
        const qty = i.fulfillmentAvailability?.[0]?.quantity;
        const buyable = (summary.status || []).includes('BUYABLE');
        out.push({
          storeId: store.id,
          externalId: i.sku,
          title: summary.itemName || i.sku,
          sku: i.sku,
          category: summary.productType || '',
          price: num(i.offers?.[0]?.price?.amount),
          stock: qty ?? null,
          status: buyable ? (qty === 0 ? 'out_of_stock' : 'active') : 'draft',
          image: summary.mainImage?.link || '',
          permalink: summary.asin ? `https://www.amazon.com/dp/${summary.asin}` : '',
        });
      });
      pageToken = data.pagination?.nextToken;
      if (!pageToken) break;
    }
    return out;
  },

  async syncOrders({ store, creds }, { since }) {
    const orders = [];
    let NextToken;
    const after = new Date(since ? since - 120000 : Date.now() - 30 * 864e5).toISOString();
    for (let page = 0; page < 30; page++) {
      const data = await get(
        creds,
        '/orders/v0/orders',
        NextToken ? { MarketplaceIds: marketplaceOf(creds), NextToken } : { MarketplaceIds: marketplaceOf(creds), LastUpdatedAfter: after, MaxResultsPerPage: 100 },
      );
      orders.push(...(data.payload?.Orders || []));
      NextToken = data.payload?.NextToken;
      if (!NextToken) break;
    }
    // Line items are one call per order and rate-limited, so only the newest 20 per sync get them.
    const withItems = new Set(orders.slice(0, 20).map((o) => o.AmazonOrderId));
    const out = [];
    for (const o of orders) {
      let items = [];
      if (withItems.has(o.AmazonOrderId)) {
        const data = await get(creds, `/orders/v0/orders/${o.AmazonOrderId}/orderItems`).catch(() => null);
        items = (data?.payload?.OrderItems || []).map((li) => ({
          productId: li.SellerSKU ? `${store.id}_p${li.SellerSKU}` : null,
          title: li.Title || li.ASIN,
          qty: num(li.QuantityOrdered),
          price: num(li.ItemPrice?.Amount) / Math.max(1, num(li.QuantityOrdered)),
        }));
      }
      const total = num(o.OrderTotal?.Amount);
      out.push({
        storeId: store.id,
        externalId: o.AmazonOrderId,
        number: o.AmazonOrderId,
        ...(items.length ? { items } : {}),
        subtotal: total,
        total,
        currency: o.OrderTotal?.CurrencyCode || 'USD',
        status: STATUS[o.OrderStatus] || 'unfulfilled',
        placedAt: Date.parse(o.PurchaseDate),
        updatedAt: Date.parse(o.LastUpdateDate),
        customer: { externalId: null, name: o.BuyerInfo?.BuyerName || 'Amazon customer', email: o.BuyerInfo?.BuyerEmail || '' },
      });
    }
    return out;
  },
};
