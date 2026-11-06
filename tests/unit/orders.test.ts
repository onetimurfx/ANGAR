import { describe, expect, it } from 'vitest'
import { getProduct } from '../../src/data/sample'
import { changeVariant, lineKey, type CartLine } from '../../src/lib/cartLogic'
import { computeTotals, readDeliveryConfig, type DeliveryConfig } from '../../src/lib/delivery'
import { makeRef, newAttemptId, placeOrder, sanitizeOrders, type Order, type PlaceInput } from '../../src/lib/orders'
import { formatPhoneInput, normalizePhone, validateAddress, validateContact, validateName, validatePhone } from '../../src/lib/validation'

const NOT_CONFIGURED: DeliveryConfig = { configured: false, fee: 0, freeFrom: null }
const NOW = () => new Date('2026-11-05T10:00:00Z')
const rnd = (() => { let i = 0; return () => ((i++ * 7) % 32) / 32 })()
const deps = { getProduct, now: NOW, random: rnd }
const contact = { name: 'Timur Karimov', phone: '+998 90 123 45 67', address: "Toshkent, Chilonzor 9, 12-uy", comment: '' }
const input = (over: Partial<PlaceInput> = {}): PlaceInput => ({
  attemptId: 'attempt-1',
  source: 'cart',
  contact,
  lines: [{ productId: 's-tee-1', size: 'M', color: 'Oq', qty: 2 }],
  delivery: NOT_CONFIGURED,
  ...over,
})

describe('phone', () => {
  it('normalises the accepted formats', () => {
    expect(normalizePhone('+998 90 123 45 67')).toBe('+998901234567')
    expect(normalizePhone('998901234567')).toBe('+998901234567')
    expect(normalizePhone('90 123-45-67')).toBe('+998901234567')
    expect(normalizePhone('901234567')).toBe('+998901234567')
  })
  it('rejects wrong lengths and operator codes starting with 0', () => {
    for (const bad of ['', '123', '+998 90 123 45', '+998 90 123 45 678', '012345678', '+7 912 345 67 89', 'abc']) expect(normalizePhone(bad)).toBeNull()
  })
  it('formats progressively and survives backspacing the prefix', () => {
    expect(formatPhoneInput('9')).toBe('+998 9')
    expect(formatPhoneInput('90123')).toBe('+998 90 123')
    expect(formatPhoneInput('+998 90 123 45 67')).toBe('+998 90 123 45 67')
    expect(formatPhoneInput('998901234567')).toBe('+998 90 123 45 67')
    expect(formatPhoneInput('+998 ')).toBe('')
    expect(formatPhoneInput('+998 9')).toBe('+998 9')
    expect(formatPhoneInput('+99890123456789999')).toBe('+998 90 123 45 67')
  })
  it('messages', () => {
    expect(validatePhone('')).toBe('err.phoneRequired')
    expect(validatePhone('12')).toBe('err.phoneInvalid')
    expect(validatePhone('+998 90 123 45 67')).toBeNull()
  })
})

describe('contact validation', () => {
  it('name rules', () => {
    expect(validateName('')).toBe('err.nameRequired')
    expect(validateName('   ')).toBe('err.nameRequired')
    expect(validateName('A')).toBe('err.nameShort')
    expect(validateName('12345')).toBe('err.nameInvalid')
    expect(validateName('<b>Ali</b>')).toBe('err.nameInvalid')
    expect(validateName('x'.repeat(61))).toBe('err.nameLong')
    expect(validateName("Sa'dulla Oʻktam")).toBeNull()
    expect(validateName('Иван Петров')).toBeNull()
  })
  it('address rules', () => {
    expect(validateAddress('')).toBe('err.addressRequired')
    expect(validateAddress('Uy 1')).toBe('err.addressShort')
    expect(validateAddress('a'.repeat(201))).toBe('err.addressLong')
  })
  it('collects every error and normalises a valid contact', () => {
    const bad = validateContact({ name: '', phone: '1', address: '', comment: 'x'.repeat(301) })
    expect(Object.keys(bad.errors).sort()).toEqual(['address', 'comment', 'name', 'phone'])
    expect(bad.value).toBeNull()
    const ok = validateContact({ name: '  Ali   Valiyev ', phone: '90 123 45 67', address: '  Toshkent,   Yunusobod 4  ', comment: ' tez ' })
    expect(ok.value).toEqual({ name: 'Ali Valiyev', phone: '+998901234567', address: 'Toshkent, Yunusobod 4', comment: 'tez' })
  })
})

