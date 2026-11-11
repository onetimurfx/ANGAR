import type { Product } from '../data/types'
import type { ErrorKind } from './backend'
import { variantQty } from '../data/catalog'
import { computeTotals, type DeliveryConfig } from './delivery'
import { validateContact, type Contact, type ContactErrors, type ContactInput } from './validation'

/**
 * An `Order` is either
 *   sync 'server'     - stored by the ANGAR backend (id + orderNumber come from the server), or
 *   sync 'local_only' - a DRAFT kept on this device only (demo mode, no backend configured). The shop has NOT received it.
 * Only orders read back from the server may ever be marked 'server'; anything read from local storage is forced to 'local_only'.
 */
export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'shipped' | 'delivered' | 'cancelled'
const STATUSES: OrderStatus[] = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled']

export interface OrderItem {
  productId: string
  name: string
  brandId: string
  categoryId: string
  size: string
  color: string
  colorHex: string
  qty: number
  /** UZS, copied from the catalog at the time of ordering */
  unitPrice: number
}

export interface Order {
  /** idempotency key of the submit attempt */
  id: string
  /** local reference shown to the customer. NOT an official ANGAR order number. */
  ref: string
  source: 'quick' | 'cart'
  createdAt: string
  contact: Contact
  items: OrderItem[]
  subtotal: number
  deliveryFee: number | null
  deliveryPending: boolean
  total: number
  sync: 'local_only' | 'server'
  /** official ANGAR order number, only for sync 'server' */
  orderNumber?: string
  status?: OrderStatus
  /** unverified Telegram id (display/prefill only, the backend will verify initData) */
  telegramUserId?: number
}

export interface OrderLineInput {
  productId: string
  size: string
  color: string
  qty: number
}

export interface StockIssue {
  productId: string
  name: string
  requested: number
  available: number
  reason: 'unavailable' | 'stock'
  size?: string
  color?: string
}

export type PlaceResult =
  | { ok: true; order: Order; orders: Order[]; duplicate: boolean }
  | { ok: false; reason: 'contact'; errors: ContactErrors }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'variant'; productId: string }
  | { ok: false; reason: 'stock'; issues: StockIssue[] }
  | { ok: false; reason: 'sample'; name: string }
  /** the server could not be reached / refused: `kind` says why, the screen shows a matching message */
  | { ok: false; reason: 'error'; kind: ErrorKind; code: string }

export interface PlaceInput {
  attemptId: string
  source: Order['source']
  contact: ContactInput
  lines: OrderLineInput[]
  delivery: DeliveryConfig
  telegramUserId?: number
}

