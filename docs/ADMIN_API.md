# Admin API (stage E)

One Edge Function, `admin-api`, serves the whole admin panel except Quick Order (pickup), which stays on `admin-pickup` (stage D, unchanged).
Both use the same header `x-aynimo-session` and the same rule: **every request** is authenticated (signed session) and authorised
(`public.is_admin(tg)` looked up in the database *now*, then checked again inside each SQL function). The admin identity is the Telegram id of the
session. Nothing in the query string, headers or body can change it, and no route writes the `administrators` table.

Errors: `{ "error": { "code": "…", … } }`. 401 no/invalid session, 403 not an (active) administrator or owner-only action, 400 invalid input
(`field` names the field), 404 unknown id, 409 conflict, 422 reason required, 415/502/503 photo upload problems.

## GET `admin-api?r=<resource>`
| r | extra params | answer |
|---|---|---|
| `me` | | `{ telegramId, name, role }` (`owner` \| `manager`) |
| `dashboard` | `low` (stock threshold, default 3) | `{ cart, pickup, stock, catalog, customers, recentOrders }` |
| `orders` | `status`, `source`, `q`, `limit` (≤100), `offset` | `{ orders, total, counts }` — Cart orders only |
| `order` | `id` (uuid) | `{ order, customer, history }` |
| `categories`, `brands` | | lists with product counts |
| `products` | `q`, `category`, `status` (`active`/`inactive`), `limit`, `offset` | `{ products, total }` |
| `product` | `id` | `{ product }` with variants (stock, reserved) and images |
| `inventory` | `q`, `filter` (`all`/`low`/`out`), `limit`, `offset`, `low` | `{ items, total, threshold }` (`available = quantity − reserved`) |
| `customers` / `customer` | `q`, `limit`, `offset` / `id` | list / `{ customer, orders, pickupOrders }` |
| `settings` | | `{ role, settings, pickup, admins }` (`admins` only for the owner, read-only) |

## POST `admin-api` `{ r, action, … }`
| r:action | body | who |
|---|---|---|
| `order:set_status` | `id, status, note?` — flow new → confirmed → preparing → shipped → delivered; cancel (reason required, stock returned) from new/confirmed/preparing | admin |
| `order:set_delivery` | `id, fee` (while not shipped) | admin |
| `category:save` / `category:delete` | `id?, name, sortOrder, active` / `id` (empty only) | admin / **owner** |
| `brand:save` | `id?, name, type, active` | admin |
| `product:save` | `product { id?, name, brandId, categoryId, description, price, oldPrice, isNew, active, isSample?, variants[] }` | admin (`isSample` change: **owner**) |
| `product:set_active` | `id, active` | admin |
| `product:image_upload_url` | `id, contentType` → `{ path, uploadUrl }` (one-time signed Storage URL, made with the service key **on the server**) | admin |
| `product:image_add` / `image_cover` / `image_delete` | `id, path` / `id` / `id` (image id) | admin |
| `inventory:adjust` | `variantId, mode` (`set`/`add`), `value, reason?` — never below the reserved amount | admin |
| `settings:update` / `settings:update_pickup` | `settings{…}` / `pickup{…}` | **owner** |

Quick Order (pickup) management is `admin-pickup` (see BACKEND_SETUP.md): `GET ?group=…|id=…|view=health`, `POST start_preparing | mark_ready | cancel | complete`.

Every mutation is written to `admin_audit_log` (who, what, target, details); stock changes also to `stock_adjustments`.
