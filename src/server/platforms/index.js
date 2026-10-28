import 'server-only';
import amazon from './amazon';
import ebay from './ebay';
import etsy from './etsy';
import mercari from './mercari';
import shopify from './shopify';
import tiktok from './tiktok';
import walmart from './walmart';
import woocommerce from './woocommerce';

/**
 * Every store platform implements this adapter. To add a platform: write one file in this
 * folder, register it below, and add its fields to src/data/platforms.js.
 *
 * {
 *   platform: 'Shopify',                     // matches stores.platform
 *   auth: 'key' | 'oauth' | 'csv',           // how a store is connected
 *   pushEdits?: true,                        // Digital Hub edits are sent back (WooCommerce only for now)
 *
 *   // auth 'key': validate the typed fields → credentials to save (may call the API, e.g. for a token)
 *   connect?(input) → creds
 *
 *   // auth 'oauth'
 *   pkce?: true,
 *   authorizeUrl?({ state, redirectUri, codeChallenge, store }) → url
 *   exchangeCode?({ query, redirectUri, codeVerifier, store }) → creds  // query = the callback's URL parameters
 *
 *   // when creds have `expiresAt`: new tokens before they run out (called automatically)
 *   refresh?(creds, store) → creds
 *
 *   test(ctx) → { ok, message, account? }
 *   syncProducts?(ctx, { since }) → [{ externalId, title, sku, price, stock, status, … } | { externalId, deleted: true }]
 *   syncOrders?(ctx, { since })   → [{ externalId, number, items, total, status, placedAt, customer: { externalId?, name, email }, … }]
 *   syncCustomers?(ctx, { since }) → [{ externalId, name, email }]
 *   registerWebhooks?(ctx, { url }) → { creds?, note? }   // real-time updates; `creds` are merged into the saved credentials
 *   pushProduct?(ctx, product, before) / pushOrder?(ctx, order) → fields to save | { deleted: true }
 *   importCsv?(store, kind, text) → { products } | { orders }
 * }
 *
 * ctx = { store, creds }. `since` (ms) is set for incremental syncs.
 * Orders may include refunded (amount) and shippingInfo { status, carrier, tracking, trackingUrl, shippedAt }.
 * Product status must be active | draft | out_of_stock; order status unfulfilled | processing |
 * fulfilled | refunded | cancelled (see supabase/migrations).
 */
const ADAPTERS = [woocommerce, shopify, ebay, etsy, walmart, amazon, tiktok, mercari];

const byPlatform = Object.fromEntries(ADAPTERS.map((a) => [a.platform, a]));

export const getAdapter = (platform) => byPlatform[platform] || null;

// URL-safe names used in the OAuth callback path: /api/integrations/callback/<slug>
const SLUGS = { Amazon: 'amazon', eBay: 'ebay', Shopify: 'shopify', 'TikTok Shop': 'tiktok' };
export const callbackSlug = (platform) => SLUGS[platform];
export const platformFromSlug = (slug) => Object.keys(SLUGS).find((p) => SLUGS[p] === slug) || null;
