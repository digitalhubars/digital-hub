# Digital Hub CRM

Next.js 14 + Tailwind front end, **Firebase** back end (project `digital-hub-4`):

| Part | What it does |
| ---- | ------------ |
| Firebase Authentication | Email + password sign-in, reset emails, email confirmation |
| Cloud Firestore (asia-southeast1) | Stores, products, orders, customers, clients, users — live on every open screen |
| Cloud Functions (asia-southeast1) | Talks to WooCommerce and holds the API keys (needs the Blaze plan) |
| Firebase Hosting | Serves the site (static export in `out/`) |

## Live WooCommerce sync

- **Connect:** Integrations → Add integration → WooCommerce, paste the site URL and a Read/Write consumer key + secret. Digital Hub imports products, orders and customers and creates webhooks in the store.
- **Digital Hub → WooCommerce:** product edits (title, SKU, price, stock, status, category), new products, deletes and order status changes are sent within seconds by the `onProductWritten` / `onOrderWritten` functions.
- **WooCommerce → Digital Hub:** the store's webhooks call `wooWebhook` (signed with a per-store secret); changes appear on every open screen.
- **Safety net:** `scheduledWooSync` pulls anything changed in the last 15 minutes.
- API keys are written to `storeSecrets/{id}`, which the browser can write but never read.

Shopify, Amazon, eBay and TikTok Shop stores can be saved (for clients and groups) but don't sync yet.

## Roles

| Role | Opens | Sees |
| ---- | ----- | ---- |
| Admin | `/admin`, can switch to `/manager` and `/client` | Everything |
| Manager | `/manager` | Stores in their store group |
| Client | `/client` | Stores of their client account, with its permissions |

The owner (`src/config/owner.js`, and `isOwner()` in `firestore.rules`) becomes admin once that email is confirmed. Everyone else who signs up is a client with no stores until an admin assigns them in **Settings → Users & roles**. Enforced by `firestore.rules`.

## One-time project setup (Firebase console, as devexpinsoft@gmail.com)

1. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
2. **Upgrade to the Blaze plan** (needed for Cloud Functions to call WooCommerce): https://console.firebase.google.com/project/digital-hub-4/usage/details
3. Then: `npm run deploy` (or ask Claude to deploy).

Then Claude (or you) creates the Firestore database in asia-southeast1 and deploys: `firebase firestore:databases:create "(default)" --location=asia-southeast1`, then `npm run deploy`.

## Commands

```
npm install && (cd functions && npm install)
npm run dev        # http://localhost:3000 against the real project (.env.local)
npm run build      # static site in out/
npm run deploy     # build + firebase deploy (hosting, functions, rules)
npm run emulators  # local Firebase; copy .env.emulators.example → .env.development.local first
```
