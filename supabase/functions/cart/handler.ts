import { fail, json, readJson, requireSession, route } from '../_shared/http.ts'
import type { Deps } from '../_shared/types.ts'

/** GET -> the saved cart. PUT { items } -> replaces it (unknown / inactive variants are dropped, quantities clamped). */
export const handler = (deps: Deps) =>
  route(['GET', 'PUT'], deps, async (req) => {
    const s = await requireSession(req, deps)
    if (s instanceof Response) return s
    if (req.method === 'GET') {
      const [r] = await deps.sql`select public.get_cart(${s.sub}::uuid) as items`
      return json(req, deps, 200, { items: r.items })
    }
    const body = await readJson(req)
    if (!body.ok || !Array.isArray(body.value?.items)) return fail(req, deps, 400, 'INVALID_REQUEST')
    // ::text::jsonb on purpose: postgres.js JSON-encodes a value typed jsonb, which would double-encode our string.
    try {
      const [r] = await deps.sql`select public.set_cart(${s.sub}::uuid, ${JSON.stringify(body.value.items)}::text::jsonb) as items`
      return json(req, deps, 200, { items: r.items })
    } catch (e) {
      if ((e as { message?: string }).message === 'INVALID_ITEM') return fail(req, deps, 400, 'INVALID_ITEM')
      throw e
    }
  })
