-- Phase 6 / stage E: back end of the admin panel (/admin). ADDITIVE ONLY: two new tables, one new nullable column and new
-- functions. No existing table, constraint, function or policy is changed, so the Cart and Quick Order (pickup) keep working.
--
-- Trust model (same as stage D): every function is SECURITY DEFINER and EXECUTE is granted to service_role ONLY (Edge
-- Functions). The admin's Telegram id is an argument, trusted only because the Edge Function takes it from the verified
-- session; each function nevertheless re-checks it against `administrators` (active row, role) on its first line.
--   manager: orders, pickup, products, categories, brands, inventory, customers (read).
--   owner  : all of the above + settings, deleting categories, the "sample product" flag.
-- Administrators themselves are NOT managed from the panel (no function here writes `administrators`): a client can never
-- grant admin rights. Errors: message = machine code, detail = JSON for the UI. Every mutation writes admin_audit_log.

-- ---------------------------------------------------------------- additive schema
alter table public.order_status_history add column note text check (note is null or length(note) <= 300);

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_telegram_id bigint not null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

create table public.stock_adjustments (
  id bigint generated always as identity primary key,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  admin_telegram_id bigint not null,
  old_qty integer not null,
  new_qty integer not null check (new_qty >= 0),
  reason text check (reason is null or length(reason) <= 200),
  created_at timestamptz not null default now()
);
create index stock_adjustments_variant_idx on public.stock_adjustments (variant_id, created_at desc);

