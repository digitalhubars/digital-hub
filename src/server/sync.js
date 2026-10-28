import 'server-only';
import { randomBytes } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { fromRow, toRow } from '../lib/db/schema';
import { authorizedCredentials, credentialsFrom, expiringSoon, loadSecretsRow, saveCredentials, saveWooSecrets } from './credentials';
import { decrypt } from './crypto';
import {
  customerDocId,
  customerFromOrder,
  customerFromWoo,
  guestDocId,
  orderCustomerId,
  orderDocId,
  orderFromWoo,
  productDocId,
  productFromWoo,
  productToWoo,
  CRM_TO_WOO,
} from './mappers';
import { callbackSlug, getAdapter } from './platforms';
import { adminDb, must } from './supabase';
import { WooError, wooFetch } from './woo';

// Stores ⇄ Supabase. Runs only in the API routes, with the secret key.
// Every platform imports through its adapter (src/server/platforms); WooCommerce also
// receives Digital Hub edits (push) and streams changes in through webhooks.

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

// Columns added by later migrations. If a migration hasn't been run yet, writes retry
// without them, so syncing keeps working (minus the new details) until it is.
const NEWER_COLUMNS = ['refunded', 'shipping_info', 'auth_expires_at'];
const withoutNewer = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !NEWER_COLUMNS.includes(k)));
let warnedMissing = false;

async function write(run, rows) {
  const first = await run(rows);
  if (first.error?.code !== 'PGRST204') return must(first);
  if (!warnedMissing) console.warn('A newer migration hasn’t been run yet; saving without its columns.', first.error.message);
  warnedMissing = true;
  return must(await run(Array.isArray(rows) ? rows.map(withoutNewer) : withoutNewer(rows)));
}

/** Inserts or merges records (only the fields each record has). */
export async function upsert(table, records) {
  for (let i = 0; i < records.length; i += 500) {
    const rows = records.slice(i, i + 500).map((r) => toRow(table, r));
    await write((r) => db().from(table).upsert(r, { onConflict: 'id', defaultToNull: false }), rows);
  }
}

export const patch = (table, id, fields) => write((r) => db().from(table).update(r).eq('id', id), toRow(table, fields));
export const remove = async (table, ids) => must(await db().from(table).delete().in('id', [].concat(ids)));

/** The store, its secrets row (webhook secret decrypted) and its decrypted credentials. */
export async function loadStore(storeId) {
  const [store, row] = await Promise.all([getRecord('stores', storeId), loadSecretsRow(storeId)]);
  const secrets = row ? { ...row, webhook_secret: decrypt(row.webhook_secret) } : null;
  return { store, secrets, creds: store && row ? credentialsFrom(store, row) : null };
}

// Why Digital Hub can't send an edit to this store right now, or null if it can.
export function syncBlocker(store, creds) {
  if (!store) return 'This store no longer exists.';
  if (store.sample) return 'sample';
  if (!getAdapter(store.platform)?.pushEdits) return `${store.platform} products and orders sync into Digital Hub, but edits made here aren’t sent to ${store.platform} yet.`;
  if (!creds) return 'This store isn’t connected yet. Edit the integration to add its keys or authorize it.';
  return null;
}

export const setStoreHealth = (storeId, fields) => patch('stores', storeId, fields);

// ---- Pull: store → Supabase (every platform) ---------------------------------------

async function pendingIds(table, storeId) {
  const rows = must(await db().from(table).select('id').eq('store_id', storeId).eq('sync_state', 'pending'));
  return new Set(rows.map((r) => r.id));
}

export async function isPending(table, id) {
  const row = must(await db().from(table).select('sync_state').eq('id', id).maybeSingle());
  return row?.sync_state === 'pending';
}

const customerIdOf = (storeId, c) => (c?.externalId ? customerDocId(storeId, c.externalId) : guestDocId(storeId, c?.email));

/**
 * Writes what an adapter returned. IDs come from the platform's own IDs
 * ({store}_p{id}, {store}_o{id}, {store}_c{id}), so syncing again updates rows instead of
 * adding duplicates. Rows with a Digital Hub edit still on its way out are left alone.
 */
