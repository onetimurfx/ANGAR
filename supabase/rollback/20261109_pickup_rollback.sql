-- ROLLBACK of Phase 6 / stage A (migrations 20261109000001..5). NOT run automatically: run it by hand in the SQL editor.
--
-- SAFETY: this script refuses to run (and changes nothing) while ANY pickup data exists: orders, items, reservations,
-- history, code attempts, queued bot messages, or store details typed into pickup_settings. Those are customer
-- records and money records. Export them first (Table Editor > Export, or pg_dump), then decide consciously.
-- It never deletes Cart orders, inventory, products or customers: it does not touch those tables at all.
--
-- What it does when the guard passes: restores the Phase 5 versions of get_catalog() and place_order(),
-- then drops the (empty) pickup tables, functions, types and the sequence.

begin;

do $guard$
begin
  if exists (select 1 from public.pickup_orders) or exists (select 1 from public.pickup_order_items)
     or exists (select 1 from public.stock_reservations) or exists (select 1 from public.pickup_status_history)
     or exists (select 1 from public.pickup_code_attempts) or exists (select 1 from public.pickup_outbox)
     or exists (select 1 from public.pickup_settings where store_address is not null or store_phone is not null or store_hours is not null)
  then
    raise exception 'ROLLBACK REFUSED: pickup data exists. Export it first; nothing was changed.';
  end if;
end
$guard$;

-- 1. Phase 5 behaviour back (verbatim copies of migration 20261106000003)
create or replace function public.get_catalog() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort_order, c.name)
                            from public.categories c), '[]'::jsonb),
    'brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'type', b.type) order by b.name)
                        from public.brands b), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'brandId', p.brand_id, 'categoryId', p.category_id,
        'description', p.description, 'price', p.price, 'oldPrice', p.old_price, 'type', p.type,
        'isNew', p.is_new, 'popularity', p.popularity, 'createdAt', p.created_at, 'sample', p.is_sample,
        'images', coalesce((select jsonb_agg(i.path order by i.sort_order, i.id)
                            from public.product_images i where i.product_id = p.id), '[]'::jsonb),
        'variants', coalesce((select jsonb_agg(jsonb_build_object(
                                'size', v.size, 'color', v.color_name, 'colorHex', v.color_hex,
                                'qty', coalesce(inv.quantity, 0)) order by v.sort_order, v.size, v.color_name)
                              from public.product_variants v
                              left join public.inventory inv on inv.variant_id = v.id
                              where v.product_id = p.id), '[]'::jsonb)
      ) order by p.created_at desc, p.id)
      from public.products p), '[]'::jsonb),
    'outfits', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'note', c.note, 'kind', c.kind,
        'productIds', coalesce((select jsonb_agg(ci.product_id order by ci.sort_order, ci.product_id)
                                from public.collection_items ci
                                join public.products p on p.id = ci.product_id
                                where ci.collection_id = c.id), '[]'::jsonb)) order by c.sort_order, c.title)
      from public.collections c), '[]'::jsonb),
    'banners', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'title', pr.title, 'subtitle', pr.subtitle,
                          'to', pr.link, 'tone', pr.tone) order by pr.sort_order, pr.title)
                         from public.promotions pr), '[]'::jsonb),
    'settings', coalesce((select jsonb_build_object(
        'deliveryConfigured', s.delivery_fee is not null,
        'deliveryFee', s.delivery_fee,
        'deliveryFreeFrom', s.delivery_free_from,
        'supportContact', s.support_contact)
      from public.settings s limit 1), '{}'::jsonb)
  );
$$;
revoke all on function public.get_catalog() from public;
grant execute on function public.get_catalog() to anon, authenticated, service_role;

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
  if p_source not in ('quick', 'cart') then raise exception 'INVALID_REQUEST'; end if;

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
           coalesce(i.quantity, 0) as have
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

-- 2. drop the pickup objects (all empty at this point)
drop function public.claim_pickup_outbox(integer), public.finish_pickup_outbox(bigint, boolean, text),
  public.sweep_pickup(), public.admin_complete_pickup(bigint, uuid, text, boolean, bigint),
  public.admin_cancel_pickup(bigint, uuid, text), public.admin_mark_ready(bigint, uuid),
  public.admin_start_preparing(bigint, uuid), public.admin_get_pickup(bigint, uuid),
  public.admin_list_pickup(bigint, text, integer), public.cancel_pickup_order_customer(uuid, uuid),
  public.get_pickup_order(uuid, uuid), public.my_pickup_orders(uuid, integer),
  public.place_pickup_order(uuid, uuid, text, text, text, jsonb), public.pickup_queue(uuid, text, boolean, boolean),
  public.pickup_settle_reservations(uuid, public.reservation_status),
  public.pickup_log(uuid, text, public.pickup_status, text, bigint, bigint, text),
  public.pickup_order_json(uuid, text), public.generate_pickup_code(), public.pickup_require_admin(bigint, boolean),
  public.available_qty(uuid), public.reserved_qty(uuid);

drop table public.pickup_outbox, public.pickup_code_attempts, public.pickup_status_history, public.stock_reservations,
  public.pickup_order_items, public.pickup_orders, public.pickup_settings, public.job_heartbeats;
drop sequence public.pickup_number_seq;
drop type public.reservation_status, public.pickup_payment_method, public.pickup_payment_status, public.pickup_status;

commit;
