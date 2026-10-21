import { doc, writeBatch } from 'firebase/firestore';
import { fb } from './firebase/client';

// Backup file for the workspace data. The live data is in Firestore; this file can be
// downloaded and later restored from Settings → Data management.

const VERSION = 2;

export function workspaceToFile(data) {
  return new Blob([JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), data }, null, 2)], {
    type: 'application/json',
  });
}

// Collections a backup restores. Activity and notifications are left out: the rules only
// let people create activity entries as themselves.
const RESTORED = ['stores', 'groups', 'products', 'orders', 'customers', 'clients'];

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

const toDoc = ({ id: _id, ...rest }) => JSON.parse(JSON.stringify(rest));

// Writes every record in the backup (existing docs with the same id are replaced).
// Products and orders are marked synced so restoring never pushes changes to a store.
export async function restoreBackup(data) {
  const { db } = fb();
  const ops = [];
  RESTORED.forEach((name) =>
    (Array.isArray(data[name]) ? data[name] : []).forEach((item) => {
      if (!item?.id) return;
      let record = toDoc(item);
      if (name === 'products' || name === 'orders') {
        const { pendingDelete: _p, syncError: _e, ...rest } = record;
        record = { ...rest, syncState: 'synced' };
      }
      ops.push([doc(db, name, String(item.id)), record]);
    }),
  );
  if (data.settings && typeof data.settings === 'object') ops.push([doc(db, 'workspace', 'settings'), toDoc(data.settings)]);

  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach(([ref, record]) => batch.set(ref, record));
    await batch.commit();
  }
  return ops.length;
}
