import { credentialsFrom, loadSecretsRow, saveCredentials, setStore } from '../../../../server/credentials';
import { getAdapter } from '../../../../server/platforms';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

/**
 * Saves the keys typed for a store, after checking them with the platform. Nothing is saved
 * if the platform refuses them.
 * - Key stores (Shopify, Walmart): the keys are the connection; the store is ready to sync.
 * - OAuth stores with their own developer app (eBay): the app keys are saved, then the
 *   seller authorizes. Same Client ID as before → the existing authorization is kept.
 */
export const POST = route(async (request, { storeId, input }) => {
  await requireAdmin(request);
  const store = await getRecord('stores', storeId);
  if (!store) throw new HttpError(404, 'Save the store first.');
  const adapter = getAdapter(store.platform);
  if (!adapter?.connect || store.platform === 'WooCommerce') throw new HttpError(400, `${store.platform} doesn’t take keys here.`);

  try {
    const keys = await adapter.connect(input || {});

    if (adapter.auth === 'oauth') {
      const previous = credentialsFrom(store, await loadSecretsRow(storeId)) || {};
      const sameApp = previous.clientId && previous.clientId === keys.clientId;
      await saveCredentials(store, sameApp ? { ...previous, ...keys } : keys);
      if (!sameApp) await setStore(storeId, { health: 'needs_auth', last_error: null, key_hint: `App ${keys.clientId.slice(0, 12)}… · not authorized yet` });
      return { ok: true, authorized: !!(sameApp && previous.accessToken), message: `${store.platform} accepted the keys.` };
    }

    const result = await adapter.test({ store, creds: keys });
    await saveCredentials(store, keys);
    await setStore(storeId, { health: 'checking', last_error: null, ...(result.account ? { account_id: result.account } : {}) });
    return { ok: true, message: result.message };
  } catch (err) {
    if (adapter.auth !== 'oauth') await setStore(storeId, { health: 'needs_auth', last_error: err.message });
    return { ok: false, message: err.message };
  }
});
