import 'server-only';
import { randomBytes } from 'node:crypto';
import { fromRow, toRow } from '../lib/db/schema';
import {
  customerDocId,
  customerFromOrder,
  customerFromWoo,
  orderCustomerId,
  orderDocId,
  orderFromWoo,
  productDocId,
  productFromWoo,
  productToWoo,
  CRM_TO_WOO,
} from './mappers';
import { adminDb, must } from './supabase';
import { WooError, wooFetch, wooFetchAll } from './woo';

// WooCommerce ⇄ Supabase. Runs only in the API routes, with the secret key.

export const WEBHOOK_TOPICS = [
  'product.created',
  'product.updated',
  'product.deleted',
  'product.restored',
  'order.created',
  'order.updated',
  'order.deleted',
  'customer.created',
  'customer.updated',
];

const db = () => adminDb();
const isLocal = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin || '');

// ---- Rows ------------------------------------------------------------------------

export async function getRecord(table, id) {
  const row = must(await db().from(table).select('*').eq('id', id).maybeSingle());
  return row ? fromRow(table, row) : null;
}

/** Inserts or merges records (only the fields each record has). */
export async function upsert(table, records) {
  for (let i = 0; i < records.length; i += 500) {
    const rows = records.slice(i, i + 500).map((r) => toRow(table, r));
    must(await db().from(table).upsert(rows, { onConflict: 'id', defaultToNull: false }));
  }
}

export const patch = async (table, id, fields) => must(await db().from(table).update(toRow(table, fields)).eq('id', id));
export const remove = async (table, ids) => must(await db().from(table).delete().in('id', [].concat(ids)));

export async function loadStore(storeId) {
  const [store, secrets] = await Promise.all([
    getRecord('stores', storeId),
    db().from('store_secrets').select('*').eq('store_id', storeId).maybeSingle().then(must),
  ]);
  const creds =
    secrets?.consumer_key && secrets?.consumer_secret
      ? { url: secrets.url || store?.url, consumerKey: secrets.consumer_key, consumerSecret: secrets.consumer_secret }
      : null;
  return { store, secrets, creds };
}

export async function saveSecrets(storeId, fields) {
  must(await db().from('store_secrets').upsert({ store_id: storeId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'store_id' }));
}

// Why a store can't be synced live right now, or null if it can.
export function syncBlocker(store, creds) {
  if (!store) return 'This store no longer exists.';
  if (store.sample) return 'sample';
  if (store.platform !== 'WooCommerce') return `Live sync for ${store.platform} isn’t available yet. Only WooCommerce stores sync for now.`;
  if (!creds) return 'No API keys are saved for this store. Edit the integration and paste the consumer key and secret.';
  return null;
}

export const setStoreHealth = (storeId, fields) => patch('stores', storeId, fields);

// ---- Pull: WooCommerce → Supabase ------------------------------------------------

async function pendingIds(table, storeId) {
  const rows = must(await db().from(table).select('id').eq('store_id', storeId).eq('sync_state', 'pending'));
  return new Set(rows.map((r) => r.id));
}

export async function isPending(table, id) {
  const row = must(await db().from(table).select('sync_state').eq('id', id).maybeSingle());
  return row?.sync_state === 'pending';
}

/** Collects the writes for a batch of WooCommerce items, then applies them. */
export function createBatch() {
  const writes = { products: [], orders: [], customers: [] };
  const deletes = { products: [], orders: [], customers: [] };
  return {
    product(storeId, p, skip = new Set()) {
      const id = productDocId(storeId, p.id);
      if (skip.has(id)) return; // a Digital Hub edit is on its way out; don't overwrite it
      if (p.status === 'trash') deletes.products.push(id);
      else writes.products.push({ id, ...productFromWoo(storeId, p) });
    },
    order(storeId, o, skip = new Set()) {
      const id = orderDocId(storeId, o.id);
      if (skip.has(id)) return;
      if (o.status === 'trash') {
        deletes.orders.push(id);
        return;
      }
      writes.orders.push({ id, ...orderFromWoo(storeId, o) });
      // Make sure the order's customer exists (guests have no customer record in WooCommerce).
      writes.customers.push({ id: orderCustomerId(storeId, o), ...customerFromOrder(storeId, o) });
    },
    customer(storeId, c) {
      writes.customers.push({ id: customerDocId(storeId, c.id), ...customerFromWoo(storeId, c) });
    },
    delete(table, id) {
      deletes[table].push(id);
    },
    async commit() {
      // Customers before orders; the same customer can appear many times, keep the last.
      for (const table of ['customers', 'products', 'orders']) {
        const unique = [...new Map(writes[table].map((r) => [r.id, r])).values()];
        await upsert(table, unique);
        if (deletes[table].length) await remove(table, deletes[table]);
      }
    },
  };
}

