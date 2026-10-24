-- Popup sign-in ("Sign in with TikTok Shop / Shopify / Etsy / eBay").
--
-- A sign-in for a NEW store no longer creates the store first: the store is created only
-- after the seller approves, so closing the popup leaves nothing behind. The pending
-- store's details (name, group, Shopify domain, …) wait in oauth_states.meta meanwhile.

alter table public.oauth_states alter column store_id drop not null;
alter table public.oauth_states add column if not exists meta jsonb not null default '{}';
