import { fail, json, readJson, route } from '../_shared/http.ts'
import { issueSession } from '../_shared/session.ts'
import { verifyInitData } from '../_shared/telegram.ts'
import type { Deps } from '../_shared/types.ts'

/** POST { initData } -> verifies the Telegram signature, upserts the customer, returns a session token. */
export const handler = (deps: Deps) =>
  route(['POST'], deps, async (req) => {
    const { BOT_TOKEN, SESSION_SECRET } = deps.env
    if (!BOT_TOKEN || !SESSION_SECRET || SESSION_SECRET.length < 32) {
      deps.log('BOT_TOKEN / SESSION_SECRET not configured')
      return fail(req, deps, 500, 'SERVER_MISCONFIGURED')
    }
    const body = await readJson(req)
    if (!body.ok || typeof body.value !== 'object' || body.value === null) return fail(req, deps, 400, 'INVALID_REQUEST')
    const res = await verifyInitData(body.value.initData, BOT_TOKEN, deps.now())
    if (!res.ok) {
      if (res.reason === 'expired') return fail(req, deps, 401, 'EXPIRED_INIT_DATA')
      return fail(req, deps, res.reason === 'malformed' || res.reason === 'no_user' ? 400 : 401, res.reason === 'bad_signature' ? 'INVALID_INIT_DATA' : 'INVALID_REQUEST')
    }
    const u = res.user
    const [c] = await deps.sql`select public.upsert_customer(${u.id}::bigint, ${u.firstName}, ${u.lastName ?? null}, ${u.username ?? null}, ${u.photoUrl ?? null}, ${u.languageCode ?? null}) as id`
    const [a] = await deps.sql`select public.is_admin(${u.id}::bigint) as a`
    const { token, expiresAt } = await issueSession({ sub: c.id, tg: u.id }, SESSION_SECRET, deps.now())
    return json(req, deps, 200, { token, expiresAt, customerId: c.id, isAdmin: a.a === true, user: u })
  })
