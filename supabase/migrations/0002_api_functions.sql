-- TAILA API: every screen makes one call to one of these functions.
-- They run as the database owner (security definer), so each one checks
-- by itself what the caller is allowed to see or change.

-- ---------- helpers ----------
create or replace function private.shop_public(s public.shops)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'kind', s.kind, 'description', s.description,
    'city', s.city, 'district', s.district, 'address', s.address, 'phone', s.phone,
    'whatsapp', s.whatsapp, 'instagram', s.instagram, 'working_hours', s.working_hours,
    'currency', s.currency, 'hold_hours', s.hold_hours, 'is_demo', s.is_demo);
$$;

-- Shoppers see "in stock / last one", never the exact count (capped at 3).
create or replace function private.variants_public(p_product uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'size', v.size, 'color', v.color,
      'qty', least(st.quantity, 3), 'confirmed_at', st.last_confirmed_at)
    order by v.sort, v.size), '[]'::jsonb)
  from public.product_variants v
  join public.stock st on st.variant_id = v.id
  where v.product_id = p_product;
$$;

-- Give stock back for reservations whose hold time has passed.
create or replace function private.expire_due()
returns void language sql security definer set search_path = '' as $$
  with due as (
    update public.reservations set status = 'expired'
    where status in ('pending','confirmed') and expires_at < now()
    returning variant_id, quantity
  ), back as (
    select variant_id, sum(quantity)::int as q from due where variant_id is not null group by variant_id
  )
  update public.stock s set quantity = least(s.quantity + b.q, 9999)
  from back b where s.variant_id = b.variant_id;
$$;

-- ---------- public reads ----------
create or replace function public.get_shop_page(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'shop', private.shop_public(s),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'title', p.title, 'price', p.price, 'old_price', p.old_price,
          'category', p.category, 'photos', to_jsonb(p.photos),
          'variants', private.variants_public(p.id))
        order by p.created_at desc)
      from public.products p where p.shop_id = s.id and p.is_active), '[]'::jsonb))
  from public.shops s
  where s.slug = lower(trim(p_slug)) and s.is_published;
$$;

create or replace function public.get_item(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'product', jsonb_build_object(
      'id', p.id, 'title', p.title, 'description', p.description, 'price', p.price,
      'old_price', p.old_price, 'category', p.category, 'photos', to_jsonb(p.photos),
      'variants', private.variants_public(p.id)),
    'shop', private.shop_public(s))
  from public.products p
  join public.shops s on s.id = p.shop_id
  where p.id = p_id and p.is_active and s.is_published;
$$;

create or replace function public.search_items(
  p_q text default '', p_size text default '', p_district text default '',
  p_category text default '', p_limit integer default 24, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := left(trim(coalesce(p_q, '')), 60);
  v_like text;
  v_size text := upper(trim(coalesce(p_size, '')));
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

-- ---------- reserving ----------
-- One atomic step: take one piece out of stock and write the reservation.
-- The stock value never comes from the browser.
create or replace function public.reserve_item(
  p_variant_id uuid, p_name text, p_phone text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_phone text;
  v_ip text;
  v_iphash text;
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
  begin
    v_ip := trim(split_part(coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1));
  exception when others then v_ip := '';
  end;
  if coalesce(v_ip, '') <> '' then
    v_iphash := md5(v_ip || ':taila');
    if (select count(*) from public.reservations
        where ip_hash = v_iphash and created_at > now() - interval '1 hour') >= 6 then
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

  insert into public.reservations(
    code, shop_id, product_id, variant_id, product_title, size, color, price,
    customer_name, customer_phone, note, expires_at, ip_hash)
  values (
    'T-' || (1000 + floor(random() * 9000))::int::text,
    v.shop_id, v.product_id, v.variant_id, v.title, v.size, v.color, v.price,
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

-- A shopper has no account: the secret token saved in their phone is the key.
create or replace function public.my_reservations(p_tokens uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.expire_due();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
        'token', r.token, 'code', r.code, 'status', r.status, 'title', r.product_title,
        'size', r.size, 'color', r.color, 'price', r.price, 'expires_at', r.expires_at,
        'created_at', r.created_at, 'product_id', r.product_id,
        'photo', (select p.photos[1] from public.products p where p.id = r.product_id),
        'shop', private.shop_public(s))
      order by r.created_at desc), '[]'::jsonb)
    from public.reservations r
    join public.shops s on s.id = r.shop_id
    where r.token = any((coalesce(p_tokens, '{}'))[1:20]));
end $$;

