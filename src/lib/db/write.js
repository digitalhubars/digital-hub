import { toRow } from './schema';
import { must, supabase } from '../supabase/client';

// Bulk writes from the browser (admins only, enforced by Row Level Security).

const CHUNK = 500;

/** Inserts or replaces records (by id). */
export async function upsertRecords(table, records) {
  for (let i = 0; i < records.length; i += CHUNK) {
    const rows = records.slice(i, i + CHUNK).map((r) => toRow(table, r));
    must(await supabase().from(table).upsert(rows, { onConflict: 'id', defaultToNull: false }));
  }
}

export async function deleteIds(table, ids) {
  for (let i = 0; i < ids.length; i += CHUNK) {
    must(await supabase().from(table).delete().in('id', ids.slice(i, i + CHUNK)));
  }
}
