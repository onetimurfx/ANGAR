import { fail, json, readJson, requireAdmin, route } from '../_shared/http.ts'
import { mapDbError, UUID_RE, type ErrorTable } from '../_shared/dbErrors.ts'
import { deliverOutbox } from '../_shared/notify.ts'
import { IMAGE_TYPES, removeObject, signedUploadUrl, storageConfigured } from '../_shared/storage.ts'
import type { Deps } from '../_shared/types.ts'

const ERRORS: ErrorTable = {
  FORBIDDEN: [403, 'FORBIDDEN'],
  NOT_FOUND: [404, 'NOT_FOUND'],
  INVALID_REQUEST: [400, 'INVALID_REQUEST'],
  INVALID_TRANSITION: [409, 'INVALID_TRANSITION'],
  INVALID_REASON: [422, 'INVALID_REASON'],
  IN_USE: [409, 'IN_USE'],
  DUPLICATE_VARIANT: [409, 'DUPLICATE_VARIANT'],
  STOCK_BELOW_RESERVED: [409, 'STOCK_BELOW_RESERVED'],
  FILE_MISSING: [409, 'FILE_MISSING'],
  TOO_MANY_IMAGES: [409, 'TOO_MANY_IMAGES'],
}

// jsonb parameters are sent as ::text::jsonb on purpose: postgres.js JSON-encodes a value typed jsonb, which would double-encode a string.
const PRODUCT_ID_RE = /^[A-Za-z0-9-]{1,60}$/
const SLUG_RE = /^[a-z0-9-]{1,60}$/
const bad = (req: Request, deps: Deps) => fail(req, deps, 400, 'INVALID_REQUEST')

const intParam = (v: string | null, def: number, min: number, max: number): number | null => {
  if (v === null || v === '') return def
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}
const textParam = (v: string | null, max = 100): string | null | undefined => {
  if (v === null || v === '') return null
  return v.length > max ? undefined : v
}
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null)

/**
 * Admin panel API (everything except Quick Order, which stays on `admin-pickup`).
 *
 * EVERY request first passes requireAdmin: a valid signed session AND an active row in `administrators` for the
 * Telegram id of that session, looked up now. The SQL functions check it again (and enforce owner-only actions).
 * The admin identity is the session's Telegram id: nothing in the query or body can change it, and no resource here
 * writes the `administrators` table, so admin rights cannot be granted through this API.
 *
 *   GET  ?r=me|dashboard|orders|order|categories|brands|products|product|inventory|customers|customer|settings
 *   POST { r, ...fields } with r = order | category | brand | product | inventory | settings and an `action`
 */
