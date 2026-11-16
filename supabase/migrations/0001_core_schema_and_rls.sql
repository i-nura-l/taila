-- TAILA core schema. Public pages never read tables directly: they call
-- the functions in the next migration. Tables are open only to shop members.

create extension if not exists pg_trgm with schema extensions;
create schema if not exists private;

-- ---------- tables ----------
create table public.shops (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind text not null default 'shop',
  description text,
  country text not null default 'KG',
  city text not null default 'Бишкек',
  district text,
  address text,
  phone text,
  whatsapp text,
  instagram text,
  working_hours text,
  currency text not null default 'KGS',
  language text not null default 'ru',
  hold_hours integer not null default 24,
  is_published boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shops_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  constraint shops_name_len check (char_length(name) between 2 and 60),
  constraint shops_kind check (kind in ('shop','stall','sewing')),
  constraint shops_hold check (hold_hours between 2 and 72),
  constraint shops_desc_len check (description is null or char_length(description) <= 600),
  constraint shops_text_len check (
    coalesce(char_length(district),0) <= 40 and coalesce(char_length(address),0) <= 160 and
    coalesce(char_length(phone),0) <= 20 and coalesce(char_length(whatsapp),0) <= 20 and
    coalesce(char_length(instagram),0) <= 40 and coalesce(char_length(working_hours),0) <= 80)
);

create table public.shop_members (
  shop_id uuid not null references public.shops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index shop_members_user_idx on public.shop_members(user_id);

-- Things only the shop may see (Telegram chat, link code).
create table public.shop_private (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  telegram_chat_id bigint,
  telegram_link_code text not null unique default replace(gen_random_uuid()::text, '-', '')
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 80),
  description text check (description is null or char_length(description) <= 1000),
  category text not null default 'other'
    check (category in ('dress','outerwear','top','bottom','shoes','kids','national','accessory','other')),
  price integer not null check (price between 0 and 10000000),
  old_price integer check (old_price is null or old_price between 0 and 10000000),
  photos text[] not null default '{}' check (cardinality(photos) <= 6),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as
    (to_tsvector('russian', coalesce(title,'') || ' ' || coalesce(description,''))) stored
);
create index products_shop_idx on public.products(shop_id, created_at desc);
create index products_search_idx on public.products using gin(search);
create index products_title_trgm_idx on public.products using gin(title extensions.gin_trgm_ops);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  size text not null check (char_length(size) between 1 and 12),
  color text not null default '' check (char_length(color) <= 30),
  sort integer not null default 0,
  unique (product_id, size, color)
);
create index product_variants_size_idx on public.product_variants(size);

create table public.stock (
  variant_id uuid primary key references public.product_variants(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  quantity integer not null default 0 check (quantity between 0 and 9999),
  last_confirmed_at timestamptz not null default now()
);
create index stock_shop_idx on public.stock(shop_id);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  token uuid not null unique default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_title text not null,
  size text not null,
  color text not null default '',
  price integer not null,
  quantity integer not null default 1 check (quantity between 1 and 3),
  customer_name text not null,
  customer_phone text not null,
  note text,
  status text not null default 'pending'
    check (status in ('pending','confirmed','picked_up','cancelled','expired')),
  expires_at timestamptz not null,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reservations_shop_idx on public.reservations(shop_id, created_at desc);
create index reservations_due_idx on public.reservations(expires_at) where status in ('pending','confirmed');
create index reservations_ip_idx on public.reservations(ip_hash, created_at);
create index reservations_phone_idx on public.reservations(customer_phone) where status in ('pending','confirmed');

-- Server-side settings (Telegram bot token etc.). Not reachable through the API.
create table private.settings (key text primary key, value text not null);

-- ---------- membership helper used by every policy ----------
create or replace function private.is_member(p_shop uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop and m.user_id = (select auth.uid())
  );
$$;

-- Same check for storage paths, where the shop id arrives as text.
create or replace function private.is_member_text(p_shop text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_shop ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.is_member(p_shop::uuid) else false end;
$$;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on function private.is_member(uuid), private.is_member_text(text) to authenticated;

-- ---------- row-level security ----------
alter table public.shops enable row level security;
alter table public.shop_members enable row level security;
alter table public.shop_private enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.stock enable row level security;
alter table public.reservations enable row level security;
alter table private.settings enable row level security;

-- Start from zero rights, then grant only what the seller screen needs.
revoke all on public.shops, public.shop_members, public.shop_private, public.products,
  public.product_variants, public.stock, public.reservations from anon, authenticated;

grant select on public.shops, public.shop_members, public.shop_private, public.products,
  public.product_variants, public.stock, public.reservations to authenticated;
grant update (name, description, kind, district, address, phone, whatsapp, instagram,
  working_hours, hold_hours, is_published, language) on public.shops to authenticated;
grant delete on public.products to authenticated;
grant update (quantity) on public.stock to authenticated;

create policy "members read their shop" on public.shops
  for select to authenticated using (private.is_member(id));
create policy "members edit their shop" on public.shops
  for update to authenticated using (private.is_member(id)) with check (private.is_member(id));

create policy "users read their own memberships" on public.shop_members
  for select to authenticated using (user_id = (select auth.uid()));

create policy "members read shop private data" on public.shop_private
  for select to authenticated using (private.is_member(shop_id));

create policy "members read their products" on public.products
  for select to authenticated using (private.is_member(shop_id));
create policy "members delete their products" on public.products
  for delete to authenticated using (private.is_member(shop_id));

create policy "members read their variants" on public.product_variants
  for select to authenticated using (private.is_member(shop_id));

create policy "members read their stock" on public.stock
  for select to authenticated using (private.is_member(shop_id));
create policy "members change their stock" on public.stock
  for update to authenticated using (private.is_member(shop_id)) with check (private.is_member(shop_id));

create policy "members read their reservations" on public.reservations
  for select to authenticated using (private.is_member(shop_id));

-- ---------- small triggers ----------
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger shops_touch before update on public.shops
  for each row execute function private.touch_updated_at();
create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();
create trigger reservations_touch before update on public.reservations
  for each row execute function private.touch_updated_at();

-- A seller changing stock by hand counts as "confirmed today".
-- Reservations change stock inside server functions and must not move the date.
create or replace function private.stock_confirm_on_seller_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then new.last_confirmed_at := now(); end if;
  return new;
end $$;
create trigger stock_confirm before update on public.stock
  for each row execute function private.stock_confirm_on_seller_edit();
