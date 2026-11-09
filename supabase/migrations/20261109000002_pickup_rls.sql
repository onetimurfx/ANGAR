-- Phase 6 / stage A2: RLS for the pickup tables. They hold customer data and money: the browser (anon /
-- authenticated) gets NO access at all. Only Edge Functions (service_role) read and write them, through the
-- SECURITY DEFINER functions of the next migration. No policies are created on purpose.

alter table public.pickup_settings enable row level security;
alter table public.pickup_orders enable row level security;
alter table public.pickup_order_items enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.pickup_status_history enable row level security;
alter table public.pickup_code_attempts enable row level security;
alter table public.pickup_outbox enable row level security;
alter table public.job_heartbeats enable row level security;

revoke all on public.pickup_settings, public.pickup_orders, public.pickup_order_items, public.stock_reservations,
  public.pickup_status_history, public.pickup_code_attempts, public.pickup_outbox, public.job_heartbeats
  from anon, authenticated;
revoke all on sequence public.pickup_number_seq from anon, authenticated;
grant all on public.pickup_settings, public.pickup_orders, public.pickup_order_items, public.stock_reservations,
  public.pickup_status_history, public.pickup_code_attempts, public.pickup_outbox, public.job_heartbeats to service_role;
grant all on all sequences in schema public to service_role;
