import { describe, expect, it } from 'vitest'
import { getProduct } from '../../src/data/sample'
import { addLine, cartCount, cartSubtotal, lineKey, qtyOfProduct, removeLine, sanitizeCart, setLineQty, type CartLine } from '../../src/lib/cartLogic'

const stockOf = (id: string) => getProduct(id)?.stock ?? 0
const priceOf = (id: string) => getProduct(id)?.price ?? 0
const L = (productId: string, size: string, color: string, qty = 1): CartLine => ({ productId, size, color, qty })

describe('cart logic', () => {
  it('adds and merges identical variants', () => {
    let r = addLine([], L('s-tee-1', 'M', 'Oq', 2), stockOf)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r = addLine(r.lines, L('s-tee-1', 'M', 'Oq', 3), stockOf)
    expect(r.ok && r.lines).toHaveLength(1)
    expect(r.ok && r.lines[0].qty).toBe(5)
  })
  it('keeps different sizes/colours as separate lines', () => {
    const a = addLine([], L('s-tee-1', 'M', 'Oq'), stockOf)
    const b = a.ok ? addLine(a.lines, L('s-tee-1', 'L', 'Oq'), stockOf) : a
    expect(b.ok && b.lines).toHaveLength(2)
  })
  it('rejects out-of-stock and invalid quantities', () => {
    expect(addLine([], L('s-dress-2', 'M', 'Qora'), stockOf)).toMatchObject({ ok: false, reason: 'out_of_stock' })
    expect(addLine([], L('s-tee-1', 'M', 'Oq', 0), stockOf)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(addLine([], L('s-tee-1', 'M', 'Oq', 1.5), stockOf)).toMatchObject({ ok: false, reason: 'invalid' })
  })
  it('caps the TOTAL per product (across variants) at stock', () => {
    const first = addLine([], L('s-sweater-1', 'S', "Fil suyagi", 2), stockOf) // stock 3
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(addLine(first.lines, L('s-sweater-1', 'M', 'Bej', 2), stockOf)).toMatchObject({ ok: false, reason: 'stock', max: 1 })
    expect(addLine(first.lines, L('s-sweater-1', 'M', 'Bej', 1), stockOf).ok).toBe(true)
  })
  it('clamps quantity changes to stock and to at least 1', () => {
    const lines = [L('s-sweater-1', 'S', 'Fil suyagi', 1)]
    const key = lineKey(lines[0])
    expect(setLineQty(lines, key, 99, stockOf)[0].qty).toBe(3)
    expect(setLineQty(lines, key, 0, stockOf)[0].qty).toBe(1)
    expect(setLineQty(lines, key, -4, stockOf)[0].qty).toBe(1)
    expect(setLineQty(lines, 'nope', 2, stockOf)).toBe(lines)
  })
  it('respects other variants when changing a quantity', () => {
    const lines = [L('s-sweater-1', 'S', 'Fil suyagi', 2), L('s-sweater-1', 'M', 'Bej', 1)]
    expect(setLineQty(lines, lineKey(lines[1]), 5, stockOf)[1].qty).toBe(1)
  })
  it('removes lines and computes totals', () => {
    const lines = [L('s-tee-1', 'M', 'Oq', 2), L('s-pants-1', 'L', 'Qora', 1)]
    expect(cartCount(lines)).toBe(3)
    expect(cartSubtotal(lines, priceOf)).toBe(2 * 190000 + 480000)
    expect(removeLine(lines, lineKey(lines[0]))).toHaveLength(1)
    expect(qtyOfProduct(lines, 's-tee-1')).toBe(2)
  })
})

describe('sanitizeCart (untrusted storage)', () => {
  const get = getProduct
  it('keeps valid lines', () => {
    const r = sanitizeCart([{ productId: 's-tee-1', size: 'M', color: 'Oq', qty: 2 }], get)
    expect(r).toEqual([L('s-tee-1', 'M', 'Oq', 2)])
  })
  it('drops garbage, unknown products, bad variants, out-of-stock', () => {
    const r = sanitizeCart(
      [null, 5, 'x', { productId: 'nope', size: 'M', color: 'Oq', qty: 1 }, { productId: 's-tee-1', size: 'XXL', color: 'Oq', qty: 1 }, { productId: 's-tee-1', size: 'M', color: 'Pushti', qty: 1 }, { productId: 's-dress-2', size: 'M', color: 'Qora', qty: 1 }, { productId: 's-tee-1', size: 'M', color: 'Oq', qty: 'a' }],
      get,
    )
    expect(r).toEqual([])
    expect(sanitizeCart('not an array', get)).toEqual([])
  })
  it('clamps to stock and merges duplicates', () => {
    const r = sanitizeCart([{ productId: 's-sweater-1', size: 'S', color: 'Fil suyagi', qty: 50 }, { productId: 's-sweater-1', size: 'S', color: 'Fil suyagi', qty: 1 }], get)
    expect(r).toHaveLength(1)
    expect(r[0].qty).toBe(3)
  })
})
