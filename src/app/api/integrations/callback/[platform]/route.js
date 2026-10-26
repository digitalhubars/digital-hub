import { randomBytes } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { consumeOAuthState, credentialsFrom, loadSecretsRow, saveCredentials, setStore } from '../../../../../server/credentials';
import { resultPage } from '../../../../../server/oauthPage';
import { getAdapter, platformFromSlug } from '../../../../../server/platforms';
import { adminDb, must } from '../../../../../server/supabase';
import { appOrigin, getRecord, syncStoreNow } from '../../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** A new store, created only now that the seller has approved (details saved with the state). */
async function createStore(platform, meta, creds) {
  const db = adminDb();
  const groups = must(await db.from('groups').select('id').order('created_at', { ascending: true }).limit(1));
  const id = `st_${randomBytes(4).toString('hex')}`;
  must(
    await db.from('stores').insert({
      id,
      name: meta.name || creds.account || `${platform} store`,
      platform,
      url: creds.url || meta.shop || '',
      region: meta.region || null,
      group_id: meta.groupId || groups[0]?.id || null,
      status: meta.status || 'active',
      health: 'checking',
      sync_frequency: meta.syncFrequency || 'default',
      created_at: new Date().toISOString(),
    }),
  );
  if (meta.clientId) {
    const client = must(await db.from('clients').select('store_ids').eq('id', meta.clientId).maybeSingle());
    if (client) must(await db.from('clients').update({ store_ids: [...(client.store_ids || []), id] }).eq('id', meta.clientId));
  }
  return getRecord('stores', id);
}

// The platform sends the seller back here after they approve (or decline). The one-time
// `state` must match one this app created for a signed-in admin. The tokens are exchanged,
// saved encrypted on the store, the first sync starts in the background (it also registers
// webhooks where the platform supports them), and the popup reports back and closes.
export async function GET(request, { params }) {
  const origin = appOrigin(request);
  const platform = platformFromSlug(params.platform);
  const adapter = platform && getAdapter(platform);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const answer = (status, message, storeId) => resultPage({ origin, platform: platform || 'This platform', status, message, storeId });
  if (!adapter) return answer('error', 'Unknown platform.');

  const saved = await consumeOAuthState(query.state, platform).catch(() => null);
  if (!saved) return answer('error', `The ${platform} sign-in expired or was already used. Close this window and try again.`);
  let store = saved.store_id ? await getRecord('stores', saved.store_id) : null;
  if (saved.store_id && !store) return answer('error', 'That store was deleted in the meantime.');

  if (query.error || query.error_description) {
    if (store) await setStore(store.id, { health: 'needs_auth', last_error: query.error_description || query.error });
    const declined = /denied|cancel/i.test(`${query.error} ${query.error_description}`);
    return answer('error', declined ? `Access wasn’t approved in ${platform}.` : `${platform}: ${query.error_description || query.error}.`, store?.id);
  }

  try {
    const redirectUri = `${origin}/api/integrations/callback/${params.platform}`;
    const appKeys = store ? credentialsFrom(store, await loadSecretsRow(store.id)) || {} : {};
    const creds = await adapter.exchangeCode({ query, redirectUri, codeVerifier: saved.code_verifier, meta: saved.meta, store: store || { region: saved.meta.region }, creds: appKeys });
    if (!store) store = await createStore(platform, saved.meta, creds);
    await saveCredentials(store, creds);
    await setStore(store.id, {
      health: 'checking',
      last_error: null,
      key_hint: creds.account ? `Signed in as ${creds.account}` : 'Signed in',
      ...(creds.account ? { account_id: String(creds.account) } : {}),
      ...(creds.url ? { url: creds.url } : {}),
      auth_expires_at: iso(creds.refreshExpiresAt),
    });
    await adminDb()
      .from('activity')
      .insert({ id: `a_${randomBytes(4).toString('hex')}`, at: new Date().toISOString(), actor: 'Digital Hub', actor_id: saved.created_by, type: 'integration', text: `Connected ${platform} store ${store.name}` })
      .then(() => {}, () => {});

    // First sync in the background (new store: everything; re-authorized: what changed since).
    if (store.status === 'active') waitUntil(syncStoreNow(store.id, { incremental: !!store.lastSync, origin }).catch((err) => console.error('first sync failed', store.id, err.message)));
    return answer('connected', `${store.name} is connected. Importing products and orders…`, store.id);
  } catch (err) {
    if (store) await setStore(store.id, { health: 'needs_auth', last_error: err.message });
    return answer('error', err.message, store?.id);
  }
}
