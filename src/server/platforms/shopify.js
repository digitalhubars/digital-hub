import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformError, num, requestJson, sleep } from './http';

// Shopify Admin GraphQL API. Two ways to connect a store:
// - "Sign in with Shopify" (popup OAuth): the admin types the store's myshopify.com domain,
//   then approves in Shopify. The app keys come only from the server's environment:
//   SHOPIFY_API_KEY (Client ID) and SHOPIFY_API_SECRET (Client Secret) of the app in the
//   Shopify Dev Dashboard, whose allowed redirect URL is <app>/api/integrations/callback/shopify.
//   Gives an offline access token; the secret also verifies webhooks for real-time updates.
// - Admin API access token (shpat_…) from an existing custom app: no webhooks, so changes
//   arrive on each background sync.
// Scopes: read_products, read_inventory, read_orders, read_fulfillments, read_customers
// (read_all_orders for orders older than 60 days). Customer names/emails need the app's
// "Protected customer data" access in the Dev Dashboard.

const VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const MAX_PAGES = 40;
const SCOPES = 'read_products,read_inventory,read_orders,read_fulfillments,read_customers';
const P = 'Shopify';

const WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'REFUNDS_CREATE',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'INVENTORY_LEVELS_UPDATE',
  'CUSTOMERS_CREATE',
  'CUSTOMERS_UPDATE',
];

const domainOf = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
const validDomain = (d) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d);
export const shopifyDomain = (value) => {
  const d = domainOf(value);
  return validDomain(d) ? d : null;
};

function app() {
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  if (!clientId || !clientSecret) throw new PlatformError('Shopify isn’t set up on the server yet: add SHOPIFY_API_KEY and SHOPIFY_API_SECRET.');
  return { clientId, clientSecret };
}

/** The app's secret, for checking webhook signatures (null when Shopify isn't set up). */
export const shopifySecret = () => process.env.SHOPIFY_API_SECRET || null;

async function gql(creds, query, variables = {}) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await requestJson(`https://${creds.domain}/admin/api/${VERSION}/graphql.json`, {
      platform: P,
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': creds.accessToken || creds.token },
      body: { query, variables },
    });
    const throttled = data?.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (data?.errors?.length) {
      const message = data.errors.map((e) => e.message).join('; ');
      throw new PlatformError(`Shopify: ${message}`, { auth: /access denied|scope|invalid api key/i.test(message) });
    }
    return data.data;
  }
}

async function paginate(creds, query, path, variables) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const conn = path(await gql(creds, query, { ...variables, after }));
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

const updatedSince = (since) => (since ? `updated_at:>'${new Date(since - 120000).toISOString()}'` : null);

const PRODUCTS = `query($after: String, $query: String) {
  products(first: 50, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId title status productType onlineStoreUrl updatedAt totalInventory tracksInventory
      featuredMedia { preview { image { url } } }
      variants(first: 1) { nodes { sku price compareAtPrice } }
    }
  }
}`;

const ORDERS = `query($after: String, $query: String) {
  orders(first: 25, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId name createdAt updatedAt cancelledAt currencyCode email
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount } }
      subtotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      fulfillments(first: 5) { status createdAt trackingInfo(first: 1) { company number url } }
      customer { legacyResourceId firstName lastName email }
      lineItems(first: 20) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } product { legacyResourceId } } }
    }
  }
}`;

const CUSTOMERS = `query($after: String, $query: String) {
  customers(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { legacyResourceId firstName lastName email updatedAt }
  }
}`;

function orderStatus(o) {
  if (o.cancelledAt) return 'cancelled';
  if (o.displayFinancialStatus === 'REFUNDED') return 'refunded';
  if (o.displayFulfillmentStatus === 'FULFILLED') return 'fulfilled';
  if (['PARTIALLY_FULFILLED', 'IN_PROGRESS'].includes(o.displayFulfillmentStatus)) return 'processing';
  return 'unfulfilled';
}

