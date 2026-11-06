import { json, requireAdmin, route } from '../_shared/http.ts'
import type { Deps } from '../_shared/types.ts'

/**
 * GET -> 200 for an active administrator, 403 for everybody else. It is also the template every admin
 * endpoint of Phase 6 must follow: `const s = await requireAdmin(req, deps); if (s instanceof Response) return s`.
 */
export const handler = (deps: Deps) =>
  route(['GET'], deps, async (req) => {
    const s = await requireAdmin(req, deps)
    if (s instanceof Response) return s
    return json(req, deps, 200, { isAdmin: true, telegramId: s.tg })
  })
