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
| 3 | Catalog filters/sorting, product details | next |
| 4 | Quick Order, cart | planned |
| 5 | Supabase database, storage | planned |
| 6 | Admin dashboard, orders | planned |
| 7 | Telegram bot | planned |
| 8 | Security, testing | planned |
| 9 | Deployment, Mini App configuration | planned |

**Everything shown in the app is temporary sample data** (`src/data/sample.ts`): names, prices, stock and the vector product
illustrations are placeholders and every product card is marked `NAMUNA`. There is **no backend yet**: nothing is saved
on a server, and no order can be placed. Quick Order and the cart are explicit "coming in phase 4" screens.

## Navigation

Exactly five items: **ASOSIY · KATALOG · TEZKOR BUYURTMA · SAVATCHA · PROFIL**. Quick Order is the emphasised Coral Red
centre button with a lightning icon. There is no favorites / wishlist feature anywhere in the project.

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

`tests/e2e/smoke.cjs` drives the production build in Chrome at phone sizes (320–430 px): navigation order and Coral Red
centre button, all homepage sections, search / filters, product and outfit pages, deep links, Telegram hash parameters,
absence of favorites text, horizontal overflow, console errors and failed requests. It also writes screenshots to
`tests/e2e/shots/` (git-ignored).

```bash
npm run build && npm run test:e2e     # uses /usr/bin/google-chrome, or set CHROME_PATH
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
