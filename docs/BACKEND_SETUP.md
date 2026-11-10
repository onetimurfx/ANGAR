# AYNIMO backend setup (Supabase)

The repository contains the complete backend (`supabase/`), but **no Supabase project has been created for you**.
Follow these steps once. **Never paste secrets into chat, issues or code**: they go only into the places named below.

## What is public and what is secret

| Value | Where it lives | Public? |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | GitHub *Variables* (or hosting build env) | yes - ends up in the browser; RLS limits it to reading the active catalog |
| `BOT_TOKEN` (from @BotFather) | Supabase *Edge Function secrets* | **secret** |
| `SESSION_SECRET` (random, 32+ chars) | Supabase Edge Function secrets | **secret** |
| `CRON_SECRET` (random, 16+ chars) | Supabase Edge Function secrets | **secret** |
| `ALLOWED_ORIGINS` (comma separated, e.g. `https://onetimurfx.github.io`) | Supabase Edge Function secrets | not secret |
| service-role key | **not used by this project at all** (functions use the injected `SUPABASE_DB_URL`) | never put it in the frontend |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | GitHub *Secrets* (only for the manual deploy workflow) | secret |

## Steps

1. Create a project at supabase.com. Note the project reference.
2. Apply the schema: `supabase link --project-ref <ref>` then `supabase db push`
   (or run the manual GitHub workflow *Deploy Supabase backend*, which also deploys the functions).
3. Set function secrets in the dashboard (Edge Functions > Secrets) or with the CLI, typing values locally:
   `supabase secrets set BOT_TOKEN=... SESSION_SECRET=$(openssl rand -hex 32) CRON_SECRET=$(openssl rand -hex 16) ALLOWED_ORIGINS=https://<your-pages-origin>`
4. Deploy functions: `supabase functions deploy --no-verify-jwt` (auth is done inside the functions with Telegram initData).
5. Add administrators (only these Telegram IDs may use admin features): in the SQL editor
   `insert into public.administrators (telegram_id, name) values (<telegram id>, '<name>');`
6. Frontend: in GitHub > Settings > Secrets and variables > Actions > **Variables** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then push to `main`.
7. Bot messages: schedule `POST https://<ref>.supabase.co/functions/v1/notify-outbox` with header `x-cron-secret: <CRON_SECRET>`
   every minute (Supabase Cron / pg_cron) so failed notifications are retried. New orders also try to notify immediately.
8. Delivery fee: it stays "not set" until you set `settings.delivery_fee` (UZS). The app never invents a price.
9. Real products: insert into `categories`, `brands`, `products`, `product_variants`, `inventory` (Phase 6 adds the admin panel).
   Placeholder products must keep `is_sample = true`; they are shown as NAMUNA and cannot be ordered
   (`settings.allow_sample_orders` is false).

Without steps 1-6 the app runs in **demo mode**: sample catalog, orders are *not sent* and every screen says so.

## Security model

- Browser -> `get_catalog()` with the anon key only; RLS is enabled on all 17 tables, private tables are denied to `anon`/`authenticated`.
- Customer data -> Edge Functions only. `telegram-auth` verifies the Telegram `initData` HMAC (and age) and returns a short-lived signed session.
- Admin rights are checked in the database (`administrators`) on every call, never stored in the token.
- `place_order` re-prices from the catalog, locks inventory rows, refuses insufficient stock and duplicates (idempotency key per customer), rate limits to 20/hour.

## Tests

`npm test` (unit + secret scan) - `npm run test:db` (real PostgreSQL: migrations, RLS, SQL functions, Edge Function handlers) -
`node tests/e2e/live.cjs` (browser against a real DB + the real handlers; only Telegram's Bot API is faked) - `npm run test:e2e`.

## Quick Order (store pickup): bot messages and the pickup-sweep cron (Phase 6, stage C)

Nothing here is active until the owner runs it. The stage-A/C migrations and the cron script are **not** applied automatically.

**What runs every minute.** `pickup-sweep` (Edge Function) does two things: (1) `sweep_pickup()` expires `pending` orders older than 30 minutes
and `ready_for_pickup` orders older than 24 hours, releases their reservations and queues a customer message; `preparing` orders are never
touched; (2) sends / retries the queued Telegram messages (`pickup_outbox`, up to 6 attempts with growing delay, each message sent once).
It writes `job_heartbeats('pickup-sweep')`. New orders and status changes also try to send their messages immediately; the cron is the safety net.

**Secrets (never in Git, the frontend or logs).** `BOT_TOKEN` and `CRON_SECRET` live only in *Edge Functions > Secrets*. Because SQL cannot read
Edge Function secrets, the cron secret is stored a second time in **Vault**, typed in the dashboard (not in SQL):

1. Edge Functions > Secrets: `CRON_SECRET` = a random 32+ character value (the same one used for `notify-outbox`).
2. Integrations > Vault > Add secret: name `aynimo_cron_secret`, value = the **same** `CRON_SECRET`.
3. Integrations > Vault > Add secret: name `aynimo_project_url`, value = `https://<project-ref>.supabase.co`.
4. After migrations are applied and `pickup-sweep` is deployed, open `supabase/ops/cron_pickup.sql` in the SQL editor and run it once
   (it refuses to schedule if a Vault secret is missing, and can be re-run safely).

**Checking that it works.** Run `supabase/ops/cron_pickup_check.sql` (read-only, prints no secret): the job must be `active`, runs `succeeded`,
`net._http_response` must show `200` (`401` = Vault value differs from `CRON_SECRET`, `404` = function not deployed) and the heartbeat status `ok`.

**How a stopped cron is detected.** `pickup_health` (admin only, `GET admin-pickup?view=health`) returns `healthy:false` when the heartbeat is
`never` (not installed), `stale` (no run for 3+ minutes) or `failing` (the sweep raises; the failure is recorded), or when open orders are more
than 2 minutes past their deadline. The admin panel (stage E) shows a banner from this. Even with cron down, an expired reservation stops
blocking stock because availability ignores expired reservations.

## Quick Order screens and retiring `source='quick'` (Phase 6, stage D)

Quick Order is now store pickup only (own basket, own server tables, no address, no delivery) and is separate from the Cart.
`place_order` (Cart) accepts `source='cart'` only; `'quick'` is refused with `QUICK_ORDER_MOVED` (HTTP 410 from `place-order`).

**Deploy together, in this order, when the owner decides to go live** (nothing is applied automatically):
1. apply migrations `…000001` to `…000007` (7 = the `place_order` change), 2. deploy the Edge Functions (`pickup-order`, `admin-pickup`,
`pickup-sweep`, updated `place-order`), 3. publish the new front-end, 4. install the cron (`supabase/ops/cron_pickup.sql`).
The Phase 5 front-end still sends `'quick'`, so migration 7 must not go live before the new front-end does. Existing orders created
with `source='quick'` stay readable.
