-- Phase 6 / stage D: retire the old Quick Order path in the Cart's place_order.
-- Quick Order is store pickup now (place_pickup_order). place_order accepts source 'cart' only; 'quick' is refused with
-- QUICK_ORDER_MOVED. Nothing else changes: the body is the stage-A5 version (reservation guard included), so the Cart keeps
-- deducting inventory immediately and everything else behaves exactly as before.
-- Existing orders that were created with source 'quick' stay readable: the orders.source CHECK still allows the value.
-- Deploy note: apply together with the new front-end; the Phase 5 front-end sent 'quick' and would be refused.

create or replace function public.place_order(p_customer uuid, p_key uuid, p_source text, p_name text, p_phone text,
                                   p_address text, p_comment text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing uuid;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_address text := regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g');
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_national text;
  v_phone text;
  v_bad text[] := '{}';
  v_lines jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_settings public.settings%rowtype;
  v_subtotal bigint := 0;
  v_fee integer;
  v_pending boolean;
  v_total bigint;
  v_order uuid := gen_random_uuid();
  v_number text;
  v_line record;
  v_tg bigint;
  v_item jsonb;
begin
  if p_customer is null or p_key is null then raise exception 'INVALID_REQUEST'; end if;
  if p_source = 'quick' then raise exception 'QUICK_ORDER_MOVED'; end if; -- Quick Order is store pickup now (place_pickup_order)
  if p_source <> 'cart' then raise exception 'INVALID_REQUEST'; end if;

  -- serialize concurrent requests with the same (customer, key): the second one waits and returns the first order
  perform pg_advisory_xact_lock(hashtextextended(p_customer::text || ':' || p_key::text, 0));
  select id into v_existing from public.orders where customer_id = p_customer and idempotency_key = p_key;
  if found then return public.order_to_json(v_existing, true); end if;

  select telegram_id into v_tg from public.customers where id = p_customer;
  if not found then raise exception 'UNKNOWN_CUSTOMER'; end if;

  if (select count(*) from public.orders where customer_id = p_customer and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'RATE_LIMITED';
  end if;

  -- contact validation: same rules as the browser (src/lib/validation.ts), enforced again here
  if length(v_name) < 2 or length(v_name) > 60 or v_name !~ '[[:alpha:]]' or v_name ~ '[<>]' then v_bad := array_append(v_bad, 'name'); end if;
  if length(v_digits) = 12 and left(v_digits, 3) = '998' then v_national := substr(v_digits, 4);
  elsif length(v_digits) = 9 then v_national := v_digits; end if;
  if v_national is null or left(v_national, 1) = '0' then v_bad := array_append(v_bad, 'phone'); else v_phone := '+998' || v_national; end if;
  if length(v_address) < 8 or length(v_address) > 200 then v_bad := array_append(v_bad, 'address'); end if;
  if v_comment is not null and length(v_comment) > 300 then v_bad := array_append(v_bad, 'comment'); end if;
  if array_length(v_bad, 1) > 0 then
    raise exception 'INVALID_CONTACT' using detail = jsonb_build_object('fields', to_jsonb(v_bad))::text;
  end if;

  -- items: shape check, then merge duplicates of the same variant
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_ORDER'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'INVALID_ITEM'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    -- IS DISTINCT FROM: a missing key yields NULL, which must count as invalid (a plain <> would let it pass)
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item -> 'productId') is distinct from 'string'
       or jsonb_typeof(v_item -> 'size') is distinct from 'string'
       or jsonb_typeof(v_item -> 'color') is distinct from 'string'
       or jsonb_typeof(v_item -> 'qty') is distinct from 'number'
       or (v_item ->> 'qty') !~ '^[0-9]{1,3}$' or (v_item ->> 'qty')::int not between 1 and 99 then
      raise exception 'INVALID_ITEM';
    end if;
  end loop;
  select jsonb_agg(jsonb_build_object('pid', pid, 'sz', sz, 'col', col, 'qty', q))
    into v_lines
  from (select e ->> 'productId' as pid, e ->> 'size' as sz, e ->> 'color' as col, sum((e ->> 'qty')::int) as q
        from jsonb_array_elements(p_items) e group by 1, 2, 3) m;

  -- lock the stock rows of every ordered variant, always in id order
  perform 1
  from public.inventory i
  join public.product_variants v on v.id = i.variant_id
  join jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
    on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col
  order by i.variant_id
  for update of i;

  select * into v_settings from public.settings limit 1;

  for v_line in
    select l.pid, l.sz, l.col, l.qty as want, v.id as variant_id, v.color_hex, v.active as v_active,
           p.name, p.price, p.category_id, p.is_sample, p.active as p_active, b.name as brand_name,
           greatest(0, coalesce(i.quantity, 0) - public.reserved_qty(v.id)) as have
    from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
    left join public.product_variants v on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col
    left join public.products p on p.id = l.pid
    left join public.brands b on b.id = p.brand_id
    left join public.inventory i on i.variant_id = v.id
    order by v.id nulls last, l.pid
  loop
    if v_line.variant_id is null or not v_line.v_active or not v_line.p_active then
      v_issues := v_issues || jsonb_build_object('productId', v_line.pid, 'size', v_line.sz, 'color', v_line.col,
                  'name', v_line.name, 'reason', 'unavailable', 'requested', v_line.want, 'available', 0);
    elsif v_line.is_sample and not v_settings.allow_sample_orders then
      raise exception 'SAMPLE_PRODUCT' using detail = jsonb_build_object('productId', v_line.pid, 'name', v_line.name)::text;
    elsif v_line.want > v_line.have then
      v_issues := v_issues || jsonb_build_object('productId', v_line.pid, 'size', v_line.sz, 'color', v_line.col,
                  'name', v_line.name, 'reason', 'stock', 'requested', v_line.want, 'available', v_line.have);
    else
      v_subtotal := v_subtotal + v_line.price::bigint * v_line.want;
    end if;
  end loop;
  if jsonb_array_length(v_issues) > 0 then
    raise exception 'ITEMS_UNAVAILABLE' using detail = jsonb_build_object('issues', v_issues)::text;
  end if;

  -- delivery: only from settings. NULL fee = not configured = pending (the shop sets it later), never invented.
  v_pending := v_settings.delivery_fee is null;
  if v_pending then v_fee := null;
  elsif v_settings.delivery_free_from is not null and v_subtotal >= v_settings.delivery_free_from then v_fee := 0;
  else v_fee := v_settings.delivery_fee; end if;
  v_total := v_subtotal + coalesce(v_fee, 0);

  v_number := 'AYN-' || to_char(now() at time zone 'Asia/Tashkent', 'YYMMDD') || '-' ||
              lpad(nextval('public.order_number_seq')::text, 5, '0');

  insert into public.orders (id, order_number, customer_id, idempotency_key, source, contact_name, contact_phone,
                             contact_address, contact_comment, subtotal, delivery_fee, delivery_pending, total)
  values (v_order, v_number, p_customer, p_key, p_source, v_name, v_phone, v_address, v_comment,
          v_subtotal, v_fee, v_pending, v_total);

  insert into public.order_items (order_id, product_id, variant_id, name, brand_name, category_id, size, color_name,
                                  color_hex, unit_price, qty)
  select v_order, p.id, v.id, p.name, b.name, p.category_id, v.size, v.color_name, v.color_hex, p.price, l.qty
  from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
  join public.product_variants v on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col
  join public.products p on p.id = l.pid
  join public.brands b on b.id = p.brand_id;

  update public.inventory i set quantity = i.quantity - l.qty, updated_at = now()
  from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int), public.product_variants v
  where v.product_id = l.pid and v.size = l.sz and v.color_name = l.col and i.variant_id = v.id;

  insert into public.order_status_history (order_id, status) values (v_order, 'new');
  update public.customers set phone = v_phone where id = p_customer;
  if p_source = 'cart' then delete from public.cart_items where customer_id = p_customer; end if;

  insert into public.notification_outbox (kind, order_id, chat_id)
  select 'order_admin', v_order, a.telegram_id from public.administrators a where a.active;
  insert into public.notification_outbox (kind, order_id, chat_id) values ('order_customer', v_order, v_tg);

  return public.order_to_json(v_order, false);
end $$;

revoke all on function public.place_order(uuid, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, text, text, text, text, jsonb) to service_role;
