# AYNIMO — premium fashion Telegram Mini App

AYNIMO runs **entirely inside Telegram** as a Mini App (no public website, no native apps).
The customer presses START in the bot, taps "🛍 AYNIMO do'koniga kirish" and shops without leaving Telegram.

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS 4 · Framer Motion · Lucide · official Telegram WebApp API.
Planned backend: Supabase (Postgres, Storage, Edge Functions) and a Python (aiogram 3) bot. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Project setup, design system | done |
| 2 | Mini App shell, bottom navigation, homepage | done |
| 3 | Catalog filters/sorting, product details, cart state | done |
| 4 | Quick Order, cart | planned |
| 5 | Supabase database, storage | planned |
| 6 | Admin dashboard, orders | planned |
| 7 | Telegram bot | planned |
| 8 | Security, testing | planned |
| 9 | Deployment, Mini App configuration | planned |

**Everything shown in the app is temporary sample data** (`src/data/sample.ts`): names, prices, stock and the vector product
illustrations are placeholders and every product card is marked `NAMUNA`. There is **no backend yet**: nothing is saved
on a server, and no order can be placed. The cart (localStorage) and the Quick Order selection (sessionStorage) already work
on the device, but the checkout / order form is an explicit "coming in phase 4" notice.

## Navigation

Exactly five items: **ASOSIY · KATALOG · TEZKOR BUYURTMA · SAVATCHA · PROFIL**. Quick Order is the emphasised Coral Red
centre button with a lightning icon. There is no favorites / wishlist feature anywhere in the project.

## Phase 3 features

- **Filters** (bottom sheet, live result count, state kept in the URL so reload/back/share keep it): category, type
  (new / discount / AYNIMO Original / other brands), brand (multi), size (multi), colour (multi), price range, availability.
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

## Tests

- `npm test` – 33 unit tests (Vitest) for filtering, sorting, URL state, cart rules and storage sanitising.
- `npm run test:e2e` – Chrome end-to-end suites against the production build at phone sizes (320–430 px):
  - `smoke.cjs` (phases 1–2): navigation order and Coral Red centre button, homepage sections, routing, Telegram hash
    parameters, overflow, console errors.
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
