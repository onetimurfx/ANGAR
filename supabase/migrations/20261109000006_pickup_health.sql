-- Phase 6 / stage C: cron health for the pickup sweep.
-- Additive only: two new functions. No table, column or existing function is changed.

-- Called by the pickup-sweep Edge Function when sweep_pickup() raised. It records that the job RAN and FAILED
-- without touching last_ok_at, so a failing sweep is visible (status 'failing') instead of looking healthy.
create function public.pickup_sweep_failed(p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.job_heartbeats (job_name, last_run_at, last_ok_at, last_result)
  values ('pickup-sweep', now(), null, jsonb_build_object('error', left(coalesce(p_error, 'unknown'), 200)))
  on conflict (job_name) do update
    set last_run_at = excluded.last_run_at, last_result = excluded.last_result;
$$;

-- Admin-only health report (the admin panel shows a banner when healthy = false).
--   never   : the sweep has not completed even once (cron not installed yet)
--   stale   : no run for more than 3 minutes (cron stopped)
--   failing : it keeps running but sweep_pickup() raises
--   ok
-- Independently of the heartbeat, `overdue` counts orders whose deadline passed more than 2 minutes ago and are
-- still open: that is also true when the job "runs" but does nothing.
create function public.pickup_health(p_admin bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  hb public.job_heartbeats%rowtype;
  v_status text;
  v_overdue_pending integer;
  v_overdue_ready integer;
begin
  perform public.pickup_require_admin(p_admin);
  select * into hb from public.job_heartbeats where job_name = 'pickup-sweep';
  if not found or hb.last_ok_at is null then
    v_status := case when found and hb.last_run_at > now() - interval '3 minutes' then 'failing' else 'never' end;
  elsif hb.last_ok_at > now() - interval '3 minutes' then
    v_status := 'ok';
  elsif hb.last_run_at > now() - interval '3 minutes' then
    v_status := 'failing';
  else
    v_status := 'stale';
  end if;
  select count(*) into v_overdue_pending from public.pickup_orders
   where status = 'pending' and pending_expires_at < now() - interval '2 minutes';
  select count(*) into v_overdue_ready from public.pickup_orders
   where status = 'ready_for_pickup' and ready_expires_at < now() - interval '2 minutes';
  return jsonb_build_object(
    'healthy', v_status = 'ok' and v_overdue_pending = 0 and v_overdue_ready = 0,
    'sweep', jsonb_build_object('status', v_status, 'lastRunAt', hb.last_run_at, 'lastOkAt', hb.last_ok_at,
                                'ageSeconds', case when hb.last_ok_at is not null then extract(epoch from now() - hb.last_ok_at)::integer end),
    'overdue', jsonb_build_object('pending', v_overdue_pending, 'ready', v_overdue_ready),
    'outbox', jsonb_build_object(
      'pending', (select count(*) from public.pickup_outbox where status = 'pending'),
      'failed', (select count(*) from public.pickup_outbox where status = 'failed'),
      'oldestPendingSeconds', (select extract(epoch from now() - min(created_at))::integer from public.pickup_outbox where status = 'pending')));
end $$;

revoke all on function public.pickup_sweep_failed(text), public.pickup_health(bigint) from public, anon, authenticated;
grant execute on function public.pickup_sweep_failed(text), public.pickup_health(bigint) to service_role;