/** Shopify signs OAuth redirects: HMAC-SHA256 (hex) of the sorted query, without `hmac`, keyed by the Client Secret. */
function validRedirect(query, secret) {
  const { hmac, signature: _s, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  return expected.length === hmac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(hmac));
}

/** Webhooks: X-Shopify-Hmac-Sha256 = base64 HMAC-SHA256 of the raw body, keyed by the Client Secret. */
export function validShopifyWebhook(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export default {
  platform: P,
  auth: 'oauth',

  requiredEnv: ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'],

  /** The "Use an access token" alternative: { domain, token } from an existing custom app. Connects right away. */
  async connect({ domain, token }) {
    const d = shopifyDomain(domain);
    if (!d) throw new PlatformError('Use the store’s myshopify.com address, e.g. your-store.myshopify.com.');
    if (!token?.trim() || token.trim().length < 20) throw new PlatformError('Paste the full Admin API access token (starts with shpat_).');
    const creds = { domain: d, token: token.trim(), accessToken: token.trim(), mode: 'token' };
    await gql(creds, '{ shop { name } }');
    return creds;
  },

  /** meta.shop = the domain typed before the popup opened (or the store's saved domain). */
  authorizeUrl({ state, redirectUri, meta = {}, store }) {
    const shop = shopifyDomain(meta.shop || store?.url);
    if (!shop) throw new PlatformError('Enter the store’s myshopify.com address first.');
    const q = new URLSearchParams({ client_id: app().clientId, scope: SCOPES, redirect_uri: redirectUri, state });
    return `https://${shop}/admin/oauth/authorize?${q}`;
  },

  async exchangeCode({ query, meta = {}, store }) {
    const { clientId, clientSecret } = app();
    if (!validRedirect(query, clientSecret)) throw new PlatformError('Shopify’s redirect signature didn’t match. Try again.');
    const expected = shopifyDomain(meta.shop || store?.url);
    const shop = shopifyDomain(query.shop);
    if (!shop || shop !== expected) throw new PlatformError(`Shopify returned a different store (${query.shop}) than ${expected}.`);
    if (!query.code) throw new PlatformError('Shopify didn’t send an authorization code.');
    const { data } = await requestJson(`https://${shop}/admin/oauth/access_token`, {
      platform: P,
      method: 'POST',
      body: { client_id: clientId, client_secret: clientSecret, code: query.code },
    });
    const creds = { domain: shop, accessToken: data.access_token, token: data.access_token, scope: data.scope, mode: 'oauth' };
    const info = await gql(creds, '{ shop { name } }');
    return { ...creds, account: info.shop.name, url: shop };
  },

  async test({ creds }) {
    const data = await gql(creds, '{ shop { name currencyCode } }');
    return { ok: true, message: `Connected to ${data.shop.name} (${data.shop.currencyCode}).`, account: data.shop.name };
  },

  async syncProducts({ store, creds }, { since }) {
    const nodes = await paginate(creds, PRODUCTS, (d) => d.products, { query: updatedSince(since) });
    return nodes.map((p) => {
      const v = p.variants.nodes[0] || {};
      let status = p.status === 'ACTIVE' ? 'active' : 'draft';
      if (status === 'active' && p.tracksInventory && p.totalInventory <= 0) status = 'out_of_stock';
      return {
        storeId: store.id,
        externalId: p.legacyResourceId,
        title: p.title,
        sku: v.sku || '',
        category: p.productType || '',
        price: num(v.price),
        salePrice: v.compareAtPrice ? num(v.price) : null,
        stock: p.tracksInventory ? p.totalInventory : null,
        status,
        image: p.featuredMedia?.preview?.image?.url || '',
        permalink: p.onlineStoreUrl || '',
        updatedAt: Date.parse(p.updatedAt),
      };
    });
  },

  async syncOrders({ store, creds }, { since }) {
    const nodes = await paginate(creds, ORDERS, (d) => d.orders, { query: updatedSince(since) });
    return nodes.map((o) => {
      const c = o.customer;
      const money = (set) => num(set?.shopMoney?.amount);
      const shipped = (o.fulfillments || []).find((f) => f.status === 'SUCCESS') || o.fulfillments?.[0];
      const tracking = shipped?.trackingInfo?.[0];
      return {
        storeId: store.id,
        externalId: o.legacyResourceId,
        number: o.name,
        items: o.lineItems.nodes.map((li) => ({
          productId: li.product ? `${store.id}_p${li.product.legacyResourceId}` : null,
          title: li.title,
          qty: li.quantity,
          price: money(li.originalUnitPriceSet),
        })),
        subtotal: money(o.subtotalPriceSet),
        shipping: money(o.totalShippingPriceSet),
        tax: money(o.totalTaxSet),
        total: money(o.totalPriceSet),
        refunded: money(o.totalRefundedSet),
        currency: o.currencyCode,
        status: orderStatus(o),
        shippingInfo: {
          status: shipped ? 'shipped' : o.cancelledAt ? null : 'awaiting',
          carrier: tracking?.company || null,
          tracking: tracking?.number || null,
          trackingUrl: tracking?.url || null,
          shippedAt: shipped ? Date.parse(shipped.createdAt) : null,
        },
        placedAt: Date.parse(o.createdAt),
        updatedAt: Date.parse(o.updatedAt),
        customer: {
          externalId: c?.legacyResourceId || null,
          name: [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.email || o.email || 'Customer',
          email: c?.email || o.email || '',
        },
      };
    });
  },

  async syncCustomers({ store, creds }, { since }) {
    const nodes = await paginate(creds, CUSTOMERS, (d) => d.customers, { query: updatedSince(since) }).catch((err) => {
      // Without "Protected customer data" access Shopify refuses the list; buyers still arrive with orders.
      console.warn('Shopify customers skipped:', err.message);
      return [];
    });
    return nodes.map((c) => ({
      storeId: store.id,
      externalId: c.legacyResourceId,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Customer',
      email: c.email || '',
      updatedAt: Date.parse(c.updatedAt),
    }));
  },

  /**
   * Real-time updates: subscribes the store to order, refund, fulfillment, product, inventory
   * and customer events (only for stores connected with Sign in with Shopify, whose Client
   * Secret verifies the deliveries). Returns the fields to keep in the credentials.
   */
  async registerWebhooks({ creds }, { url }) {
    if (creds.mode === 'token' || !shopifySecret()) return { note: 'Live updates need “Sign in with Shopify”; this store syncs on a schedule.' };
    if (creds.webhookUrl === url && creds.webhookIds?.length) return {};
    for (const id of creds.webhookIds || []) {
      await gql(creds, 'mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { message } } }', { id }).catch(() => {});
    }
    const ids = [];
    for (const topic of WEBHOOK_TOPICS) {
      const create = (field) =>
        gql(
          creds,
          `mutation($topic: WebhookSubscriptionTopic!, $url: ${field === 'uri' ? 'String!' : 'URL!'}) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: { ${field}: $url, format: JSON }) {
              webhookSubscription { id } userErrors { message }
            }
          }`,
          { topic, url },
        );
      // Newer API versions call the address `uri`; older ones `callbackUrl`.
      const data = await create('uri').catch(() => create('callbackUrl'));
      const result = data.webhookSubscriptionCreate;
      if (result.webhookSubscription?.id) ids.push(result.webhookSubscription.id);
      else if (!/already been taken|already exists/i.test(result.userErrors?.[0]?.message || '')) {
        throw new PlatformError(`Shopify didn’t accept the ${topic} webhook: ${result.userErrors?.[0]?.message || 'unknown error'}.`);
      }
    }
    return { creds: { webhookUrl: url, webhookIds: ids } };
  },
};
