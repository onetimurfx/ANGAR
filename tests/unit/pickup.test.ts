import { describe, expect, it } from 'vitest'
import { canCancel, CODE_RE, isOpen, sanitizePickupOrder, STEPS } from '../../src/lib/pickup'

const base = (over: Record<string, unknown> = {}) => ({
  id: '3f2b8c1e-5a3d-4c7e-9f10-2a6b7c8d9e01', orderNumber: 'PU-261110-00001', status: 'pending', createdAt: '2026-11-10T07:03:12.952651+05:00',
  pendingExpiresAt: '2026-11-10T07:33:12+05:00', readyExpiresAt: null, completedAt: null, closedReason: null, closeNote: null,
  contact: { name: 'Ali Valiyev', phone: '+998901234567', comment: null },
  items: [{ productId: 'P1', name: 'Xudi', brand: 'B', size: 'M', color: 'Qora', colorHex: '#222222', categoryId: 'hoodies', qty: 2, unitPrice: 100000 }],
  subtotal: 200000, total: 200000, payment: { method: 'pay_at_store', status: 'unpaid', paidAt: null }, pickupCode: null, ...over,
})

describe('sanitizePickupOrder', () => {
  it('parses a server order', () => {
    const o = sanitizePickupOrder(base())!
    expect(o).toMatchObject({ orderNumber: 'PU-261110-00001', status: 'pending', total: 200000, paymentStatus: 'unpaid', pickupCode: null })
    expect(o.contact.comment).toBe('')
  })
  it('the pickup code survives ONLY for ready_for_pickup with the exact format', () => {
    for (const status of ['pending', 'preparing', 'completed', 'cancelled', 'expired']) {
      expect(sanitizePickupOrder(base({ status, pickupCode: 'K7M2QX9A' }))!.pickupCode, status).toBeNull()
    }
    expect(sanitizePickupOrder(base({ status: 'ready_for_pickup', pickupCode: 'K7M2QX9A', readyExpiresAt: '2026-11-11T07:00:00Z' }))!.pickupCode).toBe('K7M2QX9A')
    for (const bad of ['k7m2qx9a', 'K7M2QX9', 'K7M2QX9AA', 'K7M0QX9A', 'K7M1QX9A', 'K7MOQX9A', '', null, 12345678, undefined]) {
      expect(sanitizePickupOrder(base({ status: 'ready_for_pickup', pickupCode: bad }))!.pickupCode, String(bad)).toBeNull()
    }
  })
  it('CODE_RE excludes the look-alike characters 0 O 1 I', () => {
    expect(CODE_RE.test('ABCDEFGH')).toBe(true)
    for (const c of ['0', 'O', '1', 'I']) expect(CODE_RE.test(`ABCDEFG${c}`)).toBe(false)
  })
  it('deadlines are only kept for the state they belong to', () => {
    expect(sanitizePickupOrder(base({ status: 'preparing' }))!.pendingExpiresAt).toBeNull()
    expect(sanitizePickupOrder(base({ status: 'pending', readyExpiresAt: '2026-11-11T07:00:00Z' }))!.readyExpiresAt).toBeNull()
  })
  it('rejects anything malformed instead of showing a half-order as success', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}, base({ id: 'nope' }), base({ status: 'shipped' }), base({ status: 7 }), base({ total: '200000' }), base({ items: [] }), base({ items: 'x' }),
      base({ items: [{ productId: 'P1' }] }), base({ items: [{ ...base().items[0], qty: 0 }] }), base({ contact: null }), base({ createdAt: 'garbage' }), base({ orderNumber: '' })]) {
      expect(sanitizePickupOrder(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull()
    }
  })
  it('unknown payment / reason values fall back safely', () => {
    const o = sanitizePickupOrder(base({ payment: { status: 'weird' }, closedReason: 'weird' }))!
    expect(o.paymentStatus).toBe('unpaid')
    expect(o.closedReason).toBeNull()
    expect(sanitizePickupOrder(base({ status: 'completed', payment: { status: 'paid' } }))!.paymentStatus).toBe('paid')
  })
})

describe('status helpers', () => {
  it('the customer may cancel only a pending order', () => {
    expect(canCancel('pending')).toBe(true)
    for (const s of ['preparing', 'ready_for_pickup', 'completed', 'cancelled', 'expired'] as const) expect(canCancel(s), s).toBe(false)
  })
  it('open vs closed', () => {
    for (const s of ['pending', 'preparing', 'ready_for_pickup'] as const) expect(isOpen(s)).toBe(true)
    for (const s of ['completed', 'cancelled', 'expired'] as const) expect(isOpen(s)).toBe(false)
  })
  it('the progress line has the four happy-path steps in order', () => {
    expect([...STEPS]).toEqual(['pending', 'preparing', 'ready_for_pickup', 'completed'])
  })
})
