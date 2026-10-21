import { createHmac, timingSafeEqual } from 'node:crypto';
import { orderDocId, productDocId } from '../../../../server/mappers';
import { createBatch, isPending, loadStore, setStoreHealth } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

// WooCommerce → Digital Hub. Each request is signed with the store's webhook secret.
export async function POST(request) {
  const storeId = new URL(request.url).searchParams.get('store') || '';
  const raw = await request.text();

  // WooCommerce pings a new webhook with "webhook_id=…" before sending real events.
  if (raw.startsWith('webhook_id=')) return new Response('ok');

  const { store, secrets } = await loadStore(storeId);
  if (!store || !validSignature(raw, request.headers.get('x-wc-webhook-signature'), secrets?.webhook_secret)) {
    console.warn('webhook rejected', storeId);
    return new Response('bad signature', { status: 401 });
  }

  const topic = String(request.headers.get('x-wc-webhook-topic') || '');
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return new Response('bad body', { status: 400 });
  }

  try {
    const batch = createBatch();
    if (topic === 'product.deleted') batch.delete('products', productDocId(storeId, body.id));
    else if (topic.startsWith('product.')) {
      const id = productDocId(storeId, body.id);
      batch.product(storeId, body, new Set((await isPending('products', id)) ? [id] : []));
    } else if (topic === 'order.deleted') batch.delete('orders', orderDocId(storeId, body.id));
    else if (topic.startsWith('order.')) {
      const id = orderDocId(storeId, body.id);
      batch.order(storeId, body, new Set((await isPending('orders', id)) ? [id] : []));
    } else if (topic.startsWith('customer.') && body.id) batch.customer(storeId, body);
    await batch.commit();
    await setStoreHealth(storeId, { lastSync: Date.now(), health: 'connected', lastError: null });
    return new Response('ok');
  } catch (err) {
    console.error('webhook failed', storeId, topic, err.message);
    return new Response('error', { status: 500 });
  }
}
