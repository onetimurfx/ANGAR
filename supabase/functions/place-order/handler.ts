import { fail, json, readJson, requireSession, route } from '../_shared/http.ts'
import { deliverOutbox } from '../_shared/notify.ts'
import type { Deps } from '../_shared/types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CODES: Record<string, [number, string]> = {
  INVALID_CONTACT: [422, 'INVALID_CONTACT'],
  ITEMS_UNAVAILABLE: [409, 'ITEMS_UNAVAILABLE'],
  SAMPLE_PRODUCT: [409, 'SAMPLE_PRODUCT'],
  RATE_LIMITED: [429, 'RATE_LIMITED'],
  EMPTY_ORDER: [400, 'EMPTY_ORDER'],
  INVALID_ITEM: [400, 'INVALID_ITEM'],
  INVALID_REQUEST: [400, 'INVALID_REQUEST'],
  UNKNOWN_CUSTOMER: [401, 'UNAUTHENTICATED'],
  QUICK_ORDER_MOVED: [410, 'QUICK_ORDER_MOVED'],
}

/** POST { idempotencyKey, source:'cart', contact, items } -> creates the order (or returns the existing one for the same key). */
export const handler = (deps: Deps) =>
  route(['POST'], deps, async (req) => {
    const s = await requireSession(req, deps)
    if (s instanceof Response) return s
    const body = await readJson(req)
    const b = body.ok ? body.value : null
    if (!b || typeof b !== 'object' || typeof b.idempotencyKey !== 'string' || !UUID.test(b.idempotencyKey)) return fail(req, deps, 400, 'INVALID_REQUEST')
    // Quick Order is store pickup now (pickup-order function); this endpoint serves the Cart only
    if (b.source === 'quick') return fail(req, deps, 410, 'QUICK_ORDER_MOVED')
    if (b.source !== 'cart') return fail(req, deps, 400, 'INVALID_REQUEST')
    const c = b.contact
    if (!c || typeof c !== 'object') return fail(req, deps, 400, 'INVALID_REQUEST')
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    // ::text::jsonb on purpose: postgres.js JSON-encodes a value typed jsonb, which would double-encode our string.
    try {
      const [r] = await deps.sql`select public.place_order(${s.sub}::uuid, ${b.idempotencyKey}::uuid, ${b.source}, ${str(c.name)}, ${str(c.phone)},
        ${str(c.address)}, ${str(c.comment) || null}, ${JSON.stringify(b.items ?? null)}::text::jsonb) as r`
      const result = r.r as { duplicate: boolean; order: unknown }
      // Tell the admins / the customer through the bot. Best effort: a Telegram outage must not undo the order
      // (unsent messages stay in the outbox and are retried by notify-outbox).
      if (!result.duplicate) deps.background(deliverOutbox(deps).catch((e) => deps.log('deliverOutbox failed', { message: String(e) })))
      return json(req, deps, result.duplicate ? 200 : 201, result)
    } catch (e) {
      const err = e as { code?: string; message?: string; detail?: string }
      const mapped = err.code === 'P0001' && err.message ? CODES[err.message] : undefined
      if (!mapped) throw e
      let detail: Record<string, unknown> = {}
      try {
        detail = err.detail ? JSON.parse(err.detail) : {}
      } catch {
        /* no structured detail */
      }
      return fail(req, deps, mapped[0], mapped[1], detail)
    }
  })