export interface PlaceDeps {
  getProduct: (id: string) => Product | undefined
  now?: () => Date
  random?: () => number
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function makeRef(taken: Iterable<string>, now: Date, random: () => number = Math.random): string {
  const used = new Set(taken)
  const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  for (let i = 0; i < 100; i++) {
    let s = ''
    for (let k = 0; k < 4; k++) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
    const ref = `LOC-${stamp}-${s}`
    if (!used.has(ref)) return ref
  }
  return `LOC-${stamp}-${now.getTime().toString(36).toUpperCase()}`
}

/**
 * Validates everything again (the UI is never trusted) and builds the draft.
 * Idempotent: the same `attemptId` returns the already saved order instead of creating another one.
 */
export function placeOrder(existing: Order[], input: PlaceInput, deps: PlaceDeps): PlaceResult {
  const dup = existing.find((o) => o.id === input.attemptId)
  if (dup) return { ok: true, order: dup, orders: existing, duplicate: true }

  const { errors, value: contact } = validateContact(input.contact)
  if (!contact) return { ok: false, reason: 'contact', errors }
  if (input.lines.length === 0) return { ok: false, reason: 'empty' }

  const items: OrderItem[] = []
  for (const l of input.lines) {
    const p = deps.getProduct(l.productId)
    if (!p || !p.active) return { ok: false, reason: 'stock', issues: [{ productId: l.productId, name: p?.name ?? l.productId, requested: l.qty, available: 0, reason: 'unavailable' }] }
    const color = p.colors.find((c) => c.name === l.color)
    if (!p.sizes.includes(l.size) || !color || !Number.isInteger(l.qty) || l.qty < 1) return { ok: false, reason: 'variant', productId: p.id }
    items.push({ productId: p.id, name: p.name, brandId: p.brandId, categoryId: p.categoryId, size: l.size, color: color.name, colorHex: color.hex, qty: l.qty, unitPrice: p.price })
  }

  // total per product (all sizes/colours together) may never exceed its stock
  const issues: StockIssue[] = []
  const perProduct = new Map<string, number>()
  for (const it of items) perProduct.set(it.productId, (perProduct.get(it.productId) ?? 0) + it.qty)
  for (const [id, requested] of perProduct) {
    const p = deps.getProduct(id) as Product
    if (p.stock <= 0) issues.push({ productId: id, name: p.name, requested, available: 0, reason: 'unavailable' })
    else if (requested > p.stock) issues.push({ productId: id, name: p.name, requested, available: p.stock, reason: 'stock' })
  }
  const perVariant = new Map<string, OrderItem & { want: number }>()
  for (const it of items) {
    const k = `${it.productId}|${it.size}|${it.color}`
    perVariant.set(k, { ...it, want: (perVariant.get(k)?.want ?? 0) + it.qty })
  }
  for (const v of perVariant.values()) {
    const have = variantQty(deps.getProduct(v.productId) as Product, v.size, v.color)
    if (v.want > have && !issues.some((i) => i.productId === v.productId)) issues.push({ productId: v.productId, name: v.name, requested: v.want, available: have, reason: have <= 0 ? 'unavailable' : 'stock', size: v.size, color: v.color })
  }
  if (issues.length) return { ok: false, reason: 'stock', issues }

  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0)
  const totals = computeTotals(subtotal, input.delivery)
  const now = (deps.now ?? (() => new Date()))()
  const order: Order = {
    id: input.attemptId,
    ref: makeRef(existing.map((o) => o.ref), now, deps.random),
    source: input.source,
    createdAt: now.toISOString(),
    contact,
    items,
    subtotal: totals.subtotal,
    deliveryFee: totals.deliveryFee,
    deliveryPending: totals.deliveryPending,
    total: totals.total,
    sync: 'local_only',
    ...(input.telegramUserId ? { telegramUserId: input.telegramUserId } : {}),
  }
  return { ok: true, order, orders: [order, ...existing], duplicate: false }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function sanitizeItem(r: unknown): OrderItem | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  if (!isStr(o.productId) || !isStr(o.name) || !isStr(o.size) || !isStr(o.color) || !isStr(o.colorHex) || !isStr(o.categoryId) || !isStr(o.brandId)) return null
  if (!isNum(o.qty) || !Number.isInteger(o.qty) || o.qty < 1 || !isNum(o.unitPrice)) return null
  return { productId: o.productId, name: o.name, brandId: o.brandId, categoryId: o.categoryId, size: o.size, color: o.color, colorHex: o.colorHex, qty: o.qty, unitPrice: o.unitPrice }
}

