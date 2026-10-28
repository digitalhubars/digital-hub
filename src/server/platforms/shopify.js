import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformError, num, requestJson, sleep } from './http';

// Shopify Admin GraphQL API, connected with the store's app credentials:
// - Store domain + Client ID + Client Secret of an app made in the Shopify Dev Dashboard
//   (dev.shopify.com) and installed on that store. Digital Hub swaps them for an access token
//   with Shopify's client credentials grant (no sign-in screen). Tokens last 24 hours and are
//   renewed automatically. The Client Secret also verifies Shopify's webhooks, so changes
//   show up in real time.
// - Or an Admin API access token (shpat_…) from an older custom app: no webhooks, so changes
//   arrive on each background sync.
// Scopes to give the app: see SCOPES. Without read_all_orders Shopify only shares the last 60 days
// of orders; the write_* scopes let Digital Hub send product and order changes back. Customer names/emails also
// need the app's "Protected customer data" access in the Dev Dashboard.

const VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const MAX_PAGES = 200;
const SCOPES =
  'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_all_orders,write_orders,read_fulfillments,write_merchant_managed_fulfillment_orders,read_customers';
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

/**
 * The store's myshopify.com address. A custom domain (e.g. joshuaco.shop) is looked up through
 * the storefront's public /meta.json (myshopify_domain), or the /admin redirect as a fallback.
 */
export async function resolveShopDomain(value) {
  const direct = shopifyDomain(value);
  if (direct) return direct;
  const host = domainOf(value);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  try {
    const res = await fetch(`https://${host}/meta.json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const found = shopifyDomain((await res.json())?.myshopify_domain);
      if (found) return found;
    }
  } catch {
    // try the admin redirect
  }
  try {
    const res = await fetch(`https://${host}/admin`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return shopifyDomain(res.headers.get('location'));
  } catch {
    return null;
  }
}

/** Webhook secret for a store: its own Client Secret (or SHOPIFY_API_SECRET, if set on the server). */
export const shopifySecret = (creds) => creds?.clientSecret || process.env.SHOPIFY_API_SECRET || null;

/** Client credentials grant: Client ID + Secret → an access token for the store (24 hours). */
async function clientToken(creds) {
  let res;
  try {
    res = await requestJson(`https://${creds.domain}/admin/oauth/access_token`, {
      platform: P,
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret },
    });
  } catch (err) {
    const hint =
      err.status === 404
        ? `No Shopify store at ${creds.domain}. Check the myshopify.com address.`
        : 'Check the Client ID and Client Secret, and that the app is installed on this store (Dev Dashboard → your app → Install app) with a released version that has the scopes.';
    throw new PlatformError(`Shopify didn’t give an access token. ${hint} (${err.message})`, { status: err.status, auth: true });
  }
  const data = res.data || {};
  if (!data.access_token) throw new PlatformError('Shopify didn’t return an access token. Check that the app is installed on this store.', { auth: true });
  return { ...creds, accessToken: data.access_token, token: data.access_token, scope: data.scope, expiresAt: Date.now() + num(data.expires_in || 86399) * 1000 };
}

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

const ORDER_FIELDS = `
  legacyResourceId name createdAt updatedAt cancelledAt currencyCode email
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount } }
  subtotalPriceSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  fulfillments(first: 5) { status createdAt trackingInfo(first: 1) { company number url } }
  customer { legacyResourceId firstName lastName email }
  lineItems(first: 20) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } product { legacyResourceId } } }`;

const ORDERS = `query($after: String, $query: String) {
  orders(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

const ORDER = `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

const OPEN_FULFILLMENT_ORDERS = `query($id: ID!) {
  order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } }
}`;

const orderGid = (externalId) => `gid://shopify/Order/${externalId}`;

/** First user error of a mutation result, as a PlatformError. */
function userErrors(result, what) {
  const errors = result?.userErrors || result?.orderCancelUserErrors || [];
  if (errors.length) throw new PlatformError(`Shopify didn’t ${what}: ${errors.map((e) => e.message).join('; ')}`);
}

const isScopeError = (err) => /access denied|scope|not approved to access/i.test(err.message);

/**
 * Runs a change with the store's token. If Shopify says the app lacks a scope, a new token is
 * fetched once (scopes added in the Dev Dashboard only reach new tokens), then the missing
 * scopes are named.
 */
