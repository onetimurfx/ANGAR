import type { Product } from '../data/types'
import { variantQty } from '../data/catalog'

/** Stock lookup. Called with only an id it returns the product total; with size + colour, that variant's stock. */
export type StockFn = (id: string, size?: string, color?: string) => number

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
export function addLine(lines: CartLine[], line: CartLine, stockOf: StockFn): AddResult {
  if (!Number.isInteger(line.qty) || line.qty < 1) return { ok: false, reason: 'invalid', max: 0 }
  const stock = Math.min(stockOf(line.productId), stockOf(line.productId, line.size, line.color))
  if (stock <= 0) return { ok: false, reason: 'out_of_stock', max: 0 }
  const same = lines.find((l) => lineKey(l) === lineKey(line))?.qty ?? 0
  const room = Math.min(stockOf(line.productId) - qtyOfProduct(lines, line.productId), stockOf(line.productId, line.size, line.color) - same)
  if (line.qty > room) return { ok: false, reason: 'stock', max: Math.max(room, 0) }
  const key = lineKey(line)
  const exists = lines.some((l) => lineKey(l) === key)
  return {
    ok: true,
    lines: exists ? lines.map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + line.qty } : l)) : [...lines, line],
  }
}

/** Sets a quantity, clamped to 1..(stock minus what other variants of the same product hold). */
export function setLineQty(lines: CartLine[], key: string, qty: number, stockOf: StockFn): CartLine[] {
  const target = lines.find((l) => lineKey(l) === key)
  if (!target) return lines
  const max = Math.max(1, Math.min(stockOf(target.productId) - qtyOfProduct(lines, target.productId, key), stockOf(target.productId, target.size, target.color)))
  const next = Math.min(Math.max(1, Math.floor(qty) || 1), max)
  return lines.map((l) => (lineKey(l) === key ? { ...l, qty: next } : l))
}

export const removeLine = (lines: CartLine[], key: string) => lines.filter((l) => lineKey(l) !== key)

export const cartCount = (lines: CartLine[]) => lines.reduce((s, l) => s + l.qty, 0)

export const cartSubtotal = (lines: CartLine[], priceOf: (id: string) => number) =>
  lines.reduce((s, l) => s + priceOf(l.productId) * l.qty, 0)

/**
 * Merges the cart saved on the server with the one on this device (first launch after sign-in).
 * The SAME variant on both sides is the same item (the device copy is usually just the server cart cached locally),
 * so the larger quantity wins: quantities are never added together. Lines only on the device are appended within stock.
 */
export function mergeCarts(remote: CartLine[], local: CartLine[], stockOf: StockFn): CartLine[] {
  let out = remote
  for (const l of local) {
    const k = lineKey(l)
    const have = out.find((x) => lineKey(x) === k)
    if (have) {
      if (l.qty > have.qty) {
        const res = addLine(out, { ...l, qty: l.qty - have.qty }, stockOf)
        if (res.ok) out = res.lines
      }
    } else {
      const res = addLine(out, l, stockOf)
      if (res.ok) out = res.lines
    }
  }
  return out
}

/** Builds a StockFn from a product lookup (variant-aware when the product has per-variant stock). */
export const stockFrom = (getProduct: (id: string) => Product | undefined): StockFn => (id, size, color) => {
  const p = getProduct(id)
  if (!p) return 0
  return size !== undefined && color !== undefined ? variantQty(p, size, color) : p.stock
}

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
    const res = addLine(out, { productId, size, color, qty: Math.max(1, Math.floor(qty)) }, stockFrom(getProduct))
    if (res.ok) out = res.lines
    else if (res.reason === 'stock' && res.max > 0) {
      const r2 = addLine(out, { productId, size, color, qty: res.max }, stockFrom(getProduct))
      if (r2.ok) out = r2.lines
    }
  }
  return out
}

/**
 * Changes size/colour of a cart line. If the new variant already exists in the cart the two lines merge.
 * The total quantity of the product does not change, so stock can never be exceeded by this operation.
 */
export function changeVariant(
  lines: CartLine[],
  key: string,
  next: { size: string; color: string },
  getProduct: (id: string) => Product | undefined,
): CartLine[] {
  const target = lines.find((l) => lineKey(l) === key)
  if (!target) return lines
  const p = getProduct(target.productId)
  if (!p || !p.sizes.includes(next.size) || !p.colors.some((c) => c.name === next.color)) return lines
  const newKey = lineKey({ productId: target.productId, size: next.size, color: next.color })
  if (newKey === key) return lines
  const existing = lines.find((l) => lineKey(l) === newKey)
  if (target.qty + (existing?.qty ?? 0) > variantQty(p, next.size, next.color)) return lines
  const merged: CartLine = { productId: target.productId, size: next.size, color: next.color, qty: target.qty + (existing?.qty ?? 0) }
  const out: CartLine[] = []
  let placed = false
  for (const l of lines) {
    const k = lineKey(l)
    if (k === key || k === newKey) {
      if (!placed) {
        out.push(merged)
        placed = true
      }
    } else out.push(l)
  }
  return out
}
