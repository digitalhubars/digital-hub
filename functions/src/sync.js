import { randomBytes } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
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
} from './mappers.js';
import { WooError, wooFetch, wooFetchAll } from './woo.js';

const db = () => getFirestore();

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

export const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

export async function loadStore(storeId) {
  const [storeSnap, secretSnap] = await Promise.all([db().doc(`stores/${storeId}`).get(), db().doc(`storeSecrets/${storeId}`).get()]);
  const store = storeSnap.exists ? { id: storeId, ...storeSnap.data() } : null;
  const secrets = secretSnap.exists ? secretSnap.data() : null;
  const creds =
    secrets?.consumerKey && secrets?.consumerSecret
      ? { url: secrets.url || store?.url, consumerKey: secrets.consumerKey, consumerSecret: secrets.consumerSecret }
      : null;
  return { store, secrets, creds };
}

// Why a store can't be synced live right now, or null if it can.
export function syncBlocker(store, creds) {
  if (!store) return 'This store no longer exists.';
  if (store.sample) return 'sample';
  if (store.platform !== 'WooCommerce') return `Live sync for ${store.platform} isn’t available yet. Only WooCommerce stores sync for now.`;
  if (!creds) return 'No API keys are saved for this store. Edit the integration and paste the consumer key and secret.';
  return null;
}

export const setStoreHealth = (storeId, patch) => db().doc(`stores/${storeId}`).set(patch, { merge: true });

// ---- Pull: WooCommerce → Firestore -----------------------------------------

async function pendingIds(collection, storeId) {
  const snap = await db().collection(collection).where('storeId', '==', storeId).where('syncState', '==', 'pending').get();
  return new Set(snap.docs.map((d) => d.id));
}

export function writeProduct(writer, storeId, wooProduct, skip = new Set()) {
  const ref = db().doc(`products/${productDocId(storeId, wooProduct.id)}`);
  if (skip.has(ref.id)) return; // a Digital Hub edit is on its way out; don't overwrite it
  if (wooProduct.status === 'trash') writer.delete(ref);
  else writer.set(ref, productFromWoo(storeId, wooProduct), { merge: true });
}

export function writeOrder(writer, storeId, wooOrder, skip = new Set()) {
  const ref = db().doc(`orders/${orderDocId(storeId, wooOrder.id)}`);
  if (skip.has(ref.id)) return;
  if (wooOrder.status === 'trash') return writer.delete(ref);
  writer.set(ref, orderFromWoo(storeId, wooOrder), { merge: true });
  // Make sure the order's customer exists (guests have no customer record in WooCommerce).
  writer.set(db().doc(`customers/${orderCustomerId(storeId, wooOrder)}`), customerFromOrder(storeId, wooOrder), { merge: true });
  return undefined;
}

export function writeCustomer(writer, storeId, wooCustomer) {
  writer.set(db().doc(`customers/${customerDocId(storeId, wooCustomer.id)}`), customerFromWoo(storeId, wooCustomer), { merge: true });
}

/**
 * Imports products, orders and customers. With `since` (ms), only what changed after it.
 * Returns counts.
 */
export async function importStore(storeId, creds, { since } = {}) {
  const changed = since ? { modified_after: new Date(since - 120000).toISOString() } : {};
  const [skipProducts, skipOrders] = await Promise.all([pendingIds('products', storeId), pendingIds('orders', storeId)]);

  const products = await wooFetchAll(creds, '/products', { status: 'any', ...changed });
  const orders = await wooFetchAll(creds, '/orders', changed);
  // The customers endpoint has no "changed since" filter; new buyers also arrive through orders.
  const customers = since ? [] : await wooFetchAll(creds, '/customers', { role: 'all' }, 10);

  const writer = db().bulkWriter();
  products.forEach((p) => writeProduct(writer, storeId, p, skipProducts));
  customers.forEach((c) => writeCustomer(writer, storeId, c));
  orders.forEach((o) => writeOrder(writer, storeId, o, skipOrders));
  await writer.close();

  return { products: products.length, orders: orders.length, customers: customers.length };
}

// ---- Push: Firestore → WooCommerce ------------------------------------------

async function categoryRef(creds, name) {
  if (!name) return null;
  const { data } = await wooFetch(creds, '/products/categories', { query: { search: name, per_page: 100 } });
  const found = (data || []).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (found) return { id: found.id };
  const created = await wooFetch(creds, '/products/categories', { method: 'POST', body: { name } });
  return { id: created.data.id };
}

