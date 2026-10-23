// Maps app records (camelCase, times in ms) to Postgres rows (snake_case, timestamptz)
// and back. Used by the browser and by the API routes. Must match supabase/migrations.
//
// Only listed columns are written, so computed fields (customer totals, group store
// lists, …) never reach the database.

const TABLES = {
  groups: ['id', 'name', 'sample', 'createdAt'],
  clients: ['id', 'company', 'contact', 'email', 'phone', 'status', 'storeIds', 'permissions', 'sample', 'createdAt'],
  stores: [
    'id', 'name', 'platform', 'url', 'keyHint', 'accountId', 'region', 'groupId', 'status', 'health',
    'lastSync', 'lastError', 'counts', 'webhooks', 'syncFrequency', 'sample', 'createdAt', 'authExpiresAt',
  ],
  products: [
    'id', 'storeId', 'externalId', 'title', 'sku', 'category', 'price', 'salePrice', 'stock', 'stockStatus', 'status',
    'wooStatus', 'type', 'image', 'permalink', 'syncState', 'syncError', 'pendingDelete', 'updatedBy', 'editedAt',
    'syncedAt', 'updatedAt',
  ],
  customers: ['id', 'storeId', 'externalId', 'name', 'email', 'updatedAt'],
  orders: [
    'id', 'storeId', 'externalId', 'number', 'customerId', 'items', 'subtotal', 'shipping', 'tax', 'total', 'currency',
    'status', 'wooStatus', 'placedAt', 'updatedAt', 'syncState', 'syncError', 'updatedBy', 'editedAt', 'syncedAt',
  ],
  activity: ['id', 'at', 'actor', 'actorId', 'type', 'text'],
  notifications: ['id', 'at', 'text', 'tone', 'read'],
};

const TIME_FIELDS = new Set(['at', 'createdAt', 'lastSync', 'editedAt', 'syncedAt', 'updatedAt', 'placedAt', 'authExpiresAt']);
const NUMBER_FIELDS = new Set(['price', 'salePrice', 'subtotal', 'shipping', 'tax', 'total']);

export const TABLE_NAMES = Object.keys(TABLES);

const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const toIso = (v) => (v == null || v === '' ? null : new Date(typeof v === 'number' ? v : Date.parse(v) || Number(v)).toISOString());
const toMs = (v) => (v == null ? null : Date.parse(v));

/** App record → row. `partial` keeps only the keys present on the record (for updates). */
export function toRow(table, record) {
  const columns = TABLES[table];
  if (!columns) throw new Error(`Unknown table ${table}`);
  const row = {};
  columns.forEach((key) => {
    if (!(key in record) || record[key] === undefined) return;
    const value = record[key];
    row[snake(key)] = TIME_FIELDS.has(key) ? toIso(value) : value;
  });
  return row;
}

/** Row → app record. */
export function fromRow(table, row) {
  // Tables not listed above (profiles) are used with their column names as they are.
  if (!row || !TABLES[table]) return row;
  const record = {};
  Object.entries(row).forEach(([column, value]) => {
    const key = camel(column);
    if (TIME_FIELDS.has(key)) record[key] = toMs(value);
    else if (NUMBER_FIELDS.has(key) && value != null) record[key] = Number(value);
    else record[key] = value;
  });
  return record;
}
