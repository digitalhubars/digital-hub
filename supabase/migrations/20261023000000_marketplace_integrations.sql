-- Marketplace integrations: Shopify, eBay, Etsy, Walmart, Amazon, TikTok Shop, Mercari.
--
-- Credentials stay in store_secrets (no browser access at all). New platforms keep their
-- keys/tokens in `credentials`: one JSON object encrypted with AES-256-GCM by the server
-- (TOKEN_ENCRYPTION_KEY), so even a database dump doesn't reveal them. WooCommerce's
-- consumer key/secret and webhook secret columns are encrypted the same way from now on
-- (older plain-text values are re-encrypted on the next sync).

alter table public.store_secrets
  add column if not exists credentials text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists refresh_expires_at timestamptz;

-- When the store's authorization runs out (shown on the Integrations page). Not secret.
alter table public.stores
  add column if not exists auth_expires_at timestamptz;

-- health now also uses 'needs_auth' (Authorization needed) and 'expired' (Expired).
comment on column public.stores.health is
  'connected | checking | error | slow | expiring | needs_auth | expired | manual';

-- One-time OAuth "state" values: tie the marketplace's redirect back to the store and the
-- admin who clicked Authorize. Expire after 15 minutes; deleted when used.
create table if not exists public.oauth_states (
  state text primary key,
  store_id text not null references public.stores (id) on delete cascade,
  platform text not null,
  created_by uuid references auth.users (id) on delete set null,
  code_verifier text, -- PKCE (Etsy), encrypted
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists oauth_states_expires_idx on public.oauth_states (expires_at);
create index if not exists store_secrets_token_expiry_idx on public.store_secrets (token_expires_at);

-- Server only, like store_secrets.
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;
