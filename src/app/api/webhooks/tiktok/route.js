import { createHmac, timingSafeEqual } from 'node:crypto';
import { credentialsFrom, loadSecretsRow } from '../../../../server/credentials';
import { tiktokApp } from '../../../../server/platforms/tiktok';
import { adminDb, must } from '../../../../server/supabase';
import { appOrigin, getRecord, queueStoreSync } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// TikTok Shop → Digital Hub in real time (order status, products, returns, …). Set this
// address as the Webhook URL of the app in TikTok Shop Partner Center. TikTok signs each
// delivery: Authorization = hex HMAC-SHA256(app_key + raw body), keyed by TIKTOK_APP_SECRET.
// The payload's shop_id says which store it's for.
export async function POST(request) {
  const raw = await request.text();
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch {
    return new Response('bad body', { status: 400 });
  }
  const signature = request.headers.get('authorization') || '';
  const shopId = String(event.shop_id || '');
  const signedBy = (creds) => {
    let app;
    try {
      app = tiktokApp(creds);
    } catch {
      return false;
    }
    const expected = createHmac('sha256', app.appSecret).update(app.appKey + raw).digest('hex');
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  };

  const stores = must(await adminDb().from('stores').select('id').eq('platform', 'TikTok Shop').eq('status', 'active'));
  for (const { id } of stores) {
    const store = await getRecord('stores', id);
    const creds = credentialsFrom(store, await loadSecretsRow(id));
    if (String(creds?.shopId) !== shopId || !signedBy(creds)) continue;
    queueStoreSync(id, appOrigin(request));
    return Response.json({ code: 0, message: 'success' });
  }
  console.warn('tiktok webhook rejected: unknown shop or bad signature', shopId, event.type);
  return new Response('unknown shop or bad signature', { status: 401 });
}
