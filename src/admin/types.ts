/** Shapes of the admin-api answers (see docs/ADMIN_API.md). Read defensively: the server is the source of truth. */
export type Role = 'owner' | 'manager'
export interface Me { telegramId: number; name: string; role: Role }

export const ORDER_STATUSES = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
/** the only moves the server accepts (mirrors admin_set_order_status; the server enforces it) */
export const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  new: ['confirmed', 'cancelled'], confirmed: ['preparing', 'cancelled'], preparing: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [],
}

export interface OrderRow { id: string; orderNumber: string; status: OrderStatus; source: string; createdAt: string; contactName: string; contactPhone: string; total: number; deliveryPending: boolean; itemCount: number }
export interface OrderItem { productId: string | null; name: string; brand: string; size: string; color: string; colorHex: string; qty: number; unitPrice: number }
export interface OrderFull {
  id: string; orderNumber: string; status: OrderStatus; source: string; createdAt: string
  contact: { name: string; phone: string; address: string; comment: string | null }
  subtotal: number; deliveryFee: number | null; deliveryPending: boolean; total: number; items: OrderItem[]
}
export interface OrderDetail {
  order: OrderFull
  customer: { id: string; telegramId: number; username: string | null; name: string }
  history: { status: OrderStatus; by: number | null; note: string | null; at: string }[]
}

export type PickupStatus = 'pending' | 'preparing' | 'ready_for_pickup' | 'completed' | 'cancelled' | 'expired'
export const PICKUP_GROUPS = ['active', 'pending', 'preparing', 'ready', 'history'] as const
export type PickupGroup = (typeof PICKUP_GROUPS)[number]
export interface PickupOrder {
  id: string; orderNumber: string; status: PickupStatus; createdAt: string
  pendingExpiresAt: string | null; readyAt: string | null; readyExpiresAt: string | null; completedAt: string | null
  closedAt: string | null; closedReason: string | null; closeNote: string | null
  contact: { name: string; phone: string; comment: string | null }
  subtotal: number; total: number; payment: { status: string; method: string; paidAt: string | null }; items: OrderItem[]
}
export interface PickupHistory { kind: string; status: string; actorRole: string; actorTelegramId: number | null; amount: number | null; note: string | null; at: string }

export interface DashboardData {
  cart: { new: number; confirmed: number; preparing: number; shipped: number; deliveryPending: number; today: number; todayTotal: number }
  pickup: { pending: number; preparing: number; ready: number; completedToday: number; completedTodayTotal: number }
  stock: { threshold: number; out: number; low: number }
  catalog: { active: number; inactive: number; samples: number }
  customers: { total: number; newToday: number }
  recentOrders: { id: string; orderNumber: string; status: OrderStatus; source: string; createdAt: string; contactName: string; total: number }[]
}

export interface Category { id: string; name: string; sortOrder: number; active: boolean; productCount: number; activeProductCount: number }
export interface Brand { id: string; name: string; type: 'original' | 'other'; active: boolean; productCount: number; activeProductCount: number }
export interface ProductRow { id: string; name: string; brandName: string; categoryName: string; price: number; oldPrice: number | null; active: boolean; isSample: boolean; isNew: boolean; stock: number; variantCount: number; image: string | null }
export interface Variant { id: string; size: string; colorName: string; colorHex: string; sku: string | null; active: boolean; quantity: number; reserved: number }
export interface ProductFull {
  id: string; name: string; brandId: string; categoryId: string; description: string; price: number; oldPrice: number | null; type: string
  isNew: boolean; active: boolean; isSample: boolean; variants: Variant[]; images: { id: string; path: string; sortOrder: number }[]
}
export interface InventoryRow { variantId: string; productId: string; productName: string; size: string; colorName: string; colorHex: string; sku: string | null; quantity: number; reserved: number; available: number; active: boolean }
export interface CustomerRow { id: string; telegramId: number; name: string; username: string | null; phone: string | null; createdAt: string; lastSeenAt: string | null; cartOrders: number; cartSpent: number; pickupOrders: number; pickupSpent: number }
export interface CustomerDetail {
  customer: { id: string; telegramId: number; name: string; username: string | null; phone: string | null; createdAt: string; lastSeenAt: string | null }
  orders: { id: string; orderNumber: string; status: string; source: string; createdAt: string; total: number }[]
  pickupOrders: { id: string; orderNumber: string; status: string; createdAt: string; total: number }[]
}
export interface SettingsData {
  role: Role
  settings: { deliveryFee: number | null; deliveryFreeFrom: number | null; allowSampleOrders: boolean; supportContact: string | null }
  pickup: { pendingTimeoutMinutes: number; readyHoldHours: number; maxActivePerCustomer: number; maxLines: number; storeAddress: string | null; storePhone: string | null; storeHours: string | null }
  admins: { telegramId: number; name: string; role: Role; active: boolean }[] | null
}
