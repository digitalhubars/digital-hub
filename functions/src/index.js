import { createHmac, timingSafeEqual } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { orderDocId, productDocId } from './mappers.js';
import {
  deleteStoreData,
  loadStore,
  pushOrder,
  pushProduct,
  removeWebhooks,
  syncStoreNow,
  writeCustomer,
  writeOrder,
  writeProduct,
} from './sync.js';
import { wooFetch } from './woo.js';

initializeApp();
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 });

const db = () => getFirestore();

// ---- Who is calling ----------------------------------------------------------

async function caller(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const snap = await db().doc(`users/${request.auth.uid}`).get();
  const profile = snap.exists ? snap.data() : null;
  if (!profile || profile.status !== 'active') throw new HttpsError('permission-denied', 'Your account isn’t active.');
  return { uid: request.auth.uid, profile };
}

async function requireAdmin(request) {
  const who = await caller(request);
  if (who.profile.role !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can do this.');
  return who;
}

// Admins can sync any store; managers only the stores in their group.
async function requireStoreAccess(request, storeId) {
  const who = await caller(request);
  if (who.profile.role === 'admin') return who;
  const store = (await db().doc(`stores/${storeId}`).get()).data();
  if (who.profile.role === 'manager' && store && store.groupId === who.profile.group_id) return who;
  throw new HttpsError('permission-denied', 'You can’t sync this store.');
}

// ---- WooCommerce: connect, sync, disconnect ----------------------------------

/** Checks a URL + key pair (or the saved keys of a store) without saving anything. */
export const testWooConnection = onCall(async (request) => {
  await requireAdmin(request);
  const { storeId, url, consumerKey, consumerSecret } = request.data || {};
  let creds = url && consumerKey && consumerSecret ? { url, consumerKey, consumerSecret } : null;
  if (!creds && storeId) {
    creds = (await loadStore(storeId)).creds;
    if (creds && url) creds = { ...creds, url };
  }
  if (!creds) return { ok: false, message: 'Paste the consumer key and secret to test them.' };
  try {
    const [{ total: products }, { total: orders }] = await Promise.all([
      wooFetch(creds, '/products', { query: { per_page: 1, status: 'any' } }),
      wooFetch(creds, '/orders', { query: { per_page: 1 } }),
    ]);
    return { ok: true, message: `Connected. Found ${products} products and ${orders} orders.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

export const syncStore = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const { storeId } = request.data || {};
  await requireStoreAccess(request, storeId);
  return syncStoreNow(storeId);
});

/** Removes the webhooks and everything Digital Hub stored for the store. Nothing is deleted in WooCommerce. */
export const disconnectStore = onCall({ timeoutSeconds: 300 }, async (request) => {
  await requireAdmin(request);
  const { storeId } = request.data || {};
  const { secrets, creds } = await loadStore(storeId);
  if (creds && secrets?.webhookIds?.length) await removeWebhooks(creds, secrets.webhookIds);
  await deleteStoreData(storeId);

  const clients = await db().collection('clients').where('storeIds', 'array-contains', storeId).get();
  const batch = db().batch();
  clients.docs.forEach((d) => batch.update(d.ref, { storeIds: FieldValue.arrayRemove(storeId) }));
  batch.delete(db().doc(`storeSecrets/${storeId}`));
  batch.delete(db().doc(`stores/${storeId}`));
  await batch.commit();
  return { ok: true };
});

// ---- Webhook receiver: WooCommerce → Digital Hub ------------------------------

function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export const wooWebhook = onRequest({ cors: false }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const storeId = String(req.query.store || '');
  const raw = req.rawBody || Buffer.from('');

  // WooCommerce pings a new webhook with "webhook_id=…" before sending real events.
  if (raw.toString('utf8').startsWith('webhook_id=')) return res.status(200).send('ok');

  const { store, secrets } = await loadStore(storeId);
  if (!store || !validSignature(raw, req.get('x-wc-webhook-signature'), secrets?.webhookSecret)) {
    logger.warn('webhook rejected', { storeId });
    return res.status(401).send('bad signature');
  }

  const topic = String(req.get('x-wc-webhook-topic') || '');
  const body = req.body || {};
  const writer = db().bulkWriter();
  try {
    if (topic === 'product.deleted') writer.delete(db().doc(`products/${productDocId(storeId, body.id)}`));
    else if (topic.startsWith('product.')) writeProduct(writer, storeId, body, await skipIfPending('products', productDocId(storeId, body.id)));
    else if (topic === 'order.deleted') writer.delete(db().doc(`orders/${orderDocId(storeId, body.id)}`));
    else if (topic.startsWith('order.')) writeOrder(writer, storeId, body, await skipIfPending('orders', orderDocId(storeId, body.id)));
    else if (topic.startsWith('customer.') && body.id) writeCustomer(writer, storeId, body);
    await writer.close();
    await db().doc(`stores/${storeId}`).set({ lastSync: Date.now(), health: 'connected', lastError: null }, { merge: true });
    logger.info('webhook applied', { storeId, topic, id: body.id });
    return res.status(200).send('ok');
  } catch (err) {
    logger.error('webhook failed', { storeId, topic, message: err.message });
    return res.status(500).send('error');
  }
});

async function skipIfPending(collection, id) {
  const snap = await db().doc(`${collection}/${id}`).get();
  return new Set(snap.exists && snap.data().syncState === 'pending' ? [id] : []);
}

// ---- Edits made in Digital Hub → WooCommerce -----------------------------------
// The app marks edited docs `syncState: 'pending'`. These triggers send them and
// write the store's answer back with `syncState: 'synced'` (or 'error').

export const onProductWritten = onDocumentWritten({ document: 'products/{id}', timeoutSeconds: 120 }, async (event) => {
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  if (!after || after.syncState !== 'pending') return;
  await pushProduct(event.data.after.ref, after, before);
});

export const onOrderWritten = onDocumentWritten({ document: 'orders/{id}', timeoutSeconds: 120 }, async (event) => {
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after || after.syncState !== 'pending') return;
  await pushOrder(event.data.after.ref, after);
});

// Keeps groups/{id}.storeIds in step with each store's groupId (used by security rules).
export const onStoreWritten = onDocumentWritten('stores/{id}', async (event) => {
  const id = event.params.id;
  const before = event.data?.before?.exists ? event.data.before.data().groupId : null;
  const after = event.data?.after?.exists ? event.data.after.data().groupId : null;
  if (before === after) return;
  if (before) await db().doc(`groups/${before}`).set({ storeIds: FieldValue.arrayRemove(id) }, { merge: true });
  if (after) await db().doc(`groups/${after}`).set({ storeIds: FieldValue.arrayUnion(id) }, { merge: true });
});

// ---- Safety net: catch anything a webhook missed ----------------------------------

export const scheduledWooSync = onSchedule({ schedule: 'every 15 minutes', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  const stores = await db().collection('stores').where('platform', '==', 'WooCommerce').where('status', '==', 'active').get();
  for (const doc of stores.docs) {
    if (doc.data().sample || doc.data().syncFrequency === 'manual') continue;
    const result = await syncStoreNow(doc.id, { incremental: true });
    logger.info('scheduled sync', { storeId: doc.id, ok: result.ok, message: result.message });
  }
});

