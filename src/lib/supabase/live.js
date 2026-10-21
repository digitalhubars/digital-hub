import { useCallback, useEffect, useRef, useState } from 'react';
import { fromRow, toRow } from '../db/schema';
import { must, supabase } from './client';

// Live Supabase tables that behave like useState arrays.
//
//   const [products, setProducts] = useLiveList('products', { enabled: true });
//   setProducts((list) => list.map(...));   // updates the screen at once and writes only the changed rows
//
// Row Level Security decides which rows each user receives, both for the first load
// and for the Realtime updates that keep every open screen up to date.

// Key-order independent JSON, so unchanged records are never re-written.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

const PAGE = 1000;

/** Every row of a table the user may see (paged past the API's 1000-row limit). */
export async function fetchAll(table, { order, limit } = {}) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase().from(table).select('*');
    if (order) q = q.order(order.column, { ascending: !!order.ascending });
    const to = limit ? Math.min(from + PAGE, limit) - 1 : from + PAGE - 1;
    const page = must(await q.range(from, to));
    rows.push(...page);
    if (page.length < to - from + 1 || (limit && rows.length >= limit)) break;
  }
  return rows.map((r) => fromRow(table, r));
}

/** Rows whose listed fields differ between the two records (for updates). */
function changedFields(table, before, after) {
  const a = toRow(table, before);
  const b = toRow(table, after);
  const patch = {};
  Object.keys(b).forEach((col) => {
    if (stableStringify(a[col]) !== stableStringify(b[col])) patch[col] = b[col];
  });
  Object.keys(a).forEach((col) => {
    if (!(col in b) && col !== 'id') patch[col] = null;
  });
  return patch;
}

/**
 * Writes the difference between two lists.
 * options.softDelete(item) → fields to set instead of deleting (the server finishes the delete).
 */
export async function writeDiff(table, prev, next, { softDelete } = {}) {
  const db = supabase().from(table);
  const before = new Map(prev.map((d) => [d.id, d]));
  const inserts = [];
  const updates = [];
  next.forEach((item) => {
    const old = before.get(item.id);
    if (!old) inserts.push(toRow(table, item));
    else if (stableStringify(old) !== stableStringify(item)) {
      const patch = changedFields(table, old, item);
      if (Object.keys(patch).length) updates.push([item.id, patch]);
    }
    before.delete(item.id);
  });
  const removed = [...before.values()];

  if (inserts.length) must(await db.insert(inserts));
  for (const [id, patch] of updates) must(await supabase().from(table).update(patch).eq('id', id));
  if (removed.length) {
    if (softDelete) {
      for (const item of removed) must(await supabase().from(table).update(toRow(table, softDelete(item))).eq('id', item.id));
    } else {
      must(await supabase().from(table).delete().in('id', removed.map((r) => r.id)));
    }
  }
  return inserts.length + updates.length + removed.length;
}

let channelCount = 0;

/**
 * options: enabled (false = load nothing), order { column, ascending }, limit,
 * sort (client-side), softDelete, onError(err, table).
 */
export function useLiveList(table, { enabled = true, order, limit, sort, softDelete, onError } = {}) {
  const [list, setListState] = useState([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef([]);
  const optionsRef = useRef({ sort, softDelete, onError, limit });
  optionsRef.current = { sort, softDelete, onError, limit };

  const publish = useCallback((arr) => {
    let next = arr.filter((d) => !d.pendingDelete);
    if (optionsRef.current.sort) next = [...next].sort(optionsRef.current.sort);
    if (optionsRef.current.limit) next = next.slice(0, optionsRef.current.limit);
    listRef.current = next;
    setListState(next);
  }, []);

  useEffect(() => {
    if (!enabled) {
      listRef.current = [];
      setListState([]);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);

    // Realtime first, so nothing that changes during the first load is missed.
    const channel = supabase()
      .channel(`live:${table}:${(channelCount += 1)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        const current = listRef.current;
        if (payload.eventType === 'DELETE') {
          publish(current.filter((d) => d.id !== payload.old?.id));
        } else {
          const record = fromRow(table, payload.new);
          const exists = current.some((d) => d.id === record.id);
          publish(exists ? current.map((d) => (d.id === record.id ? record : d)) : [record, ...current]);
        }
      })
      .subscribe();

    fetchAll(table, { order, limit })
      .then((rows) => {
        if (!cancelled) publish(rows);
      })
      .catch((err) => {
        console.warn(`[live] ${table}:`, err.message);
        if (!cancelled) publish([]);
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
      supabase().removeChannel(channel);
    };
    // `order`/`limit` are fixed per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, enabled, publish]);

  const setList = useCallback(
    (updater) => {
      const prev = listRef.current;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      listRef.current = next;
      setListState(next);
      return writeDiff(table, prev, next, { softDelete: optionsRef.current.softDelete }).catch((err) => {
        optionsRef.current.onError?.(err, table);
        throw err;
      });
    },
    [table],
  );

  return [list, setList, loading];
}

// The workspace settings (one row, a JSON object). update(patch) merges.
export function useWorkspaceSettings({ onError } = {}) {
  const [data, setData] = useState(null);
  const dataRef = useRef({});

  useEffect(() => {
    const set = (value) => {
      dataRef.current = value || {};
      setData(dataRef.current);
    };
    const channel = supabase()
      .channel(`live:settings:${(channelCount += 1)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_settings' }, (payload) => {
        if (payload.new?.data) set(payload.new.data);
      })
      .subscribe();
    supabase()
      .from('workspace_settings')
      .select('data')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data: row, error }) => {
        if (error) console.warn('[live] workspace_settings:', error.message);
        set(row?.data || {});
      });
    return () => supabase().removeChannel(channel);
  }, []);

  const update = useCallback(
    async (patch) => {
      const merged = JSON.parse(JSON.stringify({ ...dataRef.current, ...patch }));
      dataRef.current = merged;
      setData(merged);
      const { error } = await supabase().from('workspace_settings').upsert({ id: 1, data: merged, updated_at: new Date().toISOString() });
      if (error) {
        onError?.(error, 'settings');
        throw error;
      }
    },
    [onError],
  );

  return [data, update];
}
