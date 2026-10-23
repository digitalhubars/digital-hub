import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { decrypt, decryptJson, encrypt, encryptJson, isEncrypted } from './crypto';
import { PlatformError } from './platforms/http';
import { adminDb, must } from './supabase';

// Store credentials (API keys, OAuth tokens) live in store_secrets, encrypted, and only the
// server (secret key) can read that table. Nothing here is ever sent to the browser.

const db = () => adminDb();
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const REFRESH_MARGIN = 5 * 60 * 1000;
const EXPIRING_SOON = 7 * 864e5;

export async function loadSecretsRow(storeId) {
  return must(await db().from('store_secrets').select('*').eq('store_id', storeId).maybeSingle());
}

/**
 * The credentials a store's adapter needs. WooCommerce keeps its keys in their own columns
 * (older rows may still be plain text; they're encrypted the next time they're saved).
 */
export function credentialsFrom(store, row) {
  if (!row) return null;
  if (store.platform === 'WooCommerce') {
    const consumerKey = decrypt(row.consumer_key);
    const consumerSecret = decrypt(row.consumer_secret);
    return consumerKey && consumerSecret ? { url: row.url || store.url, consumerKey, consumerSecret } : null;
  }
  return decryptJson(row.credentials);
}

/** Saves an adapter's credentials (encrypted) and the token expiry dates. */
export async function saveCredentials(store, creds) {
  must(
    await db()
      .from('store_secrets')
      .upsert(
        {
          store_id: store.id,
          url: store.url || null,
          credentials: encryptJson(creds),
          token_expires_at: iso(creds.expiresAt),
          refresh_expires_at: iso(creds.refreshExpiresAt),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'store_id' },
      ),
  );
}

/** WooCommerce columns, encrypted. Only the fields passed are changed. */
export async function saveWooSecrets(storeId, fields) {
  const row = { store_id: storeId, updated_at: new Date().toISOString() };
  if ('url' in fields) row.url = fields.url;
  if (fields.consumer_key) row.consumer_key = encrypt(fields.consumer_key);
  if (fields.consumer_secret) row.consumer_secret = encrypt(fields.consumer_secret);
  if (fields.webhook_secret) row.webhook_secret = encrypt(fields.webhook_secret);
  if ('webhook_ids' in fields) row.webhook_ids = fields.webhook_ids;
  if ('webhook_url' in fields) row.webhook_url = fields.webhook_url;
  must(await db().from('store_secrets').upsert(row, { onConflict: 'store_id' }));
}

/** Re-saves WooCommerce keys written before encryption existed. */
export async function encryptLegacyWoo(storeId, row) {
  if (!row || (isEncrypted(row.consumer_secret) && (!row.webhook_secret || isEncrypted(row.webhook_secret)))) return;
  await saveWooSecrets(storeId, {
    consumer_key: decrypt(row.consumer_key),
    consumer_secret: decrypt(row.consumer_secret),
    webhook_secret: decrypt(row.webhook_secret),
  }).catch(() => {});
}

export const setStore = async (storeId, fields) => must(await db().from('stores').update(fields).eq('id', storeId));

/**
 * Credentials ready to use: refreshes tokens that are about to expire and saves the new
 * ones. When the platform refuses, marks the store "expired" so the UI asks to re-authorize.
 */
export async function authorizedCredentials(store, adapter) {
  const row = await loadSecretsRow(store.id);
  let creds = credentialsFrom(store, row);
  if (!creds) {
    await setStore(store.id, { health: 'needs_auth', last_error: null });
    throw new PlatformError(adapter.auth === 'oauth' ? `Authorize ${store.platform} first.` : 'No API keys are saved for this store. Edit the integration and paste them.', {
      auth: true,
    });
  }
  if (store.platform === 'WooCommerce') {
    await encryptLegacyWoo(store.id, row);
    return creds;
  }
  // App keys saved (eBay) but the seller hasn't approved access yet.
  if (adapter.auth === 'oauth' && !creds.accessToken) {
    await setStore(store.id, { health: 'needs_auth', last_error: null });
    throw new PlatformError(`Click Authorize to connect ${store.platform}.`, { auth: true });
  }

  const now = Date.now();
  if (creds.refreshExpiresAt && creds.refreshExpiresAt < now) {
    await setStore(store.id, { health: 'expired', last_error: `The ${store.platform} authorization expired. Re-authorize the store.` });
    throw new PlatformError(`The ${store.platform} authorization expired. Re-authorize the store.`, { auth: true });
  }
  if (creds.expiresAt && creds.expiresAt - REFRESH_MARGIN < now) {
    if (!adapter.refresh) throw new PlatformError(`The ${store.platform} token expired. Re-authorize the store.`, { auth: true });
    try {
      creds = await adapter.refresh(creds, store);
    } catch (err) {
      if (err.auth) await setStore(store.id, { health: 'expired', last_error: err.message });
      throw err;
    }
    await saveCredentials(store, creds);
  }
  // Refresh tokens that end within a week: still works, but the seller should re-authorize soon.
  await setStore(store.id, { auth_expires_at: iso(creds.refreshExpiresAt) });
  return creds;
}

export const expiringSoon = (creds) => !!creds?.refreshExpiresAt && creds.refreshExpiresAt - Date.now() < EXPIRING_SOON;

// ---- OAuth "state": ties the platform's redirect back to the store and admin who started it ----

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createOAuthState({ storeId, platform, uid, pkce }) {
  const state = b64url(randomBytes(24));
  const codeVerifier = pkce ? b64url(randomBytes(48)) : null;
  must(
    await db()
      .from('oauth_states')
      .insert({ state, store_id: storeId, platform, created_by: uid, code_verifier: codeVerifier ? encrypt(codeVerifier) : null, expires_at: new Date(Date.now() + 15 * 60000).toISOString() }),
  );
  const codeChallenge = codeVerifier ? b64url(createHash('sha256').update(codeVerifier).digest()) : null;
  return { state, codeChallenge };
}

/** One-time use: returns the saved state (or null) and deletes it. */
export async function consumeOAuthState(state, platform) {
  if (!state) return null;
  const row = must(await db().from('oauth_states').select('*').eq('state', state).maybeSingle());
  if (!row) return null;
  must(await db().from('oauth_states').delete().eq('state', state));
  // Clean up abandoned attempts while we're here.
  await db().from('oauth_states').delete().lt('expires_at', new Date().toISOString());
  if (row.platform !== platform || Date.parse(row.expires_at) < Date.now()) return null;
  return { ...row, code_verifier: decrypt(row.code_verifier) };
}
