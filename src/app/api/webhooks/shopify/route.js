import { shopifySecret, validShopifyWebhook } from '../../../../server/platforms/shopify';
import { appOrigin, getRecord, queueStoreSync } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Shopify → Digital Hub in real time (orders, refunds, fulfillments, products, inventory,
// customers). Each delivery is signed with the app's Client Secret (SHOPIFY_API_SECRET).
export async function POST(request) {
  const storeId = new URL(request.url).searchParams.get('store') || '';
  const raw = await request.text();
  const topic = request.headers.get('x-shopify-topic') || '';

  const store = storeId ? await getRecord('stores', storeId) : null;
  if (!store || !validShopifyWebhook(raw, request.headers.get('x-shopify-hmac-sha256'), shopifySecret())) {
    console.warn('shopify webhook rejected', storeId, topic);
    return new Response('bad signature', { status: 401 });
  }

  // Privacy requests (customers/redact, shop/redact, customers/data_request): nothing to
  // send; data is removed when the store is disconnected.
  if (!topic.startsWith('customers/data_request') && !topic.endsWith('/redact') && store.status === 'active') {
    queueStoreSync(storeId, appOrigin(request));
  }
  return new Response('ok');
}
