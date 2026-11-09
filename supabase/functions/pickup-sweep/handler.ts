import { fail, json, route } from '../_shared/http.ts'
import { deliverPickupOutbox } from '../_shared/pickupNotify.ts'
import { safeEqual } from '../_shared/telegram.ts'
import type { Deps } from '../_shared/types.ts'

/**
 * POST with header x-cron-secret, called every minute by pg_cron (pg_net). Never by the browser.
 *   wrong / missing secret -> 401 (nothing runs)      secret not configured -> 500
 *   correct               -> 200 { sweep, outbox }
 * 1. sweep_pickup(): expires `pending` orders older than the timeout and `ready_for_pickup` orders past their hold time,
 *    releases their reservations and queues customer messages. `preparing` orders are never touched. It also writes the
 *    job_heartbeats row used to detect a stopped cron.
 * 2. delivers / retries the queued pickup bot messages.
 * If the sweep itself fails, the failure is recorded in job_heartbeats (status 'failing') and the call answers 500.
 */
export const handler = (deps: Deps) =>
  route(['POST'], deps, async (req) => {
    const secret = deps.env.CRON_SECRET
    if (!secret || secret.length < 16) return fail(req, deps, 500, 'SERVER_MISCONFIGURED')
    if (!safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return fail(req, deps, 401, 'UNAUTHENTICATED')

    let sweep: unknown
    try {
      const [r] = await deps.sql`select public.sweep_pickup() as r`
      sweep = r.r
    } catch (e) {
      deps.log('pickup-sweep failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'error' })
      try {
        await deps.sql`select public.pickup_sweep_failed(${'SWEEP_FAILED'})`
      } catch {
        /* the database itself is unreachable: the stale heartbeat reveals it */
      }
      return fail(req, deps, 500, 'SERVER_ERROR')
    }
    const outbox = await deliverPickupOutbox(deps, 50).catch((e) => {
      deps.log('pickup outbox failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'error' })
      return { sent: 0, failed: 0, skipped: 0, error: true }
    })
    return json(req, deps, 200, { sweep, outbox })
  })
