import type { Deps } from './types.ts'
import { verifySession, type SessionClaims } from './session.ts'

export const SESSION_HEADER = 'x-aynimo-session'
const MAX_BODY = 64 * 1024

export function corsHeaders(req: Request, deps: Deps): Record<string, string> {
  const origin = req.headers.get('origin')
  const allowed = (deps.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const base: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': `content-type, ${SESSION_HEADER}, apikey, authorization, x-client-info`,
    'access-control-max-age': '600',
    vary: 'origin',
  }
  // Only an explicitly allowed origin gets CORS headers. No wildcard: random sites cannot call the API from a browser.
  if (origin && allowed.includes(origin)) base['access-control-allow-origin'] = origin
  return base
}

export const json = (req: Request, deps: Deps, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(req, deps) } })

export const fail = (req: Request, deps: Deps, status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(req, deps, status, { error: { code, ...extra } })

/** Wraps a handler: CORS preflight, method allow-list, and a catch-all that never leaks internals. */
export function route(methods: string[], deps: Deps, fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, deps) })
    if (!methods.includes(req.method)) return fail(req, deps, 405, 'METHOD_NOT_ALLOWED')
    try {
      return await fn(req)
    } catch (e) {
      deps.log('unhandled error', { message: e instanceof Error ? e.message : String(e) })
      return fail(req, deps, 500, 'SERVER_ERROR')
    }
  }
}

export async function readJson(req: Request): Promise<{ ok: true; value: any } | { ok: false }> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) return { ok: false }
  const text = await req.text()
  if (text.length > MAX_BODY) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** Returns the verified session, or a ready 401/500 response. */
export async function requireSession(req: Request, deps: Deps): Promise<SessionClaims | Response> {
  const secret = deps.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    deps.log('SESSION_SECRET missing or shorter than 32 chars')
    return fail(req, deps, 500, 'SERVER_MISCONFIGURED')
  }
  const claims = await verifySession(req.headers.get(SESSION_HEADER), secret, deps.now())
  return claims ?? fail(req, deps, 401, 'UNAUTHENTICATED')
}

/** Session + the Telegram id must be an ACTIVE administrator in the database (checked on every call). */
export async function requireAdmin(req: Request, deps: Deps): Promise<SessionClaims | Response> {
  const s = await requireSession(req, deps)
  if (s instanceof Response) return s
  const [r] = await deps.sql`select public.is_admin(${s.tg}::bigint) as a`
  return r?.a === true ? s : fail(req, deps, 403, 'FORBIDDEN')
}
