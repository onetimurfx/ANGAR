import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getProduct, variantQty } from '../data/catalog'
import { backend } from './backend'
import { useBackend } from './backendContext'
import {
  addLine, cartCount, mergeCarts, cartSubtotal, changeVariant, lineKey, qtyOfProduct, removeLine, sanitizeCart, setLineQty, stockFrom,
  type AddResult, type CartLine,
} from './cartLogic'

const CART_KEY = 'aynimo:cart'
const QUICK_KEY = 'aynimo:quick'

/** The variant chosen for Quick Order. Independent from the cart. `size` is null until the customer picks one. */
export interface QuickItem {
  productId: string
  size: string | null
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
  clear: () => void
  changeVariant: (key: string, size: string, color: string) => void
  /** true while the last attempt to save the cart on the server failed (it is still kept on this device) */
  syncFailed: boolean
  quick: QuickItem | null
  setQuick: (q: QuickItem | null) => void
}

const Ctx = createContext<CartCtx | null>(null)
export const useCart = (): CartCtx => {
  const c = useContext(Ctx)
  if (!c) throw new Error('useCart outside CartProvider')
  return c
}

const stockOf = stockFrom(getProduct)
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
  if (!r || typeof r.productId !== 'string' || (r.size !== null && typeof r.size !== 'string') || typeof r.color !== 'string' || typeof r.qty !== 'number') return null
  const p = getProduct(r.productId)
  if (!p || !p.active || p.stock <= 0 || (r.size !== null && !p.sizes.includes(r.size)) || !p.colors.some((c) => c.name === r.color)) return null
  const cap = r.size === null ? p.stock : variantQty(p, r.size, r.color)
  if (cap <= 0) return null
  return { productId: r.productId, size: r.size, color: r.color, qty: Math.min(Math.max(1, Math.floor(r.qty)), cap) }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => sanitizeCart(read(window.localStorage, CART_KEY), getProduct))
  const [quick, setQuickState] = useState<QuickItem | null>(readQuick)
  const { mode, auth, version } = useBackend()
  const server = mode === 'server'
  const [syncFailed, setSyncFailed] = useState(false)
  const synced = useRef(false)
  const linesRef = useRef(lines)
  linesRef.current = lines

  // Server cart: after sign-in, merge what the server has with what is on this device (server first), then keep it saved.
  useEffect(() => {
    if (!server || auth !== 'ok' || synced.current || !backend) return
    let cancelled = false
    void (async () => {
      try {
        const remote = sanitizeCart(await backend.getCart(), getProduct)
        const merged = mergeCarts(remote, linesRef.current, stockOf)
        if (cancelled) return
        synced.current = true
        setLines(merged)
        setSyncFailed(false)
        if (JSON.stringify(merged) !== JSON.stringify(remote)) await backend.putCart(merged)
      } catch {
        if (!cancelled) setSyncFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [server, auth])

  useEffect(() => {
    if (!server || auth !== 'ok' || !synced.current || !backend) return
    const id = setTimeout(() => {
      backend!.putCart(lines).then(() => setSyncFailed(false), () => setSyncFailed(true))
    }, 500)
    return () => clearTimeout(id)
  }, [lines, server, auth])

  // fresh stock arrived: drop lines that are gone and clamp quantities
  useEffect(() => {
    if (server && version > 1) setLines((cur) => sanitizeCart(cur, getProduct))
  }, [server, version])

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
      clear: () => setLines([]),
      changeVariant: (key, size, color) => setLines((cur) => changeVariant(cur, key, { size, color }, getProduct)),
      syncFailed,
      quick,
      setQuick,
    }),
    [lines, add, quick, setQuick, syncFailed],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { lineKey }
