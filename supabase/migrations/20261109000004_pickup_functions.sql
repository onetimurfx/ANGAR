-- Phase 6 / stage A4: server-side logic for pickup orders. Every function is SECURITY DEFINER and EXECUTE is granted
-- to service_role ONLY (Edge Functions). Errors: message = machine code, detail = JSON for the UI.
-- Money and stock rules live here, in single transactions; the Edge Functions only authenticate and translate.
--
-- Admin functions take the admin's Telegram id as an argument. That id is trusted ONLY because the Edge Function
-- takes it from the verified Telegram session; the database nevertheless re-checks it against `administrators`
-- (active row, role) on every call, so an id that is not an active admin can never do anything.

-- ---------------------------------------------------------------- helpers
create function public.pickup_require_admin(p_tg bigint, p_owner_only boolean default false) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role text;
begin
  select a.role into v_role from public.administrators a where a.telegram_id = p_tg and a.active;
  if not found then raise exception 'FORBIDDEN'; end if;
  if p_owner_only and v_role <> 'owner' then raise exception 'FORBIDDEN'; end if;
end $$;

-- 8 characters from a 32-symbol alphabet without 0/O/1/I (2^40 combinations). gen_random_uuid() is the
-- cryptographically secure generator that is available everywhere; only its fully random bytes are used
-- (bytes 6 and 8 carry the fixed version/variant bits and are skipped). 256 mod 32 = 0, so there is no modulo bias.
create function public.generate_pickup_code() returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c_bytes constant integer[] := array[0, 1, 2, 3, 4, 5, 10, 11];
  v_raw bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_code text := '';
  v_i integer;
begin
  foreach v_i in array c_bytes loop
    v_code := v_code || substr(c_alphabet, (get_byte(v_raw, v_i) % 32) + 1, 1);
  end loop;
  return v_code;
end $$;

-- The code is shown to the CUSTOMER only, and only while the order is ready for pickup. Admin views never contain it.
create function public.pickup_order_json(p_order uuid, p_view text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', o.id, 'orderNumber', o.order_number, 'status', o.status, 'createdAt', o.created_at,
    'pendingExpiresAt', case when o.status = 'pending' then o.pending_expires_at end,
    'readyAt', o.ready_at,
    'readyExpiresAt', case when o.status = 'ready_for_pickup' then o.ready_expires_at end,
    'completedAt', o.completed_at, 'closedAt', o.closed_at, 'closedReason', o.closed_reason, 'closeNote', o.close_note,
    'contact', jsonb_build_object('name', o.contact_name, 'phone', o.contact_phone, 'comment', o.contact_comment),
    'subtotal', o.subtotal, 'total', o.total,
    'payment', jsonb_build_object('status', o.payment_status, 'method', o.payment_method, 'paidAt', o.paid_at),
    'pickupCode', case when p_view = 'customer' and o.status = 'ready_for_pickup' then o.pickup_code end,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'productId', i.product_id, 'name', i.name, 'brand', i.brand_name, 'categoryId', i.category_id,
        'size', i.size, 'color', i.color_name, 'colorHex', i.color_hex, 'qty', i.qty, 'unitPrice', i.unit_price)
        order by i.name, i.size, i.color_name) from public.pickup_order_items i where i.order_id = o.id), '[]'::jsonb))
  from public.pickup_orders o where o.id = p_order;
$$;

