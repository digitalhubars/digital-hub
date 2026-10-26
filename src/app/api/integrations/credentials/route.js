import { credentialsFrom, loadSecretsRow, saveCredentials, setStore } from '../../../../server/credentials';
import { getAdapter } from '../../../../server/platforms';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

/**
 * Saves the credentials typed for a store, after checking them with the platform; nothing is
 * saved if the platform refuses them.
 * - Key stores (Shopify Client ID + Secret or token, Walmart): connected right away.
 * - eBay, Etsy, TikTok Shop: their app keys are saved, then the seller approves access once.
 *   The same app as before keeps the existing approval.
 */
export const POST = route(async (request, { storeId, input }) => {
  await requireAdmin(request);
  const store = await getRecord('stores', storeId);
  if (!store) throw new HttpError(404, 'Save the store first.');
  const adapter = getAdapter(store.platform);
  if (!adapter?.connect || store.platform === 'WooCommerce') throw new HttpError(400, `${store.platform} doesn’t take credentials here.`);

  try {
    const creds = await adapter.connect(input || {});

    if (adapter.auth === 'oauth') {
      const previous = credentialsFrom(store, await loadSecretsRow(storeId)) || {};
      const sameApp = !!previous.accessToken && previous.clientId && previous.clientId === creds.clientId;
      await saveCredentials(store, sameApp ? { ...previous, ...creds } : creds);
      if (!sameApp) await setStore(storeId, { health: 'needs_auth', last_error: null, key_hint: 'App keys saved · approval needed' });
      return { ok: true, authorized: sameApp, message: `${store.platform} accepted the app keys.` };
    }

    const result = await adapter.test({ store, creds });
    await saveCredentials(store, creds);
    await setStore(storeId, { health: 'checking', last_error: null, ...(result.account ? { account_id: result.account } : {}) });
    return { ok: true, authorized: true, message: result.message };
  } catch (err) {
    if (adapter.auth !== 'oauth') await setStore(storeId, { health: 'needs_auth', last_error: err.message });
    return { ok: false, message: err.message };
  }
});
