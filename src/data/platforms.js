// Store platforms shown on the Integrations page. The server side of each lives in
// src/server/platforms/<platform>.js (one adapter per platform).
//
// auth: 'key'   → API fields typed into the modal (`fields`), checked and saved encrypted by the server
//       'oauth' → "Authorize" sends the admin to the platform's sign-in, which redirects back
//       'csv'   → no API; orders and listings are imported from CSV files

export const PLATFORMS = {
  Shopify: {
    api: 'Shopify Admin API',
    auth: 'key',
    idLabel: 'Product ID',
    address: 'domain',
    fields: [
      { key: 'domain', label: 'Store domain', placeholder: 'your-store.myshopify.com' },
      {
        key: 'token',
        label: 'Admin API access token',
        placeholder: 'shpat_…',
        secret: true,
        hint: 'Shopify admin → Settings → Apps and sales channels → Develop apps → your app. Scopes: read_products, read_orders, read_customers, read_inventory.',
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
    tone: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300',
    dot: 'bg-violet-600 dark:bg-violet-400',
  },
  Amazon: {
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
    api: 'eBay Trading + Sell APIs',
    auth: 'oauth',
    twoWay: true,
    idLabel: 'Item ID',
    account: 'eBay user',
    portal: 'eBay',
    connectLabel: 'Authorize with eBay',
    button: 'bg-[#0064D2] text-white hover:bg-[#0057B8]',
    regions: ['United States', 'United Kingdom', 'Germany', 'Australia'],
    scopes: ['Listings: read, edit price/quantity/title, end', 'Orders: read, mark shipped', 'Account name'],
    // The store's own eBay developer app (developer.ebay.com → Application Keys, Production).
    fields: [
      { key: 'clientId', label: 'Client ID (App ID)', placeholder: 'YourName-AppName-PRD-…' },
      { key: 'clientSecret', label: 'Client Secret (Cert ID)', placeholder: 'PRD-…', secret: true },
      {
        key: 'ruName',
        label: 'RuName (eBay Redirect URL name)',
        placeholder: 'Your_Name-YourName-AppNam-abcdefg',
        hint: 'developer.ebay.com → User Tokens → “Get a Token from eBay via Your Application” → your RuName. Set its “Your auth accepted URL” to the address below.',
        callback: 'ebay',
      },
    ],
    tone: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    dot: 'bg-sky-600 dark:bg-sky-400',
  },
  Etsy: {
    api: 'Etsy Open API v3',
    auth: 'oauth',
    idLabel: 'Listing ID',
    account: 'Shop',
    portal: 'Etsy',
    connectLabel: 'Authorize with Etsy',
    button: 'bg-[#F1641E] text-white hover:bg-[#D9561A]',
    scopes: ['Shop (read)', 'Listings (read)', 'Orders (read)'],
    // The store's Etsy app (etsy.com/developers/your-apps). The key must be approved (not "Pending").
    fields: [
      { key: 'keystring', label: 'Keystring', placeholder: 'e.g. 1aa2bb33c44d55eeeeee6fff' },
      {
        key: 'sharedSecret',
        label: 'Shared Secret',
        placeholder: 'e.g. 7aaa8bbb9c',
        secret: true,
        hint: 'etsy.com/developers/your-apps → your app → See API Key Details. Also add this address under the app’s Callback URLs:',
        callback: 'etsy',
      },
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
    api: 'TikTok Shop Partner API',
    auth: 'oauth',
    idLabel: 'Product ID',
    account: 'Shop',
    portal: 'TikTok Shop Seller Center',
    connectLabel: 'Authorize with TikTok Shop',
    button: 'bg-gray-950 text-white hover:bg-black dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200',
    scopes: ['Products (read)', 'Orders (read)'],
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