async function withScopes(creds, needed, run) {
  try {
    return await run(creds);
  } catch (err) {
    if (!isScopeError(err)) throw err;
    let fresh = creds;
    if (creds.mode !== 'token' && creds.clientId && creds.clientSecret) {
      fresh = await clientToken(creds);
      try {
        return await run(fresh);
      } catch (again) {
        if (!isScopeError(again)) throw again;
      }
    }
    const granted = String(fresh.scope || '').split(',');
    const missing = needed.filter((x) => !granted.includes(x));
    throw new PlatformError(
      `Shopify didn’t allow this change: the store’s app is missing ${(missing.length ? missing : needed).join(', ')}. In the Shopify Dev Dashboard open the app → Versions → create a version with those scopes → Release, then approve the update on the store (Settings → Apps). Digital Hub picks the new scopes up automatically.`,
    );
  }
}

const ORDER_SCOPES = ['write_orders', 'write_merchant_managed_fulfillment_orders'];
const PRODUCT_SCOPES = ['write_products', 'write_inventory', 'read_locations'];

const productGid = (externalId) => `gid://shopify/Product/${externalId}`;

const PRODUCT_TARGET = `query($id: ID!) {
  product(id: $id) { id variants(first: 1) { nodes { id inventoryItem { id tracked } } } }
  locations(first: 1) { nodes { id } }
}`;