export async function writeRecords(storeId, { products = [], orders = [], customers = [] }) {
  const [skipProducts, skipOrders] = await Promise.all([pendingIds('products', storeId), pendingIds('orders', storeId)]);
  const stamp = { syncState: 'synced', syncError: null };
  const del = { products: [], orders: [] };

  const productRows = new Map();
  products.forEach((p) => {
    const id = productDocId(storeId, p.externalId);
    if (skipProducts.has(id)) return;
    if (p.deleted) del.products.push(id);
    else productRows.set(id, { ...p, id, storeId, externalId: String(p.externalId), ...stamp });
  });

  const customerRows = new Map();
  customers.forEach((c) => {
    const id = c.id || customerDocId(storeId, c.externalId);
    customerRows.set(id, {
      id,
      storeId,
      externalId: c.externalId ? String(c.externalId) : null,
      name: c.name || 'Customer',
      email: c.email || '',
      updatedAt: c.updatedAt || Date.now(),
    });
  });

  const orderRows = new Map();
  orders.forEach((o) => {
    const id = orderDocId(storeId, o.externalId);
    if (skipOrders.has(id)) return;
    if (o.deleted) {
      del.orders.push(id);
      return;
    }
    const { customer, ...rest } = o;
    const customerId = rest.customerId || customerIdOf(storeId, customer);
    if (!customerRows.has(customerId)) {
      customerRows.set(customerId, {
        id: customerId,
        storeId,
        externalId: customer?.externalId ? String(customer.externalId) : null,
        name: customer?.name || 'Customer',
        email: customer?.email || '',
        updatedAt: o.updatedAt || Date.now(),
      });
    }
    orderRows.set(id, { ...rest, id, storeId, externalId: String(o.externalId), customerId, ...stamp });
  });

  // Customers before orders (orders point at them).
  await upsert('customers', [...customerRows.values()]);
  await upsert('products', [...productRows.values()]);
  await upsert('orders', [...orderRows.values()]);
  if (del.products.length) await remove('products', del.products);
  if (del.orders.length) await remove('orders', del.orders);
  return { products: productRows.size, orders: orderRows.size, customers: customerRows.size };
}

/** WooCommerce webhook payloads → rows (one item at a time). */
export function createBatch() {
  const out = { products: [], orders: [], customers: [] };
  return {
    product(storeId, p, skip = new Set()) {
      if (skip.has(productDocId(storeId, p.id))) return;
      out.products.push(p.status === 'trash' ? { externalId: String(p.id), deleted: true } : productFromWoo(storeId, p));
    },
    order(storeId, o, skip = new Set()) {
      if (skip.has(orderDocId(storeId, o.id))) return;
      if (o.status === 'trash') {
        out.orders.push({ externalId: String(o.id), deleted: true });
        return;
      }
      out.orders.push({ ...orderFromWoo(storeId, o), customerId: orderCustomerId(storeId, o) });
      out.customers.push({ ...customerFromOrder(storeId, o), id: orderCustomerId(storeId, o) });
    },
    customer(storeId, c) {
      out.customers.push(customerFromWoo(storeId, c));
    },
    delete(table, id) {
      if (table === 'products') out.products.push({ id, deleted: true });
      if (table === 'orders') out.orders.push({ id, deleted: true });
    },
    async commit(storeId) {
      const deletes = { products: out.products.filter((p) => p.id && p.deleted).map((p) => p.id), orders: out.orders.filter((o) => o.id && o.deleted).map((o) => o.id) };
      await writeRecords(storeId, {
        products: out.products.filter((p) => !(p.id && p.deleted)),
        orders: out.orders.filter((o) => !(o.id && o.deleted)),
        customers: out.customers,
      });
      if (deletes.products.length) await remove('products', deletes.products);
      if (deletes.orders.length) await remove('orders', deletes.orders);
    },
  };
}

// ---- Push: Supabase → WooCommerce ----------------------------------------------------

