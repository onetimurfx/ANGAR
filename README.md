# ANGAR — premium fashion Telegram Mini App

ANGAR runs **entirely inside Telegram** as a Mini App (no public website, no native apps).
The customer presses START in the bot, taps "🛍 ANGAR do'koniga kirish" and shops without leaving Telegram.

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS 4 · Framer Motion · Lucide · official Telegram WebApp API.
Planned backend: Supabase (Postgres, Storage, Edge Functions) and a Python (aiogram 3) bot. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Project setup, design system | done |
| 2 | Mini App shell, bottom navigation, homepage | done |
| 3 | Catalog filters/sorting, product details, cart state | done |
| 4 | Quick Order, cart, checkout (device-only drafts) | done |
| 5 | Supabase backend (schema, RLS, Edge Functions, live catalog/cart/orders) | done in code; **your Supabase project must still be created** - see [docs/BACKEND_SETUP.md](docs/BACKEND_SETUP.md) |
| 6 | Admin dashboard, orders | planned |
| 7 | Telegram bot | planned |
| 8 | Security, testing | planned |
| 9 | Deployment, Mini App configuration | planned |

**Demo vs server mode.** With `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` set, the catalog, stock, cart and orders come from Supabase
and orders are really stored (official numbers `AYN-YYMMDD-00001`). Without them the app runs in demo mode: the built-in
sample catalog (`src/data/sample.ts`, every product marked `NAMUNA`) and device-only drafts that are clearly shown as *not sent*.
Sample products can never be ordered in server mode. The delivery fee is never invented: it shows as "not set" until the shop sets it.

## Navigation

Exactly five items: **ASOSIY · KATALOG · TEZKOR BUYURTMA · SAVATCHA · PROFIL**. Quick Order is the emphasised Coral Red
centre button with a lightning icon. There is no favorites / wishlist feature anywhere in the project.

## Phase 3 features

- **Filters** (bottom sheet, live result count, state kept in the URL so reload/back/share keep it): category, type
  (new / discount / ANGAR Original / other brands), brand (multi), size (multi), colour (multi), price range, availability.
  OR inside a group, AND across groups. Removable chips summarise active filters; unknown URL values are ignored safely.
- **Sorting:** popularity, newest, lowest price, highest price.
- **Product page:** swipeable 4-image gallery with synced thumbnails and a full-screen viewer (buttons, arrow keys, swipe),
  colour and size pickers, quantity stepper capped at stock, stock status (in stock / "Oxirgi N dona qoldi" / sold out),
  description and details, similar products, matching outfits, a glass purchase bar with the running total, **Add to cart**
  and **Quick Order**. Both buttons validate size, stock and quantity first.
- **Cart:** persisted in `localStorage`, merges identical variants, caps the total per product at stock, sanitises
  corrupted/stale storage. The tab bar shows a live badge. **Quick Order** keeps its own selection and never touches the cart.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check + production build -> dist/
npm run preview      # serve dist/ at http://127.0.0.1:4173
```

Outside Telegram the app opens in *preview mode* (the Telegram script is optional). Inside Telegram it calls `ready()`,
`expand()`, sets header/background colours, syncs the stable viewport height, honours safe-area insets and shows the native
BackButton on inner screens.

## Phase 4 features

- **Navigation on every screen:** the five-item bar is always visible, including on product pages. Purchase panels (product,
  cart) are a separate glass panel stacked *above* the bar (`Dock`), so they can never cover it.
- **Quick Order:** product picker (in-stock only), colour, size, quantity (capped at stock), full name, phone, delivery
  address, optional comment. Required fields, phone format (Uzbekistan numbers) and stock are validated; focus moves to the
  first invalid field. Independent from the cart.
- **Cart:** change size/colour (identical variants merge), quantity, remove, subtotal, delivery and final total, checkout form.
- **Delivery fee** is *not configured* by default (the business has not provided it): the UI says "Hali belgilanmagan" and the
  total excludes delivery. Set `VITE_DELIVERY_FEE` (UZS, 0 = free) and optionally `VITE_DELIVERY_FREE_FROM` at build time;
  Phase 6 moves this setting into the admin panel / database (`src/lib/delivery.ts`).
- **Duplicate protection:** each submit attempt has an idempotency key (the draft `id`) kept in `sessionStorage`; double taps,
  retries and re-submits resolve to the same single draft. The same key is what the server will use in Phase 5.
- **Persistence:** cart, form text and saved drafts survive reloads; a saved draft is listed in Profile and can be deleted
  (with confirmation). Typed form data is cleared after saving.
- **Honest status:** confirmation screens and Profile show "Yuborilmagan" / "Do'konga YUBORILMADI" - never "confirmed".

## Tests

- `npm test` – 58 unit tests (Vitest) for filtering, sorting, URL state, cart rules and storage sanitising.
- `npm run test:e2e` – Chrome end-to-end suites against the production build at phone sizes (320–430 px):
  - `smoke.cjs` (phases 1–2): navigation order and Coral Red centre button, homepage sections, routing, Telegram hash
    parameters, overflow, console errors.
  - `phase4.cjs`: nav on every screen, Quick Order validation/double tap/idempotency, cart change/remove/totals, checkout,
    "not sent" wording, persistence, Telegram identity mock, layouts at 320/360/390/430 px, no favorites.
  - `phase3.cjs`: every filter, sorting, gallery/lightbox, selection rules, stock limits, cart, Quick Order hand-off,
    absence of favorites text, layout checks at 320/360/390/430 px. Screenshots go to `tests/e2e/shots/` (git-ignored).

```bash
npm run build && npm test && npm run test:e2e     # uses /usr/bin/google-chrome, or set CHROME_PATH
AYN_BASE=http://127.0.0.1:4173/AYNIMO/ npm run test:e2e   # against a sub-path build (VITE_BASE=/AYNIMO/)
```

## Design system

Coral Red `#D94B59` (accent) · Ivory `#F7F5F0` · Dark Navy `#172B3A` · Beige `#D9BFA3`. Tokens live in `src/index.css`.
Liquid-glass surfaces (`.glass`, `.glass-nav`, `.glass-chip`) use controlled blur with high enough opacity to keep prices
and text readable, and fall back to near-opaque white where `backdrop-filter` is unsupported.

## Routing note

The app uses `BrowserRouter`, not `HashRouter`, because Telegram passes launch parameters (`tgWebAppData`) in the URL hash.
Static hosts need an SPA fallback: the build copies `index.html` to `404.html` (GitHub Pages) — other hosts need a rewrite rule.

## Deploying the preview

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push to `main`
(enable **Settings → Pages → Source: GitHub Actions** once). The URL is `https://<user>.github.io/AYNIMO/`.

## Brand

The brand is **ANGAR** (wordmark: lowercase "angar", yellow, bold rounded; `public/logo.svg`, favicon `public/favicon.svg`).
The project started as AYNIMO; technical identifiers keep the old name on purpose so nothing already deployed breaks:
repository and Pages path, `package.json` name, browser-storage keys `aynimo:*`, the `x-aynimo-session` header, the order-number
prefix `AYN-`, Supabase `project_id`, Vault secret names `aynimo_*` and the cron job `aynimo-pickup-sweep`.