alter table public.admin_audit_log enable row level security;
alter table public.stock_adjustments enable row level security;
revoke all on public.admin_audit_log, public.stock_adjustments from anon, authenticated;
grant all on public.admin_audit_log, public.stock_adjustments to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------- helpers
create function public.admin_audit(p_admin bigint, p_action text, p_entity text, p_id text, p_details jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.admin_audit_log (admin_telegram_id, action, entity, entity_id, details)
  values (p_admin, p_action, p_entity, p_id, coalesce(p_details, '{}'::jsonb));
$$;

-- '%text%' with the LIKE metacharacters of the search text escaped
create function public.admin_like(p_q text) returns text
language sql immutable set search_path = pg_catalog as $$
  select '%' || replace(replace(replace(btrim(coalesce(p_q, '')), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
$$;

create function public.admin_me(p_admin bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.administrators%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  select * into a from public.administrators where telegram_id = p_admin;
  return jsonb_build_object('telegramId', a.telegram_id, 'name', a.name, 'role', a.role);
end $$;

-- ---------------------------------------------------------------- dashboard
create function public.admin_dashboard(p_admin bigint, p_low integer default 3) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';
  v_low integer := least(greatest(coalesce(p_low, 3), 1), 50);
begin
  perform public.pickup_require_admin(p_admin);
  return jsonb_build_object(
    'cart', jsonb_build_object(
      'new', (select count(*) from public.orders where status = 'new'),
      'confirmed', (select count(*) from public.orders where status = 'confirmed'),
      'preparing', (select count(*) from public.orders where status = 'preparing'),
      'shipped', (select count(*) from public.orders where status = 'shipped'),
      'deliveryPending', (select count(*) from public.orders where delivery_pending and status not in ('delivered', 'cancelled')),
      'today', (select count(*) from public.orders where created_at >= v_day and status <> 'cancelled'),
      'todayTotal', (select coalesce(sum(total), 0) from public.orders where created_at >= v_day and status <> 'cancelled')),
    'pickup', jsonb_build_object(
      'pending', (select count(*) from public.pickup_orders where status = 'pending'),
      'preparing', (select count(*) from public.pickup_orders where status = 'preparing'),
      'ready', (select count(*) from public.pickup_orders where status = 'ready_for_pickup'),
      'completedToday', (select count(*) from public.pickup_orders where status = 'completed' and completed_at >= v_day),
      'completedTodayTotal', (select coalesce(sum(total), 0) from public.pickup_orders where status = 'completed' and completed_at >= v_day)),
    'stock', jsonb_build_object(
      'threshold', v_low,
      'out', (select count(*) from public.product_variants v join public.products p on p.id = v.product_id
              where v.active and p.active and public.available_qty(v.id) = 0),
      'low', (select count(*) from public.product_variants v join public.products p on p.id = v.product_id
              where v.active and p.active and public.available_qty(v.id) between 1 and v_low)),
    'catalog', jsonb_build_object(
      'active', (select count(*) from public.products where active),
      'inactive', (select count(*) from public.products where not active),
      'samples', (select count(*) from public.products where is_sample and active)),
    'customers', jsonb_build_object(
      'total', (select count(*) from public.customers),
      'newToday', (select count(*) from public.customers where created_at >= v_day)),
    'recentOrders', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'orderNumber', r.order_number, 'status', r.status,
        'source', r.source, 'createdAt', r.created_at, 'contactName', r.contact_name, 'total', r.total) order by r.created_at desc)
      from (select * from public.orders order by created_at desc limit 5) r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- Cart orders (table `orders`; source 'cart', or the retired 'quick')
create function public.admin_list_orders(p_admin bigint, p_status text default null, p_source text default null,
                                         p_q text default null, p_limit integer default 30, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_digits text;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb; v_total integer; v_counts jsonb;
begin
  perform public.pickup_require_admin(p_admin);
  if p_status is not null and p_status not in ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled') then raise exception 'INVALID_REQUEST'; end if;
  if p_source is not null and p_source not in ('cart', 'quick') then raise exception 'INVALID_REQUEST'; end if;
  if v_q is not null and length(v_q) > 100 then raise exception 'INVALID_REQUEST'; end if;
  v_like := case when v_q is null then null else public.admin_like(v_q) end;
  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');

  select count(*) into v_total from public.orders o
   where (p_status is null or o.status::text = p_status) and (p_source is null or o.source = p_source)
     and (v_like is null or o.order_number ilike v_like or o.contact_name ilike v_like
          or (length(v_digits) >= 3 and o.contact_phone like '%' || v_digits || '%'));

  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_rows
  from (select o.id, o.created_at, jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status,
               'source', o.source, 'createdAt', o.created_at, 'contactName', o.contact_name, 'contactPhone', o.contact_phone,
               'total', o.total, 'deliveryPending', o.delivery_pending,
               'itemCount', (select coalesce(sum(i.qty), 0) from public.order_items i where i.order_id = o.id)) as j
        from public.orders o
        where (p_status is null or o.status::text = p_status) and (p_source is null or o.source = p_source)
          and (v_like is null or o.order_number ilike v_like or o.contact_name ilike v_like
               or (length(v_digits) >= 3 and o.contact_phone like '%' || v_digits || '%'))
        order by o.created_at desc, o.id limit v_limit offset v_off) x;

  select coalesce(jsonb_object_agg(z.s, z.c), '{}'::jsonb) into v_counts
  from (select status::text as s, count(*) as c from public.orders where (p_source is null or source = p_source) group by 1) z;

  return jsonb_build_object('orders', v_rows, 'total', v_total, 'counts', v_counts);
end $$;

create function public.admin_get_order(p_admin bigint, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o public.orders%rowtype; c public.customers%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  select * into o from public.orders where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into c from public.customers where id = o.customer_id;
  return jsonb_build_object(
    'order', (public.order_to_json(o.id) -> 'order') || jsonb_build_object('updatedAt', o.updated_at),
    'customer', jsonb_build_object('id', c.id, 'telegramId', c.telegram_id, 'username', c.username,
                                   'name', btrim(c.first_name || ' ' || coalesce(c.last_name, ''))),
    'history', coalesce((select jsonb_agg(jsonb_build_object('status', h.status, 'by', h.changed_by_telegram_id, 'note', h.note, 'at', h.created_at) order by h.id)
                         from public.order_status_history h where h.order_id = o.id), '[]'::jsonb));
end $$;

-- new -> confirmed -> preparing -> shipped -> delivered; cancel from new / confirmed / preparing (reason mandatory, stock goes back).
create function public.admin_set_order_status(p_admin bigint, p_id uuid, p_status text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.orders%rowtype;
  v_new public.order_status;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.pickup_require_admin(p_admin);
  if p_status is null or p_status not in ('confirmed', 'preparing', 'shipped', 'delivered', 'cancelled') then raise exception 'INVALID_REQUEST'; end if;
  v_new := p_status::public.order_status;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not ((o.status = 'new' and v_new in ('confirmed', 'cancelled'))
       or (o.status = 'confirmed' and v_new in ('preparing', 'cancelled'))
       or (o.status = 'preparing' and v_new in ('shipped', 'cancelled'))
       or (o.status = 'shipped' and v_new = 'delivered')) then
    raise exception 'INVALID_TRANSITION' using detail = jsonb_build_object('status', o.status)::text;
  end if;
  if v_new = 'cancelled' then
    if v_note is null or length(v_note) < 3 or length(v_note) > 300 then raise exception 'INVALID_REASON'; end if;
    -- the Cart took the pieces out of inventory when the order was placed: put them back (rows locked in id order)
    perform 1 from public.inventory i
     where i.variant_id in (select variant_id from public.order_items where order_id = o.id and variant_id is not null)
     order by i.variant_id for update;
    update public.inventory i set quantity = i.quantity + s.q, updated_at = now()
      from (select variant_id, sum(qty)::integer as q from public.order_items
             where order_id = o.id and variant_id is not null group by variant_id) s
     where i.variant_id = s.variant_id;
  elsif v_note is not null and length(v_note) > 300 then
    raise exception 'INVALID_REQUEST';
  end if;
  update public.orders set status = v_new, updated_at = now() where id = o.id;
  insert into public.order_status_history (order_id, status, changed_by_telegram_id, note) values (o.id, v_new, p_admin, v_note);
  insert into public.notification_outbox (kind, order_id, chat_id)
    select 'status_customer', o.id, c.telegram_id from public.customers c where c.id = o.customer_id;
  perform public.admin_audit(p_admin, 'order.status', 'order', o.id::text, jsonb_build_object('from', o.status, 'to', v_new, 'note', v_note));
  return public.order_to_json(o.id) -> 'order';
end $$;

-- the shop sets the delivery fee of an order whose fee was "not configured yet" (or corrects it) until it ships
create function public.admin_set_order_delivery(p_admin bigint, p_id uuid, p_fee integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.orders%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  if p_fee is null or p_fee < 0 or p_fee > 100000000 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'fee')::text; end if;
  select * into o from public.orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if o.status not in ('new', 'confirmed', 'preparing') then
    raise exception 'INVALID_TRANSITION' using detail = jsonb_build_object('status', o.status)::text;
  end if;
  update public.orders set delivery_fee = p_fee, delivery_pending = false, total = subtotal + p_fee, updated_at = now() where id = o.id;
  perform public.admin_audit(p_admin, 'order.delivery', 'order', o.id::text, jsonb_build_object('fee', p_fee, 'was', o.delivery_fee));
  return public.order_to_json(o.id) -> 'order';
end $$;

-- ---------------------------------------------------------------- categories and brands
create function public.admin_list_categories(p_admin bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.pickup_require_admin(p_admin);
  return jsonb_build_object('categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sortOrder', c.sort_order,
      'active', c.active, 'productCount', (select count(*) from public.products p where p.category_id = c.id),
      'activeProductCount', (select count(*) from public.products p where p.category_id = c.id and p.active)) order by c.sort_order, c.name)
    from public.categories c), '[]'::jsonb));
end $$;

create function public.admin_list_brands(p_admin bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.pickup_require_admin(p_admin);
  return jsonb_build_object('brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'type', b.type,
      'active', b.active, 'productCount', (select count(*) from public.products p where p.brand_id = b.id),
      'activeProductCount', (select count(*) from public.products p where p.brand_id = b.id and p.active)) order by b.name)
    from public.brands b), '[]'::jsonb));
end $$;