create or replace function public.cancel_reservation(p_token uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare r public.reservations;
begin
  select * into r from public.reservations where token = p_token for update;
  if not found then raise exception 'not_found'; end if;
  if r.status not in ('pending','confirmed') then return r.status; end if;
  update public.reservations set status = 'cancelled' where id = r.id;
  update public.stock set quantity = least(quantity + r.quantity, 9999) where variant_id = r.variant_id;
  return 'cancelled';
end $$;

-- ---------- seller actions ----------
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
  if (select count(*) from public.shop_members where user_id = v_uid) >= 3 then
    raise exception 'shop_limit';
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then raise exception 'bad_slug'; end if;
  if v_slug in ('shop','item','seller','admin','api','taila','login','search','about','help',
                'demo','www','app','my','reservations') then
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

-- Create or update a product with all its sizes and stock in one call.
create or replace function public.save_product(p_shop_id uuid, p_product jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p_product ->> 'id', '')::uuid;
  v_is_demo boolean;
  v_photos text[];
  v_photo text;
  v jsonb;
  v_size text;
  v_color text;
  v_qty integer;
  v_vid uuid;
  v_keep uuid[] := '{}';
  v_sort integer := 0;
begin
  if not private.is_member(p_shop_id) then raise exception 'forbidden'; end if;
  select is_demo into v_is_demo from public.shops where id = p_shop_id;

  select coalesce(array_agg(x), '{}') into v_photos
  from jsonb_array_elements_text(coalesce(p_product -> 'photos', '[]'::jsonb)) x;
  foreach v_photo in array v_photos loop
    -- A photo must live in this shop's own folder.
    if not (v_photo ~ ('^' || p_shop_id::text || '/[A-Za-z0-9_.-]+$')
            or (v_is_demo and v_photo ~ '^demo/[a-z0-9_.-]+$')) then
      raise exception 'bad_photo';
    end if;
  end loop;

  if jsonb_typeof(p_product -> 'variants') is distinct from 'array'
     or jsonb_array_length(p_product -> 'variants') not between 1 and 30 then
    raise exception 'bad_variants';
  end if;

  if v_id is null then
    if (select count(*) from public.products where shop_id = p_shop_id) >= 300 then
      raise exception 'product_limit';
    end if;
    insert into public.products(shop_id, title, description, category, price, old_price, photos, is_active)
    values (p_shop_id, trim(p_product ->> 'title'), nullif(trim(p_product ->> 'description'), ''),
            coalesce(nullif(p_product ->> 'category', ''), 'other'),
            (p_product ->> 'price')::integer, nullif(p_product ->> 'old_price', '')::integer,
            v_photos, coalesce((p_product ->> 'is_active')::boolean, true))
    returning id into v_id;
  else
    update public.products set
      title = trim(p_product ->> 'title'),
      description = nullif(trim(p_product ->> 'description'), ''),
      category = coalesce(nullif(p_product ->> 'category', ''), 'other'),
      price = (p_product ->> 'price')::integer,
      old_price = nullif(p_product ->> 'old_price', '')::integer,
      photos = v_photos,
      is_active = coalesce((p_product ->> 'is_active')::boolean, true)
    where id = v_id and shop_id = p_shop_id;
    if not found then raise exception 'not_found'; end if;
  end if;

  for v in select * from jsonb_array_elements(p_product -> 'variants') loop
    v_size := upper(trim(coalesce(v ->> 'size', '')));
    v_color := trim(coalesce(v ->> 'color', ''));
    v_qty := least(greatest(coalesce((v ->> 'quantity')::integer, 0), 0), 9999);
    if v_size = '' then raise exception 'bad_variants'; end if;
    insert into public.product_variants(product_id, shop_id, size, color, sort)
    values (v_id, p_shop_id, v_size, v_color, v_sort)
    on conflict (product_id, size, color) do update set sort = excluded.sort
    returning id into v_vid;
    insert into public.stock(variant_id, shop_id, quantity, last_confirmed_at)
    values (v_vid, p_shop_id, v_qty, now())
    on conflict (variant_id) do update set quantity = excluded.quantity, last_confirmed_at = now();
    v_keep := v_keep || v_vid;
    v_sort := v_sort + 1;
  end loop;
  delete from public.product_variants where product_id = v_id and not (id = any(v_keep));
  return v_id;
end $$;

-- "Everything on the shelf is as listed" — one tap for the whole shop.
create or replace function public.confirm_stock(p_shop_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.is_member(p_shop_id) then raise exception 'forbidden'; end if;
  update public.stock set last_confirmed_at = now() where shop_id = p_shop_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.set_reservation_status(p_id uuid, p_status text)
returns text language plpgsql security definer set search_path = '' as $$
declare r public.reservations;
begin
  perform private.expire_due();
  select * into r from public.reservations where id = p_id for update;
  if not found or not private.is_member(r.shop_id) then raise exception 'not_found'; end if;
  if not ((r.status = 'pending' and p_status in ('confirmed','picked_up','cancelled'))
       or (r.status = 'confirmed' and p_status in ('picked_up','cancelled'))) then
    raise exception 'bad_transition';
  end if;
  update public.reservations set status = p_status where id = r.id;
  if p_status = 'cancelled' then
    update public.stock set quantity = least(quantity + r.quantity, 9999) where variant_id = r.variant_id;
  end if;
  return p_status;
end $$;

-- ---------- who may call what ----------
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  public.get_shop_page(text), public.get_item(uuid),
  public.search_items(text, text, text, text, integer, integer),
  public.reserve_item(uuid, text, text, text),
  public.my_reservations(uuid[]), public.cancel_reservation(uuid)
  to anon, authenticated;
grant execute on function
  public.create_shop(text, text, text, text, text, text, text),
  public.save_product(uuid, jsonb), public.confirm_stock(uuid),
  public.set_reservation_status(uuid, text)
  to authenticated;
grant execute on function private.is_member(uuid), private.is_member_text(text) to authenticated;
