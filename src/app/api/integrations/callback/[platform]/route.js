import { consumeOAuthState, credentialsFrom, loadSecretsRow, saveCredentials, setStore } from '../../../../../server/credentials';
import { callbackSlug, getAdapter, platformFromSlug } from '../../../../../server/platforms';
import { appOrigin, getRecord } from '../../../../../server/sync';

export const dynamic = 'force-dynamic';

// The marketplace sends the seller back here after they approve (or decline) access.
// The one-time `state` proves the request started from this app; the tokens are exchanged
// and saved encrypted, then the admin lands back on the Integrations page.
export async function GET(request, { params }) {
  const origin = appOrigin(request);
  const back = (query) => Response.redirect(`${origin}/admin/integrations?${new URLSearchParams(query)}`, 302);

  const platform = platformFromSlug(params.platform);
  const adapter = platform && getAdapter(platform);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  if (!adapter) return back({ authError: 'Unknown platform.' });

  const saved = await consumeOAuthState(query.state, platform).catch(() => null);
  if (!saved) return back({ authError: `The ${platform} sign-in link expired or was already used. Try Authorize again.` });
  const store = await getRecord('stores', saved.store_id);
  if (!store) return back({ authError: 'That store was deleted.' });

  if (query.error || query.error_description) {
    await setStore(store.id, { health: 'needs_auth', last_error: query.error_description || query.error });
    return back({ authError: `${platform} didn’t grant access: ${query.error_description || query.error}.`, store: store.id });
  }

  try {
    const redirectUri = `${origin}/api/integrations/callback/${callbackSlug(platform)}`;
    const appKeys = credentialsFrom(store, await loadSecretsRow(store.id)) || {};
    const creds = await adapter.exchangeCode({ query, redirectUri, codeVerifier: saved.code_verifier, store, creds: appKeys });
    await saveCredentials(store, creds);
    await setStore(store.id, {
      health: 'checking',
      last_error: null,
      ...(creds.account ? { account_id: String(creds.account), key_hint: `Authorized as ${creds.account}` } : { key_hint: 'Authorized' }),
      auth_expires_at: creds.refreshExpiresAt ? new Date(creds.refreshExpiresAt).toISOString() : null,
    });
    return back({ connected: store.id });
  } catch (err) {
    await setStore(store.id, { health: 'needs_auth', last_error: err.message });
    return back({ authError: err.message, store: store.id });
  }
}
