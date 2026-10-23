import 'server-only';
import { customerFromWoo, productFromWoo, orderFromWoo } from '../mappers';
import { wooFetch, wooFetchAll } from '../woo';
import { PlatformError } from './http';

// WooCommerce REST API v3 with a consumer key + secret. Two-way: Digital Hub edits are
// pushed back (sync.js pushProduct/pushOrder) and the store's webhooks stream changes in.

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    throw new PlatformError(err.message, { status: err.status, auth: err.status === 401 });
  }
};

export default {
  platform: 'WooCommerce',
  auth: 'key',
  pushEdits: true,

  connect({ url, consumerKey, consumerSecret }) {
    if (!/^https?:\/\//i.test(url || '')) throw new PlatformError('Use the full https:// address of the WordPress site.');
    if (!consumerKey || !consumerSecret) throw new PlatformError('Paste the consumer key and secret.');
    return { url: url.trim().replace(/\/+$/, ''), consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim() };
  },

  async test({ creds }) {
    return wrap(async () => {
      const [{ total: products }, { total: orders }] = await Promise.all([
        wooFetch(creds, '/products', { query: { per_page: 1, status: 'any' } }),
        wooFetch(creds, '/orders', { query: { per_page: 1 } }),
      ]);
      return { ok: true, message: `Connected. Found ${products} products and ${orders} orders.` };
    });
  },

  async syncProducts({ store, creds }, { since }) {
    const changed = since ? { modified_after: new Date(since - 120000).toISOString() } : {};
    const list = await wrap(() => wooFetchAll(creds, '/products', { status: 'any', ...changed }));
    return list.map((p) => (p.status === 'trash' ? { externalId: String(p.id), deleted: true } : productFromWoo(store.id, p)));
  },

  async syncOrders({ store, creds }, { since }) {
    const changed = since ? { modified_after: new Date(since - 120000).toISOString() } : {};
    const list = await wrap(() => wooFetchAll(creds, '/orders', changed));
    return list.map((o) => {
      if (o.status === 'trash') return { externalId: String(o.id), deleted: true };
      const b = o.billing || {};
      return {
        ...orderFromWoo(store.id, o),
        customer: {
          externalId: o.customer_id > 0 ? String(o.customer_id) : null,
          name: `${b.first_name || ''} ${b.last_name || ''}`.trim() || b.email || 'Customer',
          email: b.email || '',
        },
      };
    });
  },

  // The customers endpoint has no "changed since" filter; new buyers also arrive through orders.
  async syncCustomers({ store, creds }, { since }) {
    if (since) return [];
    const list = await wrap(() => wooFetchAll(creds, '/customers', { role: 'all' }, 10));
    return list.map((c) => customerFromWoo(store.id, c));
  },
};
