# Digital Hub CRM

Next.js 14 + Tailwind, hosted on **Vercel**, with **Supabase** as the back end (project `mdsitvmzqznuzgdwcrll`):

| Part | What it does |
| ---- | ------------ |
| Supabase Auth | Email + password sign-in, confirmation and password-reset emails |
| Supabase Postgres + Realtime | Stores, products, orders, customers, clients, profiles — live on every open screen |
| Row Level Security | Who sees and changes what (`supabase/migrations`) |
| Next.js API routes (`src/app/api`) | Talk to WooCommerce, hold the API keys, manage sign-in accounts |

## Live WooCommerce sync

- **Connect:** Integrations → Add integration → WooCommerce, paste the site URL and a Read/Write consumer key + secret. Digital Hub imports products, orders and customers and creates webhooks in the store.
- **Digital Hub → WooCommerce:** product edits (title, SKU, price, stock, status, category), new products, deletes and order status changes are saved as `pending`, then sent by `/api/sync/push`.
- **WooCommerce → Digital Hub:** the store's webhooks call `/api/woo/webhook` (signed with a per-store secret); changes appear on every open screen.
- **Safety net:** Vercel Cron calls `/api/cron/sync` daily (`vercel.json`). Vercel's free plan allows one run a day; on Pro, change the schedule to `*/15 * * * *`.
- API keys live in the `store_secrets` table, which only the server (secret key) can read or write.

Shopify, Amazon, eBay and TikTok Shop stores can be saved (for clients and groups) but don't sync yet.

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
