-- Photo storage (temporary home until Cloudflare R2 is connected).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 614400, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;

-- A seller may only write into the folder named after their own shop id.
create policy "members upload shop photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-photos' and private.is_member_text((storage.foldername(name))[1]));
create policy "members delete shop photos" on storage.objects for delete to authenticated
  using (bucket_id = 'product-photos' and private.is_member_text((storage.foldername(name))[1]));

-- Every 10 minutes: release holds that ran out of time.
create extension if not exists pg_cron;
select cron.schedule('taila-expire-reservations', '*/10 * * * *', 'select private.expire_due()');

-- Telegram alerts. Dormant until a bot token is stored in private.settings.
create extension if not exists pg_net with schema extensions;

create or replace function private.setting(p_key text)
returns text language sql stable security definer set search_path = '' as $$
  select value from private.settings where key = p_key;
$$;

create or replace function private.notify_new_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_token text := private.setting('telegram_bot_token');
  v_chat bigint;
begin
  if v_token is null then return new; end if;
  select telegram_chat_id into v_chat from public.shop_private where shop_id = new.shop_id;
  if v_chat is null then return new; end if;
  perform net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body := jsonb_build_object('chat_id', v_chat, 'text',
      'Новая бронь ' || new.code || E'\n' ||
      new.product_title || ', размер ' || new.size ||
      case when new.color <> '' then ', ' || new.color else '' end || E'\n' ||
      new.customer_name || ', ' || new.customer_phone || E'\n' ||
      'Отложите вещь и подтвердите: ' ||
      coalesce(private.setting('site_url'), 'https://taila.page') || '/seller/'),
    headers := jsonb_build_object('Content-Type', 'application/json'));
  return new;
exception when others then
  return new;  -- an alert problem must never block a reservation
end $$;

create trigger reservations_notify after insert on public.reservations
  for each row execute function private.notify_new_reservation();

-- Link a seller opens to connect the bot to their shop.
create or replace function public.telegram_connect_link(p_shop_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_bot text := private.setting('telegram_bot_username');
begin
  if not private.is_member(p_shop_id) then raise exception 'forbidden'; end if;
  if v_bot is null then return null; end if;
  return 'https://t.me/' || v_bot || '?start=' ||
    (select telegram_link_code from public.shop_private where shop_id = p_shop_id);
end $$;

-- Called only by the Telegram webhook (service role) when a seller presses Start.
create or replace function public.telegram_link(p_code text, p_chat_id bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare v_shop uuid;
begin
  update public.shop_private set telegram_chat_id = p_chat_id
  where telegram_link_code = p_code returning shop_id into v_shop;
  if v_shop is null then return null; end if;
  return (select name from public.shops where id = v_shop);
end $$;

revoke execute on function public.telegram_connect_link(uuid), public.telegram_link(text, bigint)
  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function public.telegram_connect_link(uuid) to authenticated;
grant execute on function public.telegram_link(text, bigint) to service_role;
grant execute on function private.is_member(uuid), private.is_member_text(text) to authenticated;
