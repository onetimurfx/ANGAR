-- Phase 6 / stage A1: Quick Order = STORE PICKUP. Additive only: new types, sequence and tables.
-- Nothing here changes or deletes existing data. The Cart (orders / order_items / cart_items) is untouched.

create type public.pickup_status as enum ('pending', 'preparing', 'ready_for_pickup', 'completed', 'cancelled', 'expired');
-- 'refunded' is reserved for a future refund flow: no code path sets it and a CHECK below forbids it for now.
create type public.pickup_payment_status as enum ('unpaid', 'paid', 'refunded');
create type public.pickup_payment_method as enum ('pay_at_store');
create type public.reservation_status as enum ('active', 'released', 'consumed');

create sequence public.pickup_number_seq;

-- ---------------------------------------------------------------- settings (single row)
create table public.pickup_settings (
  id boolean primary key default true check (id),
  pending_timeout_minutes integer not null default 30 check (pending_timeout_minutes between 1 and 1440),
  ready_hold_hours integer not null default 24 check (ready_hold_hours between 1 and 720),
  max_active_per_customer integer not null default 3 check (max_active_per_customer between 1 and 20),
  max_lines integer not null default 10 check (max_lines between 1 and 50),
  -- store details are NOT invented: NULL until the owner enters them in the admin panel
  store_address text check (store_address is null or length(store_address) <= 300),
  store_phone text check (store_phone is null or length(store_phone) <= 40),
  store_hours text check (store_hours is null or length(store_hours) <= 300),
  updated_at timestamptz not null default now(),
  updated_by bigint
);
insert into public.pickup_settings default values;