async function categoryRef(creds, name) {
  if (!name) return null;
  const { data } = await wooFetch(creds, '/products/categories', { query: { search: name, per_page: 100 } });
  const found = (data || []).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (found) return { id: found.id };
  const created = await wooFetch(creds, '/products/categories', { method: 'POST', body: { name } });
  return { id: created.data.id };
}

/**
 * Edits for platforms whose adapter has pushProduct / pushOrder (eBay, …): the adapter
 * talks to the platform and returns the fields to save, or { deleted: true }.
 */
async function pushWithAdapter(table, record, before, store) {
  const adapter = getAdapter(store.platform);
  const push = table === 'products' ? adapter.pushProduct : adapter.pushOrder;
  if (!push) {
    const message = `${store.platform} doesn’t take ${table === 'products' ? 'product' : 'order'} edits from Digital Hub yet.`;
    await patch(table, record.id, { syncState: 'error', syncError: message });
    return { state: 'error', error: message };
  }
  try {
    const creds = await authorizedCredentials(store, adapter);
    const result = await push.call(adapter, { store, creds }, record, before);
    if (result?.deleted) {
      await remove(table, record.id);
      return { state: 'gone' };
    }
    await patch(table, record.id, { ...(result || {}), syncState: 'synced', syncError: null, syncedAt: Date.now() });
    return { state: 'synced' };
  } catch (err) {
    console.warn(`${table} push failed`, record.id, err.message);
    await patch(table, record.id, { syncState: 'error', syncError: err.message, ...(table === 'products' && record.pendingDelete ? { pendingDelete: false } : {}) });
    return { state: 'error', error: err.message };
  }
}

/**
 * Sends one pending product (create, update or delete) to its store.
 * Returns { state: 'synced' | 'gone' | 'pending' | 'error', error? }.
 */
