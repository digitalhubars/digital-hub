import { getAdapter } from '../../../../server/platforms';
import { adminDb, must } from '../../../../server/supabase';
import { appOrigin, syncStoreNow } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Background sync and token upkeep. Called every 15 minutes by Supabase (pg_cron, see
// supabase/migrations) and daily by Vercel Cron (vercel.json); both send
// "Authorization: Bearer <CRON_SECRET>". Each active store with an API is synced when its
// own "Sync every" interval (or the workspace default) has passed; syncing also refreshes
// OAuth tokens before they expire.
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

  const db = adminDb();
  const settings = must(await db.from('workspace_settings').select('data').eq('id', 1).maybeSingle())?.data || {};
  const stores = must(await db.from('stores').select('id, platform, sample, sync_frequency, health, last_sync').eq('status', 'active'));
  const started = Date.now();
  const results = [];

  for (const s of stores) {
    const adapter = getAdapter(s.platform);
    if (s.sample || !adapter || adapter.auth === 'csv' || s.health === 'needs_auth') continue;
    const every = s.sync_frequency && s.sync_frequency !== 'default' ? s.sync_frequency : settings.syncFrequency || '15';
    if (every === 'manual') continue;
    const minutes = Number(every) || 15;
    // A minute of slack so a 15-minute store isn't skipped because the last run took a moment.
    if (s.last_sync && Date.now() - Date.parse(s.last_sync) < (minutes - 1) * 60000) continue;
    // Leave time to answer: anything not reached now is picked up on the next run.
    if (Date.now() - started > 240000) break;
    const result = await syncStoreNow(s.id, { incremental: true, origin: appOrigin(request) });
    results.push({ storeId: s.id, ok: result.ok, message: result.message });
  }
  return Response.json({ ok: true, synced: results.length, results });
}
