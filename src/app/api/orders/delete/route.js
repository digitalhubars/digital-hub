import { HttpError, requireAdmin, route } from '../../../../server/supabase';
import { deleteOrder, getRecord } from '../../../../server/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Deletes orders on their stores and in Digital Hub (admins only).
 * Answers { results: [{ id, state: 'deleted' | 'local' | 'error', error? }] }.
 */
export const POST = route(async (request, { ids }) => {
  await requireAdmin(request);
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Choose the orders to delete.');
  if (ids.length > 200) throw new HttpError(400, 'Delete at most 200 orders at a time.');

  const results = [];
  for (const id of ids) {
    const order = await getRecord('orders', id);
    results.push(order ? { id, ...(await deleteOrder(order)) } : { id, state: 'deleted' });
  }
  return { results };
});