export async function pushProduct(product, before) {
  const { id } = product;
  const { store, creds } = await loadStore(product.storeId);
  const blocker = syncBlocker(store, creds);
  if (store && !blocker && store.platform !== 'WooCommerce') {
    if (store.status === 'paused') return { state: 'pending', error: `${store.name} is paused. The change goes out when it resumes.` };
    return pushWithAdapter('products', product, before, store);
  }
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

/** Sends a pending order status change to its store. */
export async function pushOrder(order) {
  const { id } = order;
  const { store, creds } = await loadStore(order.storeId);
  const blocker = syncBlocker(store, creds);
  if (store && !blocker && store.platform !== 'WooCommerce') {
    if (store.status === 'paused') return { state: 'pending', error: `${store.name} is paused. The change goes out when it resumes.` };
    return pushWithAdapter('orders', order, null, store);
  }
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

/**
 * Deletes an order on its store, then in Digital Hub. WooCommerce moves it to the trash;
 * platforms with `deleteOrder` (Shopify) delete it there; on the others it's removed from
 * Digital Hub only. Returns { state: 'deleted' | 'local' | 'error', error? }.
 */
export async function deleteOrder(order) {
  const { store, creds } = await loadStore(order.storeId);
  const adapter = store && getAdapter(store.platform);
  try {
    if (store && !store.sample && order.externalId) {
      if (store.platform === 'WooCommerce') {
        if (!creds) throw new Error('This store isn’t connected. Add its keys first.');
        await wooFetch(creds, `/orders/${order.externalId}`, { method: 'DELETE' }).catch((err) => {
          if (!(err instanceof WooError && err.status === 404)) throw err;
        });
      } else if (adapter?.deleteOrder) {
        await adapter.deleteOrder({ store, creds: await authorizedCredentials(store, adapter) }, order);
      } else {
        await remove('orders', order.id);
        return { state: 'local' };
      }
    }
    await remove('orders', order.id);
    return { state: 'deleted' };
  } catch (err) {
    console.warn('order delete failed', order.id, err.message);
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

// ---- WooCommerce webhooks (store → Digital Hub in real time) ----------------------------

/** Public address of this app, for webhook and OAuth callback URLs. */
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
  await saveWooSecrets(storeId, { webhook_secret: secret, webhook_ids: ids, webhook_url: deliveryUrl });
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

// Real-time updates for adapters that support them (Shopify). A failure here never fails the sync.
async function registerAdapterWebhooks(store, adapter, creds, origin) {
  if (isLocal(origin)) return { note: 'Live updates are switched on after deploying.', live: 'local' };
  try {
    const url = `${origin}/api/webhooks/${callbackSlug(store.platform)}?store=${encodeURIComponent(store.id)}`;
    const result = await adapter.registerWebhooks({ store, creds }, { url });
    if (result.creds) await saveCredentials(store, { ...creds, ...result.creds });
    return { note: result.note || null, live: result.note ? 'polling' : 'active' };
  } catch (err) {
    console.warn('webhook setup failed', store.id, err.message);
    return { note: `Live updates couldn’t be switched on (${err.message}). Changes arrive on each scheduled sync.`, live: 'polling' };
  }
}

// ---- Full sync used by "Sync now", new connections and the schedule ----------------------

export async function syncStoreNow(storeId, { incremental = false, origin = '' } = {}) {
  const store = await getRecord('stores', storeId);
  if (!store) return { ok: false, message: 'This store no longer exists.' };
  if (store.sample) return { ok: true, message: 'Sample store: nothing to sync.' };
  const adapter = getAdapter(store.platform);
  if (!adapter) return { ok: false, message: `Digital Hub can’t sync ${store.platform} stores yet.` };
  if (adapter.auth === 'csv') return { ok: true, message: `${store.platform} has no API. Import its CSV exports from the store’s menu.` };
  if (store.status === 'paused') return { ok: false, message: `${store.name} is paused. Resume it to sync.` };

  const startedAt = Date.now();
  try {
    await setStoreHealth(storeId, { health: 'checking' });
    const creds = await authorizedCredentials(store, adapter);
    const ctx = { store, creds };
    if (adapter.pushEdits) await pushPending(storeId);

    const since = incremental ? store.lastSync : undefined;
    const [products, orders, customers] = [
      adapter.syncProducts ? await adapter.syncProducts(ctx, { since }) : [],
      adapter.syncOrders ? await adapter.syncOrders(ctx, { since }) : [],
      adapter.syncCustomers ? await adapter.syncCustomers(ctx, { since }) : [],
    ];
    const counts = await writeRecords(storeId, { products, orders, customers });

    let note = null;
    let live = null;
    if (store.platform === 'WooCommerce') {
      const { secrets } = await loadStore(storeId);
      note = await ensureWebhooks(storeId, creds, secrets, origin);
      live = isLocal(origin) ? 'local' : 'active';
    } else if (adapter.registerWebhooks) {
      ({ note, live } = await registerAdapterWebhooks(store, adapter, creds, origin));
    }
    await setStoreHealth(storeId, {
      health: expiringSoon(creds) ? 'expiring' : 'connected',
      lastError: null,
      lastSync: startedAt,
      ...(incremental ? {} : { counts }),
      ...(live ? { webhooks: live } : {}),
    });
    return { ok: true, counts, message: note };
  } catch (err) {
    console.error('sync failed', storeId, err.message);
    const current = await getRecord('stores', storeId);
    // authorizedCredentials already marked needs_auth / expired; keep that over a generic error.
    const health = ['needs_auth', 'expired'].includes(current?.health) ? current.health : err.auth && adapter.auth === 'oauth' ? 'expired' : 'error';
    await setStoreHealth(storeId, { health, lastError: err.message });
    return { ok: false, message: err.message };
  }
}

// ---- Webhook-triggered syncs ------------------------------------------------------------

const recentlyQueued = new Map(); // storeId → ms, per server instance

/**
 * Answers a platform's webhook straight away and syncs the store's recent changes in the
 * background (platforms give a webhook only a few seconds). Bursts of events for the same
 * store within 20 seconds share one sync.
 */
export function queueStoreSync(storeId, origin) {
  const last = recentlyQueued.get(storeId) || 0;
  if (Date.now() - last < 20000) return false;
  recentlyQueued.set(storeId, Date.now());
  const run = syncStoreNow(storeId, { incremental: true, origin }).catch((err) => console.error('webhook sync failed', storeId, err.message));
  waitUntil(run);
  return true;
}
