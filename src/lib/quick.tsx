import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getProduct } from '../data/catalog'
import { useBackend } from './backendContext'
import { addLine, basketCount, basketSubtotal, removeLine, sanitizeBasket, setQty as setLineQty, type AddResult, type QuickLine } from './quickBasket'

/** Quick Order basket (store pickup). Own storage key, independent from the Cart. sessionStorage: it is a short-lived selection. */
const KEY = 'aynimo:quick-basket'

interface Ctx {
  lines: QuickLine[]
  count: number
  subtotal: number
  add: (line: QuickLine) => AddResult
  setQty: (key: string, qty: number) => void
  remove: (key: string) => void
  clear: () => void
  /** re-validates the lines against the catalog and returns how many were changed or dropped */
  revalidate: () => number
}

const QuickCtx = createContext<Ctx | null>(null)
export const useQuick = (): Ctx => {
  const c = useContext(QuickCtx)
  if (!c) throw new Error('useQuick outside QuickProvider')
  return c
}

function read(): unknown {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function QuickProvider({ children }: { children: ReactNode }) {
  const { version } = useBackend()
  const [lines, setLines] = useState<QuickLine[]>(() => sanitizeBasket(read(), getProduct))
  const ref = useRef(lines)
  ref.current = lines

  useEffect(() => {
    try {
      if (lines.length) window.sessionStorage.setItem(KEY, JSON.stringify(lines))
      else window.sessionStorage.removeItem(KEY)
    } catch {
      /* storage unavailable: the basket still works in memory */
    }
  }, [lines])

  // fresh stock arrived: drop variants that are gone, clamp quantities
  useEffect(() => {
    if (version > 1) setLines((cur) => sanitizeBasket(cur, getProduct))
  }, [version])

  const add = useCallback((line: QuickLine): AddResult => {
    const res = addLine(ref.current, line, getProduct)
    if (res.ok) {
      ref.current = res.lines
      setLines(res.lines)
    }
    return res
  }, [])

  const revalidate = useCallback(() => {
    const next = sanitizeBasket(ref.current, getProduct)
    const changed = next.length !== ref.current.length || next.some((l, i) => l.qty !== ref.current[i]?.qty)
    ref.current = next
    setLines(next)
    return changed ? 1 : 0
  }, [])

  const value = useMemo<Ctx>(
    () => ({
      lines,
      count: basketCount(lines),
      subtotal: basketSubtotal(lines, getProduct),
      add,
      setQty: (key, qty) => setLines((cur) => setLineQty(cur, key, qty, getProduct)),
      remove: (key) => setLines((cur) => removeLine(cur, key)),
      clear: () => {
        ref.current = []
        setLines([])
      },
      revalidate,
    }),
    [lines, add, revalidate],
  )
  return <QuickCtx.Provider value={value}>{children}</QuickCtx.Provider>
}