/** Imports products, orders and customers. With `since` (ms), only what changed after it. */
export async function importStore(storeId, creds, { since } = {}) {
  const changed = since ? { modified_after: new Date(since - 120000).toISOString() } : {};
  const [skipProducts, skipOrders] = await Promise.all([pendingIds('products', storeId), pendingIds('orders', storeId)]);

  const products = await wooFetchAll(creds, '/products', { status: 'any', ...changed });
  const orders = await wooFetchAll(creds, '/orders', changed);
  // The customers endpoint has no "changed since" filter; new buyers also arrive through orders.
  const customers = since ? [] : await wooFetchAll(creds, '/customers', { role: 'all' }, 10);

  const batch = createBatch();
  products.forEach((p) => batch.product(storeId, p, skipProducts));
  customers.forEach((c) => batch.customer(storeId, c));
  orders.forEach((o) => batch.order(storeId, o, skipOrders));
  await batch.commit();

  return { products: products.length, orders: orders.length, customers: customers.length };
}

// ---- Push: Supabase → WooCommerce -------------------------------------------------

async function categoryRef(creds, name) {
  if (!name) return null;
  const { data } = await wooFetch(creds, '/products/categories', { query: { search: name, per_page: 100 } });
  const found = (data || []).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (found) return { id: found.id };
  const created = await wooFetch(creds, '/products/categories', { method: 'POST', body: { name } });
  return { id: created.data.id };
}

/**
 * Sends one pending product (create, update or delete) to WooCommerce.
 * Returns { state: 'synced' | 'gone' | 'pending' | 'error', error? }.
 */
export async function pushProduct(product, before) {
  const { id } = product;
  const { store, creds } = await loadStore(product.storeId);
  const blocker = syncBlocker(store, creds);
  if (blocker === 'sample') {
    if (product.pendingDelete) {
      await remove('products', id);
      return { state: 'gone' };
    }
    await patch('products', id, { syncState: 'synced', syncError: null });
    return { state: 'synced' };
  }
  if (blocker) {
    await patch('products', id, { syncState: 'error', syncError: blocker });
    return { state: 'error', error: blocker };
  }
  if (store.status === 'paused') return { state: 'pending', error: `${store.name} is paused. The change goes out when it resumes.` };

  try {
    if (product.pendingDelete) {
      if (product.externalId && product.externalId !== 'pending') {
        try {
          await wooFetch(creds, `/products/${product.externalId}`, { method: 'DELETE', query: { force: true } });
        } catch (err) {
          if (!(err instanceof WooError && err.status === 404)) throw err;
        }
      }
      await remove('products', id);
      return { state: 'gone' };
    }

    const body = productToWoo(product, before);
    if (product.category && product.category !== before?.category) {
      const cat = await categoryRef(creds, product.category);
      if (cat) body.categories = [cat];
    }

    if (!product.externalId || product.externalId === 'pending') {
      const { data } = await wooFetch(creds, '/products', { method: 'POST', body });
      const canonical = productDocId(store.id, data.id);
      await upsert('products', [{ id: canonical, ...productFromWoo(store.id, data), syncedAt: Date.now() }]);
      if (canonical !== id) await remove('products', id);
      return { state: 'gone' };
    }

    const { data } = await wooFetch(creds, `/products/${product.externalId}`, { method: 'PUT', body });
    await patch('products', id, { ...productFromWoo(store.id, data), syncedAt: Date.now() });
    await setStoreHealth(store.id, { health: 'connected', lastError: null });
    return { state: 'synced' };
  } catch (err) {
    console.warn('product push failed', id, err.message);
    await patch('products', id, { syncState: 'error', syncError: err.message });
    return { state: 'error', error: err.message };
  }
}

