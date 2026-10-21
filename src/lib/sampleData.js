import { clients, customers, groups, orders, products, stores } from '../data';
import { deleteIds, upsertRecords } from './db/write';

// The demo stores (marked `sample: true`) so the dashboards have something to show.
// The sync never contacts a real store for them.

export async function loadSampleData() {
  // Parents first: stores need their group, products/orders/customers their store.
  await upsertRecords('groups', groups.map((g) => ({ ...g, sample: true })));
  await upsertRecords('stores', stores.map((s) => ({ ...s, sample: true })));
  await upsertRecords('customers', customers);
  await upsertRecords('products', products.map((p) => ({ ...p, syncState: 'synced' })));
  await upsertRecords('orders', orders.map((o) => ({ ...o, syncState: 'synced' })));
  await upsertRecords('clients', clients.map((c) => ({ ...c, sample: true })));
}

export async function removeSampleData() {
  // Deleting a store also deletes its products, orders and customers (on delete cascade).
  await deleteIds('clients', clients.map((c) => c.id));
  await deleteIds('stores', stores.map((s) => s.id));
  await deleteIds('groups', groups.map((g) => g.id));
}
