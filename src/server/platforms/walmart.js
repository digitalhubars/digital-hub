import 'server-only';
import { randomUUID } from 'node:crypto';
import { PlatformError, basic, num, requestJson } from './http';

// Walmart Marketplace API with the seller's Client ID + Client Secret
// (Seller Center → Settings → API Key Management). Access tokens last 15 minutes and are
// fetched again automatically with the saved client credentials.

const API = 'https://marketplace.walmartapis.com';
const P = 'Walmart';

const baseHeaders = () => ({ 'WM_SVC.NAME': 'Walmart Marketplace', 'WM_QOS.CORRELATION_ID': randomUUID() });

const get = (creds, path, query) =>
  requestJson(`${API}${path}`, { platform: P, headers: { ...baseHeaders(), 'WM_SEC.ACCESS_TOKEN': creds.accessToken }, query }).then((r) => r.data);

async function fetchToken(creds) {
  const { data } = await requestJson(`${API}/v3/token`, {
    platform: P,
    method: 'POST',
    headers: { ...baseHeaders(), Authorization: basic(creds.clientId, creds.clientSecret) },
    form: { grant_type: 'client_credentials' },
  });
  return { ...creds, accessToken: data.access_token, expiresAt: Date.now() + num(data.expires_in || 900) * 1000 };
}

const LINE_STATUS = { Cancelled: 'cancelled', Delivered: 'fulfilled', Shipped: 'fulfilled', Acknowledged: 'processing', Created: 'unfulfilled' };

function orderStatus(lines) {
  const statuses = lines.flatMap((l) => (l.orderLineStatuses?.orderLineStatus || []).map((s) => s.status));
  if (statuses.length && statuses.every((s) => s === 'Cancelled')) return 'cancelled';
  if (statuses.some((s) => s === 'Shipped' || s === 'Delivered')) return statuses.every((s) => s === 'Shipped' || s === 'Delivered' || s === 'Cancelled') ? 'fulfilled' : 'processing';
  if (statuses.includes('Acknowledged')) return 'processing';
  return LINE_STATUS[statuses[0]] || 'unfulfilled';
}

const charge = (line, type) =>
  (line.charges?.charge || []).filter((c) => c.chargeType === type).reduce((sum, c) => sum + num(c.chargeAmount?.amount), 0);
const lineTax = (line) => (line.charges?.charge || []).reduce((sum, c) => sum + num(c.tax?.taxAmount?.amount), 0);

export default {
  platform: P,
  auth: 'key',

  async connect({ clientId, clientSecret }) {
    if (!clientId || !clientSecret) throw new PlatformError('Paste the Client ID and Client Secret from Walmart Seller Center.');
    return fetchToken({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  },

  // Client credentials never expire, so "refreshing" just asks for a new access token.
  refresh: fetchToken,

  async test({ creds }) {
    const data = await get(creds, '/v3/items', { limit: 1 });
    return { ok: true, message: `Connected to Walmart Marketplace. Found ${num(data.totalItems)} items.` };
  },

  async syncProducts({ store, creds }) {
    const out = [];
    for (let offset = 0; offset < 5000; offset += 50) {
      const data = await get(creds, '/v3/items', { limit: 50, offset });
      (data.ItemResponse || []).forEach((i) =>
        out.push({
          storeId: store.id,
          externalId: i.sku,
          title: i.productName || i.sku,
          sku: i.sku,
          category: i.productType || '',
          price: num(i.price?.amount),
          stock: null, // inventory is a separate per-SKU call
          status: i.publishedStatus === 'PUBLISHED' && i.lifecycleStatus !== 'RETIRED' ? 'active' : 'draft',
          permalink: i.wpid ? `https://www.walmart.com/ip/${i.wpid}` : '',
        }),
      );
      if ((data.ItemResponse || []).length < 50) break;
    }
    return out;
  },

  async syncOrders({ store, creds }, { since }) {
    const start = new Date(since ? since - 30 * 864e5 : Date.now() - 180 * 864e5).toISOString();
    const orders = [];
    let data = await get(creds, '/v3/orders', { createdStartDate: start, limit: 100 });
    for (let page = 0; page < 50; page++) {
      orders.push(...(data.list?.elements?.order || []));
      const next = data.list?.meta?.nextCursor;
      if (!next) break;
      data = await requestJson(`${API}/v3/orders${next.startsWith('?') ? next : `?${next}`}`, {
        platform: P,
        headers: { ...baseHeaders(), 'WM_SEC.ACCESS_TOKEN': creds.accessToken },
      }).then((r) => r.data);
    }
    return orders.map((o) => {
      const lines = o.orderLines?.orderLine || [];
      const subtotal = lines.reduce((sum, l) => sum + charge(l, 'PRODUCT'), 0);
      const shipping = lines.reduce((sum, l) => sum + charge(l, 'SHIPPING'), 0);
      const tax = lines.reduce((sum, l) => sum + lineTax(l), 0);
      return {
        storeId: store.id,
        externalId: o.purchaseOrderId,
        number: o.customerOrderId || o.purchaseOrderId,
        items: lines.map((l) => ({
          productId: l.item?.sku ? `${store.id}_p${l.item.sku}` : null,
          title: l.item?.productName || '',
          qty: num(l.orderLineQuantity?.amount) || 1,
          price: charge(l, 'PRODUCT') / (num(l.orderLineQuantity?.amount) || 1),
        })),
        subtotal,
        shipping,
        tax,
        total: subtotal + shipping + tax,
        currency: 'USD',
        status: orderStatus(lines),
        placedAt: num(o.orderDate) || Date.now(),
        updatedAt: Date.now(),
        customer: { externalId: null, name: o.shippingInfo?.postalAddress?.name || 'Walmart customer', email: o.customerEmailId || '' },
      };
    });
  },
};
