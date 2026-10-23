import { createOAuthState, credentialsFrom, loadSecretsRow } from '../../../../server/credentials';
import { callbackSlug, getAdapter } from '../../../../server/platforms';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { appOrigin, getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

/** Starts "Authorize" / "Re-authorize" for a marketplace store: returns the platform's sign-in URL. */
export const POST = route(async (request, { storeId }) => {
  const who = await requireAdmin(request);
  const store = await getRecord('stores', storeId);
  if (!store) throw new HttpError(404, 'Save the store first.');
  const adapter = getAdapter(store.platform);
  if (adapter?.auth !== 'oauth') throw new HttpError(400, `${store.platform} doesn’t use authorization.`);

  const redirectUri = `${appOrigin(request)}/api/integrations/callback/${callbackSlug(store.platform)}`;
  // Stores with their own developer app (eBay) sign in with those keys.
  const creds = credentialsFrom(store, await loadSecretsRow(storeId)) || {};
  const { state, codeChallenge } = await createOAuthState({ storeId, platform: store.platform, uid: who.uid, pkce: adapter.pkce });
  try {
    return { url: adapter.authorizeUrl({ state, redirectUri, codeChallenge, store, creds }) };
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});
