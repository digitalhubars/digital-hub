import { requireAdmin, route } from '../../../../server/supabase';
import { loadStore } from '../../../../server/sync';
import { wooFetch } from '../../../../server/woo';

export const dynamic = 'force-dynamic';

/** Checks a URL + key pair (or the saved keys of a store) without saving anything. */
export const POST = route(async (request, { storeId, url, consumerKey, consumerSecret }) => {
  await requireAdmin(request);
  let creds = url && consumerKey && consumerSecret ? { url, consumerKey, consumerSecret } : null;
  if (!creds && storeId) {
    creds = (await loadStore(storeId)).creds;
    if (creds && url) creds = { ...creds, url };
  }
  if (!creds) return { ok: false, message: 'Paste the consumer key and secret to test them.' };
  try {
    const [{ total: products }, { total: orders }] = await Promise.all([
      wooFetch(creds, '/products', { query: { per_page: 1, status: 'any' } }),
      wooFetch(creds, '/orders', { query: { per_page: 1 } }),
    ]);
    return { ok: true, message: `Connected. Found ${products} products and ${orders} orders.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
