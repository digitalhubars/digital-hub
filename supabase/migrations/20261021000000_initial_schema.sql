-- Digital Hub CRM: initial schema (migrated from Firestore).
--
-- Tables mirror the old Firestore collections. Record IDs stay text (e.g. "st_01",
-- "{storeId}_p{wooId}") so WooCommerce IDs keep mapping to the same row.
-- Row Level Security reproduces firestore.rules; the server (Next.js API routes) uses
-- the secret key, which bypasses RLS.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.groups (
  id text primary key,
  name text not null,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.clients (
  id text primary key,
  company text not null default '',
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  status text not null default 'invited' check (status in ('active', 'invited', 'suspended')),
  store_ids text[] not null default '{}',
  permissions jsonb not null default '{"viewCustomers": true, "editProducts": false, "addProducts": false, "exportData": false}',
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

-- One row per sign-in account (auth.users). Created by a trigger, never by the browser.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'client' check (role in ('admin', 'manager', 'client')),
  group_id text references public.groups (id) on delete set null,
  client_id text references public.clients (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table public.workspace_settings (
  id smallint primary key default 1 check (id = 1),
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.stores (
  id text primary key,
  name text not null default '',
  platform text not null default 'WooCommerce',
  url text not null default '',
  key_hint text,
  account_id text,
  region text,
  group_id text references public.groups (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused')),
  health text,
  last_sync timestamptz,
  last_error text,
  counts jsonb,
  webhooks text,
  sync_frequency text,
  sample boolean not null default false,
  created_at timestamptz not null default now()
);

-- API keys and webhook secrets. Only the server (secret key) can touch this table.
create table public.store_secrets (
  store_id text primary key references public.stores (id) on delete cascade,
  url text,
  consumer_key text,
  consumer_secret text,
  webhook_secret text,
  webhook_ids bigint[] not null default '{}',
  webhook_url text,
  updated_at timestamptz not null default now()
);

create table public.products (
  id text primary key,
  store_id text not null references public.stores (id) on delete cascade,
  external_id text,
  title text not null default '',
  sku text not null default '',
  category text not null default '',
  price numeric(12, 2) not null default 0,
  sale_price numeric(12, 2),
  stock integer, -- null = the store doesn't track a quantity
  stock_status text,
  status text not null default 'active' check (status in ('active', 'draft', 'out_of_stock')),
  woo_status text,
  type text,
  image text,
  permalink text,
  sync_state text not null default 'synced' check (sync_state in ('synced', 'pending', 'error')),
  sync_error text,
  pending_delete boolean not null default false,
  updated_by uuid,
  edited_at timestamptz,
  synced_at timestamptz,
  updated_at timestamptz
);

create table public.customers (
  id text primary key,
  store_id text not null references public.stores (id) on delete cascade,
  external_id text,
  name text not null default '',
  email text not null default '',
  updated_at timestamptz
);

create table public.orders (
  id text primary key,
  store_id text not null references public.stores (id) on delete cascade,
  external_id text,
  number text not null default '',
  customer_id text, -- no FK: an order can arrive before its customer
  items jsonb not null default '[]',
  subtotal numeric(12, 2) not null default 0,
  shipping numeric(12, 2) not null default 0,
  tax numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  currency text,
  status text not null default 'unfulfilled' check (status in ('unfulfilled', 'processing', 'fulfilled', 'refunded', 'cancelled')),
  woo_status text,
  placed_at timestamptz not null default now(),
  updated_at timestamptz,
  sync_state text not null default 'synced' check (sync_state in ('synced', 'pending', 'error')),
  sync_error text,
  updated_by uuid,
  edited_at timestamptz,
  synced_at timestamptz
);

create table public.activity (
  id text primary key,
  at timestamptz not null default now(),
  actor text not null default '',
  actor_id uuid,
  type text,
  text text not null default ''
);

create table public.notifications (
  id text primary key,
  at timestamptz not null default now(),
  text text not null default '',
  tone text not null default 'success',
  read boolean not null default false
);

-- ---------------------------------------------------------------------------
-- Indexes (the four Firestore composite indexes plus the lookups RLS relies on)
-- ---------------------------------------------------------------------------

create index products_store_sync_idx on public.products (store_id, sync_state);
create index orders_store_sync_idx on public.orders (store_id, sync_state);
create index orders_placed_at_idx on public.orders (placed_at desc);
create index customers_store_idx on public.customers (store_id);
create index profiles_role_status_idx on public.profiles (role, status);
create index stores_platform_status_idx on public.stores (platform, status);
create index stores_group_idx on public.stores (group_id);
create index clients_store_ids_idx on public.clients using gin (store_ids);
create index activity_at_idx on public.activity (at desc);
create index notifications_at_idx on public.notifications (at desc);

-- ---------------------------------------------------------------------------
-- Who is asking (used by the policies). SECURITY DEFINER so they can read
-- profiles/clients/stores without recursing into those tables' own policies.
-- ---------------------------------------------------------------------------

create or replace function public.me() returns public.profiles
language sql stable security definer set search_path = public as $$
  select * from public.profiles where id = auth.uid() and status = 'active'
$$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active')
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.me()), false)
$$;

create or replace function public.can_see_store(target text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when (select role from public.me()) = 'admin' then true
    when (select role from public.me()) = 'manager' then exists (
      select 1 from public.stores s where s.id = target and s.group_id is not null and s.group_id = (select group_id from public.me())
    )
    when (select role from public.me()) = 'client' then exists (
      select 1 from public.clients c where c.id = (select client_id from public.me()) and target = any (c.store_ids)
    )
    else false
  end
$$;

-- A client user's permission flag (editProducts, addProducts, ...). Managers always may.
create or replace function public.may(permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when (select role from public.me()) = 'manager' then (select group_id from public.me()) is not null
    when (select role from public.me()) = 'client' then coalesce((
      select (c.permissions ->> permission)::boolean from public.clients c where c.id = (select client_id from public.me())
    ), false)
    else false
  end
$$;

-- Requests made with the secret key (the server) skip the column guards below.
create or replace function public.is_server() returns boolean
language sql stable as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin')
$$;

-- ---------------------------------------------------------------------------
-- Owner and sign-up: every auth user gets a profile. The owner (confirmed email)
-- becomes admin; everyone else starts as a client with no stores.
-- Keep the list in step with src/config/owner.js.
-- ---------------------------------------------------------------------------

create or replace function public.owner_emails() returns text[]
language sql immutable as $$
  select array['digitalhubars@gmail.com']
$$;

create or replace function public.seed_workspace() returns void
language sql security definer set search_path = public as $$
  insert into public.workspace_settings (id, data)
    values (1, '{"workspaceName": "Digital Hub", "currency": "USD", "lowStockThreshold": 10}')
    on conflict (id) do nothing;
  insert into public.groups (id, name) values ('g_main', 'Main') on conflict (id) do nothing;
$$;

create or replace function public.handle_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_owner boolean := lower(new.email) = any (public.owner_emails()) and new.email_confirmed_at is not null;
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id, email, full_name, role)
    values (
      new.id,
      coalesce(new.email, ''),
      left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120),
      case when is_owner then 'admin' else 'client' end
    )
    on conflict (id) do nothing;
  else
    update public.profiles set email = new.email where id = new.id and email is distinct from new.email;
    if is_owner then
      update public.profiles set role = 'admin' where id = new.id and role = 'client' and client_id is null;
    end if;
  end if;
  if is_owner then perform public.seed_workspace(); end if;
  return new;
end
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_auth_user();

create trigger on_auth_user_updated after update of email, email_confirmed_at on auth.users
  for each row execute function public.handle_auth_user();

-- ---------------------------------------------------------------------------
-- Column guards (Firestore's changedOnly([...])): non-admins may change only
-- these columns, and product/order edits must be marked pending for the sync.
-- ---------------------------------------------------------------------------

create or replace function public.guard_columns() returns trigger
language plpgsql as $$
declare
  allowed text[] := tg_argv;
begin
  if public.is_server() or public.is_admin() then return new; end if;
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'You can only change % here.', array_to_string(allowed, ', ') using errcode = '42501';
  end if;
  if tg_table_name in ('products', 'orders') and new.sync_state <> 'pending' then
    raise exception 'Edits must be marked pending so they reach the store.' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_columns('full_name', 'phone');

create trigger products_guard before update on public.products
  for each row execute function public.guard_columns(
    'title', 'sku', 'category', 'price', 'stock', 'status', 'sync_state', 'sync_error', 'updated_by', 'edited_at'
  );

create trigger orders_guard before update on public.orders
  for each row execute function public.guard_columns('status', 'sync_state', 'sync_error', 'updated_by', 'edited_at');

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.groups enable row level security;
alter table public.stores enable row level security;
alter table public.store_secrets enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.customers enable row level security;
alter table public.clients enable row level security;
alter table public.activity enable row level security;
alter table public.notifications enable row level security;

-- Nothing is readable without signing in.
revoke all on all tables in schema public from anon;
-- API keys: no browser access at all (not even admins); only the server.
revoke all on public.store_secrets from authenticated;

-- profiles: yourself or admins; you may edit your own name and phone; admins manage everyone else.
create policy "profiles: read own or admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy "profiles: update own or admin" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create policy "profiles: admin deletes others" on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

create policy "settings: active users read" on public.workspace_settings for select to authenticated using (public.is_active());
create policy "settings: admin writes" on public.workspace_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "groups: active users read" on public.groups for select to authenticated using (public.is_active());
create policy "groups: admin writes" on public.groups for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "stores: read if visible" on public.stores for select to authenticated using (public.can_see_store(id));
create policy "stores: admin writes" on public.stores for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "products: read if visible" on public.products for select to authenticated using (public.can_see_store(store_id));
create policy "products: admin writes" on public.products for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "products: add if allowed" on public.products for insert to authenticated
  with check (public.may('addProducts') and public.can_see_store(store_id) and sync_state = 'pending' and not pending_delete);
create policy "products: edit if allowed" on public.products for update to authenticated
  using (public.may('editProducts') and public.can_see_store(store_id))
  with check (public.may('editProducts') and public.can_see_store(store_id));

create policy "orders: read if visible" on public.orders for select to authenticated using (public.can_see_store(store_id));
create policy "orders: admin writes" on public.orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "orders: managers change status" on public.orders for update to authenticated
  using ((select role from public.me()) = 'manager' and public.can_see_store(store_id))
  with check ((select role from public.me()) = 'manager' and public.can_see_store(store_id));

create policy "customers: read if visible" on public.customers for select to authenticated using (public.can_see_store(store_id));
create policy "customers: admin writes" on public.customers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "clients: admin or own client" on public.clients for select to authenticated
  using (public.is_admin() or id = (select client_id from public.me()));
create policy "clients: admin writes" on public.clients for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "activity: admin reads" on public.activity for select to authenticated using (public.is_admin());
create policy "activity: log as yourself" on public.activity for insert to authenticated
  with check (public.is_active() and actor_id = auth.uid());

create policy "notifications: anyone active raises" on public.notifications for insert to authenticated
  with check (public.is_active());
create policy "notifications: admin reads" on public.notifications for select to authenticated using (public.is_admin());
create policy "notifications: admin updates" on public.notifications for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "notifications: admin deletes" on public.notifications for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Realtime: every open screen updates live (RLS decides who receives what).
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.profiles, public.workspace_settings, public.groups, public.stores, public.products,
  public.orders, public.customers, public.clients, public.activity, public.notifications;

-- Starting point for a new workspace.
select public.seed_workspace();
