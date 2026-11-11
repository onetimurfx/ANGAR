# Architecture and roadmap

## Principles
- Telegram Mini App only. No public shop website, no Android/iOS apps.
- ANGAR administrators manage all products. No seller registration.
- No fake success: until a backend exists, the UI says so instead of pretending.

## Planned architecture
- **Frontend** (this repo, `src/`): `pages/`, `components/`, `lib/`, `i18n/` (Uzbek Latin now; ru/en dictionaries later), `data/`.
- **Auth:** an Edge Function verifies Telegram `initData` (HMAC with the bot token) and returns a short-lived JWT. The bot token and the service-role key never reach the browser.
- **Database:** PostgreSQL with RLS. Entities: products, categories, brands, product_variants, inventory, customers, orders, order_items, promotions, collections, administrators.
- **Orders:** one atomic SQL function (`place_order`) validates variants and stock, decrements inventory, creates a unique order number and honours an idempotency key to block duplicate submissions. Cart and Quick Order both call it but work independently.
- **Admin:** a protected `/admin` area inside the same Mini App; authorisation is checked on the server against the `administrators` table (Telegram ID).
- **Bot:** Python + aiogram 3 (webhook): `/start` welcome in Uzbek, WebApp launch button, admin new-order alerts, customer confirmations and status updates.
- **Hosting:** HTTPS front-end host (Vercel / Cloudflare Pages / GitHub Pages for previews) + a small host for the bot.

## Needed from the owner before Phase 5+
Supabase project (URL + anon key), BotFather token (set only as a secret), admin Telegram ID(s), bot hosting choice,
delivery cost, support contact, real product data and photos.
