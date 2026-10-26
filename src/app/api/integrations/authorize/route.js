import { createOAuthState, credentialsFrom, loadSecretsRow } from '../../../../server/credentials';
import { callbackSlug, getAdapter } from '../../../../server/platforms';
import { shopifyDomain } from '../../../../server/platforms/shopify';
import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';

const missingEnv = (adapter) =>
  (adapter.requiredEnv || []).filter((name) => !name.split('|').some((n) => process.env[n])).map((name) => name.split('|')[0]);

/**
 * Step 1 of "Sign in with …". The browser has already opened the popup (so it isn't
 * blocked); this creates a one-time `state` and returns the popup's next address,
 * /api/integrations/<platform>/connect?state=…, which redirects to the platform's sign-in.
 *
 * body: { platform, storeId? (re-authorize), shop? (Shopify domain), name?, groupId?, region?,
 *         syncFrequency?, status?, clientId? (client access for the new store) }
 */
export const POST = route(async (request, body) => {
  const who = await requireAdmin(request);
  const existing = body.storeId ? await getRecord('stores', body.storeId) : null;
  if (body.storeId && !existing) throw new HttpError(404, 'This store no longer exists.');
  const platform = existing?.platform || body.platform;
  const adapter = getAdapter(platform);
  if (adapter?.auth !== 'oauth') throw new HttpError(400, `${platform} doesn’t use sign-in.`);

  // App keys: the store's own (saved from the connect window) or the server's variables.
  const saved = existing ? credentialsFrom(existing, await loadSecretsRow(existing.id)) || {} : {};
  const ownKeys = (adapter.appKeyFields || []).length > 0 && adapter.appKeyFields.every((k) => saved[k]);
  const missing = ownKeys ? [] : missingEnv(adapter);
  if (missing.length) {
    throw new HttpError(400, `Enter ${platform}’s app credentials in the store’s connect window first (or add ${missing.join(', ')} to the server’s environment variables).`);
  }
  if (adapter.checkApp) {
    try {
      await adapter.checkApp(saved);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  const meta = {};
  if (platform === 'Shopify') {
    const shop = shopifyDomain(body.shop || existing?.url);
    if (!shop) throw new HttpError(400, 'Enter the store’s myshopify.com address, e.g. your-store.myshopify.com.');
    meta.shop = shop;
  }
  if (!existing) {
    Object.assign(meta, {
      name: String(body.name || '').trim().slice(0, 120),
      groupId: body.groupId || null,
      region: body.region || null,
      syncFrequency: body.syncFrequency || 'default',
      status: body.status === 'paused' ? 'paused' : 'active',
      clientId: body.clientId || null,
    });
  }

  const { state } = await createOAuthState({ storeId: existing?.id || null, platform, uid: who.uid, pkce: adapter.pkce, meta });
  return { connectUrl: `/api/integrations/${callbackSlug(platform)}/connect?state=${encodeURIComponent(state)}` };
});
