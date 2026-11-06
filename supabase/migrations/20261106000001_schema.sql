-- AYNIMO schema. All money is integer UZS. Nothing here contains secrets.

create type public.order_status as enum ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled');
create type public.product_type as enum ('original', 'other');

create table public.categories (
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (length(name) between 1 and 80),
  sort_order integer not null default 0,
  active boolean not null default true
);

create table public.brands (
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (length(name) between 1 and 80),
  type public.product_type not null,
  active boolean not null default true
);

create table public.products (
  id text primary key default gen_random_uuid()::text check (id ~ '^[a-zA-Z0-9-]{1,60}$'),
  name text not null check (length(name) between 1 and 200),
  brand_id text not null references public.brands (id),
  category_id text not null references public.categories (id),
  description text not null default '' check (length(description) <= 4000),
  price integer not null check (price >= 0),
  old_price integer check (old_price is null or old_price > price),
  type public.product_type not null,
  is_new boolean not null default false,
  active boolean not null default true,
  popularity integer not null default 0,
  -- true for placeholder products. The UI marks them NAMUNA and place_order refuses them (see settings).
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on public.products (category_id) where active;
create index products_brand_idx on public.products (brand_id) where active;
create index products_created_idx on public.products (created_at desc) where active;
create index products_price_idx on public.products (price) where active;

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products (id) on delete cascade,
  -- object path inside the public Storage bucket "product-images"
  path text not null check (length(path) between 1 and 300),
  sort_order integer not null default 0
);
create index product_images_product_idx on public.product_images (product_id, sort_order);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products (id) on delete cascade,
  size text not null check (length(size) between 1 and 20),
  color_name text not null check (length(color_name) between 1 and 40),
  color_hex text not null check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  sku text,
  sort_order integer not null default 0,
  active boolean not null default true,
  unique (product_id, size, color_name)
);
create index product_variants_product_idx on public.product_variants (product_id);

create table public.inventory (
  variant_id uuid primary key references public.product_variants (id) on delete cascade,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now()
);

create table public.collections (
  id text primary key check (id ~ '^[a-z0-9-]{1,60}$'),
  kind text not null default 'outfit' check (kind in ('outfit', 'collection')),
  title text not null check (length(title) between 1 and 120),
  note text not null default '',
  sort_order integer not null default 0,
  active boolean not null default true
);
create table public.collection_items (
  collection_id text not null references public.collections (id) on delete cascade,
  product_id text not null references public.products (id) on delete cascade,
  sort_order integer not null default 0,
  primary key (collection_id, product_id)
);

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 120),
  subtitle text not null default '',
  link text not null default '/katalog' check (link ~ '^/'),
  tone text not null default 'coral' check (tone in ('coral', 'navy', 'beige')),
  sort_order integer not null default 0,
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz
);

-- One row. delivery_fee NULL means "not configured yet": the app then says so and never guesses a price.
create table public.settings (
  id boolean primary key default true check (id),
  delivery_fee integer check (delivery_fee is null or delivery_fee >= 0),
  delivery_free_from integer check (delivery_free_from is null or delivery_free_from > 0),
  allow_sample_orders boolean not null default false,
  support_contact text check (support_contact is null or length(support_contact) <= 200)
);
insert into public.settings (id) values (true);

create table public.administrators (
  telegram_id bigint primary key,
  name text not null default '',
  role text not null default 'manager' check (role in ('owner', 'manager')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  first_name text not null default '',
  last_name text,
  username text,
  photo_url text,
  language_code text,
  phone text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.cart_items (
  customer_id uuid not null references public.customers (id) on delete cascade,
  product_id text not null references public.products (id) on delete cascade,
  size text not null,
  color_name text not null,
  qty integer not null check (qty between 1 and 99),
  updated_at timestamptz not null default now(),
  primary key (customer_id, product_id, size, color_name)
);

create sequence public.order_number_seq;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.customers (id),
  -- one client-side attempt = one key. (customer, key) is unique, so a retry can never create a second order.
  idempotency_key uuid not null,
  status public.order_status not null default 'new',
  source text not null check (source in ('quick', 'cart')),
  contact_name text not null,
  contact_phone text not null check (contact_phone ~ '^\+998[1-9][0-9]{8}$'),
  contact_address text not null,
  contact_comment text,
  subtotal bigint not null check (subtotal >= 0),
  delivery_fee integer,
  delivery_pending boolean not null,
  total bigint not null check (total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, idempotency_key)
);
create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_status_idx on public.orders (status, created_at desc);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id text references public.products (id) on delete set null,
  variant_id uuid references public.product_variants (id) on delete set null,
  -- snapshots: later catalog edits must not rewrite history
  name text not null,
  brand_name text not null,
  category_id text not null,
  size text not null,
  color_name text not null,
  color_hex text not null,
  unit_price integer not null,
  qty integer not null check (qty between 1 and 99)
);
create index order_items_order_idx on public.order_items (order_id);

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  status public.order_status not null,
  changed_by_telegram_id bigint,
  created_at timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

-- Messages the bot must send (admin alerts, customer confirmations). Sent by the notify code, retried on failure.
create table public.notification_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('order_admin', 'order_customer', 'status_customer')),
  order_id uuid not null references public.orders (id) on delete cascade,
  chat_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notification_outbox_pending_idx on public.notification_outbox (next_attempt_at) where status = 'pending';
