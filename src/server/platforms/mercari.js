import 'server-only';
import { createHash } from 'node:crypto';
import { PlatformError, num } from './http';

// Mercari has no public seller API, so its data comes in as CSV files (orders and listings)
// uploaded on the Integrations page. Column names are matched loosely, so exports and
// hand-made sheets both work. Re-importing the same file updates rows instead of duplicating them.

const COLUMNS = {
  listings: {
    id: ['item id', 'listing id', 'item_id', 'listing_id', 'id'],
    title: ['title', 'item title', 'item name', 'name'],
    price: ['price', 'listing price', 'list price'],
    qty: ['quantity', 'qty', 'stock', 'available'],
    status: ['status', 'listing status', 'state'],
    sku: ['sku'],
    category: ['category'],
    url: ['url', 'link', 'listing url'],
  },
  orders: {
    id: ['order id', 'transaction id', 'order number', 'order_id', 'item id', 'id'],
    date: ['sold date', 'date sold', 'order date', 'sale date', 'purchase date', 'date'],
    title: ['item title', 'item name', 'title', 'name'],
    itemId: ['item id', 'listing id'],
    price: ['sale price', 'sold price', 'item price', 'price'],
    shipping: ['shipping paid by buyer', 'buyer shipping fee', 'shipping fee', 'shipping'],
    tax: ['sales tax', 'tax'],
    total: ['order total', 'total paid', 'total'],
    buyer: ['buyer name', 'buyer username', 'buyer'],
    email: ['buyer email', 'email'],
    status: ['order status', 'status'],
  },
};

/** RFC 4180-ish CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function table(text, kind) {
  const [head, ...body] = parseCsv(text);
  if (!head) throw new PlatformError('The file is empty.');
  const names = head.map((h) => h.trim().toLowerCase());
  const index = Object.fromEntries(
    Object.entries(COLUMNS[kind]).map(([key, options]) => [key, options.map((o) => names.indexOf(o)).find((i) => i >= 0) ?? -1]),
  );
  const need = kind === 'orders' ? ['title', 'price'] : ['title', 'price'];
  const missing = need.filter((k) => index[k] < 0);
  if (missing.length) {
    throw new PlatformError(`Couldn’t find the ${missing.join(' and ')} column${missing.length > 1 ? 's' : ''}. Columns found: ${head.join(', ')}.`);
  }
  return body.map((cells) => Object.fromEntries(Object.entries(index).map(([key, i]) => [key, i >= 0 ? String(cells[i] ?? '').trim() : ''])));
}

const money = (v) => num(String(v || '').replace(/[^0-9.-]/g, ''));
const fingerprint = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
const slug = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '');

function orderStatus(s) {
  const v = s.toLowerCase();
  if (/cancel/.test(v)) return 'cancelled';
  if (/refund|return/.test(v)) return 'refunded';
  if (/complete|deliver|rated|shipped/.test(v)) return 'fulfilled';
  if (/ship|transit/.test(v)) return 'processing';
  return 'unfulfilled';
}

export default {
  platform: 'Mercari',
  auth: 'csv',

  async test() {
    return { ok: true, message: 'Mercari has no seller API. Import your orders and listings as CSV files from the store’s menu.' };
  },

  /** kind: 'listings' | 'orders'. Returns { products } or { orders }. */
  importCsv(store, kind, text) {
    if (kind === 'listings') {
      const products = table(text, 'listings').map((r) => {
        const qty = r.qty === '' ? null : num(r.qty);
        const sold = /sold/i.test(r.status);
        return {
          storeId: store.id,
          externalId: slug(r.id) || fingerprint(r.title, r.sku),
          title: r.title,
          sku: r.sku,
          category: r.category,
          price: money(r.price),
          stock: sold ? 0 : qty,
          status: sold || qty === 0 ? 'out_of_stock' : /inactive|draft|deactiv/i.test(r.status) ? 'draft' : 'active',
          permalink: r.url,
        };
      });
      return { products };
    }
    const orders = table(text, 'orders').map((r) => {
      const price = money(r.price);
      const shipping = money(r.shipping);
      const tax = money(r.tax);
      const placed = Date.parse(r.date) || Date.now();
      const externalId = slug(r.id) || fingerprint(r.date, r.title, r.price, r.buyer);
      return {
        storeId: store.id,
        externalId,
        number: r.id ? `#${r.id}` : `#${externalId.slice(0, 8)}`,
        items: [{ productId: r.itemId ? `${store.id}_p${slug(r.itemId)}` : null, title: r.title, qty: 1, price }],
        subtotal: price,
        shipping,
        tax,
        total: money(r.total) || price + shipping + tax,
        currency: 'USD',
        status: orderStatus(r.status),
        placedAt: placed,
        updatedAt: Date.now(),
        customer: { externalId: r.buyer ? slug(r.buyer) || null : null, name: r.buyer || 'Mercari buyer', email: r.email },
      };
    });
    return { orders };
  },
};
