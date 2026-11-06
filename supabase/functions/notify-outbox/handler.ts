import { fail, json, route } from '../_shared/http.ts'
import { deliverOutbox } from '../_shared/notify.ts'
import { safeEqual } from '../_shared/telegram.ts'
import type { Deps } from '../_shared/types.ts'

/** POST with header x-cron-secret -> retries the queued bot messages. Called by a scheduler, never by the browser. */
export const handler = (deps: Deps) =>
  route(['POST'], deps, async (req) => {
    const secret = deps.env.CRON_SECRET
    if (!secret || secret.length < 16) return fail(req, deps, 500, 'SERVER_MISCONFIGURED')
    if (!safeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return fail(req, deps, 401, 'UNAUTHENTICATED')
    return json(req, deps, 200, await deliverOutbox(deps, 50))
  })