/** Title, type, status, price, SKU and stock of a product's first variant. Returns its ID. */
async function saveProduct(creds, product, before) {
  const changed = (key) => !before || before[key] !== product[key];
  const isNew = !product.externalId || product.externalId === 'pending';
  const status = product.status === 'draft' ? 'DRAFT' : 'ACTIVE';

  let productId = isNew ? null : productGid(product.externalId);
  if (isNew) {
    const created = await gql(creds, `mutation($product: ProductCreateInput!) { productCreate(product: $product) { product { id } userErrors { message } } }`, {
      product: { title: product.title, productType: product.category || '', status },
    });
    userErrors(created.productCreate, 'create the product');
    productId = created.productCreate.product.id;
  } else if (changed('title') || changed('category') || changed('status')) {
    const updated = await gql(creds, `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { message } } }`, {
      product: { id: productId, title: product.title, productType: product.category || '', status },
    });
    userErrors(updated.productUpdate, 'update the product');
  }

  const target = await gql(creds, PRODUCT_TARGET, { id: productId });
  const variant = target.product?.variants?.nodes?.[0];
  if (!variant) throw new PlatformError('Shopify has no variant for this product.');

  if (isNew || changed('price') || changed('sku') || (product.stock != null && !variant.inventoryItem?.tracked)) {
    const result = await gql(
      creds,
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } } }`,
      {
        productId,
        variants: [
          {
            id: variant.id,
            price: String(Number(product.price) || 0),
            inventoryItem: { sku: product.sku || '', ...(product.stock != null ? { tracked: true } : {}) },
          },
        ],
      },
    );
    userErrors(result.productVariantsBulkUpdate, 'update the price');
  }

  const location = target.locations?.nodes?.[0];
  if (product.stock != null && (isNew || changed('stock')) && location) {
    const result = await gql(creds, `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`, {
      input: {
        name: 'available',
        reason: 'correction',
        ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId: variant.inventoryItem.id, locationId: location.id, quantity: Math.max(0, Math.round(product.stock)) }],
      },
    });
    userErrors(result.inventorySetQuantities, 'update the stock');
  }
  return productId.split('/').pop();
}

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

function orderRecord(store, o) {
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
}

/** Webhooks: X-Shopify-Hmac-Sha256 = base64 HMAC-SHA256 of the raw body, keyed by the Client Secret. */
export function validShopifyWebhook(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export default {
  platform: P,
  auth: 'key',

  /**
   * { domain, clientId, clientSecret } → access token via the client credentials grant, or
   * { domain, token } for an older custom app's Admin API token. Checked before it's saved.
   */
  async connect({ domain, clientId, clientSecret, token }) {
    const d = await resolveShopDomain(domain);
    if (!d) {
      throw new PlatformError(
        `Couldn’t find a Shopify store at ${domainOf(domain) || 'that address'}. Use the store’s myshopify.com address (Shopify admin → Settings → Domains), e.g. your-store.myshopify.com.`,
      );
    }
    if (token?.trim()) {
      if (/^shpss_/i.test(token.trim())) throw new PlatformError('That’s the app’s Client secret, not an access token. Choose “Client ID + Secret” and paste it there with the Client ID.');
      if (token.trim().length < 20) throw new PlatformError('Paste the full Admin API access token (starts with shpat_ or shpca_).');
      const creds = { domain: d, publicDomain: domainOf(domain), token: token.trim(), accessToken: token.trim(), mode: 'token' };
      await gql(creds, '{ shop { name } }');
      return creds;
    }
    if (!clientId?.trim() || !clientSecret?.trim()) throw new PlatformError('Enter the app’s Client ID and Client Secret.');
    return clientToken({ domain: d, publicDomain: domainOf(domain), clientId: clientId.trim(), clientSecret: clientSecret.trim(), mode: 'client' });
  },

  /** A new 24-hour token with the saved Client ID + Secret (token-mode stores never expire). */
  async refresh(creds) {
    return clientToken(creds);
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
    return nodes.map((o) => orderRecord(store, o));
  },

  pushEdits: true,

  /**
   * Order changes made in Digital Hub: "fulfilled" fulfils every open fulfillment order (no
   * customer email), "cancelled" cancels the order on Shopify (restocks, no refund). Other
   * statuses follow from what happens on Shopify, so they're refused with an explanation.
   */
  async pushOrder({ store, creds: saved }, order) {
    const id = orderGid(order.externalId);
    let creds = saved;
    await withScopes(saved, ORDER_SCOPES, async (c) => {
      creds = c;
      if (order.status === 'fulfilled') {
        const data = await gql(creds, OPEN_FULFILLMENT_ORDERS, { id });
        const open = (data.order?.fulfillmentOrders?.nodes || []).filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED', 'ON_HOLD'].includes(f.status));
        if (open.length) {
          const result = await gql(
            creds,
            `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { message } } }`,
            { fulfillment: { notifyCustomer: false, lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })) } },
          );
          userErrors(result.fulfillmentCreate, 'fulfil the order');
        }
      } else if (order.status === 'cancelled') {
        const cancel = (refundArg) =>
          gql(
            creds,
            `mutation($id: ID!) { orderCancel(orderId: $id, reason: OTHER, restock: true, notifyCustomer: false, ${refundArg}) { job { id } orderCancelUserErrors { message } } }`,
            { id },
          );
        // Newer API versions replaced `refund` with `refundMethod`.
        const result = await cancel('refundMethod: { originalPaymentMethodsRefund: false }').catch(() => cancel('refund: false'));
        userErrors(result.orderCancel, 'cancel the order');
      } else if (order.status === 'refunded') {
        throw new PlatformError('Refunds move money, so make them in Shopify (Orders → Refund). The order updates here on the next sync.');
      } else {
        throw new PlatformError('Shopify sets “unfulfilled” and “processing” itself. From Digital Hub you can mark an order fulfilled, cancel it or delete it.');
      }
    });
    // Cancelling runs as a job on Shopify; the fresh order may still show it as open for a moment.
    const fresh = (await gql(creds, ORDER, { id })).order;
    if (!fresh) return { status: order.status };
    const { customer: _c, ...fields } = orderRecord(store, fresh);
    return order.status === 'cancelled' ? { ...fields, status: 'cancelled' } : fields;
  },

  /** Deletes the order on Shopify (Shopify refuses orders paid through an online gateway). */
  async deleteOrder({ creds }, order) {
    await withScopes(creds, ORDER_SCOPES, async (c) => {
      const result = await gql(c, `mutation($id: ID!) { orderDelete(orderId: $id) { deletedId userErrors { message } } }`, { id: orderGid(order.externalId) });
      userErrors(result.orderDelete, 'delete the order');
    });
  },

  /** Product edits, new products and deletes made in Digital Hub. Returns the fields to save. */
  async pushProduct({ creds }, product, before) {
    return withScopes(creds, PRODUCT_SCOPES, async (c) => {
      if (product.pendingDelete) {
        if (product.externalId && product.externalId !== 'pending') {
          const result = await gql(c, `mutation($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }`, {
            input: { id: productGid(product.externalId) },
          });
          const gone = (result.productDelete?.userErrors || []).some((e) => /not exist|not found/i.test(e.message));
          if (!gone) userErrors(result.productDelete, 'delete the product');
        }
        return { deleted: true };
      }
      const externalId = await saveProduct(c, product, before);
      return { externalId, status: product.stock === 0 && product.status === 'active' ? 'out_of_stock' : product.status };
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
   * and customer events (stores connected with a Client ID + Secret; the secret verifies
   * the deliveries). Returns the fields to keep in the credentials.
   */
  async registerWebhooks({ creds }, { url }) {
    if (creds.mode === 'token' || !shopifySecret(creds)) return { note: 'Live updates need the app’s Client ID and Client Secret; this store syncs on a schedule.' };
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
