/**
 * The Quick Order basket: several variants for ONE pickup order. It is separate from the Cart (own storage key, own
 * rules) and holds only real, in-stock variants. Pure functions, no React: see tests/unit/quickBasket.test.ts.
 */
import type { Product } from '../data/types'
import { variantQty } from '../data/catalog'

/** the server refuses more lines; the UI stops earlier (the server answers TOO_MANY_LINES if the limit changes) */
export const MAX_LINES = 10

export interface QuickLine {
  productId: string
  size: string
  color: string
  qty: number
}
type Lookup = (id: string) => Product | undefined

export const lineKey = (l: Pick<QuickLine, 'productId' | 'size' | 'color'>) => `${l.productId}|${l.size}|${l.color}`

/** pieces of exactly this size + colour that can be ordered (0 when the product/variant does not exist or is hidden) */
export function capFor(p: Product | undefined, size: string, color: string): number {
  if (!p || !p.active || !p.sizes.includes(size) || !p.colors.some((c) => c.name === color)) return 0
  return Math.max(0, variantQty(p, size, color))
}

/** colours that have at least one size in stock */
export const colorsInStock = (p: Product) => p.colors.filter((c) => p.sizes.some((s) => capFor(p, s, c.name) > 0))
/** sizes in stock for one colour */
export const sizesInStock = (p: Product, color: string) => p.sizes.filter((s) => capFor(p, s, color) > 0)

export type AddResult =
  | { ok: true; lines: QuickLine[] }
  | { ok: false; reason: 'unavailable' | 'stock' | 'lines'; max: number }

export function addLine(lines: QuickLine[], line: QuickLine, get: Lookup): AddResult {
  const cap = capFor(get(line.productId), line.size, line.color)
  const qty = Math.floor(line.qty)
  if (cap <= 0 || !(qty >= 1)) return { ok: false, reason: 'unavailable', max: 0 }
  const key = lineKey(line)
  const at = lines.findIndex((l) => lineKey(l) === key)
  if (at >= 0) {
    if (lines[at].qty >= cap) return { ok: false, reason: 'stock', max: cap }
    const next = lines.slice()
    next[at] = { ...lines[at], qty: Math.min(cap, lines[at].qty + qty) }
    return { ok: true, lines: next }
  }
  if (lines.length >= MAX_LINES) return { ok: false, reason: 'lines', max: MAX_LINES }
  return { ok: true, lines: [...lines, { productId: line.productId, size: line.size, color: line.color, qty: Math.min(cap, qty) }] }
}

export function setQty(lines: QuickLine[], key: string, qty: number, get: Lookup): QuickLine[] {
  return lines.flatMap((l) => {
    if (lineKey(l) !== key) return [l]
    const cap = capFor(get(l.productId), l.size, l.color)
    return cap > 0 ? [{ ...l, qty: Math.min(cap, Math.max(1, Math.floor(qty))) }] : []
  })
}

export const removeLine = (lines: QuickLine[], key: string) => lines.filter((l) => lineKey(l) !== key)

/** Reads whatever storage returned and keeps only variants that can still be ordered, with quantities clamped to stock. */
export function sanitizeBasket(raw: unknown, get: Lookup): QuickLine[] {
  if (!Array.isArray(raw)) return []
  const out: QuickLine[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const l = r as Partial<QuickLine>
    if (typeof l.productId !== 'string' || typeof l.size !== 'string' || typeof l.color !== 'string' || typeof l.qty !== 'number' || !Number.isFinite(l.qty)) continue
    const cap = capFor(get(l.productId), l.size, l.color)
    if (cap <= 0) continue
    const key = lineKey(l as QuickLine)
    if (out.some((x) => lineKey(x) === key)) continue
    out.push({ productId: l.productId, size: l.size, color: l.color, qty: Math.min(cap, Math.max(1, Math.floor(l.qty))) })
    if (out.length >= MAX_LINES) break
  }
  return out
}

export const basketCount = (lines: QuickLine[]) => lines.reduce((n, l) => n + l.qty, 0)
export const basketSubtotal = (lines: QuickLine[], get: Lookup) => lines.reduce((s, l) => s + (get(l.productId)?.price ?? 0) * l.qty, 0)
/** names of NAMUNA (placeholder) products in the basket: they cannot be ordered */
export const sampleNames = (lines: QuickLine[], get: Lookup) => [...new Set(lines.filter((l) => get(l.productId)?.sample).map((l) => get(l.productId)!.name))]
