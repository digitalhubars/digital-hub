import { must, supabase } from './supabase/client';
import { upsertRecords } from './db/write';

// Backup file for the workspace data. The live data is in Supabase; this file can be
// downloaded and later restored from Settings → Data management.

const VERSION = 3;

export function workspaceToFile(data) {
  return new Blob([JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), data }, null, 2)], {
    type: 'application/json',
  });
}

// Tables a backup restores, parents first. Activity and notifications are left out: the
// policies only let people add activity entries as themselves.
const RESTORED = ['groups', 'stores', 'customers', 'products', 'orders', 'clients'];

export async function readBackupFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('This file isn’t a Digital Hub backup (it isn’t valid JSON).');
  }
  const data = parsed?.data;
  if (!data || typeof data !== 'object' || !RESTORED.some((name) => Array.isArray(data[name]))) {
    throw new Error('This file isn’t a Digital Hub backup.');
  }
  const counts = Object.fromEntries(RESTORED.map((name) => [name, Array.isArray(data[name]) ? data[name].length : 0]));
  return { exportedAt: parsed.exportedAt || null, data, counts };
}

// Writes every record in the backup (rows with the same id are replaced).
// Products and orders are marked synced so restoring never pushes changes to a store.
export async function restoreBackup(data) {
  let count = 0;
  for (const name of RESTORED) {
    let records = (Array.isArray(data[name]) ? data[name] : []).filter((r) => r?.id).map((r) => ({ ...r, id: String(r.id) }));
    if (name === 'products' || name === 'orders') {
      records = records.map(({ pendingDelete: _p, syncError: _e, ...rest }) => ({ ...rest, syncState: 'synced', ...(name === 'products' ? { pendingDelete: false } : {}) }));
    }
    await upsertRecords(name, records);
    count += records.length;
  }
  if (data.settings && typeof data.settings === 'object') {
    must(await supabase().from('workspace_settings').upsert({ id: 1, data: JSON.parse(JSON.stringify(data.settings)) }));
    count += 1;
  }
  return count;
}
