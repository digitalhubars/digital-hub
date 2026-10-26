// Store platforms shown on the Integrations page. The server side of each lives in
// src/server/platforms/<platform>.js (one adapter per platform).
//
// auth: 'key'   → API fields typed into the modal (`fields`), checked and saved encrypted by the server
//       'oauth' → "Sign in with …" opens the platform's official sign-in in a pop-up
//                 (app keys live only in the server's environment variables)
//       'csv'   → no API; orders and listings are imported from CSV files
// live: 'webhooks' → changes arrive in real time; otherwise the background sync (every 15 minutes)

export const PLATFORMS = {
  Shopify: {
    slug: 'shopify',
    api: 'Shopify Admin API',
    auth: 'key',
    idLabel: 'Product ID',
    account: 'Shop',
    portal: 'Shopify',
    connectLabel: 'Connect Shopify',
    keysLabel: 'Client ID + Secret',
    button: 'bg-[#008060] text-white hover:bg-[#006e52]',
    live: 'webhooks',
    scopes: ['Products & inventory (read)', 'Orders, fulfillments & refunds (read)', 'Customers (read)'],
    // App made in the Shopify Dev Dashboard (dev.shopify.com) and installed on the store.
    fields: [
      { key: 'domain', label: 'Store domain', placeholder: 'your-store.myshopify.com' },
      { key: 'clientId', label: 'Client ID', placeholder: 'From the app’s Settings → Credentials' },
      {
        key: 'clientSecret',
        label: 'Client secret',
        secret: true,
        hint: 'Shopify Dev Dashboard → your app → Settings → Credentials. The app must be installed on this store, with scopes read_products, read_inventory, read_orders, read_fulfillments, read_customers.',
      },
    ],
    // Alternative: an Admin API access token from an existing custom app (no live updates).
    tokenFields: [
      { key: 'domain', label: 'Store domain', placeholder: 'your-store.myshopify.com' },
      {
        key: 'token',
        label: 'Admin API access token',
        placeholder: 'shpat_…',
        secret: true,
        hint: 'Shopify admin → Settings → Apps → Develop apps → your app → API credentials. Scopes: read_products, read_inventory, read_orders, read_fulfillments, read_customers.',
      },
    ],
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    dot: 'bg-emerald-600 dark:bg-emerald-400',
  },
  WooCommerce: {
    api: 'WooCommerce REST API',
    auth: 'key',
    idLabel: 'Product ID',
    twoWay: true,
    live: 'webhooks',
    tone: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300',
    dot: 'bg-violet-600 dark:bg-violet-400',
  },
  Amazon: {
    slug: 'amazon',
    api: 'Amazon SP-API',
    auth: 'oauth',
    idLabel: 'SKU',
    account: 'Seller ID',
    portal: 'Amazon Seller Central',
    connectLabel: 'Authorize with Amazon Seller Central',
    button: 'bg-[#FF9900] text-gray-950 hover:bg-[#F08C00]',
    regions: ['North America', 'Europe', 'Far East'],
    scopes: ['Listings (read)', 'Orders (read)'],
    tone: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  eBay: {
    slug: 'ebay',
    api: 'eBay Trading + Sell APIs',
    auth: 'oauth',
    twoWay: true,
    idLabel: 'Item ID',
    account: 'eBay user',
    portal: 'eBay',
    connectLabel: 'Connect eBay',
    button: 'bg-[#0064D2] text-white hover:bg-[#0057B8]',
    regions: ['United States', 'United Kingdom', 'Germany', 'Australia'],
    scopes: ['Listings: read, edit price/quantity/title, end', 'Orders: read, mark shipped', 'Account name'],
    // The store's eBay app (developer.ebay.com → Application Keys, Production). eBay then asks the seller to approve once.
    fields: [
      { key: 'clientId', label: 'Client ID (App ID)', placeholder: 'YourName-AppName-PRD-…' },
      { key: 'clientSecret', label: 'Client secret (Cert ID)', placeholder: 'PRD-…', secret: true },
      {
        key: 'ruName',
        label: 'RuName',
        placeholder: 'Your_Name-YourName-AppNam-abcdefg',
        hint: 'developer.ebay.com → User Tokens → your RuName. Set its “auth accepted URL” to:',
        callback: 'ebay',
      },
    ],
    tone: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    dot: 'bg-sky-600 dark:bg-sky-400',
  },
  Etsy: {
    slug: 'etsy',
    api: 'Etsy Open API v3',
    auth: 'oauth',
    idLabel: 'Listing ID',
    account: 'Shop',
    portal: 'Etsy',
    connectLabel: 'Connect Etsy',
    button: 'bg-[#F1641E] text-white hover:bg-[#D9561A]',
    scopes: ['Shop (read)', 'Listings (read)', 'Orders (read)'],
    // The store's Etsy app (etsy.com/developers/your-apps; must be approved). Etsy then asks the seller to approve once.
    fields: [
      { key: 'keystring', label: 'Keystring (Client ID)', placeholder: 'e.g. 1aa2bb33c44d55eeeeee6fff' },
      { key: 'sharedSecret', label: 'Shared secret (Client secret)', secret: true, hint: 'Add this callback URL on the Etsy app:', callback: 'etsy' },
    ],
    tone: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-300',
    dot: 'bg-orange-500 dark:bg-orange-400',
  },
  Walmart: {
    api: 'Walmart Marketplace API',
    auth: 'key',
    idLabel: 'SKU',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: 'xxxxxxxx-xxxx-…' },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        secret: true,
        hint: 'Walmart Seller Center → Settings → API Key Management → Generate (Marketplace, read access to Items and Orders).',
      },
    ],
    tone: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300',
    dot: 'bg-blue-600 dark:bg-blue-400',
  },
  'TikTok Shop': {
    slug: 'tiktok',
    api: 'TikTok Shop Partner API',
    auth: 'oauth',
    idLabel: 'Product ID',
    account: 'Shop',
    portal: 'TikTok Shop Seller Center',
    connectLabel: 'Connect TikTok Shop',
    live: 'webhooks',
    button: 'bg-gray-950 text-white hover:bg-black dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200',
    scopes: ['Products (read)', 'Orders (read)'],
    // The store's TikTok Shop app (partner.tiktokshop.com → App & Service). TikTok then asks the seller to approve once.
    fields: [
      { key: 'appKey', label: 'App key (Client ID)', placeholder: 'e.g. 6abc1d2ef3gh4' },
      { key: 'appSecret', label: 'App secret (Client secret)', secret: true },
      { key: 'serviceId', label: 'Service ID', placeholder: 'e.g. 7123456789012345678', hint: 'Set the app’s Redirect URL to:', callback: 'tiktok' },
    ],
    tone: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    dot: 'bg-rose-600 dark:bg-rose-400',
  },
  Mercari: {
    api: 'CSV import',
    auth: 'csv',
    idLabel: 'Item ID',
    tone: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
    dot: 'bg-red-600 dark:bg-red-400',
  },
};

export const PLATFORM_NAMES = Object.keys(PLATFORMS);

export const isOAuthPlatform = (platform) => PLATFORMS[platform]?.auth === 'oauth';
export const isCsvPlatform = (platform) => PLATFORMS[platform]?.auth === 'csv';

export const platformSlug = (platform) => platform.toLowerCase().replace(/\s+/g, '_');