-- slug of a name: lower-case a-z0-9 and '-'; Uzbek apostrophes are dropped
create function public.admin_slug(p_name text) returns text
language sql immutable set search_path = pg_catalog as $$
  select left(trim(both '-' from regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[''`‘’ʻʼ]', '', 'g'), '[^a-z0-9]+', '-', 'g')), 40);
$$;

-- p_id NULL = create (the id is derived from the name, made unique); otherwise update (the id never changes)
create function public.admin_save_category(p_admin bigint, p_id text, p_name text, p_sort integer, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id text; v_base text; v_n integer := 1; c public.categories%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  if length(v_name) < 1 or length(v_name) > 80 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'name')::text; end if;
  if p_sort is null or p_sort < -100000 or p_sort > 100000 or p_active is null then raise exception 'INVALID_REQUEST'; end if;
  if p_id is null then
    v_base := public.admin_slug(v_name);
    if v_base = '' then v_base := 'kat'; end if;
    v_id := v_base;
    while exists (select 1 from public.categories where id = v_id) loop
      v_n := v_n + 1;
      v_id := left(v_base, 36) || '-' || v_n;
    end loop;
    insert into public.categories (id, name, sort_order, active) values (v_id, v_name, p_sort, p_active);
    perform public.admin_audit(p_admin, 'category.create', 'category', v_id, jsonb_build_object('name', v_name));
  else
    select * into c from public.categories where id = p_id for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    -- a hidden category with visible products would break the catalog: move or hide the products first
    if c.active and not p_active and exists (select 1 from public.products where category_id = c.id and active) then
      raise exception 'IN_USE' using detail = jsonb_build_object('count', (select count(*) from public.products where category_id = c.id and active))::text;
    end if;
    update public.categories set name = v_name, sort_order = p_sort, active = p_active where id = c.id;
    v_id := c.id;
    perform public.admin_audit(p_admin, 'category.update', 'category', v_id, jsonb_build_object('name', v_name, 'active', p_active));
  end if;
  return (select jsonb_build_object('id', x.id, 'name', x.name, 'sortOrder', x.sort_order, 'active', x.active) from public.categories x where x.id = v_id);
end $$;

create function public.admin_delete_category(p_admin bigint, p_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.pickup_require_admin(p_admin, true);
  if not exists (select 1 from public.categories where id = p_id) then raise exception 'NOT_FOUND'; end if;
  if exists (select 1 from public.products where category_id = p_id) then
    raise exception 'IN_USE' using detail = jsonb_build_object('count', (select count(*) from public.products where category_id = p_id))::text;
  end if;
  delete from public.categories where id = p_id;
  perform public.admin_audit(p_admin, 'category.delete', 'category', p_id);
end $$;

create function public.admin_save_brand(p_admin bigint, p_id text, p_name text, p_type text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id text; v_base text; v_n integer := 1; b public.brands%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  if length(v_name) < 1 or length(v_name) > 80 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'name')::text; end if;
  if p_type is null or p_type not in ('original', 'other') or p_active is null then raise exception 'INVALID_REQUEST'; end if;
  if p_id is null then
    v_base := public.admin_slug(v_name);
    if v_base = '' then v_base := 'brend'; end if;
    v_id := v_base;
    while exists (select 1 from public.brands where id = v_id) loop
      v_n := v_n + 1;
      v_id := left(v_base, 36) || '-' || v_n;
    end loop;
    insert into public.brands (id, name, type, active) values (v_id, v_name, p_type::public.product_type, p_active);
    perform public.admin_audit(p_admin, 'brand.create', 'brand', v_id, jsonb_build_object('name', v_name));
  else
    select * into b from public.brands where id = p_id for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    if b.active and not p_active and exists (select 1 from public.products where brand_id = b.id and active) then
      raise exception 'IN_USE' using detail = jsonb_build_object('count', (select count(*) from public.products where brand_id = b.id and active))::text;
    end if;
    -- products.type follows the brand: changing it with products attached would silently re-label them
    if b.type::text <> p_type and exists (select 1 from public.products where brand_id = b.id) then
      raise exception 'IN_USE' using detail = jsonb_build_object('field', 'type')::text;
    end if;
    update public.brands set name = v_name, type = p_type::public.product_type, active = p_active where id = b.id;
    v_id := b.id;
    perform public.admin_audit(p_admin, 'brand.update', 'brand', v_id, jsonb_build_object('name', v_name, 'active', p_active));
  end if;
  return (select jsonb_build_object('id', x.id, 'name', x.name, 'type', x.type, 'active', x.active) from public.brands x where x.id = v_id);
end $$;

-- ---------------------------------------------------------------- products
create function public.admin_list_products(p_admin bigint, p_q text default null, p_category text default null,
                                           p_status text default null, p_limit integer default 30, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb; v_total integer;
begin
  perform public.pickup_require_admin(p_admin);
  if p_status is not null and p_status not in ('active', 'inactive') then raise exception 'INVALID_REQUEST'; end if;
  if v_q is not null and length(v_q) > 100 then raise exception 'INVALID_REQUEST'; end if;
  v_like := case when v_q is null then null else public.admin_like(v_q) end;
  select count(*) into v_total from public.products p
   where (p_category is null or p.category_id = p_category)
     and (p_status is null or p.active = (p_status = 'active'))
     and (v_like is null or p.name ilike v_like or exists (select 1 from public.product_variants v where v.product_id = p.id and v.sku ilike v_like));
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_rows
  from (select p.id, p.created_at, jsonb_build_object('id', p.id, 'name', p.name, 'brandId', p.brand_id, 'brandName', b.name,
          'categoryId', p.category_id, 'categoryName', c.name, 'price', p.price, 'oldPrice', p.old_price, 'active', p.active,
          'isSample', p.is_sample, 'isNew', p.is_new,
          'stock', (select coalesce(sum(i.quantity), 0) from public.product_variants v join public.inventory i on i.variant_id = v.id
                    where v.product_id = p.id and v.active),
          'variantCount', (select count(*) from public.product_variants v where v.product_id = p.id and v.active),
          'image', (select pi.path from public.product_images pi where pi.product_id = p.id order by pi.sort_order, pi.id limit 1)) as j
        from public.products p join public.brands b on b.id = p.brand_id join public.categories c on c.id = p.category_id
        where (p_category is null or p.category_id = p_category)
          and (p_status is null or p.active = (p_status = 'active'))
          and (v_like is null or p.name ilike v_like or exists (select 1 from public.product_variants v where v.product_id = p.id and v.sku ilike v_like))
        order by p.created_at desc, p.id limit v_limit offset v_off) x;
  return jsonb_build_object('products', v_rows, 'total', v_total);
end $$;

create function public.admin_get_product(p_admin bigint, p_id text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.products%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  select * into p from public.products where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('product', jsonb_build_object(
    'id', p.id, 'name', p.name, 'brandId', p.brand_id, 'categoryId', p.category_id, 'description', p.description,
    'price', p.price, 'oldPrice', p.old_price, 'type', p.type, 'isNew', p.is_new, 'active', p.active,
    'popularity', p.popularity, 'isSample', p.is_sample, 'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'size', v.size, 'colorName', v.color_name, 'colorHex', v.color_hex,
         'sku', v.sku, 'active', v.active, 'sortOrder', v.sort_order, 'quantity', coalesce(i.quantity, 0), 'reserved', public.reserved_qty(v.id))
         order by v.sort_order, v.size, v.color_name)
       from public.product_variants v left join public.inventory i on i.variant_id = v.id where v.product_id = p.id), '[]'::jsonb),
    'images', coalesce((select jsonb_agg(jsonb_build_object('id', pi.id, 'path', pi.path, 'sortOrder', pi.sort_order) order by pi.sort_order, pi.id)
       from public.product_images pi where pi.product_id = p.id), '[]'::jsonb)));
end $$;

-- create (no id) or update (id) a product together with its variants. Variants that are not listed are left untouched (never
-- deleted: orders and reservations point at them); hide one with active=false. Stock of EXISTING variants is changed only
-- through admin_adjust_stock (audited); a NEW variant may start with `quantity`.
create function public.admin_save_product(p_admin bigint, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id text;
  v_old public.products%rowtype;
  v_brand public.brands%rowtype;
  v_cat public.categories%rowtype;
  v_name text; v_desc text; v_price integer; v_oldp integer; v_active boolean; v_isnew boolean; v_pop integer; v_sample boolean;
  v_variants jsonb; v jsonb; v_vid uuid; v_size text; v_color text; v_hex text; v_sku text; v_vactive boolean; v_qty integer;
  v_seen text[] := '{}'; v_key text; v_ord integer := 0; v_exists boolean;
begin
  perform public.pickup_require_admin(p_admin);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'INVALID_REQUEST'; end if;

  if p_payload ? 'id' and jsonb_typeof(p_payload -> 'id') is distinct from 'null' then
    if jsonb_typeof(p_payload -> 'id') <> 'string' then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'id')::text; end if;
    v_id := p_payload ->> 'id';
    select * into v_old from public.products where id = v_id for update;
    if not found then raise exception 'NOT_FOUND'; end if;
  end if;

  if jsonb_typeof(p_payload -> 'name') is distinct from 'string' then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'name')::text; end if;
  v_name := regexp_replace(btrim(p_payload ->> 'name'), '\s+', ' ', 'g');
  if length(v_name) < 1 or length(v_name) > 200 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'name')::text; end if;

  v_desc := case when jsonb_typeof(p_payload -> 'description') = 'string' then btrim(p_payload ->> 'description') else '' end;
  if length(v_desc) > 4000 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'description')::text; end if;

  if jsonb_typeof(p_payload -> 'price') is distinct from 'number' or (p_payload ->> 'price') !~ '^[0-9]{1,9}$' then
    raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'price')::text;
  end if;
  v_price := (p_payload ->> 'price')::integer;
  if jsonb_typeof(p_payload -> 'oldPrice') = 'number' then
    if (p_payload ->> 'oldPrice') !~ '^[0-9]{1,9}$' or (p_payload ->> 'oldPrice')::integer <= v_price then
      raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'oldPrice')::text;
    end if;
    v_oldp := (p_payload ->> 'oldPrice')::integer;
  elsif jsonb_typeof(p_payload -> 'oldPrice') is not null and jsonb_typeof(p_payload -> 'oldPrice') <> 'null' then
    raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'oldPrice')::text;
  end if;

  v_active := coalesce(case when jsonb_typeof(p_payload -> 'active') = 'boolean' then (p_payload ->> 'active')::boolean end, coalesce(v_old.active, true));
  v_isnew := coalesce(case when jsonb_typeof(p_payload -> 'isNew') = 'boolean' then (p_payload ->> 'isNew')::boolean end, coalesce(v_old.is_new, false));
  v_pop := coalesce(case when jsonb_typeof(p_payload -> 'popularity') = 'number' and (p_payload ->> 'popularity') ~ '^[0-9]{1,6}$' then (p_payload ->> 'popularity')::integer end, coalesce(v_old.popularity, 0));

  -- brand / category must be active, except that an existing product may keep one that was hidden after it was assigned
  select * into v_brand from public.brands where id = p_payload ->> 'brandId' and (active or id = v_old.brand_id);
  if not found then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'brandId')::text; end if;
  select * into v_cat from public.categories where id = p_payload ->> 'categoryId' and (active or id = v_old.category_id);
  if not found then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'categoryId')::text; end if;

  -- the "sample product" flag decides whether the shop may sell it: only the owner changes it (new products are real)
  v_sample := coalesce(v_old.is_sample, false);
  if jsonb_typeof(p_payload -> 'isSample') = 'boolean' and (p_payload ->> 'isSample')::boolean is distinct from v_sample then
    perform public.pickup_require_admin(p_admin, true);
    v_sample := (p_payload ->> 'isSample')::boolean;
  end if;

  v_variants := p_payload -> 'variants';
  if v_variants is not null and jsonb_typeof(v_variants) <> 'null' and (jsonb_typeof(v_variants) <> 'array' or jsonb_array_length(v_variants) > 100) then
    raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'variants')::text;
  end if;
  -- validate every variant BEFORE writing anything
  if jsonb_typeof(v_variants) = 'array' then
    for v in select * from jsonb_array_elements(v_variants) loop
      if jsonb_typeof(v) <> 'object'
         or jsonb_typeof(v -> 'size') is distinct from 'string' or length(btrim(v ->> 'size')) not between 1 and 20
         or jsonb_typeof(v -> 'colorName') is distinct from 'string' or length(btrim(v ->> 'colorName')) not between 1 and 40
         or jsonb_typeof(v -> 'colorHex') is distinct from 'string' or (v ->> 'colorHex') !~ '^#[0-9A-Fa-f]{6}$'
         or (jsonb_typeof(v -> 'sku') = 'string' and length(v ->> 'sku') > 60)
         or (jsonb_typeof(v -> 'quantity') = 'number' and (v ->> 'quantity') !~ '^[0-9]{1,6}$')
         or (jsonb_typeof(v -> 'quantity') is not null and jsonb_typeof(v -> 'quantity') not in ('number', 'null'))
         or (jsonb_typeof(v -> 'id') is not null and jsonb_typeof(v -> 'id') not in ('string', 'null')) then
        raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'variants')::text;
      end if;
      v_key := btrim(v ->> 'size') || '|' || btrim(v ->> 'colorName');
      if v_key = any (v_seen) then raise exception 'DUPLICATE_VARIANT' using detail = jsonb_build_object('size', btrim(v ->> 'size'), 'color', btrim(v ->> 'colorName'))::text; end if;
      v_seen := array_append(v_seen, v_key);
    end loop;
  end if;

  if v_id is null then
    insert into public.products (name, brand_id, category_id, description, price, old_price, type, is_new, active, popularity, is_sample)
    values (v_name, v_brand.id, v_cat.id, v_desc, v_price, v_oldp, v_brand.type, v_isnew, v_active, v_pop, false)
    returning id into v_id;
    perform public.admin_audit(p_admin, 'product.create', 'product', v_id, jsonb_build_object('name', v_name, 'price', v_price));
  else
    update public.products
       set name = v_name, brand_id = v_brand.id, category_id = v_cat.id, description = v_desc, price = v_price, old_price = v_oldp,
           type = v_brand.type, is_new = v_isnew, active = v_active, popularity = v_pop, is_sample = v_sample, updated_at = now()
     where id = v_id;
    perform public.admin_audit(p_admin, 'product.update', 'product', v_id,
      jsonb_build_object('name', v_name, 'price', v_price, 'was', v_old.price, 'active', v_active));
  end if;

  if jsonb_typeof(v_variants) = 'array' then
    for v in select * from jsonb_array_elements(v_variants) loop
      v_size := btrim(v ->> 'size'); v_color := btrim(v ->> 'colorName'); v_hex := v ->> 'colorHex';
      v_sku := nullif(btrim(coalesce(v ->> 'sku', '')), '');
      v_vactive := coalesce(case when jsonb_typeof(v -> 'active') = 'boolean' then (v ->> 'active')::boolean end, true);
      v_ord := v_ord + 1;
      begin
        if jsonb_typeof(v -> 'id') = 'string' then
          select exists (select 1 from public.product_variants where id::text = v ->> 'id' and product_id = v_id) into v_exists;
          if not v_exists then raise exception 'NOT_FOUND'; end if;
          update public.product_variants set size = v_size, color_name = v_color, color_hex = v_hex, sku = v_sku, active = v_vactive, sort_order = v_ord
           where id::text = v ->> 'id';
        else
          v_qty := coalesce(case when jsonb_typeof(v -> 'quantity') = 'number' then (v ->> 'quantity')::integer end, 0);
          insert into public.product_variants (product_id, size, color_name, color_hex, sku, sort_order, active)
          values (v_id, v_size, v_color, v_hex, v_sku, v_ord, v_vactive) returning id into v_vid;
          insert into public.inventory (variant_id, quantity) values (v_vid, v_qty);
        end if;
      exception when unique_violation then
        raise exception 'DUPLICATE_VARIANT' using detail = jsonb_build_object('size', v_size, 'color', v_color)::text;
      end;
    end loop;
  end if;
  return public.admin_get_product(p_admin, v_id);
end $$;

create function public.admin_set_product_active(p_admin bigint, p_id text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.pickup_require_admin(p_admin);
  if p_active is null then raise exception 'INVALID_REQUEST'; end if;
  update public.products set active = p_active, updated_at = now() where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform public.admin_audit(p_admin, 'product.active', 'product', p_id, jsonb_build_object('active', p_active));
  return public.admin_get_product(p_admin, p_id);
end $$;

-- images: the file is uploaded to Storage first (signed URL issued by the Edge Function), then registered here
create function public.admin_add_product_image(p_admin bigint, p_product text, p_path text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer; v_max integer;
begin
  perform public.pickup_require_admin(p_admin);
  perform 1 from public.products where id = p_product for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  -- only a file that was issued for THIS product can be attached
  if p_path is null or p_path !~ '^products/[A-Za-z0-9-]{1,60}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
     or split_part(p_path, '/', 2) <> p_product then
    raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'path')::text;
  end if;
  -- on a real Supabase project the object must exist; plain Postgres (tests) has no storage schema
  if to_regclass('storage.objects') is not null then
    if not exists (select 1 from storage.objects o where o.bucket_id = 'product-images' and o.name = p_path) then
      raise exception 'FILE_MISSING';
    end if;
  end if;
  select count(*), coalesce(max(sort_order), 0) into v_count, v_max from public.product_images where product_id = p_product;
  if v_count >= 12 then raise exception 'TOO_MANY_IMAGES'; end if;
  insert into public.product_images (product_id, path, sort_order) values (p_product, p_path, v_max + 1);
  update public.products set updated_at = now() where id = p_product;
  perform public.admin_audit(p_admin, 'product.image.add', 'product', p_product, jsonb_build_object('path', p_path));
  return public.admin_get_product(p_admin, p_product);
end $$;

-- returns the deleted file's path so that the Edge Function can remove the object from Storage
create function public.admin_delete_product_image(p_admin bigint, p_image uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.product_images%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  delete from public.product_images where id = p_image returning * into r;
  if not found then raise exception 'NOT_FOUND'; end if;
  update public.products set updated_at = now() where id = r.product_id;
  perform public.admin_audit(p_admin, 'product.image.delete', 'product', r.product_id, jsonb_build_object('path', r.path));
  return jsonb_build_object('path', r.path, 'product', public.admin_get_product(p_admin, r.product_id) -> 'product');
end $$;

create function public.admin_set_cover_image(p_admin bigint, p_image uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.product_images%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  select * into r from public.product_images where id = p_image;
  if not found then raise exception 'NOT_FOUND'; end if;
  update public.product_images
     set sort_order = (select min(sort_order) - 1 from public.product_images where product_id = r.product_id)
   where id = r.id;
  update public.products set updated_at = now() where id = r.product_id;
  perform public.admin_audit(p_admin, 'product.image.cover', 'product', r.product_id, jsonb_build_object('path', r.path));
  return public.admin_get_product(p_admin, r.product_id);
end $$;

-- ---------------------------------------------------------------- inventory
create function public.admin_list_inventory(p_admin bigint, p_q text default null, p_filter text default 'all',
                                            p_limit integer default 50, p_offset integer default 0, p_low integer default 3) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_low integer := least(greatest(coalesce(p_low, 3), 1), 50);
  v_rows jsonb; v_total integer;
begin
  perform public.pickup_require_admin(p_admin);
  if p_filter not in ('all', 'low', 'out') then raise exception 'INVALID_REQUEST'; end if;
  if v_q is not null and length(v_q) > 100 then raise exception 'INVALID_REQUEST'; end if;
  v_like := case when v_q is null then null else public.admin_like(v_q) end;
  select count(*) into v_total
    from public.product_variants v join public.products p on p.id = v.product_id
   where (v_like is null or p.name ilike v_like or v.sku ilike v_like or v.color_name ilike v_like)
     and (p_filter = 'all'
          or (p_filter = 'out' and public.available_qty(v.id) = 0)
          or (p_filter = 'low' and public.available_qty(v.id) between 1 and v_low));
  select coalesce(jsonb_agg(x.j order by x.pname, x.sort_order, x.size, x.color_name), '[]'::jsonb) into v_rows
  from (select p.name as pname, v.sort_order, v.size, v.color_name, jsonb_build_object(
          'variantId', v.id, 'productId', p.id, 'productName', p.name, 'size', v.size, 'colorName', v.color_name, 'colorHex', v.color_hex,
          'sku', v.sku, 'quantity', coalesce(i.quantity, 0), 'reserved', public.reserved_qty(v.id), 'available', public.available_qty(v.id),
          'active', (v.active and p.active)) as j
        from public.product_variants v join public.products p on p.id = v.product_id left join public.inventory i on i.variant_id = v.id
        where (v_like is null or p.name ilike v_like or v.sku ilike v_like or v.color_name ilike v_like)
          and (p_filter = 'all'
               or (p_filter = 'out' and public.available_qty(v.id) = 0)
               or (p_filter = 'low' and public.available_qty(v.id) between 1 and v_low))
        order by p.name, v.sort_order, v.size, v.color_name limit v_limit offset v_off) x;
  return jsonb_build_object('items', v_rows, 'total', v_total, 'threshold', v_low);
end $$;

-- p_mode 'set': the counted quantity; 'add': a signed change (receiving goods = +, a correction = -).
-- The result can never be below what is reserved for pickup orders: those pieces are promised to customers.
create function public.admin_adjust_stock(p_admin bigint, p_variant uuid, p_mode text, p_value integer, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old integer; v_new integer; v_res integer; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.pickup_require_admin(p_admin);
  if p_mode is null or p_mode not in ('set', 'add') or p_value is null or p_value < -1000000 or p_value > 1000000 then raise exception 'INVALID_REQUEST'; end if;
  if v_reason is not null and length(v_reason) > 200 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'reason')::text; end if;
  if not exists (select 1 from public.product_variants where id = p_variant) then raise exception 'NOT_FOUND'; end if;
  insert into public.inventory (variant_id, quantity) values (p_variant, 0) on conflict (variant_id) do nothing;
  select quantity into v_old from public.inventory where variant_id = p_variant for update;
  v_new := case p_mode when 'set' then p_value else v_old + p_value end;
  if v_new < 0 or v_new > 1000000 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'value')::text; end if;
  v_res := public.reserved_qty(p_variant);
  if v_new < v_res then raise exception 'STOCK_BELOW_RESERVED' using detail = jsonb_build_object('reserved', v_res)::text; end if;
  update public.inventory set quantity = v_new, updated_at = now() where variant_id = p_variant;
  insert into public.stock_adjustments (variant_id, admin_telegram_id, old_qty, new_qty, reason) values (p_variant, p_admin, v_old, v_new, v_reason);
  perform public.admin_audit(p_admin, 'stock.adjust', 'variant', p_variant::text, jsonb_build_object('from', v_old, 'to', v_new, 'reason', v_reason));
  return jsonb_build_object('variantId', p_variant, 'quantity', v_new, 'reserved', v_res, 'available', greatest(0, v_new - v_res), 'was', v_old);
end $$;

-- ---------------------------------------------------------------- customers (read only)
create function public.admin_list_customers(p_admin bigint, p_q text default null, p_limit integer default 30, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text; v_digits text; v_tg bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb; v_total integer;
begin
  perform public.pickup_require_admin(p_admin);
  if v_q is not null and length(v_q) > 100 then raise exception 'INVALID_REQUEST'; end if;
  v_like := case when v_q is null then null else public.admin_like(v_q) end;
  v_digits := regexp_replace(coalesce(v_q, ''), '\D', '', 'g');
  v_tg := case when v_q ~ '^[0-9]{1,15}$' then v_q::bigint end;
  select count(*) into v_total from public.customers c
   where v_like is null or (c.first_name || ' ' || coalesce(c.last_name, '')) ilike v_like or c.username ilike v_like
      or (length(v_digits) >= 3 and c.phone like '%' || v_digits || '%') or c.telegram_id = v_tg;
  select coalesce(jsonb_agg(x.j order by x.last_seen_at desc, x.id), '[]'::jsonb) into v_rows
  from (select c.id, c.last_seen_at, jsonb_build_object('id', c.id, 'telegramId', c.telegram_id,
          'name', btrim(c.first_name || ' ' || coalesce(c.last_name, '')), 'username', c.username, 'phone', c.phone,
          'createdAt', c.created_at, 'lastSeenAt', c.last_seen_at,
          'cartOrders', (select count(*) from public.orders o where o.customer_id = c.id),
          'cartSpent', (select coalesce(sum(o.total), 0) from public.orders o where o.customer_id = c.id and o.status <> 'cancelled'),
          'pickupOrders', (select count(*) from public.pickup_orders o where o.customer_id = c.id),
          'pickupSpent', (select coalesce(sum(o.total), 0) from public.pickup_orders o where o.customer_id = c.id and o.status = 'completed')) as j
        from public.customers c
        where v_like is null or (c.first_name || ' ' || coalesce(c.last_name, '')) ilike v_like or c.username ilike v_like
           or (length(v_digits) >= 3 and c.phone like '%' || v_digits || '%') or c.telegram_id = v_tg
        order by c.last_seen_at desc, c.id limit v_limit offset v_off) x;
  return jsonb_build_object('customers', v_rows, 'total', v_total);
end $$;

create function public.admin_get_customer(p_admin bigint, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.customers%rowtype;
begin
  perform public.pickup_require_admin(p_admin);
  select * into c from public.customers where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'telegramId', c.telegram_id, 'name', btrim(c.first_name || ' ' || coalesce(c.last_name, '')),
                                   'username', c.username, 'phone', c.phone, 'createdAt', c.created_at, 'lastSeenAt', c.last_seen_at),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status, 'source', o.source,
        'createdAt', o.created_at, 'total', o.total) order by o.created_at desc)
      from (select * from public.orders where customer_id = c.id order by created_at desc limit 20) o), '[]'::jsonb),
    'pickupOrders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'orderNumber', o.order_number, 'status', o.status,
        'createdAt', o.created_at, 'total', o.total) order by o.created_at desc)
      from (select * from public.pickup_orders where customer_id = c.id order by created_at desc limit 20) o), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- settings (owner writes, everybody reads)
create function public.admin_get_settings(p_admin bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.settings%rowtype; ps public.pickup_settings%rowtype; v_role text;
begin
  perform public.pickup_require_admin(p_admin);
  select role into v_role from public.administrators where telegram_id = p_admin;
  select * into s from public.settings limit 1;
  select * into ps from public.pickup_settings limit 1;
  return jsonb_build_object(
    'role', v_role,
    'settings', jsonb_build_object('deliveryFee', s.delivery_fee, 'deliveryFreeFrom', s.delivery_free_from,
                                   'allowSampleOrders', s.allow_sample_orders, 'supportContact', s.support_contact),
    'pickup', jsonb_build_object('pendingTimeoutMinutes', ps.pending_timeout_minutes, 'readyHoldHours', ps.ready_hold_hours,
                                 'maxActivePerCustomer', ps.max_active_per_customer, 'maxLines', ps.max_lines,
                                 'storeAddress', ps.store_address, 'storePhone', ps.store_phone, 'storeHours', ps.store_hours,
                                 'updatedAt', ps.updated_at),
    -- administrators are listed (read only, owner only); nothing in the panel can add or change one
    'admins', case when v_role = 'owner' then coalesce((select jsonb_agg(jsonb_build_object('telegramId', a.telegram_id, 'name', a.name,
                  'role', a.role, 'active', a.active) order by a.created_at) from public.administrators a), '[]'::jsonb) end);
end $$;

create function public.admin_update_settings(p_admin bigint, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.settings%rowtype; v_text text;
begin
  perform public.pickup_require_admin(p_admin, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'INVALID_REQUEST'; end if;
  select * into s from public.settings for update;
  if p_payload ? 'deliveryFee' then
    if jsonb_typeof(p_payload -> 'deliveryFee') = 'null' then s.delivery_fee := null;
    elsif jsonb_typeof(p_payload -> 'deliveryFee') = 'number' and (p_payload ->> 'deliveryFee') ~ '^[0-9]{1,9}$' then s.delivery_fee := (p_payload ->> 'deliveryFee')::integer;
    else raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'deliveryFee')::text; end if;
  end if;
  if p_payload ? 'deliveryFreeFrom' then
    if jsonb_typeof(p_payload -> 'deliveryFreeFrom') = 'null' then s.delivery_free_from := null;
    elsif jsonb_typeof(p_payload -> 'deliveryFreeFrom') = 'number' and (p_payload ->> 'deliveryFreeFrom') ~ '^[0-9]{1,9}$' and (p_payload ->> 'deliveryFreeFrom')::integer > 0 then s.delivery_free_from := (p_payload ->> 'deliveryFreeFrom')::integer;
    else raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'deliveryFreeFrom')::text; end if;
  end if;
  if p_payload ? 'allowSampleOrders' then
    if jsonb_typeof(p_payload -> 'allowSampleOrders') <> 'boolean' then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'allowSampleOrders')::text; end if;
    s.allow_sample_orders := (p_payload ->> 'allowSampleOrders')::boolean;
  end if;
  if p_payload ? 'supportContact' then
    if jsonb_typeof(p_payload -> 'supportContact') = 'null' then s.support_contact := null;
    elsif jsonb_typeof(p_payload -> 'supportContact') = 'string' then
      v_text := nullif(btrim(p_payload ->> 'supportContact'), '');
      if length(coalesce(v_text, '')) > 200 then raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'supportContact')::text; end if;
      s.support_contact := v_text;
    else raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', 'supportContact')::text; end if;
  end if;
  update public.settings set delivery_fee = s.delivery_fee, delivery_free_from = s.delivery_free_from,
         allow_sample_orders = s.allow_sample_orders, support_contact = s.support_contact;
  perform public.admin_audit(p_admin, 'settings.update', 'settings', null,
    jsonb_build_object('deliveryFee', s.delivery_fee, 'deliveryFreeFrom', s.delivery_free_from, 'allowSampleOrders', s.allow_sample_orders));
  return public.admin_get_settings(p_admin);
end $$;

create function public.admin_update_pickup_settings(p_admin bigint, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ps public.pickup_settings%rowtype; k text; v_text text;
  v_ints constant text[] := array['pendingTimeoutMinutes', 'readyHoldHours', 'maxActivePerCustomer', 'maxLines'];
  v_lo constant integer[] := array[1, 1, 1, 1];
  v_hi constant integer[] := array[1440, 720, 20, 50];
  v_i integer; v_limit integer;
begin
  perform public.pickup_require_admin(p_admin, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'INVALID_REQUEST'; end if;
  select * into ps from public.pickup_settings for update;
  for v_i in 1..4 loop
    k := v_ints[v_i];
    if p_payload ? k then
      if jsonb_typeof(p_payload -> k) <> 'number' or (p_payload ->> k) !~ '^[0-9]{1,5}$'
         or (p_payload ->> k)::integer not between v_lo[v_i] and v_hi[v_i] then
        raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', k)::text;
      end if;
      case k
        when 'pendingTimeoutMinutes' then ps.pending_timeout_minutes := (p_payload ->> k)::integer;
        when 'readyHoldHours' then ps.ready_hold_hours := (p_payload ->> k)::integer;
        when 'maxActivePerCustomer' then ps.max_active_per_customer := (p_payload ->> k)::integer;
        when 'maxLines' then ps.max_lines := (p_payload ->> k)::integer;
      end case;
    end if;
  end loop;
  foreach k in array array['storeAddress', 'storePhone', 'storeHours'] loop
    if p_payload ? k then
      if jsonb_typeof(p_payload -> k) = 'null' then v_text := null;
      elsif jsonb_typeof(p_payload -> k) = 'string' then v_text := nullif(btrim(p_payload ->> k), '');
      else raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', k)::text; end if;
      v_limit := case when k = 'storePhone' then 40 else 300 end;
      if length(coalesce(v_text, '')) > v_limit then
        raise exception 'INVALID_REQUEST' using detail = jsonb_build_object('field', k)::text;
      end if;
      case k
        when 'storeAddress' then ps.store_address := v_text;
        when 'storePhone' then ps.store_phone := v_text;
        when 'storeHours' then ps.store_hours := v_text;
      end case;
    end if;
  end loop;
  update public.pickup_settings
     set pending_timeout_minutes = ps.pending_timeout_minutes, ready_hold_hours = ps.ready_hold_hours,
         max_active_per_customer = ps.max_active_per_customer, max_lines = ps.max_lines,
         store_address = ps.store_address, store_phone = ps.store_phone, store_hours = ps.store_hours,
         updated_at = now(), updated_by = p_admin;
  perform public.admin_audit(p_admin, 'pickup_settings.update', 'pickup_settings', null,
    jsonb_build_object('pendingTimeoutMinutes', ps.pending_timeout_minutes, 'readyHoldHours', ps.ready_hold_hours));
  return public.admin_get_settings(p_admin);
end $$;

-- ---------------------------------------------------------------- privileges: nothing here is callable by the browser
revoke all on function
  public.admin_audit(bigint, text, text, text, jsonb), public.admin_like(text), public.admin_slug(text),
  public.admin_me(bigint), public.admin_dashboard(bigint, integer),
  public.admin_list_orders(bigint, text, text, text, integer, integer), public.admin_get_order(bigint, uuid),
  public.admin_set_order_status(bigint, uuid, text, text), public.admin_set_order_delivery(bigint, uuid, integer),
  public.admin_list_categories(bigint), public.admin_list_brands(bigint),
  public.admin_save_category(bigint, text, text, integer, boolean), public.admin_delete_category(bigint, text),
  public.admin_save_brand(bigint, text, text, text, boolean),
  public.admin_list_products(bigint, text, text, text, integer, integer), public.admin_get_product(bigint, text),
  public.admin_save_product(bigint, jsonb), public.admin_set_product_active(bigint, text, boolean),
  public.admin_add_product_image(bigint, text, text), public.admin_delete_product_image(bigint, uuid), public.admin_set_cover_image(bigint, uuid),
  public.admin_list_inventory(bigint, text, text, integer, integer, integer), public.admin_adjust_stock(bigint, uuid, text, integer, text),
  public.admin_list_customers(bigint, text, integer, integer), public.admin_get_customer(bigint, uuid),
  public.admin_get_settings(bigint), public.admin_update_settings(bigint, jsonb), public.admin_update_pickup_settings(bigint, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.admin_audit(bigint, text, text, text, jsonb), public.admin_like(text), public.admin_slug(text),
  public.admin_me(bigint), public.admin_dashboard(bigint, integer),
  public.admin_list_orders(bigint, text, text, text, integer, integer), public.admin_get_order(bigint, uuid),
  public.admin_set_order_status(bigint, uuid, text, text), public.admin_set_order_delivery(bigint, uuid, integer),
  public.admin_list_categories(bigint), public.admin_list_brands(bigint),
  public.admin_save_category(bigint, text, text, integer, boolean), public.admin_delete_category(bigint, text),
  public.admin_save_brand(bigint, text, text, text, boolean),
  public.admin_list_products(bigint, text, text, text, integer, integer), public.admin_get_product(bigint, text),
  public.admin_save_product(bigint, jsonb), public.admin_set_product_active(bigint, text, boolean),
  public.admin_add_product_image(bigint, text, text), public.admin_delete_product_image(bigint, uuid), public.admin_set_cover_image(bigint, uuid),
  public.admin_list_inventory(bigint, text, text, integer, integer, integer), public.admin_adjust_stock(bigint, uuid, text, integer, text),
  public.admin_list_customers(bigint, text, integer, integer), public.admin_get_customer(bigint, uuid),
  public.admin_get_settings(bigint), public.admin_update_settings(bigint, jsonb), public.admin_update_pickup_settings(bigint, jsonb)
  to service_role;
