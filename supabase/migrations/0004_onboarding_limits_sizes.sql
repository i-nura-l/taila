-- 0004 (17 Nov 2026): fixes from the end-to-end review.
-- 1. Invite links, so the founder can set up a shop and hand it to its real owner.
-- 2. Up to 10 shops per account (was 3), for founder-led onboarding.
-- 3. Reservations: 20 per IP address per hour (was 6, which blocked testers on one Wi-Fi);
--    reservation codes no longer repeat among a shop's active reservations.
-- 4. Search: sizes grouped into clothes / shoes / kids, and only categories that have stock.
-- 5. Missing indexes on foreign keys (Supabase performance advisor).
-- 6. Shopper names and phones are wiped 90 days after a reservation (personal data law).

-- ---------- 1. invite links ----------
-- No table access for anyone: only the functions below read or write invites.
create table public.shop_invites (
  code text primary key default replace(gen_random_uuid()::text, '-', ''),
  shop_id uuid not null references public.shops(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid,
  used_at timestamptz
);
create index shop_invites_shop_idx on public.shop_invites(shop_id);
alter table public.shop_invites enable row level security;
revoke all on public.shop_invites from anon, authenticated;

-- A shop member makes a one-time link that is valid for 7 days.
create or replace function public.create_shop_invite(p_shop_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not private.is_member(p_shop_id) then raise exception 'forbidden'; end if;
  delete from public.shop_invites
  where shop_id = p_shop_id and (used_at is not null or expires_at < now());
  if (select count(*) from public.shop_invites where shop_id = p_shop_id) >= 5 then
    raise exception 'too_many';
  end if;
  insert into public.shop_invites(shop_id, created_by) values (p_shop_id, auth.uid())
  returning code into v_code;
  return v_code;
end $$;

-- The person who opens the link (signed in) becomes an owner of the shop.
create or replace function public.accept_shop_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  i public.shop_invites;
  s public.shops;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into i from public.shop_invites where code = trim(coalesce(p_code, '')) for update;
  if not found or i.used_at is not null or i.expires_at < now() then raise exception 'bad_invite'; end if;
  select * into s from public.shops where id = i.shop_id;
  if not exists (select 1 from public.shop_members where shop_id = i.shop_id and user_id = v_uid) then
    if (select count(*) from public.shop_members where user_id = v_uid) >= 10 then
      raise exception 'shop_limit';
    end if;
    insert into public.shop_members(shop_id, user_id, role) values (i.shop_id, v_uid, 'owner');
  end if;
  update public.shop_invites set used_by = v_uid, used_at = now() where code = i.code;
  return jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name);
end $$;

-- Leave a shop (for example the founder after handing it over). The last owner cannot leave.
create or replace function public.leave_shop(p_shop_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_member(p_shop_id) then raise exception 'forbidden'; end if;
  if (select count(*) from public.shop_members where shop_id = p_shop_id) <= 1 then
    raise exception 'last_owner';
  end if;
  delete from public.shop_members where shop_id = p_shop_id and user_id = auth.uid();
end $$;

-- How many people manage this shop (shown in the cabinet).
create or replace function public.shop_member_count(p_shop_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case when private.is_member(p_shop_id)
    then (select count(*)::int from public.shop_members where shop_id = p_shop_id) end;
$$;

-- ---------- 2. shop limit 10 ----------
create or replace function public.create_shop(
  p_name text, p_slug text, p_kind text default 'shop', p_district text default null,
  p_address text default null, p_phone text default null, p_instagram text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if (select count(*) from public.shop_members where user_id = v_uid) >= 10 then
    raise exception 'shop_limit';
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then raise exception 'bad_slug'; end if;
  if v_slug in ('shop','item','seller','admin','api','taila','login','search','about','help',
                'demo','www','app','my','reservations','privacy') then
    raise exception 'slug_taken';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 60 then raise exception 'bad_name'; end if;
  if coalesce(nullif(p_kind, ''), 'shop') not in ('shop','stall','sewing') then raise exception 'bad_kind'; end if;
  begin
    insert into public.shops(slug, name, kind, district, address, phone, whatsapp, instagram)
    values (v_slug, trim(p_name), coalesce(nullif(p_kind, ''), 'shop'),
            nullif(trim(p_district), ''), nullif(trim(p_address), ''),
            nullif(trim(p_phone), ''), nullif(trim(p_phone), ''),
            nullif(trim(both ' @' from p_instagram), ''))
    returning id into v_id;
  exception when unique_violation then raise exception 'slug_taken';
  end;
  insert into public.shop_members(shop_id, user_id, role) values (v_id, v_uid, 'owner');
  insert into public.shop_private(shop_id) values (v_id);
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end $$;

-- ---------- 3. reservations ----------
create or replace function public.reserve_item(
  p_variant_id uuid, p_name text, p_phone text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_phone text;
  v_ip text;
  v_iphash text;
  v_code text;
  v_try integer := 0;
  v record;
  v_shop public.shops;
  v_res public.reservations;
begin
  if char_length(v_name) not between 2 and 60 then raise exception 'bad_name'; end if;
  if char_length(v_digits) = 10 and left(v_digits, 1) = '0' then v_digits := '996' || substr(v_digits, 2); end if;
  if char_length(v_digits) = 9 then v_digits := '996' || v_digits; end if;
  if char_length(v_digits) not between 11 and 15 then raise exception 'bad_phone'; end if;
  v_phone := '+' || v_digits;

  perform private.expire_due();

  -- Light protection against someone emptying a shop's stock with fake holds.
  -- 20 an hour per address, so a group testing on one Wi-Fi is not blocked.
  begin
    v_ip := trim(split_part(coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1));
  exception when others then v_ip := '';
  end;
  if coalesce(v_ip, '') <> '' then
    v_iphash := md5(v_ip || ':taila');
    if (select count(*) from public.reservations
        where ip_hash = v_iphash and created_at > now() - interval '1 hour') >= 20 then
      raise exception 'too_many';
    end if;
  end if;
  if (select count(*) from public.reservations
      where customer_phone = v_phone and status in ('pending','confirmed')) >= 3 then
    raise exception 'too_many_active';
  end if;

  select pv.id as variant_id, pv.size, pv.color, p.id as product_id, p.title, p.price, p.shop_id
    into v
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  join public.shops s on s.id = p.shop_id
  where pv.id = p_variant_id and p.is_active and s.is_published;
  if not found then raise exception 'not_found'; end if;

  update public.stock set quantity = quantity - 1
  where variant_id = p_variant_id and quantity >= 1;
  if not found then raise exception 'out_of_stock'; end if;

  select * into v_shop from public.shops where id = v.shop_id;

  -- A short code the shopper says in the shop; never the same as another active one there.
  loop
    v_code := 'T-' || (1000 + floor(random() * 9000))::int::text;
    exit when not exists (select 1 from public.reservations
      where shop_id = v.shop_id and code = v_code and status in ('pending','confirmed'));
    v_try := v_try + 1;
    if v_try >= 30 then v_code := 'T-' || (10000 + floor(random() * 90000))::int::text; exit; end if;
  end loop;

  insert into public.reservations(
    code, shop_id, product_id, variant_id, product_title, size, color, price,
    customer_name, customer_phone, note, expires_at, ip_hash)
  values (
    v_code, v.shop_id, v.product_id, v.variant_id, v.title, v.size, v.color, v.price,
    v_name, v_phone, nullif(left(trim(coalesce(p_note, '')), 200), ''),
    now() + make_interval(hours => v_shop.hold_hours), v_iphash)
  returning * into v_res;

  return jsonb_build_object(
    'token', v_res.token, 'code', v_res.code, 'status', v_res.status,
    'expires_at', v_res.expires_at, 'created_at', v_res.created_at,
    'title', v_res.product_title, 'size', v_res.size, 'color', v_res.color,
    'price', v_res.price, 'product_id', v_res.product_id,
    'shop', private.shop_public(v_shop));
end $$;

-- ---------- 4. search with size groups ----------
-- Shoe 40 and dress 40 are different things: the size picker groups sizes by kind.
create or replace function private.size_group(p_category text)
returns text language sql immutable set search_path = '' as $$
  select case p_category when 'shoes' then 'shoes' when 'kids' then 'kids' else 'clothes' end;
$$;

drop function if exists public.search_items(text, text, text, text, integer, integer);
create or replace function public.search_items(
  p_q text default '', p_size text default '', p_district text default '',
  p_category text default '', p_limit integer default 24, p_offset integer default 0,
  p_size_group text default '')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := left(trim(coalesce(p_q, '')), 60);
  v_like text;
  v_size text := upper(trim(coalesce(p_size, '')));
  v_group text := trim(coalesce(p_size_group, ''));
  v_district text := trim(coalesce(p_district, ''));
  v_category text := trim(coalesce(p_category, ''));
  v_tsq tsquery := null;
  v_items jsonb;
  v_facets jsonb := null;
begin
  p_limit := least(greatest(coalesce(p_limit, 24), 1), 48);
  p_offset := greatest(coalesce(p_offset, 0), 0);
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if v_q <> '' then v_tsq := websearch_to_tsquery('russian', v_q); end if;

  select coalesce(jsonb_agg(t.row_json), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
        'id', p.id, 'title', p.title, 'price', p.price, 'old_price', p.old_price,
        'photo', p.photos[1], 'shop_name', s.name, 'shop_slug', s.slug, 'district', s.district,
        'sizes', (select coalesce(jsonb_agg(distinct v.size), '[]'::jsonb)
                  from public.product_variants v join public.stock st on st.variant_id = v.id
                  where v.product_id = p.id and st.quantity > 0)) as row_json
    from public.products p
    join public.shops s on s.id = p.shop_id
    where p.is_active and s.is_published
      and exists (select 1 from public.product_variants v
                  join public.stock st on st.variant_id = v.id
                  where v.product_id = p.id and st.quantity > 0
                    and (v_size = '' or v.size = v_size))
      and (v_group = '' or private.size_group(p.category) = v_group)
      and (v_district = '' or s.district = v_district)
      and (v_category = '' or p.category = v_category)
      and (v_q = '' or p.search @@ v_tsq or p.title ilike v_like or s.name ilike v_like
           or extensions.word_similarity(v_q, p.title) > 0.45)
    order by (case when v_q = '' then 0
                   else ts_rank(p.search, v_tsq) + extensions.word_similarity(v_q, p.title) end) desc,
             p.created_at desc
    limit p_limit offset p_offset
  ) t;

  if p_offset = 0 then
    v_facets := jsonb_build_object(
      'sizes', (
        select coalesce(jsonb_agg(z.size), '[]'::jsonb) from (
          select v.size, count(*) as n
          from public.product_variants v
          join public.stock st on st.variant_id = v.id
          join public.products p on p.id = v.product_id
          join public.shops s on s.id = p.shop_id
          where st.quantity > 0 and p.is_active and s.is_published
          group by v.size order by n desc, v.size limit 24) z),
      -- {"clothes": [...], "shoes": [...], "kids": [...]}: only groups that have stock.
      'size_groups', (
        select coalesce(jsonb_object_agg(g.grp, g.sizes), '{}'::jsonb) from (
          select z.grp, jsonb_agg(z.size order by z.size) as sizes from (
            select distinct private.size_group(p.category) as grp, v.size
            from public.product_variants v
            join public.stock st on st.variant_id = v.id
            join public.products p on p.id = v.product_id
            join public.shops s on s.id = p.shop_id
            where st.quantity > 0 and p.is_active and s.is_published) z
          group by z.grp) g),
      'categories', (
        select coalesce(jsonb_agg(c.category), '[]'::jsonb) from (
          select distinct p.category from public.products p
          join public.shops s on s.id = p.shop_id
          where p.is_active and s.is_published
            and exists (select 1 from public.stock st join public.product_variants v on v.id = st.variant_id
                        where v.product_id = p.id and st.quantity > 0)) c),
      'districts', (
        select coalesce(jsonb_agg(d.district order by d.district), '[]'::jsonb) from (
          select distinct s.district from public.shops s
          where s.is_published and coalesce(s.district, '') <> ''
            and exists (select 1 from public.products p where p.shop_id = s.id and p.is_active)) d),
      'shops', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'slug', x.slug, 'name', x.name, 'district', x.district, 'kind', x.kind, 'count', x.n)
          order by x.n desc, x.name), '[]'::jsonb) from (
          select s.slug, s.name, s.district, s.kind,
                 (select count(*) from public.products p where p.shop_id = s.id and p.is_active) as n
          from public.shops s where s.is_published) x
        where x.n > 0));
  end if;

  return jsonb_build_object('items', v_items, 'facets', v_facets);
