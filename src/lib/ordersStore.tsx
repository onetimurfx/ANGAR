import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { getProduct } from '../data/sample'
import { placeOrder, sanitizeOrders, type Order, type PlaceInput, type PlaceResult } from './orders'

const KEY = 'aynimo:orders'

export type PlaceOutcome = PlaceResult & {
  /** true only when the draft was written to this device's storage AND read back successfully */
  persisted?: boolean
}

interface Ctx {
  orders: Order[]
  /** false when this browser blocks storage: drafts then live in memory and vanish on refresh */
  storageOk: boolean
  place: (input: Omit<PlaceInput, 'delivery'> & { delivery: PlaceInput['delivery'] }) => PlaceOutcome
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
  const initial = useMemo(readStorage, [])
  const [orders, setOrders] = useState<Order[]>(initial.orders)
  const [storageOk, setStorageOk] = useState(initial.ok)
  const ref = useRef(orders)
  ref.current = orders

  const place = useCallback<Ctx['place']>((input) => {
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

  const remove = useCallback((id: string) => {
    const stored = readStorage()
    const next = (stored.ok ? stored.orders : ref.current).filter((o) => o.id !== id)
    writeStorage(next)
    ref.current = next
    setOrders(next)
  }, [])

  const value = useMemo(() => ({ orders, storageOk, place, remove }), [orders, storageOk, place, remove])
  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>
}