/** Sends one pending product (create, update or delete) to WooCommerce. */
export async function pushProduct(ref, after, before) {
  const { store, creds } = await loadStore(after.storeId);
  const blocker = syncBlocker(store, creds);
  if (blocker === 'sample') {
    if (after.pendingDelete) return ref.delete();
    return ref.set({ syncState: 'synced', syncError: null }, { merge: true });
  }
  if (blocker) return ref.set({ syncState: 'error', syncError: blocker }, { merge: true });
  if (store.status === 'paused') return null; // stays pending; sent when the store resumes

  try {
    if (after.pendingDelete) {
      if (after.externalId && after.externalId !== 'pending') {
        try {
          await wooFetch(creds, `/products/${after.externalId}`, { method: 'DELETE', query: { force: true } });
        } catch (err) {
          if (!(err instanceof WooError && err.status === 404)) throw err;
        }
      }
      return ref.delete();
    }

    const body = productToWoo(after, before);
    if (after.category && after.category !== before?.category) {
      const cat = await categoryRef(creds, after.category);
      if (cat) body.categories = [cat];
    }

    if (!after.externalId || after.externalId === 'pending') {
      const { data } = await wooFetch(creds, '/products', { method: 'POST', body });
      const canonical = db().doc(`products/${productDocId(store.id, data.id)}`);
      await canonical.set({ ...productFromWoo(store.id, data), syncedAt: Date.now() }, { merge: true });
      if (canonical.id !== ref.id) await ref.delete();
      return null;
    }

    const { data } = await wooFetch(creds, `/products/${after.externalId}`, { method: 'PUT', body });
    await ref.set({ ...productFromWoo(store.id, data), syncedAt: Date.now() }, { merge: true });
    await setStoreHealth(store.id, { health: 'connected', lastError: null });
    return null;
  } catch (err) {
    logger.warn('product push failed', { id: ref.id, message: err.message });
    return ref.set({ syncState: 'error', syncError: err.message }, { merge: true });
  }
}

/** Sends a pending order status change to WooCommerce. */
export async function pushOrder(ref, after) {
  const { store, creds } = await loadStore(after.storeId);
  const blocker = syncBlocker(store, creds);
  if (blocker === 'sample') return ref.set({ syncState: 'synced', syncError: null }, { merge: true });
  if (blocker) return ref.set({ syncState: 'error', syncError: blocker }, { merge: true });
  if (store.status === 'paused') return null;

  try {
    const { data } = await wooFetch(creds, `/orders/${after.externalId}`, { method: 'PUT', body: { status: CRM_TO_WOO[after.status] || 'processing' } });
    await ref.set({ ...orderFromWoo(store.id, data), syncedAt: Date.now() }, { merge: true });
    return null;
  } catch (err) {
    logger.warn('order push failed', { id: ref.id, message: err.message });
    return ref.set({ syncState: 'error', syncError: err.message }, { merge: true });
  }
}

// Edits made while a store was paused, or that failed before.
export async function pushPending(storeId) {
  for (const collection of ['products', 'orders']) {
    const snap = await db().collection(collection).where('storeId', '==', storeId).where('syncState', 'in', ['pending', 'error']).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (collection === 'products') await pushProduct(doc.ref, data, null);
      else await pushOrder(doc.ref, data);
    }
  }
}

// ---- Webhooks (WooCommerce → Digital Hub in real time) ----------------------

export function webhookUrl(storeId) {
  const project = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId;
  return `https://asia-southeast1-${project}.cloudfunctions.net/wooWebhook?store=${encodeURIComponent(storeId)}`;
}

/** Creates the store's webhooks once, or again if the address changed. Returns a note for the UI. */
export async function ensureWebhooks(storeId, creds, secrets) {
  if (isEmulator()) return 'Webhooks are skipped when running locally. Changes in WooCommerce come in on the next sync.';
  const deliveryUrl = webhookUrl(storeId);
  if (secrets?.webhookIds?.length && secrets.webhookUrl === deliveryUrl) return null;

  await removeWebhooks(creds, secrets?.webhookIds);
  const secret = randomBytes(24).toString('hex');
  const ids = [];
  for (const topic of WEBHOOK_TOPICS) {
    const { data } = await wooFetch(creds, '/webhooks', {
      method: 'POST',
      body: { name: `Digital Hub · ${topic}`, topic, delivery_url: deliveryUrl, secret, status: 'active' },
    });
    ids.push(data.id);
  }
  await db().doc(`storeSecrets/${storeId}`).set({ webhookSecret: secret, webhookIds: ids, webhookUrl: deliveryUrl }, { merge: true });
  return null;
}

export async function removeWebhooks(creds, ids = []) {
  for (const id of ids || []) {
    try {
      await wooFetch(creds, `/webhooks/${id}`, { method: 'DELETE', query: { force: true } });
    } catch (err) {
      logger.info('webhook delete skipped', { id, message: err.message });
    }
  }
}

// ---- Full sync used by "Sync now", new integrations and the schedule --------

export async function syncStoreNow(storeId, { incremental = false } = {}) {
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
    const webhookNote = await ensureWebhooks(storeId, creds, secrets);
    await setStoreHealth(storeId, {
      health: 'connected',
      lastError: null,
      lastSync: startedAt,
      ...(incremental ? {} : { counts: { products: counts.products, orders: counts.orders, customers: counts.customers } }),
      webhooks: isEmulator() ? 'local' : 'active',
    });
    return { ok: true, counts, message: webhookNote };
  } catch (err) {
    logger.error('sync failed', { storeId, message: err.message });
    await setStoreHealth(storeId, { health: 'error', lastError: err.message });
    return { ok: false, message: err.message };
  }
}

// ---- Disconnect ----------------------------------------------------------------

export async function deleteStoreData(storeId) {
  const writer = db().bulkWriter();
  for (const collection of ['products', 'orders', 'customers']) {
    const snap = await db().collection(collection).where('storeId', '==', storeId).select().get();
    snap.docs.forEach((d) => writer.delete(d.ref));
  }
  await writer.close();
}
