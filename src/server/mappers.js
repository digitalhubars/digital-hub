import { createHash } from 'node:crypto';

// Document IDs are derived from the WooCommerce IDs, so the same item always maps to the same doc.
export const productDocId = (storeId, wooId) => `${storeId}_p${wooId}`;
export const orderDocId = (storeId, wooId) => `${storeId}_o${wooId}`;
export const customerDocId = (storeId, wooId) => `${storeId}_c${wooId}`;
export const guestDocId = (storeId, email) =>
  `${storeId}_g${createHash('sha1').update(String(email || 'guest').toLowerCase()).digest('hex').slice(0, 16)}`;

const ts = (gmt) => (gmt ? Date.parse(`${gmt}Z`) || Date.now() : Date.now());
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- Products ---------------------------------------------------------------

export function productFromWoo(storeId, p) {
  let status = p.status === 'publish' ? 'active' : 'draft';
  if (status === 'active' && p.stock_status === 'outofstock') status = 'out_of_stock';
  return {
    storeId,
    externalId: String(p.id),
    title: p.name || '',
    sku: p.sku || '',
    category: p.categories?.[0]?.name || '',
    price: num(p.regular_price || p.price),
    salePrice: p.sale_price ? num(p.sale_price) : null,
    // null = WooCommerce isn't tracking a quantity for this product ("In stock" / "Out of stock" only)
    stock: p.manage_stock ? num(p.stock_quantity) : null,
    stockStatus: p.stock_status || 'instock',
    wooStatus: p.status,
    type: p.type || 'simple',
    image: p.images?.[0]?.src || '',
    permalink: p.permalink || '',
    updatedAt: ts(p.date_modified_gmt),
    syncState: 'synced',
    syncError: null,
  };
}

// Only the fields Digital Hub edits. Category is left alone (WooCommerce needs category IDs).
export function productToWoo(p, before) {
  const body = { name: p.title, sku: p.sku || '', regular_price: String(p.price ?? '') };

  if (p.stock != null) {
    body.manage_stock = true;
    body.stock_quantity = Number(p.stock);
  } else if (before?.stock != null) {
    body.manage_stock = false;
  }

  if (p.status === 'draft') {
    body.status = 'draft';
  } else {
    body.status = 'publish';
    if (p.stock == null) body.stock_status = p.status === 'out_of_stock' ? 'outofstock' : 'instock';
  }
  return body;
}

// ---- Orders -----------------------------------------------------------------

const WOO_TO_CRM = {
  pending: 'unfulfilled',
  'on-hold': 'unfulfilled',
  'checkout-draft': 'unfulfilled',
  processing: 'processing',
  completed: 'fulfilled',
  cancelled: 'cancelled',
  failed: 'cancelled',
  refunded: 'refunded',
};

export const CRM_TO_WOO = {
  unfulfilled: 'on-hold',
  processing: 'processing',
  fulfilled: 'completed',
  refunded: 'refunded',
  cancelled: 'cancelled',
};

export const orderCustomerId = (storeId, o) =>
  o.customer_id > 0 ? customerDocId(storeId, o.customer_id) : guestDocId(storeId, o.billing?.email);

export function orderFromWoo(storeId, o) {
  const shipping = num(o.shipping_total);
  const total = num(o.total);
  return {
    storeId,
    externalId: String(o.id),
    number: `#${o.number || o.id}`,
    customerId: orderCustomerId(storeId, o),
    items: (o.line_items || []).map((li) => ({
      productId: li.product_id ? productDocId(storeId, li.product_id) : null,
      title: li.name || '',
      qty: num(li.quantity),
      price: num(li.price),
    })),
    subtotal: Math.max(0, total - shipping - num(o.total_tax)),
    shipping,
    tax: num(o.total_tax),
    total,
    currency: o.currency || 'USD',
    status: WOO_TO_CRM[o.status] || 'unfulfilled',
    wooStatus: o.status,
    placedAt: ts(o.date_created_gmt),
    updatedAt: ts(o.date_modified_gmt),
    syncState: 'synced',
    syncError: null,
  };
}

// ---- Customers --------------------------------------------------------------

const fullName = (first, last, fallback) => `${first || ''} ${last || ''}`.trim() || fallback || 'Customer';

export function customerFromWoo(storeId, c) {
  return {
    storeId,
    externalId: String(c.id),
    name: fullName(c.first_name, c.last_name, c.username),
    email: c.email || '',
    updatedAt: ts(c.date_modified_gmt),
  };
}

// Guests (no account) are built from the order's billing details.
export function customerFromOrder(storeId, o) {
  const b = o.billing || {};
  return {
    storeId,
    externalId: o.customer_id > 0 ? String(o.customer_id) : null,
    name: fullName(b.first_name, b.last_name, b.email),
    email: b.email || '',
    updatedAt: ts(o.date_modified_gmt),
  };
}