/** Rebuilds the order list from untrusted storage: drops malformed entries and duplicate ids, newest first. */
export function sanitizeOrders(raw: unknown): Order[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Order[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const c = o.contact as Record<string, unknown> | undefined
    if (!isStr(o.id) || !isStr(o.ref) || seen.has(o.id)) continue
    if (o.source !== 'quick' && o.source !== 'cart') continue
    if (!isStr(o.createdAt) || Number.isNaN(Date.parse(o.createdAt))) continue
    if (!c || !isStr(c.name) || !isStr(c.phone) || !isStr(c.address) || typeof c.comment !== 'string') continue
    if (!Array.isArray(o.items)) continue
    const items = o.items.map(sanitizeItem)
    if (items.length === 0 || items.some((i) => i === null)) continue
    if (!isNum(o.subtotal) || !isNum(o.total) || typeof o.deliveryPending !== 'boolean') continue
    if (o.deliveryFee !== null && !isNum(o.deliveryFee)) continue
    seen.add(o.id)
    out.push({
      id: o.id,
      ref: o.ref,
      source: o.source,
      createdAt: o.createdAt,
      contact: { name: c.name, phone: c.phone, address: c.address, comment: c.comment },
      items: items as OrderItem[],
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee as number | null,
      deliveryPending: o.deliveryPending,
      total: o.total,
      sync: 'local_only', // nothing stored locally can ever claim to be on the server
      ...(isNum(o.telegramUserId) ? { telegramUserId: o.telegramUserId } : {}),
    })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** A UUID v4: the server uses it as the idempotency key, so it must be a real UUID even without crypto.randomUUID. */
export function newAttemptId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
  } catch {
    /* fall through */
  }
  const r = () => Math.floor(Math.random() * 16).toString(16)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => (c === 'x' ? r() : ((Math.floor(Math.random() * 4) + 8).toString(16))))
}

/** Maps the JSON the server returns (order_to_json) to an Order. Untrusted input: anything malformed -> null. */
export function fromServerOrder(raw: unknown): Order | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const c = o.contact as Record<string, unknown> | undefined
  if (!isUuid(o.id) || !isStr(o.orderNumber) || !isStr(o.createdAt) || Number.isNaN(Date.parse(o.createdAt))) return null
  if (o.source !== 'quick' && o.source !== 'cart') return null
  if (!c || !isStr(c.name) || !isStr(c.phone) || !isStr(c.address)) return null
  if (!Array.isArray(o.items) || o.items.length === 0) return null
  const items = o.items.map((i): OrderItem | null => {
    if (!i || typeof i !== 'object') return null
    const r = i as Record<string, unknown>
    if (!isStr(r.productId) || !isStr(r.name) || !isStr(r.size) || !isStr(r.color) || !isStr(r.colorHex)) return null
    if (!isNum(r.qty) || !Number.isInteger(r.qty) || r.qty < 1 || !isNum(r.unitPrice)) return null
    return { productId: r.productId, name: r.name, brandId: typeof r.brand === 'string' ? r.brand : '', categoryId: typeof r.categoryId === 'string' ? r.categoryId : '', size: r.size, color: r.color, colorHex: r.colorHex, qty: r.qty, unitPrice: r.unitPrice }
  })
  if (items.some((i) => i === null)) return null
  if (!isNum(o.subtotal) || !isNum(o.total) || typeof o.deliveryPending !== 'boolean') return null
  if (o.deliveryFee !== null && !isNum(o.deliveryFee)) return null
  return {
    id: o.id,
    ref: o.orderNumber,
    orderNumber: o.orderNumber,
    status: STATUSES.includes(o.status as OrderStatus) ? (o.status as OrderStatus) : 'new',
    source: o.source,
    createdAt: o.createdAt,
    contact: { name: c.name, phone: c.phone, address: c.address, comment: typeof c.comment === 'string' ? c.comment : '' },
    items: items as OrderItem[],
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee as number | null,
    deliveryPending: o.deliveryPending,
    total: o.total,
    sync: 'server',
  }
}

/** Server stock issues -> StockIssue list for the checkout message. */
export function issuesFromServer(detail: Record<string, unknown>): StockIssue[] {
  const raw = Array.isArray(detail.issues) ? detail.issues : []
  const out: StockIssue[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const i = r as Record<string, unknown>
    if (typeof i.productId !== 'string') continue
    out.push({
      productId: i.productId,
      name: typeof i.name === 'string' ? i.name : i.productId,
      requested: typeof i.requested === 'number' ? i.requested : 0,
      available: typeof i.available === 'number' ? i.available : 0,
      reason: i.reason === 'stock' ? 'stock' : 'unavailable',
      ...(typeof i.size === 'string' ? { size: i.size } : {}),
      ...(typeof i.color === 'string' ? { color: i.color } : {}),
    })
  }
  return out
}
