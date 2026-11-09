import { fail, json, readJson, requireSession, route } from '../_shared/http.ts'
import { mapDbError, UUID_RE, type ErrorTable } from '../_shared/dbErrors.ts'
import type { Deps } from '../_shared/types.ts'

const ERRORS: ErrorTable = {
  INVALID_CONTACT: [422, 'INVALID_CONTACT'],
  ITEMS_UNAVAILABLE: [409, 'ITEMS_UNAVAILABLE'],
  SAMPLE_PRODUCT: [409, 'SAMPLE_PRODUCT'],
  ACTIVE_LIMIT: [409, 'ACTIVE_LIMIT'],
  TOO_MANY_LINES: [422, 'TOO_MANY_LINES'],
  RATE_LIMITED: [429, 'RATE_LIMITED'],
  EMPTY_ORDER: [400, 'EMPTY_ORDER'],
  INVALID_ITEM: [400, 'INVALID_ITEM'],
  INVALID_REQUEST: [400, 'INVALID_REQUEST'],
  UNKNOWN_CUSTOMER: [401, 'UNAUTHENTICATED'],
  NOT_FOUND: [404, 'NOT_FOUND'],
  NOT_CANCELLABLE: [409, 'NOT_CANCELLABLE'],
}

/**
 * Customer side of Quick Order (store pickup). WHO the customer is comes ONLY from the signed session token
 * (itself issued after the Telegram initData signature was verified). Any customerId / telegramId / isAdmin that
 * the client puts in the body, query or headers is never read.
 *
 *   GET                  -> { orders: [...] }          my pickup orders
 *   GET ?id=<uuid>       -> { order }                  one of MY orders (anything else is 404)
 *   POST { action:'place', idempotencyKey, contact:{name,phone,comment}, items:[{productId,size,color,qty}] }
 *                        -> 201 { duplicate:false, order } | 200 { duplicate:true, order } (same key = same order)
 *   POST { action:'cancel', id }                        -> { order }   only while the order is still `pending`
 */
export const handler = (deps: Deps) =>
  route(['GET', 'POST'], deps, async (req) => {
    const s = await requireSession(req, deps)
    if (s instanceof Response) return s
    const customer = s.sub

    try {
      if (req.method === 'GET') {
        const id = new URL(req.url).searchParams.get('id')
        if (id !== null) {
          if (!UUID_RE.test(id)) return fail(req, deps, 400, 'INVALID_REQUEST')
          const [r] = await deps.sql`select public.get_pickup_order(${customer}::uuid, ${id}::uuid) as o`
          return json(req, deps, 200, { order: r.o })
        }
        const [r] = await deps.sql`select public.my_pickup_orders(${customer}::uuid, 30) as o`
        return json(req, deps, 200, { orders: r.o })
      }

      const body = await readJson(req)
      const b = body.ok ? body.value : null
      if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(req, deps, 400, 'INVALID_REQUEST')

      if (b.action === 'cancel') {
        if (typeof b.id !== 'string' || !UUID_RE.test(b.id)) return fail(req, deps, 400, 'INVALID_REQUEST')
        const [r] = await deps.sql`select public.cancel_pickup_order_customer(${customer}::uuid, ${b.id}::uuid) as o`
        return json(req, deps, 200, { order: r.o })
      }

      if (b.action !== 'place') return fail(req, deps, 400, 'INVALID_REQUEST')
      if (typeof b.idempotencyKey !== 'string' || !UUID_RE.test(b.idempotencyKey)) return fail(req, deps, 400, 'INVALID_REQUEST')
      const c = b.contact
      if (!c || typeof c !== 'object' || Array.isArray(c)) return fail(req, deps, 400, 'INVALID_REQUEST')
      const str = (v: unknown) => (typeof v === 'string' ? v : '')
      // ::text::jsonb on purpose: postgres.js JSON-encodes a value typed jsonb, which would double-encode our string.
      const [r] = await deps.sql`select public.place_pickup_order(${customer}::uuid, ${b.idempotencyKey}::uuid, ${str(c.name)}, ${str(c.phone)},
        ${str(c.comment) || null}, ${JSON.stringify(b.items ?? null)}::text::jsonb) as r`
      const result = r.r as { duplicate: boolean; order: unknown }
      return json(req, deps, result.duplicate ? 200 : 201, result)
    } catch (e) {
      const mapped = mapDbError(req, deps, e, ERRORS)
      if (mapped) return mapped
      throw e
    }
  })
