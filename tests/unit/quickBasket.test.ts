import { describe, expect, it } from 'vitest'
import type { Product } from '../../src/data/types'
import { addLine, capFor, colorsInStock, lineKey, MAX_LINES, removeLine, sampleNames, sanitizeBasket, setQty, sizesInStock, basketCount, basketSubtotal } from '../../src/lib/quickBasket'

const mk = (id: string, over: Partial<Product> = {}): Product => ({
  id, name: `Mahsulot ${id}`, brandId: 'b', description: '', categoryId: 'hoodies', price: 100000,
  sizes: ['S', 'M', 'L'], colors: [{ name: 'Qora', hex: '#222' }, { name: 'Oq', hex: '#fff' }], stock: 10,
  variants: [
    { size: 'S', color: 'Qora', qty: 0 }, { size: 'M', color: 'Qora', qty: 3 }, { size: 'L', color: 'Qora', qty: 1 },
    { size: 'S', color: 'Oq', qty: 0 }, { size: 'M', color: 'Oq', qty: 0 }, { size: 'L', color: 'Oq', qty: 0 },
  ],
  type: 'original', isNew: false, active: true, popularity: 1, createdAt: '2026-01-01', sample: false, ...over,
})
const P = mk('P1')
const get = (id: string) => (id === 'P1' ? P : id === 'P2' ? mk('P2', { price: 250000 }) : id === 'S' ? mk('S', { sample: true }) : id === 'OFF' ? mk('OFF', { active: false }) : undefined)
const L = (size = 'M', color = 'Qora', qty = 1, productId = 'P1') => ({ productId, size, color, qty })

describe('variant availability', () => {
  it('capFor is the stock of exactly that size + colour', () => {
    expect(capFor(P, 'M', 'Qora')).toBe(3)
    expect(capFor(P, 'S', 'Qora')).toBe(0)
    expect(capFor(P, 'M', 'Oq')).toBe(0)
    expect(capFor(P, 'XXL', 'Qora')).toBe(0)
    expect(capFor(P, 'M', 'Yashil')).toBe(0)
    expect(capFor(undefined, 'M', 'Qora')).toBe(0)
    expect(capFor(mk('X', { active: false }), 'M', 'Qora')).toBe(0)
  })
  it('only colours and sizes that are really in stock are offered', () => {
    expect(colorsInStock(P).map((c) => c.name)).toEqual(['Qora'])
    expect(sizesInStock(P, 'Qora')).toEqual(['M', 'L'])
    expect(sizesInStock(P, 'Oq')).toEqual([])
  })
})

describe('addLine', () => {
  it('adds several different products to one basket', () => {
    let lines = [] as ReturnType<typeof L>[]
    for (const l of [L('M', 'Qora', 2), L('L', 'Qora', 1), L('M', 'Qora', 1, 'P2')]) {
      const r = addLine(lines, l, get)
      expect(r.ok).toBe(true)
      if (r.ok) lines = r.lines
    }
    expect(lines).toHaveLength(3)
  })
  it('the same variant merges and is capped by stock', () => {
    const a = addLine([], L('M', 'Qora', 2), get)
    expect(a.ok && a.lines).toEqual([L('M', 'Qora', 2)])
    const b = addLine(a.ok ? a.lines : [], L('M', 'Qora', 5), get)
    expect(b.ok && b.lines[0].qty).toBe(3)
    const c = addLine(b.ok ? b.lines : [], L('M', 'Qora', 1), get)
    expect(c).toEqual({ ok: false, reason: 'stock', max: 3 })
  })
  it('refuses out-of-stock, unknown and hidden variants', () => {
    expect(addLine([], L('S', 'Qora'), get)).toEqual({ ok: false, reason: 'unavailable', max: 0 })
    expect(addLine([], L('M', 'Oq'), get)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(addLine([], L('M', 'Qora', 1, 'NOPE'), get)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(addLine([], L('M', 'Qora', 1, 'OFF'), get)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(addLine([], L('M', 'Qora', 0), get)).toMatchObject({ ok: false })
    expect(addLine([], L('M', 'Qora', NaN), get)).toMatchObject({ ok: false })
  })
  it(`stops at ${MAX_LINES} different lines`, () => {
    const many = Array.from({ length: MAX_LINES }, (_, i) => L('M', 'Qora', 1, `P${i}`))
    const all = (id: string) => mk(id)
    const r = addLine(many, L('M', 'Qora', 1, 'PX'), all)
    expect(r).toEqual({ ok: false, reason: 'lines', max: MAX_LINES })
    // but more of an existing line is still allowed
    expect(addLine(many, L('M', 'Qora', 1, 'P0'), all).ok).toBe(true)
  })
})

describe('setQty / removeLine / totals', () => {
  it('clamps between 1 and stock; drops a line that is no longer orderable', () => {
    const lines = [L('M', 'Qora', 2)]
    expect(setQty(lines, lineKey(lines[0]), 99, get)[0].qty).toBe(3)
    expect(setQty(lines, lineKey(lines[0]), 0, get)[0].qty).toBe(1)
    expect(setQty([L('S', 'Qora', 1)], lineKey(L('S', 'Qora')), 2, get)).toEqual([])
  })
  it('removes by key and counts / sums', () => {
    const lines = [L('M', 'Qora', 2), L('M', 'Qora', 1, 'P2')]
    expect(removeLine(lines, lineKey(lines[0]))).toEqual([lines[1]])
    expect(basketCount(lines)).toBe(3)
    expect(basketSubtotal(lines, get)).toBe(2 * 100000 + 250000)
  })
  it('names the sample products in the basket', () => {
    expect(sampleNames([L('M', 'Qora', 1, 'S'), L('M', 'Qora', 1, 'P1')], get)).toEqual(['Mahsulot S'])
  })
})

describe('sanitizeBasket (what storage / a stale catalog may hand back)', () => {
  it('keeps valid lines, clamps quantities and drops everything else', () => {
    const out = sanitizeBasket(
      [L('M', 'Qora', 9), L('M', 'Qora', 1), L('S', 'Qora', 1), { productId: 'P1' }, null, 'x', 7, L('L', 'Qora', 2.9), { ...L('M', 'Qora'), qty: Infinity }],
      get,
    )
    expect(out).toEqual([L('M', 'Qora', 3), L('L', 'Qora', 1)])
  })
  it('not an array -> empty', () => {
    for (const bad of [null, undefined, {}, 'x', 5]) expect(sanitizeBasket(bad, get)).toEqual([])
  })
  it('never exceeds the line limit', () => {
    const raw = Array.from({ length: 30 }, (_, i) => L('M', 'Qora', 1, `P${i}`))
    expect(sanitizeBasket(raw, (id) => mk(id))).toHaveLength(MAX_LINES)
  })
})
