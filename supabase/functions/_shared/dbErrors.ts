import type { Deps } from './types.ts'
import { fail } from './http.ts'

/** machine code raised by the SQL functions -> [HTTP status, public error code] */
export type ErrorTable = Record<string, [number, string]>

/**
 * Turns an exception raised on purpose by a SQL function (SQLSTATE P0001, message = machine code) into a clean
 * JSON error. Anything else (constraint violations, connection errors, bugs) is NOT mapped: it propagates to
 * route()'s catch-all, which answers a generic 500 and never leaks the internals.
 */
export function mapDbError(req: Request, deps: Deps, e: unknown, table: ErrorTable): Response | null {
  const err = e as { code?: string; message?: string; detail?: string }
  const mapped = err?.code === 'P0001' && err.message ? table[err.message] : undefined
  if (!mapped) return null
  let detail: Record<string, unknown> = {}
  try {
    const d = err.detail ? JSON.parse(err.detail) : {}
    if (d && typeof d === 'object' && !Array.isArray(d)) detail = d
  } catch {
    /* no structured detail */
  }
  return fail(req, deps, mapped[0], mapped[1], detail)
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
