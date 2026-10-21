import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord, saveSecrets } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

/** Saves a store's address and API keys where no browser can read them back. */
export const POST = route(async (request, { storeId, url, consumerKey, consumerSecret }) => {
  await requireAdmin(request);
  if (!(await getRecord('stores', storeId))) throw new HttpError(404, 'Save the store first.');
  await saveSecrets(storeId, {
    url: url || null,
    ...(consumerKey ? { consumer_key: consumerKey } : {}),
    ...(consumerSecret ? { consumer_secret: consumerSecret } : {}),
  });
  return { ok: true };
});
