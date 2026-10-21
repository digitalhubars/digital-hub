import { adminDb, must } from '../../../../server/supabase';
import { appOrigin, syncStoreNow } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Safety net: catches anything a webhook missed. Called by Vercel Cron (vercel.json),
// which sends "Authorization: Bearer <CRON_SECRET>".
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

  const stores = must(await adminDb().from('stores').select('id, sample, sync_frequency').eq('platform', 'WooCommerce').eq('status', 'active'));
  const results = [];
  for (const s of stores) {
    if (s.sample || s.sync_frequency === 'manual') continue;
    const result = await syncStoreNow(s.id, { incremental: true, origin: appOrigin(request) });
    results.push({ storeId: s.id, ok: result.ok, message: result.message });
  }
  return Response.json({ ok: true, results });
}
