import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getProduct } from '../data/sample'
import {
  addLine, cartCount, cartSubtotal, lineKey, qtyOfProduct, removeLine, sanitizeCart, setLineQty,
  type AddResult, type CartLine,
} from './cartLogic'

const CART_KEY = 'aynimo:cart'
const QUICK_KEY = 'aynimo:quick'

/** The variant chosen for Quick Order. Independent from the cart (the order form arrives in Phase 4). */
export interface QuickItem {
  productId: string
  size: string
  color: string
  qty: number
}

interface CartCtx {
  lines: CartLine[]
  count: number
  subtotal: number
  qtyOf: (productId: string, exceptKey?: string) => number
  add: (line: CartLine) => AddResult
  setQty: (key: string, qty: number) => void
  remove: (key: string) => void
  quick: QuickItem | null
  setQuick: (q: QuickItem | null) => void
}

const Ctx = createContext<CartCtx | null>(null)
export const useCart = (): CartCtx => {
  const c = useContext(Ctx)
  if (!c) throw new Error('useCart outside CartProvider')
  return c
}

const stockOf = (id: string) => getProduct(id)?.stock ?? 0
const priceOf = (id: string) => getProduct(id)?.price ?? 0

function read(storage: Storage | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function readQuick(): QuickItem | null {
  const r = read(window.sessionStorage, QUICK_KEY) as Partial<QuickItem> | null
  if (!r || typeof r.productId !== 'string' || typeof r.size !== 'string' || typeof r.color !== 'string' || typeof r.qty !== 'number') return null
  const p = getProduct(r.productId)
  if (!p || !p.active || p.stock <= 0 || !p.sizes.includes(r.size) || !p.colors.some((c) => c.name === r.color)) return null
  return { productId: r.productId, size: r.size, color: r.color, qty: Math.min(Math.max(1, Math.floor(r.qty)), p.stock) }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => sanitizeCart(read(window.localStorage, CART_KEY), getProduct))
  const [quick, setQuickState] = useState<QuickItem | null>(readQuick)

  useEffect(() => {
    try {
      window.localStorage.setItem(CART_KEY, JSON.stringify(lines))
    } catch {
      /* storage unavailable (private mode): the cart still works in memory for this session */
    }
  }, [lines])

  const setQuick = useCallback((q: QuickItem | null) => {
    setQuickState(q)
    try {
      if (q) window.sessionStorage.setItem(QUICK_KEY, JSON.stringify(q))
      else window.sessionStorage.removeItem(QUICK_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const add = useCallback(
    (line: CartLine): AddResult => {
      const res = addLine(lines, line, stockOf)
      if (res.ok) setLines(res.lines)
      return res
    },
    [lines],
  )

  const value = useMemo<CartCtx>(
    () => ({
      lines,
      count: cartCount(lines),
      subtotal: cartSubtotal(lines, priceOf),
      qtyOf: (id, except) => qtyOfProduct(lines, id, except),
      add,
      setQty: (key, qty) => setLines((cur) => setLineQty(cur, key, qty, stockOf)),
      remove: (key) => setLines((cur) => removeLine(cur, key)),
      quick,
      setQuick,
    }),
    [lines, add, quick, setQuick],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { lineKey }
