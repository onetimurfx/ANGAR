import { fail, json, readJson, requireAdmin, route } from '../_shared/http.ts'
import { mapDbError, UUID_RE, type ErrorTable } from '../_shared/dbErrors.ts'
import { deliverInBackground } from '../_shared/pickupNotify.ts'
import type { Deps } from '../_shared/types.ts'

const ERRORS: ErrorTable = {
  FORBIDDEN: [403, 'FORBIDDEN'],
  NOT_FOUND: [404, 'NOT_FOUND'],
  INVALID_REQUEST: [400, 'INVALID_REQUEST'],
  INVALID_TRANSITION: [409, 'INVALID_TRANSITION'],
  NOT_CANCELLABLE: [409, 'NOT_CANCELLABLE'],
  NOT_READY: [409, 'NOT_READY'],
  EXPIRED: [409, 'EXPIRED'],
  INVALID_REASON: [422, 'INVALID_REASON'],
  PAYMENT_REQUIRED: [422, 'PAYMENT_REQUIRED'],
  AMOUNT_MISMATCH: [422, 'AMOUNT_MISMATCH'],
}
/** expected outcomes of admin_complete_pickup that the SQL returns (so that failed attempts are stored) */
const COMPLETE_FAILURES: Record<string, [number, string]> = {
  INVALID_CODE: [422, 'INVALID_CODE'],
  RATE_LIMITED: [429, 'RATE_LIMITED'],
}
const GROUPS = new Set(['active', 'pending', 'preparing', 'ready', 'history'])

/**
 * Admin side of Quick Order. EVERY request first passes requireAdmin: a valid signed session AND an active row in
 * `administrators` for the Telegram id of that session (looked up now, not cached). The SQL functions check it
 * again on their own. The admin identity is the session's Telegram id only; nothing the client sends can change it.
 *
 *   GET ?group=active|pending|preparing|ready|history[&limit=n]  -> { orders, counts, sweep }
 *   GET ?id=<uuid>                                               -> { order, history }
 *   GET ?view=health                                             -> { healthy, sweep, overdue, outbox }  (cron monitoring)
 *   POST { action:'start_preparing', id }
 *   POST { action:'mark_ready', id }
 *   POST { action:'cancel', id, reason }                         reason is mandatory
 *   POST { action:'complete', id?, code, paymentConfirmed:true, amount }
 *        the ONLY way to hand an order over: checks the one-time code, the admin's explicit payment confirmation
 *        (must be the JSON boolean true) and that `amount` equals the order total, in one database transaction.
 * The pickup code is never returned by any admin response.
 */
export const handler = (deps: Deps) =>
  route(['GET', 'POST'], deps, async (req) => {
    const s = await requireAdmin(req, deps)
    if (s instanceof Response) return s
    const admin = s.tg

    try {
      if (req.method === 'GET') {
        const q = new URL(req.url).searchParams
        if (q.get('view') === 'health') {
          const [h] = await deps.sql`select public.pickup_health(${admin}::bigint) as r`
          return json(req, deps, 200, h.r)
        }
        const id = q.get('id')
        if (id !== null) {
          if (!UUID_RE.test(id)) return fail(req, deps, 400, 'INVALID_REQUEST')
          const [r] = await deps.sql`select public.admin_get_pickup(${admin}::bigint, ${id}::uuid) as r`
          return json(req, deps, 200, r.r)
        }
        const group = q.get('group') ?? 'active'
        if (!GROUPS.has(group)) return fail(req, deps, 400, 'INVALID_REQUEST')
        const rawLimit = q.get('limit')
        const limit = rawLimit === null ? 50 : Number(rawLimit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(req, deps, 400, 'INVALID_REQUEST')
        const [r] = await deps.sql`select public.admin_list_pickup(${admin}::bigint, ${group}, ${limit}::int) as r`
        return json(req, deps, 200, r.r)
      }

      const body = await readJson(req)
      const b = body.ok ? body.value : null
      if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(req, deps, 400, 'INVALID_REQUEST')
      const id = typeof b.id === 'string' && UUID_RE.test(b.id) ? b.id : null

      switch (b.action) {
        case 'start_preparing': {
          if (!id) return fail(req, deps, 400, 'INVALID_REQUEST')
          const [r] = await deps.sql`select public.admin_start_preparing(${admin}::bigint, ${id}::uuid) as r`
          deliverInBackground(deps)
          return json(req, deps, 200, { order: r.r })
        }
        case 'mark_ready': {
          if (!id) return fail(req, deps, 400, 'INVALID_REQUEST')
          const [r] = await deps.sql`select public.admin_mark_ready(${admin}::bigint, ${id}::uuid) as r`
          deliverInBackground(deps)
          return json(req, deps, 200, { order: r.r })
        }
        case 'cancel': {
          if (!id || typeof b.reason !== 'string') return fail(req, deps, 400, 'INVALID_REQUEST')
          const [r] = await deps.sql`select public.admin_cancel_pickup(${admin}::bigint, ${id}::uuid, ${b.reason}) as r`
          deliverInBackground(deps)
          return json(req, deps, 200, { order: r.r })
        }
        case 'complete': {
          if (b.id !== undefined && b.id !== null && !id) return fail(req, deps, 400, 'INVALID_REQUEST')
          if (typeof b.code !== 'string' || b.code.length > 32) return fail(req, deps, 400, 'INVALID_REQUEST')
          // strict: only the JSON boolean true counts as the admin's confirmation ("true", 1, "yes" do not)
          const confirmed = b.paymentConfirmed === true
          const amount = typeof b.amount === 'number' && Number.isSafeInteger(b.amount) && b.amount >= 0 ? b.amount : null
          const [r] = await deps.sql`select public.admin_complete_pickup(${admin}::bigint, ${id}::uuid, ${b.code}, ${confirmed}::boolean, ${amount}::bigint) as r`
          const out = r.r as { ok: boolean; error?: string; order?: unknown }
          if (!out.ok) {
            const f = COMPLETE_FAILURES[out.error ?? ''] ?? [500, 'SERVER_ERROR']
            return fail(req, deps, f[0], f[1])
          }
          deliverInBackground(deps)
          return json(req, deps, 200, { order: out.order })
        }
        default:
          return fail(req, deps, 400, 'INVALID_REQUEST')
      }
    } catch (e) {
      const mapped = mapDbError(req, deps, e, ERRORS)
      if (mapped) return mapped
      throw e
    }
  })
