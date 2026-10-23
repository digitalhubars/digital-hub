import { authorizedCredentials } from '../../../../server/credentials';
import { getAdapter } from '../../../../server/platforms';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

/**
 * "Test connection" for any platform. With `input` (the typed keys) it tests those without
 * saving anything; otherwise it tests the store's saved credentials (refreshing tokens if needed).
 */
export const POST = route(async (request, { storeId, platform, input }) => {
  await requireAdmin(request);
  const store = storeId ? await getRecord('stores', storeId) : null;
  const adapter = getAdapter(platform || store?.platform);
  if (!adapter) throw new HttpError(400, `Digital Hub can’t connect ${platform} stores yet.`);
  if (adapter.auth === 'csv') return adapter.test({});

  try {
    const hasInput = input && Object.values(input).some(Boolean);
    if (hasInput && adapter.connect) {
      const creds = await adapter.connect(input);
      return await adapter.test({ store: store || { id: 'test', platform: adapter.platform }, creds });
    }
    if (!store) {
      return { ok: false, message: adapter.auth === 'oauth' ? `Save the store, then authorize ${adapter.platform}.` : 'Paste the API keys to test them.' };
    }
    const creds = await authorizedCredentials(store, adapter);
    return await adapter.test({ store, creds });
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
