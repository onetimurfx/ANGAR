import type { Product } from '../data/types'

export interface CartLine {
  productId: string
  size: string
  /** colour NAME (matches Product.colors[].name) */
  color: string
  qty: number
}

export const lineKey = (l: Pick<CartLine, 'productId' | 'size' | 'color'>) => `${l.productId}|${l.size}|${l.color}`

export const qtyOfProduct = (lines: CartLine[], productId: string, exceptKey?: string) =>
  lines.filter((l) => l.productId === productId && lineKey(l) !== exceptKey).reduce((s, l) => s + l.qty, 0)

export type AddResult =
  | { ok: true; lines: CartLine[] }
  | { ok: false; reason: 'invalid' | 'out_of_stock' | 'stock'; max: number }

/** Adds a variant. Total quantity per product (across sizes/colours) may never exceed its stock. */
export function addLine(lines: CartLine[], line: CartLine, stockOf: (id: string) => number): AddResult {
  if (!Number.isInteger(line.qty) || line.qty < 1) return { ok: false, reason: 'invalid', max: 0 }
  const stock = stockOf(line.productId)
  if (stock <= 0) return { ok: false, reason: 'out_of_stock', max: 0 }
  const room = stock - qtyOfProduct(lines, line.productId)
  if (line.qty > room) return { ok: false, reason: 'stock', max: Math.max(room, 0) }
  const key = lineKey(line)
  const exists = lines.some((l) => lineKey(l) === key)
  return {
    ok: true,
    lines: exists ? lines.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + line.qty } : l)) : [...lines, line],
  }
}

/** Sets a quantity, clamped to 1..(stock minus what other variants of the same product hold). */
export function setLineQty(lines: CartLine[], key: string, qty: number, stockOf: (id: string) => number): CartLine[] {
  const target = lines.find((l) => lineKey(l) === key)
  if (!target) return lines
  const max = Math.max(1, stockOf(target.productId) - qtyOfProduct(lines, target.productId, key))
  const next = Math.min(Math.max(1, Math.floor(qty) || 1), max)
  return lines.map((l) => (lineKey(l) === key ? { ...l, qty: next } : l))
}

export const removeLine = (lines: CartLine[], key: string) => lines.filter((l) => lineKey(l) !== key)

export const cartCount = (lines: CartLine[]) => lines.reduce((s, l) => s + l.qty, 0)

export const cartSubtotal = (lines: CartLine[], priceOf: (id: string) => number) =>
  lines.reduce((s, l) => s + priceOf(l.productId) * l.qty, 0)

/** Rebuilds a cart from untrusted storage: drops unknown/inactive products, bad variants, clamps to stock. */
export function sanitizeCart(raw: unknown, getProduct: (id: string) => Product | undefined): CartLine[] {
  if (!Array.isArray(raw)) return []
  let out: CartLine[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const { productId, size, color, qty } = r as Record<string, unknown>
    if (typeof productId !== 'string' || typeof size !== 'string' || typeof color !== 'string' || typeof qty !== 'number') continue
    const p = getProduct(productId)
    if (!p || !p.active || p.stock <= 0) continue
    if (!p.sizes.includes(size) || !p.colors.some((c) => c.name === color)) continue
    const res = addLine(out, { productId, size, color, qty: Math.max(1, Math.floor(qty)) }, (id) => getProduct(id)?.stock ?? 0)
    if (res.ok) out = res.lines
    else if (res.reason === 'stock' && res.max > 0) {
      const r2 = addLine(out, { productId, size, color, qty: res.max }, (id) => getProduct(id)?.stock ?? 0)
      if (r2.ok) out = r2.lines
    }
  }
  return out
}