create function public.pickup_log(p_order uuid, p_kind text, p_status public.pickup_status, p_role text, p_tg bigint,
                                  p_amount bigint default null, p_note text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.pickup_status_history (order_id, kind, status, actor_role, actor_telegram_id, amount, payment_method, note)
  values (p_order, p_kind, p_status, p_role, p_tg, p_amount,
          case when p_kind = 'payment' then 'pay_at_store'::public.pickup_payment_method end, p_note);
$$;

create function public.pickup_settle_reservations(p_order uuid, p_to public.reservation_status) returns integer
language sql security definer set search_path = public, pg_temp as $$
  with s as (
    update public.stock_reservations r set status = p_to, expires_at = null, settled_at = now()
    where r.order_id = p_order and r.status = 'active' returning 1)
  select count(*)::integer from s;
$$;

create function public.pickup_queue(p_order uuid, p_event text, p_admins boolean, p_customer boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_admins then
    insert into public.pickup_outbox (kind, event, pickup_order_id, chat_id)
    select 'pickup_admin', p_event, p_order, a.telegram_id from public.administrators a where a.active;
  end if;
  if p_customer then
    insert into public.pickup_outbox (kind, event, pickup_order_id, chat_id)
    select 'pickup_customer', p_event, p_order, c.telegram_id
    from public.pickup_orders o join public.customers c on c.id = o.customer_id where o.id = p_order;
  end if;
end $$;

-- ---------------------------------------------------------------- customer: place an order
create function public.place_pickup_order(p_customer uuid, p_key uuid, p_name text, p_phone text, p_comment text,
                                          p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing uuid;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_national text;
  v_phone text;
  v_bad text[] := '{}';
  v_lines jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_settings public.pickup_settings%rowtype;
  v_shop public.settings%rowtype;
  v_subtotal bigint := 0;
  v_order uuid := gen_random_uuid();
  v_number text;
  v_line record;
  v_tg bigint;
  v_item jsonb;
  v_expires timestamptz;
begin
  if p_customer is null or p_key is null then raise exception 'INVALID_REQUEST'; end if;

  -- a retry with the same key waits for the first call and returns ITS order
  perform pg_advisory_xact_lock(hashtextextended('pickup:' || p_customer::text || ':' || p_key::text, 0));
  select id into v_existing from public.pickup_orders where customer_id = p_customer and idempotency_key = p_key;
  if found then
    return jsonb_build_object('duplicate', true, 'order', public.pickup_order_json(v_existing, 'customer'));
  end if;

  select telegram_id into v_tg from public.customers where id = p_customer;
  if not found then raise exception 'UNKNOWN_CUSTOMER'; end if;

  -- one customer cannot race past the limits with parallel requests
  perform pg_advisory_xact_lock(hashtextextended('pickup-customer:' || p_customer::text, 0));
  select * into v_settings from public.pickup_settings limit 1;
  select * into v_shop from public.settings limit 1;

  if (select count(*) from public.pickup_orders where customer_id = p_customer and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'RATE_LIMITED';
  end if;
  if (select count(*) from public.pickup_orders where customer_id = p_customer
        and status in ('pending', 'preparing', 'ready_for_pickup')) >= v_settings.max_active_per_customer then
    raise exception 'ACTIVE_LIMIT' using detail = jsonb_build_object('max', v_settings.max_active_per_customer)::text;
  end if;

  -- contact: no address, no delivery (store pickup only)
  if length(v_name) < 2 or length(v_name) > 60 or v_name !~ '[[:alpha:]]' or v_name ~ '[<>]' then v_bad := array_append(v_bad, 'name'); end if;
  if length(v_digits) = 12 and left(v_digits, 3) = '998' then v_national := substr(v_digits, 4);
  elsif length(v_digits) = 9 then v_national := v_digits; end if;
  if v_national is null or left(v_national, 1) = '0' then v_bad := array_append(v_bad, 'phone'); else v_phone := '+998' || v_national; end if;
  if v_comment is not null and length(v_comment) > 300 then v_bad := array_append(v_bad, 'comment'); end if;
  if array_length(v_bad, 1) > 0 then
    raise exception 'INVALID_CONTACT' using detail = jsonb_build_object('fields', to_jsonb(v_bad))::text;
  end if;

  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_ORDER'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'INVALID_ITEM'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
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
  if jsonb_array_length(v_lines) > v_settings.max_lines then
    raise exception 'TOO_MANY_LINES' using detail = jsonb_build_object('max', v_settings.max_lines)::text;
  end if;
  if exists (select 1 from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int) where l.qty > 99) then
    raise exception 'INVALID_ITEM';
  end if;

  -- Lock the stock rows of every ordered variant, always in id order (same order as the Cart's place_order, so the
  -- two flows can never deadlock). Reservations are only ever written while this lock is held, so the
  -- "available" figure read below cannot change under us.
  perform 1
  from public.inventory i
  join public.product_variants v on v.id = i.variant_id
  join jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
    on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col
  order by i.variant_id
  for update of i;

  for v_line in
    select l.pid, l.sz, l.col, l.qty as want, v.id as variant_id, v.active as v_active,
           p.name, p.price, p.is_sample, p.active as p_active,
           greatest(0, coalesce(i.quantity, 0) - public.reserved_qty(v.id)) as have
    from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
    left join public.product_variants v on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col
    left join public.products p on p.id = l.pid
    left join public.inventory i on i.variant_id = v.id
    order by v.id nulls last, l.pid
  loop
    if v_line.variant_id is null or not v_line.v_active or not v_line.p_active then
      v_issues := v_issues || jsonb_build_object('productId', v_line.pid, 'size', v_line.sz, 'color', v_line.col,
                  'name', v_line.name, 'reason', 'unavailable', 'requested', v_line.want, 'available', 0);
    elsif v_line.is_sample and not v_shop.allow_sample_orders then
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

  v_number := 'PU-' || to_char(now() at time zone 'Asia/Tashkent', 'YYMMDD') || '-' ||
              lpad(nextval('public.pickup_number_seq')::text, 5, '0');
  v_expires := now() + make_interval(mins => v_settings.pending_timeout_minutes);

  insert into public.pickup_orders (id, order_number, customer_id, idempotency_key, contact_name, contact_phone,
                                    contact_comment, subtotal, total, pending_expires_at)
  values (v_order, v_number, p_customer, p_key, v_name, v_phone, v_comment, v_subtotal, v_subtotal, v_expires);

  insert into public.pickup_order_items (order_id, product_id, variant_id, name, brand_name, category_id, size, color_name,
                                         color_hex, unit_price, qty)
  select v_order, p.id, v.id, p.name, b.name, p.category_id, v.size, v.color_name, v.color_hex, p.price, l.qty
  from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
  join public.product_variants v on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col
  join public.products p on p.id = l.pid
  join public.brands b on b.id = p.brand_id;

  -- reservation: pending = 30 minutes (pickup_settings). The physical stock (inventory) is NOT touched here.
  insert into public.stock_reservations (order_id, variant_id, qty, expires_at)
  select v_order, v.id, l.qty, v_expires
  from jsonb_to_recordset(v_lines) as l(pid text, sz text, col text, qty int)
  join public.product_variants v on v.product_id = l.pid and v.size = l.sz and v.color_name = l.col;

  perform public.pickup_log(v_order, 'status', 'pending', 'customer', v_tg);
  update public.customers set phone = v_phone where id = p_customer;
  perform public.pickup_queue(v_order, 'new', true, true);

  return jsonb_build_object('duplicate', false, 'order', public.pickup_order_json(v_order, 'customer'));
end $$;

-- ---------------------------------------------------------------- customer: read / cancel
create function public.my_pickup_orders(p_customer uuid, p_limit integer default 30) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.pickup_order_json(o.id, 'customer') order by o.created_at desc), '[]'::jsonb)
  from (select id, created_at from public.pickup_orders where customer_id = p_customer
        order by created_at desc limit least(greatest(p_limit, 1), 100)) o;
$$;

-- another customer's id gets the same NOT_FOUND as a missing id: existence is never revealed
create function public.get_pickup_order(p_customer uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.pickup_orders where id = p_id and customer_id = p_customer) then raise exception 'NOT_FOUND'; end if;
  return public.pickup_order_json(p_id, 'customer');
end $$;

-- the customer may cancel only while the order is still `pending` (the store has not accepted it)
create function public.cancel_pickup_order_customer(p_customer uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.pickup_orders%rowtype; v_tg bigint;
begin
  select * into o from public.pickup_orders where id = p_id and customer_id = p_customer for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if o.status = 'cancelled' and o.closed_reason = 'customer_cancelled' then
    return public.pickup_order_json(o.id, 'customer'); -- repeated tap: already done
  end if;
  if o.status <> 'pending' then
    raise exception 'NOT_CANCELLABLE' using detail = jsonb_build_object('status', o.status)::text;
  end if;
  update public.pickup_orders set status = 'cancelled', closed_reason = 'customer_cancelled', closed_at = now(), updated_at = now()
   where id = o.id;
  perform public.pickup_settle_reservations(o.id, 'released');
  select telegram_id into v_tg from public.customers where id = p_customer;
  perform public.pickup_log(o.id, 'status', 'cancelled', 'customer', v_tg);
  perform public.pickup_queue(o.id, 'cancelled', true, false);
  return public.pickup_order_json(o.id, 'customer');
end $$;

-- ---------------------------------------------------------------- admin: read
create function public.admin_list_pickup(p_admin bigint, p_group text default 'active', p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_orders jsonb; v_hb public.job_heartbeats%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  if p_group not in ('active', 'pending', 'preparing', 'ready', 'history') then raise exception 'INVALID_REQUEST'; end if;
  select * into v_hb from public.job_heartbeats where job_name = 'pickup-sweep';
  select coalesce(jsonb_agg(public.pickup_order_json(x.id, 'admin') order by
           case when p_group = 'history' then null else x.created_at end asc,
           case when p_group = 'history' then x.created_at end desc), '[]'::jsonb)
    into v_orders
  from (select id, created_at from public.pickup_orders o
        where case p_group
                when 'active' then o.status in ('pending', 'preparing', 'ready_for_pickup')
                when 'pending' then o.status = 'pending'
                when 'preparing' then o.status = 'preparing'
                when 'ready' then o.status = 'ready_for_pickup'
                else o.status in ('completed', 'cancelled', 'expired') end
        order by case when p_group = 'history' then null else o.created_at end asc,
                 case when p_group = 'history' then o.created_at end desc
        limit least(greatest(p_limit, 1), 200)) x;
  return jsonb_build_object(
    'orders', v_orders,
    'counts', jsonb_build_object(
      'pending', (select count(*) from public.pickup_orders where status = 'pending'),
      'preparing', (select count(*) from public.pickup_orders where status = 'preparing'),
      'ready', (select count(*) from public.pickup_orders where status = 'ready_for_pickup')),
    'sweep', jsonb_build_object('lastRunAt', v_hb.last_run_at, 'lastOkAt', v_hb.last_ok_at));
end $$;

create function public.admin_get_pickup(p_admin bigint, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.pickup_require_admin(p_admin);
  if not exists (select 1 from public.pickup_orders where id = p_id) then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('order', public.pickup_order_json(p_id, 'admin'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('kind', h.kind, 'status', h.status, 'actorRole', h.actor_role,
                'actorTelegramId', h.actor_telegram_id, 'amount', h.amount, 'note', h.note, 'at', h.created_at) order by h.id)
              from public.pickup_status_history h where h.order_id = p_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- admin: transitions
-- pending -> preparing. Reservation: expires_at becomes NULL (a preparing order is never auto-cancelled).
create function public.admin_start_preparing(p_admin bigint, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.pickup_orders%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  select * into o from public.pickup_orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if o.status <> 'pending' then
    raise exception 'INVALID_TRANSITION' using detail = jsonb_build_object('status', o.status)::text;
  end if;
  -- time is up: the sweeper will close it (and the stock is already free). Refuse to accept it.
  if o.pending_expires_at <= now() then raise exception 'EXPIRED'; end if;
  update public.pickup_orders set status = 'preparing', pending_expires_at = null, updated_at = now() where id = o.id;
  update public.stock_reservations set expires_at = null where order_id = o.id and status = 'active';
  perform public.pickup_log(o.id, 'status', 'preparing', 'admin', p_admin);
  perform public.pickup_queue(o.id, 'preparing', false, true);
  return public.pickup_order_json(o.id, 'admin');
end $$;

-- preparing -> ready_for_pickup. Creates the one-time code; reservation expires_at = now + ready_hold_hours.
create function public.admin_mark_ready(p_admin bigint, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.pickup_orders%rowtype; v_hold integer; v_code text; v_until timestamptz; v_try integer;
begin
  perform public.pickup_require_admin(p_admin);
  select * into o from public.pickup_orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if o.status <> 'preparing' then
    raise exception 'INVALID_TRANSITION' using detail = jsonb_build_object('status', o.status)::text;
  end if;
  select ready_hold_hours into v_hold from public.pickup_settings limit 1;
  v_until := now() + make_interval(hours => v_hold);
  for v_try in 1..8 loop
    v_code := public.generate_pickup_code();
    begin
      update public.pickup_orders
         set status = 'ready_for_pickup', pickup_code = v_code, ready_at = now(), ready_expires_at = v_until, updated_at = now()
       where id = o.id;
      exit;
    exception when unique_violation then
      v_code := null; -- another order already has this code: draw again
    end;
  end loop;
  if v_code is null then raise exception 'CODE_GENERATION_FAILED'; end if;
  update public.stock_reservations set expires_at = v_until where order_id = o.id and status = 'active';
  perform public.pickup_log(o.id, 'status', 'ready_for_pickup', 'admin', p_admin);
  perform public.pickup_queue(o.id, 'ready', false, true);
  return public.pickup_order_json(o.id, 'admin');
end $$;

-- pending / preparing / ready -> cancelled, with a mandatory reason. Reservations are released.
create function public.admin_cancel_pickup(p_admin bigint, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.pickup_orders%rowtype; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public.pickup_require_admin(p_admin);
  if length(v_reason) < 3 or length(v_reason) > 300 then raise exception 'INVALID_REASON'; end if;
  select * into o from public.pickup_orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if o.status not in ('pending', 'preparing', 'ready_for_pickup') then
    raise exception 'NOT_CANCELLABLE' using detail = jsonb_build_object('status', o.status)::text;
  end if;
  update public.pickup_orders
     set status = 'cancelled', closed_reason = 'admin_cancelled', close_note = v_reason, closed_at = now(), updated_at = now()
   where id = o.id;
  perform public.pickup_settle_reservations(o.id, 'released');
  perform public.pickup_log(o.id, 'status', 'cancelled', 'admin', p_admin, null, v_reason);
  perform public.pickup_queue(o.id, 'cancelled', false, true);
  return public.pickup_order_json(o.id, 'admin');
end $$;

-- ready_for_pickup -> completed. ONE transaction does all of: check the code, check that the admin explicitly
-- confirmed receiving exactly the order total, record the payment, take the pieces out of inventory, consume the
-- reservations, close the order. Any failure leaves everything untouched.
-- A wrong code is an expected outcome that must be LOGGED (rate limiting), so it is returned, not raised.
-- payment_confirmed is only an ADMIN's assertion that the money was received; the database cannot see the
-- money. What it guarantees is that the assertion is explicit, tied to this admin and amount, and stored.
create function public.admin_complete_pickup(p_admin bigint, p_id uuid, p_code text, p_payment_confirmed boolean,
                                             p_amount bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.pickup_orders%rowtype;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_found boolean;
begin
  perform public.pickup_require_admin(p_admin);

  if (select count(*) from public.pickup_code_attempts
       where admin_telegram_id = p_admin and not ok and created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  end if;

  if p_id is not null then
    select * into o from public.pickup_orders where id = p_id for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    if o.status <> 'ready_for_pickup' then
      raise exception 'NOT_READY' using detail = jsonb_build_object('status', o.status)::text;
    end if;
  else
    -- find by code among READY orders only
    select * into o from public.pickup_orders where pickup_code = v_code and status = 'ready_for_pickup' for update;
    v_found := found;
    if not v_found then
      insert into public.pickup_code_attempts (admin_telegram_id, order_id, ok) values (p_admin, null, false);
      return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
    end if;
  end if;

  if o.ready_expires_at <= now() then raise exception 'EXPIRED'; end if;

  -- plain <> would let NULL through: compare NULL-safely
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' or o.pickup_code is distinct from v_code then
    insert into public.pickup_code_attempts (admin_telegram_id, order_id, ok) values (p_admin, o.id, false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  if p_payment_confirmed is not true then raise exception 'PAYMENT_REQUIRED'; end if;
  if p_amount is distinct from o.total then
    raise exception 'AMOUNT_MISMATCH' using detail = jsonb_build_object('expected', o.total)::text;
  end if;

  -- inventory rows in id order (same order as every other flow), then take the reserved pieces out
  perform 1 from public.inventory i
   where i.variant_id in (select variant_id from public.stock_reservations where order_id = o.id and status = 'active')
   order by i.variant_id for update;
  update public.inventory i set quantity = i.quantity - r.qty, updated_at = now()
    from public.stock_reservations r
   where r.order_id = o.id and r.status = 'active' and i.variant_id = r.variant_id;
  perform public.pickup_settle_reservations(o.id, 'consumed');

  update public.pickup_orders
     set status = 'completed', completed_at = now(), payment_status = 'paid', payment_method = 'pay_at_store',
         paid_at = now(), updated_at = now()
   where id = o.id;

  perform public.pickup_log(o.id, 'payment', 'completed', 'admin', p_admin, p_amount);
  perform public.pickup_log(o.id, 'status', 'completed', 'admin', p_admin);
  insert into public.pickup_code_attempts (admin_telegram_id, order_id, ok) values (p_admin, o.id, true);
  perform public.pickup_queue(o.id, 'completed', false, true);
  return jsonb_build_object('ok', true, 'order', public.pickup_order_json(o.id, 'admin'));
end $$;

-- ---------------------------------------------------------------- scheduler (pickup-sweep)
-- pending past its deadline (admin never accepted) and ready past its deadline -> expired; reservations released.
-- Rows locked by an admin action right now are skipped (SKIP LOCKED): whoever has the row wins, the sweeper retries
-- on its next run.
create function public.sweep_pickup() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_pending integer := 0; v_ready integer := 0; v_res jsonb;
begin
  for r in select id from public.pickup_orders where status = 'pending' and pending_expires_at <= now()
           order by pending_expires_at limit 200 for update skip locked loop
    update public.pickup_orders set status = 'expired', closed_reason = 'pending_timeout', closed_at = now(), updated_at = now()
     where id = r.id;
    perform public.pickup_settle_reservations(r.id, 'released');
    perform public.pickup_log(r.id, 'status', 'expired', 'system', null);
    perform public.pickup_queue(r.id, 'expired', false, true);
    v_pending := v_pending + 1;
  end loop;
  for r in select id from public.pickup_orders where status = 'ready_for_pickup' and ready_expires_at <= now()
           order by ready_expires_at limit 200 for update skip locked loop
    update public.pickup_orders set status = 'expired', closed_reason = 'pickup_timeout', closed_at = now(), updated_at = now()
     where id = r.id;
    perform public.pickup_settle_reservations(r.id, 'released');
    perform public.pickup_log(r.id, 'status', 'expired', 'system', null);
    perform public.pickup_queue(r.id, 'expired', false, true);
    v_ready := v_ready + 1;
  end loop;
  v_res := jsonb_build_object('expiredPending', v_pending, 'expiredReady', v_ready);
  insert into public.job_heartbeats (job_name, last_run_at, last_ok_at, last_result)
  values ('pickup-sweep', now(), now(), v_res)
  on conflict (job_name) do update set last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at, last_result = excluded.last_result;
  return v_res;
end $$;

-- ---------------------------------------------------------------- bot outbox for pickup orders
create function public.claim_pickup_outbox(p_limit integer default 20) returns setof public.pickup_outbox
language sql security definer set search_path = public, pg_temp as $$
  update public.pickup_outbox n
     set attempts = n.attempts + 1,
         next_attempt_at = now() + (interval '1 minute' * power(2, least(n.attempts, 6)))
   where n.id in (select id from public.pickup_outbox
                  where status = 'pending' and next_attempt_at <= now()
                  order by id limit least(greatest(p_limit, 1), 100) for update skip locked)
  returning n.*;
$$;

create function public.finish_pickup_outbox(p_id bigint, p_ok boolean, p_error text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.pickup_outbox
     set status = case when p_ok then 'sent' when attempts >= 6 then 'failed' else 'pending' end,
         sent_at = case when p_ok then now() end,
         last_error = case when p_ok then null else left(p_error, 500) end
   where id = p_id;
$$;

-- ---------------------------------------------------------------- privileges: nothing here is callable by the browser
revoke all on function
  public.pickup_require_admin(bigint, boolean), public.generate_pickup_code(), public.pickup_order_json(uuid, text),
  public.pickup_log(uuid, text, public.pickup_status, text, bigint, bigint, text),
  public.pickup_settle_reservations(uuid, public.reservation_status), public.pickup_queue(uuid, text, boolean, boolean),
  public.place_pickup_order(uuid, uuid, text, text, text, jsonb), public.my_pickup_orders(uuid, integer),
  public.get_pickup_order(uuid, uuid), public.cancel_pickup_order_customer(uuid, uuid),
  public.admin_list_pickup(bigint, text, integer), public.admin_get_pickup(bigint, uuid),
  public.admin_start_preparing(bigint, uuid), public.admin_mark_ready(bigint, uuid),
  public.admin_cancel_pickup(bigint, uuid, text), public.admin_complete_pickup(bigint, uuid, text, boolean, bigint),
  public.sweep_pickup(), public.claim_pickup_outbox(integer), public.finish_pickup_outbox(bigint, boolean, text)
  from public, anon, authenticated;
grant execute on function
  public.pickup_require_admin(bigint, boolean), public.generate_pickup_code(), public.pickup_order_json(uuid, text),
  public.pickup_log(uuid, text, public.pickup_status, text, bigint, bigint, text),
  public.pickup_settle_reservations(uuid, public.reservation_status), public.pickup_queue(uuid, text, boolean, boolean),
  public.place_pickup_order(uuid, uuid, text, text, text, jsonb), public.my_pickup_orders(uuid, integer),
  public.get_pickup_order(uuid, uuid), public.cancel_pickup_order_customer(uuid, uuid),
  public.admin_list_pickup(bigint, text, integer), public.admin_get_pickup(bigint, uuid),
  public.admin_start_preparing(bigint, uuid), public.admin_mark_ready(bigint, uuid),
  public.admin_cancel_pickup(bigint, uuid, text), public.admin_complete_pickup(bigint, uuid, text, boolean, bigint),
  public.sweep_pickup(), public.claim_pickup_outbox(integer), public.finish_pickup_outbox(bigint, boolean, text)
  to service_role;
