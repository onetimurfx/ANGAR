import { json, requireSession, route } from '../_shared/http.ts'
import type { Deps } from '../_shared/types.ts'

/** GET -> the signed-in customer's orders (only their own: the id comes from the verified session). */
export const handler = (deps: Deps) =>
  route(['GET'], deps, async (req) => {
    const s = await requireSession(req, deps)
    if (s instanceof Response) return s
    const [r] = await deps.sql`select public.my_orders(${s.sub}::uuid, 30) as orders`
    return json(req, deps, 200, { orders: r.orders })
  })