export const handler = (deps: Deps) =>
  route(['GET', 'POST'], deps, async (req) => {
    const s = await requireAdmin(req, deps)
    if (s instanceof Response) return s
    const admin = s.tg
    const sql = deps.sql

    try {
      if (req.method === 'GET') {
        const q = new URL(req.url).searchParams
        const r = q.get('r')
        const limit = intParam(q.get('limit'), 30, 1, 100)
        const offset = intParam(q.get('offset'), 0, 0, 100000)
        const low = intParam(q.get('low'), 3, 0, 1000)
        const search = textParam(q.get('q'))
        if (limit === null || offset === null || low === null || search === undefined) return bad(req, deps)
        const id = q.get('id')
        const uuid = id !== null && UUID_RE.test(id) ? id : null

        switch (r) {
          case 'me': {
            const [x] = await sql`select public.admin_me(${admin}::bigint) as r`
            return json(req, deps, 200, x.r)
          }
          case 'dashboard': {
            const [x] = await sql`select public.admin_dashboard(${admin}::bigint, ${low}::int) as r`
            return json(req, deps, 200, x.r)
          }
          case 'orders': {
            const [x] = await sql`select public.admin_list_orders(${admin}::bigint, ${textParam(q.get('status'), 20) ?? null}, ${textParam(q.get('source'), 20) ?? null}, ${search}, ${limit}::int, ${offset}::int) as r`
            return json(req, deps, 200, x.r)
          }
          case 'order': {
            if (!uuid) return bad(req, deps)
            const [x] = await sql`select public.admin_get_order(${admin}::bigint, ${uuid}::uuid) as r`
            return json(req, deps, 200, x.r)
          }
          case 'categories': {
            const [x] = await sql`select public.admin_list_categories(${admin}::bigint) as r`
            return json(req, deps, 200, x.r)
          }
          case 'brands': {
            const [x] = await sql`select public.admin_list_brands(${admin}::bigint) as r`
            return json(req, deps, 200, x.r)
          }
          case 'products': {
            const [x] = await sql`select public.admin_list_products(${admin}::bigint, ${search}, ${textParam(q.get('category'), 60) ?? null}, ${textParam(q.get('status'), 20) ?? null}, ${limit}::int, ${offset}::int) as r`
            return json(req, deps, 200, x.r)
          }
          case 'product': {
            if (id === null || !PRODUCT_ID_RE.test(id)) return bad(req, deps)
            const [x] = await sql`select public.admin_get_product(${admin}::bigint, ${id}) as r`
            return json(req, deps, 200, x.r)
          }
          case 'inventory': {
            const [x] = await sql`select public.admin_list_inventory(${admin}::bigint, ${search}, ${textParam(q.get('filter'), 10) ?? 'all'}, ${limit}::int, ${offset}::int, ${low}::int) as r`
            return json(req, deps, 200, x.r)
          }
          case 'customers': {
            const [x] = await sql`select public.admin_list_customers(${admin}::bigint, ${search}, ${limit}::int, ${offset}::int) as r`
            return json(req, deps, 200, x.r)
          }
          case 'customer': {
            if (!uuid) return bad(req, deps)
            const [x] = await sql`select public.admin_get_customer(${admin}::bigint, ${uuid}::uuid) as r`
            return json(req, deps, 200, x.r)
          }
          case 'settings': {
            const [x] = await sql`select public.admin_get_settings(${admin}::bigint) as r`
            return json(req, deps, 200, x.r)
          }
          default:
            return bad(req, deps)
        }
      }

      const body = await readJson(req)
      const b = body.ok ? body.value : null
      if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(req, deps)
      const uuid = typeof b.id === 'string' && UUID_RE.test(b.id) ? b.id : null
      const key = `${String(b.r)}:${String(b.action ?? '')}`

      switch (key) {
        case 'order:set_status': {
          if (!uuid || typeof b.status !== 'string') return bad(req, deps)
          const [x] = await sql`select public.admin_set_order_status(${admin}::bigint, ${uuid}::uuid, ${b.status}, ${str(b.note, 300)}) as r`
          deps.background(deliverOutbox(deps).catch((e) => deps.log('deliverOutbox failed', { message: String(e instanceof Error ? e.message : e) })))
          return json(req, deps, 200, { order: x.r })
        }
        case 'order:set_delivery': {
          const fee = num(b.fee)
          if (!uuid || fee === null) return bad(req, deps)
          const [x] = await sql`select public.admin_set_order_delivery(${admin}::bigint, ${uuid}::uuid, ${fee}::int) as r`
          return json(req, deps, 200, { order: x.r })
        }
        case 'category:save': {
          const sort = b.sortOrder === undefined ? 0 : num(b.sortOrder)
          if (sort === null || typeof b.name !== 'string' || typeof b.active !== 'boolean') return bad(req, deps)
          const id = b.id === undefined || b.id === null ? null : typeof b.id === 'string' && SLUG_RE.test(b.id) ? b.id : undefined
          if (id === undefined) return bad(req, deps)
          const [x] = await sql`select public.admin_save_category(${admin}::bigint, ${id}, ${b.name}, ${sort}::int, ${b.active}::boolean) as r`
          return json(req, deps, 200, { category: x.r })
        }
        case 'category:delete': {
          if (typeof b.id !== 'string' || !SLUG_RE.test(b.id)) return bad(req, deps)
          await sql`select public.admin_delete_category(${admin}::bigint, ${b.id})`
          return json(req, deps, 200, { ok: true })
        }
        case 'brand:save': {
          if (typeof b.name !== 'string' || typeof b.type !== 'string' || typeof b.active !== 'boolean') return bad(req, deps)
          const id = b.id === undefined || b.id === null ? null : typeof b.id === 'string' && SLUG_RE.test(b.id) ? b.id : undefined
          if (id === undefined) return bad(req, deps)
          const [x] = await sql`select public.admin_save_brand(${admin}::bigint, ${id}, ${b.name}, ${b.type}, ${b.active}::boolean) as r`
          return json(req, deps, 200, { brand: x.r })
        }
        case 'product:save': {
          if (!b.product || typeof b.product !== 'object' || Array.isArray(b.product)) return bad(req, deps)
          const [x] = await sql`select public.admin_save_product(${admin}::bigint, ${JSON.stringify(b.product)}::text::jsonb) as r`
          return json(req, deps, 200, x.r)
        }
        case 'product:set_active': {
          if (typeof b.id !== 'string' || !PRODUCT_ID_RE.test(b.id) || typeof b.active !== 'boolean') return bad(req, deps)
          const [x] = await sql`select public.admin_set_product_active(${admin}::bigint, ${b.id}, ${b.active}::boolean) as r`
          return json(req, deps, 200, x.r)
        }
        case 'product:image_upload_url': {
          if (typeof b.id !== 'string' || !PRODUCT_ID_RE.test(b.id) || typeof b.contentType !== 'string') return bad(req, deps)
          const ext = IMAGE_TYPES[b.contentType]
          if (!ext) return fail(req, deps, 415, 'UNSUPPORTED_TYPE')
          // the product must exist (and the caller is an admin: the SQL check) before a URL is issued
          const [p] = await sql`select public.admin_get_product(${admin}::bigint, ${b.id}) as r`
          if (!p?.r) return fail(req, deps, 404, 'NOT_FOUND')
          if (!storageConfigured(deps)) return fail(req, deps, 503, 'STORAGE_UNAVAILABLE')
          const path = `products/${b.id}/${crypto.randomUUID()}.${ext}`
          const uploadUrl = await signedUploadUrl(deps, path)
          if (!uploadUrl) return fail(req, deps, 502, 'STORAGE_UNAVAILABLE')
          return json(req, deps, 200, { path, uploadUrl })
        }
        case 'product:image_add': {
          if (typeof b.id !== 'string' || !PRODUCT_ID_RE.test(b.id) || typeof b.path !== 'string') return bad(req, deps)
          const [x] = await sql`select public.admin_add_product_image(${admin}::bigint, ${b.id}, ${b.path}) as r`
          return json(req, deps, 200, x.r)
        }
        case 'product:image_delete': {
          if (!uuid) return bad(req, deps)
          const [x] = await sql`select public.admin_delete_product_image(${admin}::bigint, ${uuid}::uuid) as r`
          const out = x.r as { path?: string; product: unknown }
          if (typeof out.path === 'string') deps.background(removeObject(deps, out.path))
          return json(req, deps, 200, { product: out.product })
        }
        case 'product:image_cover': {
          if (!uuid) return bad(req, deps)
          const [x] = await sql`select public.admin_set_cover_image(${admin}::bigint, ${uuid}::uuid) as r`
          return json(req, deps, 200, x.r)
        }
        case 'inventory:adjust': {
          const value = num(b.value)
          if (typeof b.variantId !== 'string' || !UUID_RE.test(b.variantId) || typeof b.mode !== 'string' || value === null) return bad(req, deps)
          const [x] = await sql`select public.admin_adjust_stock(${admin}::bigint, ${b.variantId}::uuid, ${b.mode}, ${value}::int, ${str(b.reason, 200)}) as r`
          return json(req, deps, 200, x.r)
        }
        case 'settings:update': {
          if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) return bad(req, deps)
          const [x] = await sql`select public.admin_update_settings(${admin}::bigint, ${JSON.stringify(b.settings)}::text::jsonb) as r`
          return json(req, deps, 200, x.r)
        }
        case 'settings:update_pickup': {
          if (!b.pickup || typeof b.pickup !== 'object' || Array.isArray(b.pickup)) return bad(req, deps)
          const [x] = await sql`select public.admin_update_pickup_settings(${admin}::bigint, ${JSON.stringify(b.pickup)}::text::jsonb) as r`
          return json(req, deps, 200, x.r)
        }
        default:
          return bad(req, deps)
      }
    } catch (e) {
      const mapped = mapDbError(req, deps, e, ERRORS)
      if (mapped) return mapped
      throw e
    }
  })
