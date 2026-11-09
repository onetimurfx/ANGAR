-- Phase 6 / stage A3: "available" stock = physical stock minus active reservations.
-- Nothing is deleted or rewritten: with no reservations the numbers are identical to before.

-- Sum of ACTIVE, not-yet-expired reservations for a variant. An expired one stops counting by itself, so a stopped
-- cron job can never keep stock locked. Server only.
create function public.reserved_qty(p_variant uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(r.qty), 0)::integer
  from public.stock_reservations r
  where r.variant_id = p_variant and r.status = 'active' and (r.expires_at is null or r.expires_at > now());
$$;

-- What a customer can still take. Callable by the browser: it only reveals the same number get_catalog shows.
create function public.available_qty(p_variant uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(0, coalesce((select i.quantity from public.inventory i where i.variant_id = p_variant), 0)
                     - public.reserved_qty(p_variant));
$$;

revoke all on function public.reserved_qty(uuid), public.available_qty(uuid) from public, anon, authenticated;
grant execute on function public.reserved_qty(uuid) to service_role;
grant execute on function public.available_qty(uuid) to anon, authenticated, service_role;

-- get_catalog: identical to the Phase 5 version except 'qty' is now the AVAILABLE quantity.
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
                                'qty', public.available_qty(v.id)) order by v.sort_order, v.size, v.color_name)
                              from public.product_variants v
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