describe('delivery', () => {
  it('is "not configured" unless a valid fee is provided', () => {
    for (const env of [{}, { VITE_DELIVERY_FEE: '' }, { VITE_DELIVERY_FEE: 'abc' }, { VITE_DELIVERY_FEE: '-5' }, { VITE_DELIVERY_FEE: '12.5' }]) expect(readDeliveryConfig(env).configured).toBe(false)
  })
  it('reads fee and free-from threshold', () => {
    expect(readDeliveryConfig({ VITE_DELIVERY_FEE: '30000' })).toEqual({ configured: true, fee: 30000, freeFrom: null })
    expect(readDeliveryConfig({ VITE_DELIVERY_FEE: '0' })).toEqual({ configured: true, fee: 0, freeFrom: null })
    expect(readDeliveryConfig({ VITE_DELIVERY_FEE: '30000', VITE_DELIVERY_FREE_FROM: '500000' })).toEqual({ configured: true, fee: 30000, freeFrom: 500000 })
    expect(readDeliveryConfig({ VITE_DELIVERY_FEE: '30000', VITE_DELIVERY_FREE_FROM: 'x' }).freeFrom).toBeNull()
  })
  it('totals', () => {
    expect(computeTotals(400000, NOT_CONFIGURED)).toEqual({ subtotal: 400000, deliveryFee: null, deliveryFree: false, deliveryPending: true, total: 400000 })
    const cfg: DeliveryConfig = { configured: true, fee: 30000, freeFrom: 500000 }
    expect(computeTotals(400000, cfg)).toMatchObject({ deliveryFee: 30000, deliveryFree: false, total: 430000 })
    expect(computeTotals(500000, cfg)).toMatchObject({ deliveryFee: 0, deliveryFree: true, total: 500000 })
    expect(computeTotals(0, cfg)).toMatchObject({ deliveryFee: 0, total: 0 })
  })
})

describe('placeOrder', () => {
  it('creates a local-only draft priced from the catalog, never from the input', () => {
    const r = placeOrder([], input(), deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.order.sync).toBe('local_only')
    expect(r.order.subtotal).toBe(2 * 190000)
    expect(r.order.total).toBe(380000)
    expect(r.order.deliveryPending).toBe(true)
    expect(r.order.deliveryFee).toBeNull()
    expect(r.order.contact.phone).toBe('+998901234567')
    expect(r.order.ref).toMatch(/^LOC-261105-[2-9A-Z]{4}$/)
    expect(r.order.items[0]).toMatchObject({ name: 'Oddiy futbolka', unitPrice: 190000, colorHex: expect.any(String) })
  })
  it('adds the configured delivery fee to the total', () => {
    const r = placeOrder([], input({ delivery: { configured: true, fee: 25000, freeFrom: null } }), deps)
    expect(r.ok && r.order.total).toBe(405000)
    expect(r.ok && r.order.deliveryFee).toBe(25000)
  })
  it('is idempotent: the same attempt id never creates a second order', () => {
    const first = placeOrder([], input(), deps)
    if (!first.ok) throw new Error('setup')
    const again = placeOrder(first.orders, input(), deps)
    expect(again.ok && again.duplicate).toBe(true)
    expect(again.ok && again.orders).toHaveLength(1)
    expect(again.ok && again.order.id).toBe(first.order.id)
    // even if the retry carries different (e.g. edited) data, the saved order wins
    const edited = placeOrder(first.orders, input({ lines: [{ productId: 's-tee-1', size: 'L', color: 'Oq', qty: 5 }] }), deps)
    expect(edited.ok && edited.duplicate).toBe(true)
    expect(edited.ok && edited.order.items[0].qty).toBe(2)
  })
  it('a new attempt id creates a new order with a different reference', () => {
    const a = placeOrder([], input(), deps)
    if (!a.ok) throw new Error('setup')
    const b = placeOrder(a.orders, input({ attemptId: 'attempt-2' }), deps)
    expect(b.ok && b.orders).toHaveLength(2)
    expect(b.ok && b.order.ref).not.toBe(a.order.ref)
  })
  it('refuses invalid contacts with field errors', () => {
    const r = placeOrder([], input({ contact: { ...contact, phone: '12', name: '' } }), deps)
    expect(r).toMatchObject({ ok: false, reason: 'contact' })
    if (!r.ok && r.reason === 'contact') expect(Object.keys(r.errors).sort()).toEqual(['name', 'phone'])
  })
  it('refuses an empty cart and invalid variants', () => {
    expect(placeOrder([], input({ lines: [] }), deps)).toMatchObject({ ok: false, reason: 'empty' })
    expect(placeOrder([], input({ lines: [{ productId: 's-tee-1', size: 'XXL', color: 'Oq', qty: 1 }] }), deps)).toMatchObject({ ok: false, reason: 'variant' })
    expect(placeOrder([], input({ lines: [{ productId: 's-tee-1', size: 'M', color: 'Yo‘q', qty: 1 }] }), deps)).toMatchObject({ ok: false, reason: 'variant' })
    expect(placeOrder([], input({ lines: [{ productId: 's-tee-1', size: 'M', color: 'Oq', qty: 0 }] }), deps)).toMatchObject({ ok: false, reason: 'variant' })
    expect(placeOrder([], input({ lines: [{ productId: 's-tee-1', size: 'M', color: 'Oq', qty: 1.5 }] }), deps)).toMatchObject({ ok: false, reason: 'variant' })
  })
  it('checks stock: out of stock, unknown product, and the total across variants', () => {
    expect(placeOrder([], input({ lines: [{ productId: 's-dress-2', size: 'M', color: 'Qora', qty: 1 }] }), deps)).toMatchObject({ ok: false, reason: 'stock', issues: [{ available: 0, reason: 'unavailable' }] })
    expect(placeOrder([], input({ lines: [{ productId: 'nope', size: 'M', color: 'Oq', qty: 1 }] }), deps)).toMatchObject({ ok: false, reason: 'stock' })
    const split = placeOrder([], input({ lines: [{ productId: 's-sweater-1', size: 'S', color: 'Bej', qty: 2 }, { productId: 's-sweater-1', size: 'M', color: 'Bej', qty: 2 }] }), deps) // stock 3
    expect(split).toMatchObject({ ok: false, reason: 'stock', issues: [{ requested: 4, available: 3 }] })
  })
  it('failed attempts save nothing', () => {
    const r = placeOrder([], input({ contact: { ...contact, name: '' } }), deps)
    expect(r.ok).toBe(false)
  })
})

