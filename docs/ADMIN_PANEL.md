# Admin panel (`/admin`) — stage E

Inside the same Mini App, lazy-loaded (its own bundle, the shop's Dock/Carts are not loaded). Reached from Profile → "Admin panel"
(shown only to administrators; this is a UI hint — the server decides) or by opening `/admin`.

| Section | What it does |
|---|---|
| Dashboard | Cart orders (new/confirmed/preparing/shipped, today, delivery price missing) and Quick orders (pending/preparing/ready/completed today) **separately**; stock out/low; catalog; customers; latest orders |
| Buyurtmalar | **Cart** (delivery) orders: filter by status, search by number/name/phone, details, status flow, delivery fee, cancel with reason (stock returns) |
| Pickup | **Quick** (store pickup) orders via `admin-pickup`: start, ready (code goes to the customer, never shown here), hand over (code + payment confirmed), cancel; cron health banner |
| Mahsulotlar | list/search/filter; create/edit product, variants (size/colour/SKU/active, starting stock), photos (signed upload, cover, delete), hide/show |
| Kategoriyalar | categories and brands (create, rename, order, hide; owner deletes empty categories) |
| Ombor | stock by variant: available vs reserved; count (`set`) or change (`add`) with a reason; low/out filter |
| Mijozlar | read-only list/search and order history (Cart + pickup) |
| Sozlamalar | delivery fee/free-from/support/sample switch; store address/phone/hours and pickup limits (owner edits, manager reads); administrators listed read-only |

## Security model
* Roles: `owner` (everything) and `manager` (everything except settings, deleting categories and the sample flag).
* Authentication = Telegram `initData` → signed session. Authorisation = `administrators` row, checked on **every** call in the Edge Function **and** inside every `admin_*` SQL function (defence in depth). Deactivating an administrator takes effect on the next call.
* Admin rights cannot be given or changed through the panel/API: no function writes `administrators`. Add/remove administrators in the Supabase SQL editor (BACKEND_SETUP.md step 5).
* The service-role key exists only in the Edge Function environment (Supabase injects it) and is used to sign Storage uploads. The browser receives only a one-time signed upload URL for one path; the bundle never contains the key (checked by `tests/unit`).
* `admin_*` functions and the new tables are granted to `service_role` only; RLS is on; `anon`/`authenticated` cannot execute or read them (DB-tested).
* Errors shown to admins are Uzbek messages mapped from machine codes; technical detail is never shown.

## Deploy (NOT done by this change — owner's decision)
1. Apply `supabase/migrations/20261111000001_admin_panel.sql` (additive: new tables, one new column, new functions; Cart/pickup data untouched). Needs migrations 1–7 first.
2. Deploy the Edge Function `admin-api` (`verify_jwt = false` is in `supabase/config.toml`). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase automatically.
3. Publish the front-end. The panel works as soon as 1–2 are live; before that it shows "Admin xizmati hali yoqilmagan".
4. Rollback: `supabase/rollback/20261111_admin_rollback.sql` (refuses while audit/stock-adjustment history exists; run it before the stage-D rollback if both are needed).

## Tests
`tests/db/admin-sql.test.ts` (SQL rules, privileges), `tests/db/admin-api.test.ts` (handler: auth matrix, validation, owner-only, Storage mock, secret hygiene), `tests/unit/admin.test.ts`, `tests/e2e/admin.cjs` (browser: access, every section, mobile 390/320 and desktop).
