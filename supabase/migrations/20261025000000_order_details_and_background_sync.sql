-- Refunds and shipping on orders, and a 15-minute background sync run by Supabase.

-- ---------------------------------------------------------------------------
-- Orders: how much was refunded, and shipping / tracking where the platform shares it.
-- shipping_info = { status, carrier, tracking, trackingUrl, shippedAt (ms) }
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists refunded numeric(12, 2) not null default 0,
  add column if not exists shipping_info jsonb;

-- Managers can still only change status (the column guard lists what they may change;
-- refunded / shipping_info come from the platforms through the server).

-- ---------------------------------------------------------------------------
-- Background sync: every 15 minutes Supabase calls the app's /api/cron/sync, which syncs
-- each active store whose own "Sync every" interval has passed (and refreshes tokens).
-- Works on Vercel's free plan, whose own cron runs only once a day.
--
-- After running this file, store the app address and CRON_SECRET in Vault once
-- (Supabase → SQL Editor), with your own values:
--   select vault.create_secret('https://digital-hub-chi-puce.vercel.app', 'app_url');
--   select vault.create_secret('<CRON_SECRET from .env.local / Vercel>', 'cron_secret');
-- Until both exist, the job does nothing.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.run_background_sync() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  app_url text;
  secret text;
begin
  select decrypted_secret into app_url from vault.decrypted_secrets where name = 'app_url' limit 1;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if app_url is null or secret is null then
    return;
  end if;
  perform net.http_get(
    url := rtrim(app_url, '/') || '/api/cron/sync',
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 5000
  );
end
$$;

revoke execute on function public.run_background_sync() from public, anon, authenticated;

-- Same name → replaces an earlier schedule instead of adding a second one.
select cron.schedule('digital-hub-background-sync', '*/15 * * * *', $$select public.run_background_sync()$$);