-- ---------------------------------------------------------------- orders
create table public.pickup_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.customers (id),
  -- one client-side attempt = one key; (customer, key) is unique so a retry can never create a second order
  idempotency_key uuid not null,
  status public.pickup_status not null default 'pending',
  contact_name text not null,
  contact_phone text not null check (contact_phone ~ '^\+998[1-9][0-9]{8}$'),
  contact_comment text check (contact_comment is null or length(contact_comment) <= 300),
  -- no delivery, no address: the customer collects the order in the store
  subtotal bigint not null check (subtotal >= 0),
  total bigint not null check (total >= 0),

  payment_status public.pickup_payment_status not null default 'unpaid',
  payment_method public.pickup_payment_method not null default 'pay_at_store',
  paid_at timestamptz,

  pending_expires_at timestamptz,
  pickup_code text,
  ready_at timestamptz,
  ready_expires_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  closed_reason text check (closed_reason in ('customer_cancelled', 'admin_cancelled', 'pending_timeout', 'pickup_timeout')),
  close_note text check (close_note is null or length(close_note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (customer_id, idempotency_key),

  -- ---- payment is protected by the database itself, not only by application code ----
  -- completed REQUIRES paid + a payment time. 'refunded' does NOT satisfy it.
  constraint pickup_completed_requires_payment
    check (status <> 'completed' or (payment_status = 'paid' and paid_at is not null)),
  -- 'paid' is only possible for a completed order (pay at the store, at handover)
  constraint pickup_paid_only_when_completed
    check (payment_status <> 'paid' or status = 'completed'),
  constraint pickup_paid_at_matches_payment
    check ((payment_status = 'paid') = (paid_at is not null)),
  -- the refund flow does not exist yet: drop this constraint in the migration that introduces it
  constraint pickup_refund_not_enabled
    check (payment_status <> 'refunded'),

  -- ---- code and timestamps must match the status ----
  constraint pickup_code_format check (pickup_code is null or pickup_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  constraint pickup_code_not_before_ready check (status not in ('pending', 'preparing') or pickup_code is null),
  constraint pickup_ready_has_code check (status <> 'ready_for_pickup' or (pickup_code is not null and ready_expires_at is not null and ready_at is not null)),
  constraint pickup_completed_at_matches check ((status = 'completed') = (completed_at is not null)),
  constraint pickup_closed_matches check ((status in ('cancelled', 'expired')) = (closed_reason is not null and closed_at is not null)),
  constraint pickup_closed_reason_matches_status check (
    closed_reason is null
    or (status = 'cancelled' and closed_reason in ('customer_cancelled', 'admin_cancelled'))
    or (status = 'expired' and closed_reason in ('pending_timeout', 'pickup_timeout'))),
  constraint pickup_admin_cancel_has_note check (closed_reason is distinct from 'admin_cancelled' or length(btrim(coalesce(close_note, ''))) >= 3)
);
create unique index pickup_orders_code_uidx on public.pickup_orders (pickup_code) where pickup_code is not null;
create index pickup_orders_customer_idx on public.pickup_orders (customer_id, created_at desc);
create index pickup_orders_active_customer_idx on public.pickup_orders (customer_id) where status in ('pending', 'preparing', 'ready_for_pickup');
create index pickup_orders_status_idx on public.pickup_orders (status, created_at desc);
create index pickup_orders_pending_expiry_idx on public.pickup_orders (pending_expires_at) where status = 'pending';
create index pickup_orders_ready_expiry_idx on public.pickup_orders (ready_expires_at) where status = 'ready_for_pickup';

create table public.pickup_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pickup_orders (id) on delete cascade,
  product_id text references public.products (id) on delete set null,
  variant_id uuid references public.product_variants (id) on delete set null,
  -- snapshots: later catalog edits must not rewrite history
  name text not null,
  brand_name text not null,
  category_id text not null,
  size text not null,
  color_name text not null,
  color_hex text not null,
  unit_price integer not null check (unit_price >= 0),
  qty integer not null check (qty between 1 and 99)
);
create index pickup_order_items_order_idx on public.pickup_order_items (order_id);

-- ---------------------------------------------------------------- stock reservations
-- available = inventory.quantity - SUM(active, not expired reservations). inventory itself only changes on handover.
create table public.stock_reservations (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.pickup_orders (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  qty integer not null check (qty between 1 and 99),
  status public.reservation_status not null default 'active',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (order_id, variant_id),
  -- a settled reservation can no longer expire, and every settled one carries its settle time
  constraint reservation_settled_has_no_expiry check (status = 'active' or expires_at is null),
  constraint reservation_settled_at_matches check ((status = 'active') = (settled_at is null))
);
create index stock_reservations_variant_active_idx on public.stock_reservations (variant_id) where status = 'active';
create index stock_reservations_order_idx on public.stock_reservations (order_id);

-- ---------------------------------------------------------------- audit trail
create table public.pickup_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.pickup_orders (id) on delete cascade,
  kind text not null check (kind in ('status', 'payment')),
  status public.pickup_status not null,
  actor_role text not null check (actor_role in ('customer', 'admin', 'system')),
  actor_telegram_id bigint,
  -- payment events: how much the admin confirmed receiving
  amount bigint check (amount is null or amount >= 0),
  payment_method public.pickup_payment_method,
  note text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now(),
  constraint history_payment_has_amount_and_admin
    check (kind <> 'payment' or (amount is not null and payment_method is not null and actor_role = 'admin' and actor_telegram_id is not null)),
  constraint history_actor_needs_id check (actor_role = 'system' or actor_telegram_id is not null)
);
create index pickup_status_history_order_idx on public.pickup_status_history (order_id, id);

-- failed and successful code checks (rate limiting + audit). A failed check must be stored, so it is never an exception.
create table public.pickup_code_attempts (
  id bigint generated always as identity primary key,
  admin_telegram_id bigint not null,
  order_id uuid references public.pickup_orders (id) on delete set null,
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index pickup_code_attempts_admin_idx on public.pickup_code_attempts (admin_telegram_id, created_at desc);

-- ---------------------------------------------------------------- bot messages for pickup orders
-- Separate from notification_outbox on purpose: the existing outbox points at the Cart orders table and the
-- existing notify-outbox worker must never pick up (and fail on) pickup rows.
create table public.pickup_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('pickup_admin', 'pickup_customer')),
  event text not null check (event in ('new', 'preparing', 'ready', 'completed', 'cancelled', 'expired')),
  pickup_order_id uuid not null references public.pickup_orders (id) on delete cascade,
  chat_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index pickup_outbox_pending_idx on public.pickup_outbox (next_attempt_at) where status = 'pending';

-- ---------------------------------------------------------------- cron health
create table public.job_heartbeats (
  job_name text primary key,
  last_run_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_result jsonb
);
