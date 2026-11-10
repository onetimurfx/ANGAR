import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getProduct } from '../data/catalog'
import { backend, BackendError } from './backend'
import { useBackend } from './backendContext'
import { fromServerOrder, issuesFromServer, placeOrder, sanitizeOrders, type Order, type PlaceInput, type PlaceResult } from './orders'
import { validateContact, validateField, type ContactErrors, type ContactField } from './validation'

const KEY = 'aynimo:orders'

export type PlaceOutcome = PlaceResult & {
  /** true only when the draft was written to this device's storage AND read back successfully */
  persisted?: boolean
}

/** Where the order list stands (server mode only; demo mode is always 'ready'). */
export type OrdersStatus = 'loading' | 'ready' | 'error' | 'unauth'

interface Ctx {
  orders: Order[]
  status: OrdersStatus
  /** reloads the orders from the server */
  refresh: () => void
  /** false when this browser blocks storage: drafts then live in memory and vanish on refresh */
  storageOk: boolean
  place: (input: PlaceInput) => Promise<PlaceOutcome>
  remove: (id: string) => void
}

const OrdersCtx = createContext<Ctx | null>(null)
export const useOrders = (): Ctx => {
  const c = useContext(OrdersCtx)
  if (!c) throw new Error('useOrders outside OrdersProvider')
  return c
}

function readStorage(): { orders: Order[]; ok: boolean } {
  try {
    const raw = window.localStorage.getItem(KEY)
    return { orders: raw ? sanitizeOrders(JSON.parse(raw)) : [], ok: true }
  } catch {
    // unreadable JSON still means storage works; a thrown SecurityError means it does not. Distinguish:
    try {
      window.localStorage.getItem('aynimo:probe')
      return { orders: [], ok: true }
    } catch {
      return { orders: [], ok: false }
    }
  }
}

function writeStorage(orders: Order[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(orders))
    return true
  } catch {
    return false
  }
}

export function OrdersProvider({ children }: { children: ReactNode }) {
  const { mode, auth, reload } = useBackend()
  const server = mode === 'server'
  // In server mode the list comes from the backend only: nothing from local storage can pose as a server order.
  const initial = useMemo(() => (server ? { orders: [] as Order[], ok: true } : readStorage()), [server])
  const [orders, setOrders] = useState<Order[]>(initial.orders)
  const [storageOk, setStorageOk] = useState(initial.ok)
  const [status, setStatus] = useState<OrdersStatus>(server ? 'loading' : 'ready')
  const ref = useRef(orders)
  ref.current = orders

  const load = useCallback(async () => {
    if (!backend) return
    setStatus('loading')
    try {
      const list = (await backend.myOrders()).map(fromServerOrder).filter((o): o is Order => o !== null)
      setOrders(list)
      ref.current = list
      setStatus('ready')
    } catch (e) {
      setStatus(e instanceof BackendError && (e.kind === 'auth' || e.kind === 'not_in_telegram') ? 'unauth' : 'error')
    }
  }, [])

  useEffect(() => {
    if (!server) return
    if (auth === 'ok') void load()
    else if (auth === 'not_in_telegram') setStatus('unauth')
    else if (auth === 'failed') setStatus('error')
  }, [server, auth, load])

  const placeOnServer = useCallback(
    async (input: PlaceInput): Promise<PlaceOutcome> => {
      const { errors, value } = validateContact(input.contact)
      if (!value) return { ok: false, reason: 'contact', errors }
      if (input.lines.length === 0) return { ok: false, reason: 'empty' }
      // Quick Order is store pickup (pickupStore); only the Cart may use this endpoint
      if (input.source !== 'cart') return { ok: false, reason: 'error', kind: 'invalid', code: 'QUICK_ORDER_MOVED' }
      try {
        const res = await backend!.placeOrder({ idempotencyKey: input.attemptId, source: 'cart', contact: value, items: input.lines })
        const order = fromServerOrder(res.order)
        if (!order) return { ok: false, reason: 'error', kind: 'format', code: 'BAD_ORDER' }
        const next = [order, ...ref.current.filter((o) => o.id !== order.id)]
        ref.current = next
        setOrders(next)
        return { ok: true, order, orders: next, duplicate: res.duplicate, persisted: true }
      } catch (e) {
        if (!(e instanceof BackendError)) return { ok: false, reason: 'error', kind: 'server', code: 'UNKNOWN' }
        if (e.code === 'ITEMS_UNAVAILABLE') {
          void reload() // stock changed: show the fresh numbers
          return { ok: false, reason: 'stock', issues: issuesFromServer(e.detail) }
        }
        if (e.code === 'SAMPLE_PRODUCT') return { ok: false, reason: 'sample', name: typeof e.detail.name === 'string' ? e.detail.name : '' }
        if (e.code === 'INVALID_CONTACT') {
          const fields = Array.isArray(e.detail.fields) ? (e.detail.fields as unknown[]) : []
          const errs: ContactErrors = {}
          for (const f of fields) if (f === 'name' || f === 'phone' || f === 'address' || f === 'comment') errs[f as ContactField] = validateField(f as ContactField, input.contact[f as ContactField]) ?? 'form.invalid'
          return { ok: false, reason: 'contact', errors: errs }
        }
        if (e.code === 'INVALID_ITEM' || e.code === 'EMPTY_ORDER') {
          void reload()
          return { ok: false, reason: 'variant', productId: '' }
        }
        return { ok: false, reason: 'error', kind: e.kind, code: e.code }
      }
    },
    [reload],
  )

  const placeLocal = useCallback((input: PlaceInput): PlaceOutcome => {
    // Always decide against the newest saved list (another tab may have saved an order meanwhile),
    // so the same attempt id can never be saved twice.
    const stored = readStorage()
    const base = stored.ok ? stored.orders : ref.current
    const res = placeOrder(base, input, { getProduct })
    if (!res.ok) return res
    if (res.duplicate) {
      setOrders(res.orders)
      return { ...res, persisted: stored.ok }
    }
    const written = writeStorage(res.orders)
    const verified = written && readStorage().orders.some((o) => o.id === res.order.id)
    setStorageOk(verified)
    setOrders(res.orders)
    ref.current = res.orders
    return { ...res, persisted: verified }
  }, [])

  const place = useCallback<Ctx['place']>((input) => (server ? placeOnServer(input) : Promise.resolve(placeLocal(input))), [server, placeOnServer, placeLocal])

  const remove = useCallback((id: string) => {
    if (server) return // server orders are never deleted from the app
    const stored = readStorage()
    const next = (stored.ok ? stored.orders : ref.current).filter((o) => o.id !== id)
    writeStorage(next)
    ref.current = next
    setOrders(next)
  }, [server])

  const refresh = useCallback(() => void load(), [load])
  const value = useMemo(() => ({ orders, status, refresh, storageOk, place, remove }), [orders, status, refresh, storageOk, place, remove])
  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>
}
