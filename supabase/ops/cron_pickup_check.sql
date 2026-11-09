-- Read-only checks for the pickup-sweep cron job. Safe to run any time in the SQL editor. Prints no secrets.

-- 1. Is the job scheduled and active?
select jobid, jobname, schedule, active from cron.job where jobname = 'aynimo-pickup-sweep';

-- 2. Did pg_cron start it? (last 10 runs; status should be 'succeeded')
select d.runid, d.status, d.start_time, d.end_time, left(d.return_message, 120) as message
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where j.jobname = 'aynimo-pickup-sweep' order by d.start_time desc limit 10;

-- 3. What did the Edge Function answer? 200 = ok, 401 = Vault secret differs from CRON_SECRET, 404 = function not deployed.
select id, status_code, left(content, 160) as response, created
from net._http_response order by created desc limit 10;

-- 4. Heartbeat written by the function itself: status must be 'ok' (last_ok_at less than 3 minutes ago).
select job_name, last_run_at, last_ok_at, now() - last_ok_at as age, last_result,
       case when last_ok_at is null then 'never'
            when last_ok_at > now() - interval '3 minutes' then 'ok'
            when last_run_at > now() - interval '3 minutes' then 'failing'
            else 'stale' end as status
from public.job_heartbeats where job_name = 'pickup-sweep';

-- 5. Open orders that are overdue by more than 2 minutes (must be 0 while cron works).
select
  (select count(*) from public.pickup_orders where status = 'pending' and pending_expires_at < now() - interval '2 minutes') as overdue_pending,
  (select count(*) from public.pickup_orders where status = 'ready_for_pickup' and ready_expires_at < now() - interval '2 minutes') as overdue_ready,
  (select count(*) from public.pickup_outbox where status = 'pending') as bot_messages_waiting,
  (select count(*) from public.pickup_outbox where status = 'failed') as bot_messages_failed;