describe('refs and attempt ids', () => {
  it('refs never collide with taken ones', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const r = makeRef(taken, NOW())
      expect(taken.has(r)).toBe(false)
      taken.add(r)
    }
  })
  it('attempt ids are unique', () => {
    expect(new Set(Array.from({ length: 50 }, newAttemptId)).size).toBe(50)
  })
})

describe('sanitizeOrders', () => {
  const good = (): Order => {
    const r = placeOrder([], input(), deps)
    if (!r.ok) throw new Error('setup')
    return r.order
  }
  it('keeps valid orders, newest first, and forces sync=local_only', () => {
    const a = good()
    const b = { ...good(), id: 'b', ref: 'LOC-X', createdAt: '2026-11-06T00:00:00Z', sync: 'sent' }
    const out = sanitizeOrders([a, b])
    expect(out.map((o) => o.id)).toEqual(['b', 'attempt-1'])
    expect(out.every((o) => o.sync === 'local_only')).toBe(true)
  })
  it('drops garbage, duplicates and malformed entries', () => {
    const a = good()
    expect(sanitizeOrders(null)).toEqual([])
    expect(sanitizeOrders('x')).toEqual([])
    expect(sanitizeOrders([a, a])).toHaveLength(1)
    expect(sanitizeOrders([{ ...a, items: [] }])).toEqual([])
    expect(sanitizeOrders([{ ...a, items: [{ ...a.items[0], qty: -1 }] }])).toEqual([])
    expect(sanitizeOrders([{ ...a, total: 'x' }])).toEqual([])
    expect(sanitizeOrders([{ ...a, contact: { name: 'x' } }])).toEqual([])
    expect(sanitizeOrders([{ ...a, createdAt: 'not a date' }])).toEqual([])
    expect(sanitizeOrders([42, null, {}])).toEqual([])
  })
})

describe('changeVariant', () => {
  const L = (size: string, color: string, qty: number): CartLine => ({ productId: 's-tee-1', size, color, qty })
  it('moves a line to the new variant', () => {
    const lines = [L('M', 'Oq', 2)]
    const out = changeVariant(lines, lineKey(lines[0]), { size: 'L', color: 'Qora' }, getProduct)
    expect(out).toEqual([L('L', 'Qora', 2)])
  })
  it('merges into an existing line and keeps the total quantity', () => {
    const lines = [L('M', 'Oq', 2), L('L', 'Oq', 3)]
    const out = changeVariant(lines, lineKey(lines[0]), { size: 'L', color: 'Oq' }, getProduct)
    expect(out).toEqual([L('L', 'Oq', 5)])
  })
  it('ignores invalid variants, unknown keys and no-ops', () => {
    const lines = [L('M', 'Oq', 2)]
    const k = lineKey(lines[0])
    expect(changeVariant(lines, k, { size: 'XXL', color: 'Oq' }, getProduct)).toBe(lines)
    expect(changeVariant(lines, k, { size: 'M', color: 'Yo‘q' }, getProduct)).toBe(lines)
    expect(changeVariant(lines, 'zzz', { size: 'L', color: 'Oq' }, getProduct)).toBe(lines)
    expect(changeVariant(lines, k, { size: 'M', color: 'Oq' }, getProduct)).toBe(lines)
  })
})
