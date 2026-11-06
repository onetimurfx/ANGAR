-- Row Level Security. Model:
--   * Browser (anon / authenticated) may READ the public catalog only. It can never write, and can never
--     read customers, carts, orders, notifications or administrators.
--   * Everything else goes through Edge Functions that use the service_role key (server only) and
--     verify Telegram initData first.
-- RLS is ON for every table. Tables without a policy are invisible to anon/authenticated.

alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.product_variants enable row level security;
alter table public.inventory enable row level security;
alter table public.collections enable row level security;
alter table public.collection_items enable row level security;
alter table public.promotions enable row level security;
alter table public.settings enable row level security;
alter table public.administrators enable row level security;
alter table public.customers enable row level security;
alter table public.cart_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.notification_outbox enable row level security;

-- Defense in depth: no table privileges at all for the browser roles, then grant SELECT on catalog tables.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.categories, public.brands, public.products, public.product_images,
  public.product_variants, public.inventory, public.collections, public.collection_items,
  public.promotions, public.settings to anon, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

create policy categories_read on public.categories for select to anon, authenticated using (active);
create policy brands_read on public.brands for select to anon, authenticated using (active);
create policy products_read on public.products for select to anon, authenticated using (active);
create policy product_images_read on public.product_images for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.active));
create policy product_variants_read on public.product_variants for select to anon, authenticated
  using (active and exists (select 1 from public.products p where p.id = product_id and p.active));
create policy inventory_read on public.inventory for select to anon, authenticated
  using (exists (select 1 from public.product_variants v join public.products p on p.id = v.product_id
                 where v.id = variant_id and v.active and p.active));
create policy collections_read on public.collections for select to anon, authenticated using (active);
create policy collection_items_read on public.collection_items for select to anon, authenticated
  using (exists (select 1 from public.collections c where c.id = collection_id and c.active));
create policy promotions_read on public.promotions for select to anon, authenticated
  using (active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
-- settings holds only public-safe values (delivery fee, support contact): never put a secret in this table.
create policy settings_read on public.settings for select to anon, authenticated using (true);
