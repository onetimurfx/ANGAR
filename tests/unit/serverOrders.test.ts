import { describe, expect, it } from 'vitest'
import { fromServerOrder, isUuid, issuesFromServer, newAttemptId } from '../../src/lib/orders'
import { addLine, mergeCarts, setLineQty, stockFrom, type CartLine } from '../../src/lib/cartLogic'
import type { Product } from '../../src/data/types'

const ID = '3f2b8f1e-6c3a-4c9a-9a39-0f1f6d9b2a11'
const raw = () => ({
  id: ID, orderNumber: 'AYN-261106-00001', status: 'new', source: 'quick', createdAt: '2026-11-06T10:00:00+05:00',
  contact: { name: 'Ali Valiyev', phone: '+998901234567', address: 'Toshkent, Chilonzor 9', comment: null },
  subtotal: 100000, deliveryFee: null, deliveryPending: true, total: 100000,
  items: [{ productId: 'P1', name: 'Xudi', brand: 'Brend', categoryId: 'hoodies', size: 'M', color: 'Qora', colorHex: '#222222', qty: 1, unitPrice: 100000 }],
})

describe('server orders', () => {
  it('maps a server order and marks it as stored on the server', () => {
    const o = fromServerOrder(raw())!
    expect(o.sync).toBe('server')
    expect(o.ref).toBe('AYN-261106-00001')
    expect(o.orderNumber).toBe('AYN-261106-00001')
    expect(o.contact.comment).toBe('')
    expect(o.deliveryPending).toBe(true)
    expect(o.deliveryFee).toBeNull()
  })
  it('rejects malformed server orders', () => {
    expect(fromServerOrder(null)).toBeNull()
    expect(fromServerOrder({ ...raw(), id: 'local-123' })).toBeNull()
    expect(fromServerOrder({ ...raw(), orderNumber: '' })).toBeNull()
    expect(fromServerOrder({ ...raw(), items: [] })).toBeNull()
    expect(fromServerOrder({ ...raw(), total: -1 })).toBeNull()
    expect(fromServerOrder({ ...raw(), source: 'x' })).toBeNull()
    expect(fromServerOrder({ ...raw(), items: [{ ...raw().items[0], qty: 0 }] })).toBeNull()
    expect(fromServerOrder({ ...raw(), status: 'weird' })!.status).toBe('new')
  })
  it('turns server stock issues into readable lines', () => {
    expect(issuesFromServer({ issues: [{ productId: 'P1', name: 'Xudi', size: 'M', color: 'Qora', requested: 3, available: 1, reason: 'stock' }, { bad: true }, null] })).toEqual([
      { productId: 'P1', name: 'Xudi', size: 'M', color: 'Qora', requested: 3, available: 1, reason: 'stock' },
    ])
    expect(issuesFromServer({})).toEqual([])
  })
  it('idempotency keys are real UUIDs, unique per attempt', () => {
    const a = newAttemptId()
    expect(isUuid(a)).toBe(true)
    expect(newAttemptId()).not.toBe(a)
    expect(isUuid('a-123')).toBe(false)
    const orig = globalThis.crypto.randomUUID
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      expect(isUuid(newAttemptId())).toBe(true) // getRandomValues fallback
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: orig, configurable: true })
    }
  })
})

const product: Product = {
  id: 'P1', name: 'X', brandId: 'b', categoryId: 'c', description: '', price: 1000, sizes: ['M', 'L'], colors: [{ name: 'Qora', hex: '#000000' }, { name: 'Oq', hex: '#ffffff' }],
  stock: 7, variants: [{ size: 'M', color: 'Qora', qty: 5 }, { size: 'L', color: 'Qora', qty: 2 }, { size: 'M', color: 'Oq', qty: 0 }],
  type: 'original', isNew: false, active: true, popularity: 0, createdAt: '2026-01-01', sample: false,
}
const stockOf = stockFrom((id) => (id === 'P1' ? product : undefined))
const L = (size: string, color: string, qty: number): CartLine => ({ productId: 'P1', size, color, qty })

describe('per-variant stock in the cart', () => {
  it('caps each variant by its own stock', () => {
    expect(addLine([], L('L', 'Qora', 3), stockOf)).toMatchObject({ ok: false, reason: 'stock', max: 2 })
    expect(addLine([], L('M', 'Oq', 1), stockOf)).toMatchObject({ ok: false, reason: 'out_of_stock' })
    expect(addLine([], L('XL', 'Qora', 1), stockOf)).toMatchObject({ ok: false, reason: 'out_of_stock' })
    const a = addLine([], L('L', 'Qora', 2), stockOf)
    expect(a.ok).toBe(true)
    if (a.ok) expect(addLine(a.lines, L('L', 'Qora', 1), stockOf)).toMatchObject({ ok: false, max: 0 })
  })
  it('clamps quantity changes to the variant stock', () => {
    const lines = [L('L', 'Qora', 1)]
    expect(setLineQty(lines, 'P1|L|Qora', 9, stockOf)[0].qty).toBe(2)
  })
})

describe('cart merge after sign-in', () => {
  it('does not add the same variant twice (device copy of the server cart)', () => {
    const remote = [L('M', 'Qora', 1)]
    expect(mergeCarts(remote, [L('M', 'Qora', 1)], stockOf)).toEqual([L('M', 'Qora', 1)])
  })
  it('keeps the larger quantity, within stock', () => {
    expect(mergeCarts([L('M', 'Qora', 1)], [L('M', 'Qora', 3)], stockOf)).toEqual([L('M', 'Qora', 3)])
    expect(mergeCarts([L('M', 'Qora', 1)], [L('M', 'Qora', 99)], stockOf)).toEqual([L('M', 'Qora', 1)]) // 99 does not fit: server value stays
  })
  it('adds device-only lines and drops ones that cannot be bought', () => {
    const m = mergeCarts([L('M', 'Qora', 1)], [L('L', 'Qora', 2), L('M', 'Oq', 1)], stockOf)
    expect(m.map((l) => `${l.size}|${l.color}|${l.qty}`)).toEqual(['M|Qora|1', 'L|Qora|2'])
  })
})
