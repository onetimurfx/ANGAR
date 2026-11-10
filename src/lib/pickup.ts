/**
 * Quick Order = STORE PICKUP. Types and strict parsing of what the server returns.
 * The pickup code is kept only for an order that is `ready_for_pickup` and only if it has the exact server format, so
 * the UI can never show a code for any other state, whatever a response contained.
 */
import type { Key } from '../i18n/uz'

export type PickupStatus = 'pending' | 'preparing' | 'ready_for_pickup' | 'completed' | 'cancelled' | 'expired'
const STATUSES: PickupStatus[] = ['pending', 'preparing', 'ready_for_pickup', 'completed', 'cancelled', 'expired']
export const isPickupStatus = (v: unknown): v is PickupStatus => typeof v === 'string' && (STATUSES as string[]).includes(v)

/** the order is still being handled by the shop */
export const isOpen = (s: PickupStatus) => s === 'pending' || s === 'preparing' || s === 'ready_for_pickup'
/** the customer may cancel only while the shop has not started */
export const canCancel = (s: PickupStatus) => s === 'pending'

export interface PickupItem {
  productId: string
  name: string
  brand: string
  size: string
  color: string
  colorHex: string
  categoryId: string
  qty: number
  unitPrice: number
}

export interface PickupOrder {
  id: string
  orderNumber: string
  status: PickupStatus
  createdAt: string
  /** while pending: the shop must accept before this time, otherwise the order expires */
  pendingExpiresAt: string | null
  readyExpiresAt: string | null
  completedAt: string | null
  closedReason: 'customer_cancelled' | 'admin_cancelled' | 'pending_timeout' | 'pickup_timeout' | null
  closeNote: string | null
  contact: { name: string; phone: string; comment: string }
  items: PickupItem[]
  subtotal: number
  total: number
  paymentStatus: 'unpaid' | 'paid' | 'refunded'
  /** only while `ready_for_pickup` */
  pickupCode: string | null
}

export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REASONS = ['customer_cancelled', 'admin_cancelled', 'pending_timeout', 'pickup_timeout'] as const

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const date = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

export function sanitizePickupOrder(raw: unknown): PickupOrder | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  const orderNumber = str(o.orderNumber)
  const createdAt = date(o.createdAt)
  if (!id || !UUID_RE.test(id) || !orderNumber || !createdAt || !isPickupStatus(o.status)) return null
  const status = o.status
  const c = o.contact && typeof o.contact === 'object' ? (o.contact as Record<string, unknown>) : null
  const pay = o.payment && typeof o.payment === 'object' ? (o.payment as Record<string, unknown>) : null
  const total = num(o.total)
  const subtotal = num(o.subtotal)
  if (!c || total === null || subtotal === null || !Array.isArray(o.items) || o.items.length === 0) return null
  const items: PickupItem[] = []
  for (const r of o.items) {
    if (!r || typeof r !== 'object') return null
    const i = r as Record<string, unknown>
    const qty = num(i.qty)
    const unitPrice = num(i.unitPrice)
    if (!str(i.productId) || !str(i.name) || !str(i.size) || !str(i.color) || qty === null || qty < 1 || unitPrice === null) return null
    items.push({
      productId: i.productId as string, name: i.name as string, brand: str(i.brand) ?? '', size: i.size as string, color: i.color as string,
      colorHex: str(i.colorHex) ?? '#cccccc', categoryId: str(i.categoryId) ?? '', qty, unitPrice,
    })
  }
  const code = str(o.pickupCode)
  const reason = (REASONS as readonly unknown[]).includes(o.closedReason) ? (o.closedReason as PickupOrder['closedReason']) : null
  const ps = pay?.status
  return {
    id, orderNumber, status, createdAt,
    pendingExpiresAt: status === 'pending' ? date(o.pendingExpiresAt) : null,
    readyExpiresAt: status === 'ready_for_pickup' ? date(o.readyExpiresAt) : null,
    completedAt: date(o.completedAt),
    closedReason: reason,
    closeNote: str(o.closeNote),
    contact: { name: str(c.name) ?? '', phone: str(c.phone) ?? '', comment: str(c.comment) ?? '' },
    items, subtotal, total,
    paymentStatus: ps === 'paid' || ps === 'refunded' ? ps : 'unpaid',
    pickupCode: status === 'ready_for_pickup' && code && CODE_RE.test(code) ? code : null,
  }
}

export const STATUS_LABEL: Record<PickupStatus, Key> = {
  pending: 'pickup.status.pending',
  preparing: 'pickup.status.preparing',
  ready_for_pickup: 'pickup.status.ready_for_pickup',
  completed: 'pickup.status.completed',
  cancelled: 'pickup.status.cancelled',
  expired: 'pickup.status.expired',
}

/** the happy path shown as a progress line */
export const STEPS = ['pending', 'preparing', 'ready_for_pickup', 'completed'] as const satisfies readonly PickupStatus[]
