import { HttpError, caller, route, userDb } from '../../../../server/supabase';
import { getRecord, pushOrder, pushProduct } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Edits made in Digital Hub → WooCommerce. The browser saves the row as `pending`, then
// calls this; the answer is { state: 'synced' | 'gone' | 'pending' | 'error', error? }.
export const POST = route(async (request, { table, id, before }) => {
  if (!['products', 'orders'].includes(table) || !id) throw new HttpError(400, 'Unknown record.');
  const who = await caller(request);

  // Row Level Security decides whether this person may see the row at all.
  const { data: visible } = await userDb(who.token).from(table).select('id').eq('id', id).maybeSingle();
  if (!visible) return { state: 'gone' };

  const record = await getRecord(table, id);
  if (!record || record.syncState !== 'pending') return { state: record?.syncState || 'gone', error: record?.syncError };
  const prior =
    before && typeof before === 'object'
      ? { stock: before.stock ?? null, category: before.category ?? '', title: before.title, price: before.price, status: before.status, sku: before.sku }
      : null;
  return table === 'products' ? pushProduct(record, prior) : pushOrder(record);
});
