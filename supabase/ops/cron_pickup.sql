-- ============================================================================================================
-- AYNIMO Phase 6: schedule the pickup-sweep job (pg_cron + pg_net + Vault).        >>> RUN BY THE OWNER, ONCE <<<
-- Run it in the Supabase SQL editor ONLY after: migrations are applied, the pickup-sweep Edge Function is deployed,
-- CRON_SECRET is set in Edge Function secrets, and the two Vault secrets below exist.
--
-- This file contains NO secret value. The secret values are typed into the dashboard UI, never into SQL:
--   Dashboard > Edge Functions > Secrets     : CRON_SECRET          (random, 32+ chars)
--   Dashboard > Integrations > Vault > Add   : name  aynimo_cron_secret   value = the SAME CRON_SECRET
--   Dashboard > Integrations > Vault > Add   : name  aynimo_project_url   value = https://<project-ref>.supabase.co
-- (Edge Function secrets cannot be read back by SQL, so the same value is stored once in each place.)
-- ============================================================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Refuse to schedule a job that could only fail: both Vault secrets must exist and be non-empty.
do $$
begin
  if coalesce((select length(decrypted_secret) from vault.decrypted_secrets where name = 'aynimo_cron_secret'), 0) < 16 then
    raise exception 'Vault secret aynimo_cron_secret is missing or shorter than 16 characters. Add it in Dashboard > Vault first.';
  end if;
  if coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'aynimo_project_url'), '') !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 'Vault secret aynimo_project_url is missing or is not of the form https://<project-ref>.supabase.co';
  end if;
end $$;

-- Idempotent: replace the job if it already exists.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'aynimo-pickup-sweep') then
    perform cron.unschedule('aynimo-pickup-sweep');
  end if;
end $$;

-- Every minute. The secret is read from Vault at run time; it is never stored in the job text or the logs.
select cron.schedule(
  'aynimo-pickup-sweep',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'aynimo_project_url') || '/functions/v1/pickup-sweep',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aynimo_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000);
  $job$);

-- To stop the job:  select cron.unschedule('aynimo-pickup-sweep');
