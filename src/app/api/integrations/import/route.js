import { setStore } from '../../../../server/credentials';
import { getAdapter } from '../../../../server/platforms';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord, writeRecords } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** CSV import for platforms without an API (Mercari). kind: 'orders' | 'listings'. */
export const POST = route(async (request, { storeId, kind, csv }) => {
  await requireAdmin(request);
  const store = await getRecord('stores', storeId);
  if (!store) throw new HttpError(404, 'This store no longer exists.');
  const adapter = getAdapter(store.platform);
  if (!adapter?.importCsv) throw new HttpError(400, `${store.platform} syncs through its API, not CSV files.`);
  if (!['orders', 'listings'].includes(kind)) throw new HttpError(400, 'Choose orders or listings.');
  if (!csv || csv.length > 4_000_000) throw new HttpError(400, 'The file is empty or larger than 4 MB. Split it and import the parts.');

  let data;
  try {
    data = adapter.importCsv(store, kind, csv);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  const counts = await writeRecords(storeId, data);
  await setStore(storeId, { health: 'connected', last_error: null, last_sync: new Date().toISOString() });
  return { ok: true, counts, message: kind === 'orders' ? `${counts.orders} orders imported.` : `${counts.products} listings imported.` };
});
