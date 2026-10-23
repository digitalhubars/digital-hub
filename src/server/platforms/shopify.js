import 'server-only';
import { PlatformError, num, requestJson, sleep } from './http';

// Shopify Admin GraphQL API with a custom app's Admin API access token (shpat_…).
// Scopes: read_products, read_orders, read_customers, read_inventory
// (read_all_orders for orders older than 60 days).

const VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const MAX_PAGES = 40;

const domainOf = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

async function gql(creds, query, variables = {}) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await requestJson(`https://${creds.domain}/admin/api/${VERSION}/graphql.json`, {
      platform: 'Shopify',
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': creds.token },
      body: { query, variables },
    });
    const throttled = data?.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (data?.errors?.length) {
      const message = data.errors.map((e) => e.message).join('; ');
      throw new PlatformError(`Shopify: ${message}`, { auth: /access denied|scope/i.test(message) });
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
      customer { legacyResourceId firstName lastName email }
      lineItems(first: 20) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } product { legacyResourceId } } }
    }
  }
}`;

function orderStatus(o) {
  if (o.cancelledAt) return 'cancelled';
  if (o.displayFinancialStatus === 'REFUNDED') return 'refunded';
  if (o.displayFulfillmentStatus === 'FULFILLED') return 'fulfilled';
  if (['PARTIALLY_FULFILLED', 'IN_PROGRESS'].includes(o.displayFulfillmentStatus)) return 'processing';
  return 'unfulfilled';
}

export default {
  platform: 'Shopify',
  auth: 'key',

  connect({ domain, token }) {
    const d = domainOf(domain);
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) throw new PlatformError('Use the store’s myshopify.com address, e.g. your-store.myshopify.com.');
    if (!token || token.trim().length < 20) throw new PlatformError('Paste the Admin API access token (starts with shpat_).');
    return { domain: d, token: token.trim() };
  },

  async test({ creds }) {
    const data = await gql(creds, '{ shop { name currencyCode } }');
    return { ok: true, message: `Connected to ${data.shop.name} (${data.shop.currencyCode}).`, account: creds.domain };
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
        currency: o.currencyCode,
        status: orderStatus(o),
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
};
