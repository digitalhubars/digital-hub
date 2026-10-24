import { saveCredentials, setStore } from '../../../../server/credentials';
import { getAdapter } from '../../../../server/platforms';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

/**
 * Saves the keys typed for a store, after checking them with the platform; nothing is saved
 * if the platform refuses them. Key stores (Walmart) and Shopify's "Use an access token"
 * option. App keys for sign-in platforms live only in the server's environment.
 */
export const POST = route(async (request, { storeId, input }) => {
  await requireAdmin(request);
  const store = await getRecord('stores', storeId);
  if (!store) throw new HttpError(404, 'Save the store first.');
  const adapter = getAdapter(store.platform);
  if (!adapter?.connect || store.platform === 'WooCommerce') throw new HttpError(400, `${store.platform} connects with “Sign in”, not keys.`);

  try {
    const creds = await adapter.connect(input || {});
    const result = adapter.auth === 'oauth' ? { message: `${store.platform} accepted the token.` } : await adapter.test({ store, creds });
    await saveCredentials(store, creds);
    await setStore(storeId, {
      health: 'checking',
      last_error: null,
      ...(adapter.auth === 'oauth' ? { key_hint: 'Admin API token' } : {}),
      ...(result.account ? { account_id: result.account } : {}),
    });
    return { ok: true, authorized: true, message: result.message };
  } catch (err) {
    await setStore(storeId, { health: 'needs_auth', last_error: err.message });
    return { ok: false, message: err.message };
  }
});