/** Sends a pending order status change to WooCommerce. */
export async function pushOrder(order) {
  const { id } = order;
  const { store, creds } = await loadStore(order.storeId);
  const blocker = syncBlocker(store, creds);
  if (blocker === 'sample') {
    await patch('orders', id, { syncState: 'synced', syncError: null });
    return { state: 'synced' };
  }
  if (blocker) {
    await patch('orders', id, { syncState: 'error', syncError: blocker });
    return { state: 'error', error: blocker };
  }
  if (store.status === 'paused') return { state: 'pending', error: `${store.name} is paused. The change goes out when it resumes.` };

  try {
    const { data } = await wooFetch(creds, `/orders/${order.externalId}`, { method: 'PUT', body: { status: CRM_TO_WOO[order.status] || 'processing' } });
    await patch('orders', id, { ...orderFromWoo(store.id, data), syncedAt: Date.now() });
    return { state: 'synced' };
  } catch (err) {
    console.warn('order push failed', id, err.message);
    await patch('orders', id, { syncState: 'error', syncError: err.message });
    return { state: 'error', error: err.message };
  }
}

// Edits made while a store was paused, or that failed before.
export async function pushPending(storeId) {
  for (const table of ['products', 'orders']) {
    const rows = must(await db().from(table).select('*').eq('store_id', storeId).in('sync_state', ['pending', 'error']));
    for (const row of rows) {
      const record = fromRow(table, row);
      if (table === 'products') await pushProduct(record, null);
      else await pushOrder(record);
    }
  }
}

// ---- Webhooks (WooCommerce → Digital Hub in real time) --------------------------------

/** Public address of this app, for the webhook URLs WooCommerce calls. */
export function appOrigin(request) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return request ? new URL(request.url).origin : '';
}

export const webhookUrl = (origin, storeId) => `${origin}/api/woo/webhook?store=${encodeURIComponent(storeId)}`;

/** Creates the store's webhooks once, or again if the address changed. Returns a note for the UI. */
export async function ensureWebhooks(storeId, creds, secrets, origin) {
  if (isLocal(origin)) return 'Webhooks are skipped when running locally. Changes in WooCommerce come in on the next sync.';
  const deliveryUrl = webhookUrl(origin, storeId);
  if (secrets?.webhook_ids?.length && secrets.webhook_url === deliveryUrl) return null;

  await removeWebhooks(creds, secrets?.webhook_ids);
  const secret = randomBytes(24).toString('hex');
  const ids = [];
  for (const topic of WEBHOOK_TOPICS) {
    const { data } = await wooFetch(creds, '/webhooks', {
      method: 'POST',
      body: { name: `Digital Hub · ${topic}`, topic, delivery_url: deliveryUrl, secret, status: 'active' },
    });
    ids.push(data.id);
  }
  await saveSecrets(storeId, { webhook_secret: secret, webhook_ids: ids, webhook_url: deliveryUrl });
  return null;
}

export async function removeWebhooks(creds, ids = []) {
  for (const id of ids || []) {
    try {
      await wooFetch(creds, `/webhooks/${id}`, { method: 'DELETE', query: { force: true } });
    } catch (err) {
      console.info('webhook delete skipped', id, err.message);
    }
  }
}

// ---- Full sync used by "Sync now", new integrations and the schedule ----------------------

export async function syncStoreNow(storeId, { incremental = false, origin = '' } = {}) {
  const { store, secrets, creds } = await loadStore(storeId);
  const blocker = syncBlocker(store, creds);
  if (blocker === 'sample') return { ok: true, message: 'Sample store: nothing to sync.' };
  if (blocker) {
    if (store) await setStoreHealth(storeId, { health: 'error', lastError: blocker });
    return { ok: false, message: blocker };
  }
  if (store.status === 'paused') return { ok: false, message: `${store.name} is paused. Resume it to sync.` };

  const startedAt = Date.now();
  try {
    await setStoreHealth(storeId, { health: 'checking' });
    await pushPending(storeId);
    const counts = await importStore(storeId, creds, { since: incremental ? store.lastSync : undefined });
    const webhookNote = await ensureWebhooks(storeId, creds, secrets, origin);
    await setStoreHealth(storeId, {
      health: 'connected',
      lastError: null,
      lastSync: startedAt,
      ...(incremental ? {} : { counts: { products: counts.products, orders: counts.orders, customers: counts.customers } }),
      webhooks: isLocal(origin) ? 'local' : 'active',
    });
    return { ok: true, counts, message: webhookNote };
  } catch (err) {
    console.error('sync failed', storeId, err.message);
    await setStoreHealth(storeId, { health: 'error', lastError: err.message });
    return { ok: false, message: err.message };
  }
}
