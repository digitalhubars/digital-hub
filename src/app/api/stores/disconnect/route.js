import { adminDb, must, requireAdmin, route } from '../../../../server/supabase';
import { loadStore, removeWebhooks } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Removes the webhooks and everything Digital Hub stored for the store. Nothing is deleted in WooCommerce. */
export const POST = route(async (request, { storeId }) => {
  await requireAdmin(request);
  const { secrets, creds } = await loadStore(storeId);
  if (creds && secrets?.webhook_ids?.length) await removeWebhooks(creds, secrets.webhook_ids);

  const db = adminDb();
  const clients = must(await db.from('clients').select('id, store_ids').contains('store_ids', [storeId]));
  for (const c of clients) {
    must(await db.from('clients').update({ store_ids: c.store_ids.filter((id) => id !== storeId) }).eq('id', c.id));
  }
  // Products, orders, customers and the saved keys go with the store (on delete cascade).
  must(await db.from('stores').delete().eq('id', storeId));
  return { ok: true };
});
