# Digital Hub CRM

Next.js 14 + Tailwind, hosted on **Vercel**, with **Supabase** as the back end (project `mdsitvmzqznuzgdwcrll`):

| Part | What it does |
| ---- | ------------ |
| Supabase Auth | Email + password sign-in, confirmation and password-reset emails |
| Supabase Postgres + Realtime | Stores, products, orders, customers, clients, profiles — live on every open screen |
| Row Level Security | Who sees and changes what (`supabase/migrations`) |
| Next.js API routes (`src/app/api`) | Talk to the store platforms, hold their keys and tokens, manage sign-in accounts |

## Store integrations

Every platform is one adapter in `src/server/platforms/` with the same interface (`connect` / `authorizeUrl` + `exchangeCode` / `refresh` / `test` / `syncProducts` / `syncOrders`); `index.js` documents it. To add a platform, write one file, register it there, and add it to `src/data/platforms.js`.

| Platform | Connects with | Products & orders |
| -------- | ------------- | ----------------- |
| WooCommerce | Site URL + consumer key/secret | Two-way: edits are pushed back, webhooks stream changes in |
| Shopify | Store domain + Admin API token | Imported (GraphQL Admin API) |
| eBay | The store's own Client ID + Client Secret + RuName, then Authorize | Two-way: every active listing (Trading API) and orders (Fulfillment API); title, price and quantity edits, ending listings and marking orders shipped go back to eBay |
| Etsy | The store's own Keystring + Shared Secret, then Authorize (OAuth with PKCE) | Imported (listings + receipts) |
| Walmart | Client ID + Client Secret | Imported (items + orders; stock isn't included) |
| Amazon | OAuth via Seller Central | Imported (Listings Items + Orders; line items for the newest 20 orders per sync) |
| TikTok Shop | The store's own App Key + App Secret + Service ID, then Authorize | Imported (products + orders, signed requests) |
| Mercari | CSV import (no public API) | Orders and listings from CSV files |

- **No duplicates:** rows use the platform's own IDs (`{store}_p{id}`, `{store}_o{id}`, `{store}_c{id}`), so every sync or re-import updates rows in place.
- **Secrets:** keys and tokens are saved in `store_secrets` encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`); only the server can read that table.
- **Tokens:** refreshed automatically 5 minutes before they expire (every sync and the daily cron). A refused refresh marks the store **Expired**; a store without keys or authorization shows **Authorization needed**.
- **OAuth:** "Authorize" creates a one-time `state` (15 minutes) in `oauth_states`; the platform redirects to `/api/integrations/callback/<amazon|ebay|etsy|tiktok>`, which exchanges the code and returns to Integrations.
- **Routes:** `/api/stores/test` (Test connection), `/api/integrations/credentials` (save keys), `/api/integrations/authorize`, `/api/integrations/callback/[platform]`, `/api/integrations/import` (CSV), `/api/stores/sync`, `/api/stores/disconnect`.
- **Schedule:** Vercel Cron calls `/api/cron/sync` daily (`vercel.json`); on Vercel Pro, change it to `*/15 * * * *`.

Each marketplace needs its own developer app; the keys and redirect URLs are listed in `.env.production.example`.

## Roles

| Role | Opens | Sees |
| ---- | ----- | ---- |
| Admin | `/admin`, can switch to `/manager` and `/client` | Everything |
| Manager | `/manager` | Stores in their store group |
| Client | `/client` | Stores of their client account, with its permissions |

The owner (`src/config/owner.js`, and `owner_emails()` in the migration) becomes admin once that email is confirmed. Everyone else who signs up is a client with no stores until an admin assigns them in **Settings → Users & roles**.

## Environment variables

`.env.local` for local runs, and Vercel → Settings → Environment Variables for the live site (see `.env.production.example`):

| Name | Where it's used |
| ---- | --------------- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + server |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser + server (public; RLS protects the data) |
| `SUPABASE_SECRET_KEY` | Server only. Bypasses RLS: never commit it, never prefix it with `NEXT_PUBLIC_` |
| `CRON_SECRET` | Server only. Protects `/api/cron/sync` |
| `TOKEN_ENCRYPTION_KEY` | Server only. Encrypts store keys and tokens; never change it once stores are connected |
| Marketplace app keys | Server only. eBay, Etsy, Amazon, TikTok Shop: see `.env.production.example` |

## Database changes

```
npx supabase login                                   # once, opens the browser
npx supabase link --project-ref mdsitvmzqznuzgdwcrll # once, asks for the database password
npx supabase migration new <name>                    # write SQL in supabase/migrations
npx supabase db push                                 # apply new migrations to the live project
npx supabase config push                             # apply auth settings from supabase/config.toml
```

## Commands

```
npm install
npm run dev        # http://localhost:3000 against the live Supabase project (.env.local)
npm run build      # production build (Vercel runs this on every push to main)
```