end $$;

-- ---------- 5. indexes on foreign keys ----------
create index if not exists product_variants_shop_idx on public.product_variants(shop_id);
create index if not exists reservations_product_idx on public.reservations(product_id);
create index if not exists reservations_variant_idx on public.reservations(variant_id);

-- ---------- 6. keep shopper data only as long as needed ----------
-- 90 days after a reservation, its name, phone, note and address hash are wiped.
-- The period is an assumption: confirm it in the privacy notice and with a lawyer.
create or replace function private.forget_old_shoppers()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.reservations
  set customer_name = '—', customer_phone = '—', note = null, ip_hash = null
  where created_at < now() - interval '90 days' and customer_phone <> '—'
    and status not in ('pending','confirmed');
  get diagnostics n = row_count;
  return n;
end $$;
select cron.schedule('taila-forget-old-shoppers', '17 3 * * *', 'select private.forget_old_shoppers()');

-- ---------- who may call what ----------
revoke execute on function
  public.create_shop_invite(uuid), public.accept_shop_invite(text), public.leave_shop(uuid),
  public.shop_member_count(uuid),
  public.search_items(text, text, text, text, integer, integer, text)
  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function public.search_items(text, text, text, text, integer, integer, text)
  to anon, authenticated;
grant execute on function
  public.create_shop_invite(uuid), public.accept_shop_invite(text), public.leave_shop(uuid),
  public.shop_member_count(uuid)
  to authenticated;
grant execute on function private.is_member(uuid), private.is_member_text(text) to authenticated;
