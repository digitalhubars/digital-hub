import { requireStoreAccess, route } from '../../../../server/supabase';
import { appOrigin, syncStoreNow } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = route(async (request, { storeId }) => {
  await requireStoreAccess(request, storeId);
  return syncStoreNow(storeId, { origin: appOrigin(request) });
});
