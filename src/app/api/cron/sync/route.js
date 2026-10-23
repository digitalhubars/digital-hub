import { getAdapter } from '../../../../server/platforms';
import { adminDb, must } from '../../../../server/supabase';
import { appOrigin, syncStoreNow } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Safety net and token upkeep: syncs every active store (any platform with an API), which
// also refreshes OAuth tokens before they expire. Called by Vercel Cron (vercel.json),
// which sends "Authorization: Bearer <CRON_SECRET>".
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

  const stores = must(await adminDb().from('stores').select('id, platform, sample, sync_frequency, health').eq('status', 'active'));
  const results = [];
  for (const s of stores) {
    const adapter = getAdapter(s.platform);
    if (s.sample || s.sync_frequency === 'manual' || !adapter || adapter.auth === 'csv' || s.health === 'needs_auth') continue;
    const result = await syncStoreNow(s.id, { incremental: true, origin: appOrigin(request) });
    results.push({ storeId: s.id, ok: result.ok, message: result.message });
  }
  return Response.json({ ok: true, results });
}
