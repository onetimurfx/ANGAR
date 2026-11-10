import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { backend, BackendError, type ErrorKind } from './backend'
import { useBackend } from './backendContext'
import { issuesFromServer, type StockIssue } from './orders'
import { sanitizePickupOrder, type PickupOrder } from './pickup'
import type { QuickLine } from './quickBasket'
import { validateComment, validateName, validatePhone, normalizePhone, type ContactErrors } from './validation'

/** Where the list stands. Quick Order exists on the server only: with no backend there is nothing to list. */
export type PickupStatusState = 'idle' | 'loading' | 'ready' | 'error' | 'unauth'

export interface PickupPlaceInput {
  attemptId: string
  contact: { name: string; phone: string; comment: string }
  lines: QuickLine[]
}

export type PickupPlaceOutcome =
  | { ok: true; order: PickupOrder; duplicate: boolean }
  | { ok: false; reason: 'contact'; errors: ContactErrors }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'stock'; issues: StockIssue[] }
  | { ok: false; reason: 'sample'; name: string }
  | { ok: false; reason: 'limit'; max: number }
  | { ok: false; reason: 'lines'; max: number }
  /** no answer (offline / timeout): the order MAY have reached the shop. Never reported as success, never as "not created". */
  | { ok: false; reason: 'unconfirmed'; kind: ErrorKind }
  | { ok: false; reason: 'error'; kind: ErrorKind; code: string }

export type PickupCancelOutcome = { ok: true; order: PickupOrder } | { ok: false; kind: ErrorKind; code: string }

interface Ctx {
  orders: PickupOrder[]
  status: PickupStatusState
  refresh: () => void
  place: (input: PickupPlaceInput) => Promise<PickupPlaceOutcome>
  cancel: (id: string) => Promise<PickupCancelOutcome>
  /** loads ONE order of mine from the server (the status screen polls it) and merges it into the list */
  load: (id: string) => Promise<PickupOrder | null>
}

const Ctx_ = createContext<Ctx | null>(null)
export const usePickup = (): Ctx => {
  const c = useContext(Ctx_)
  if (!c) throw new Error('usePickup outside PickupProvider')
  return c
}

const contactErrors = (c: PickupPlaceInput['contact']): ContactErrors => {
  const e: ContactErrors = {}
  const n = validateName(c.name)
  const p = validatePhone(c.phone)
  const m = validateComment(c.comment)
  if (n) e.name = n
  if (p) e.phone = p
  if (m) e.comment = m
  return e
}

export function PickupProvider({ children }: { children: ReactNode }) {
  const { mode, auth, reload } = useBackend()
  const server = mode === 'server'
  const [orders, setOrders] = useState<PickupOrder[]>([])
  const [status, setStatus] = useState<PickupStatusState>(server ? 'loading' : 'idle')
  const ref = useRef(orders)
  ref.current = orders

  const put = useCallback((o: PickupOrder) => {
    const next = [o, ...ref.current.filter((x) => x.id !== o.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    ref.current = next
    setOrders(next)
  }, [])

  const refresh = useCallback(async () => {
    if (!backend) return
    setStatus('loading')
    try {
      const list = (await backend.pickupOrders()).map(sanitizePickupOrder).filter((o): o is PickupOrder => o !== null)
      ref.current = list
      setOrders(list)
      setStatus('ready')
    } catch (e) {
      setStatus(e instanceof BackendError && (e.kind === 'auth' || e.kind === 'not_in_telegram') ? 'unauth' : 'error')
    }
  }, [])

  useEffect(() => {
    if (!server) return
    if (auth === 'ok') void refresh()
    else if (auth === 'not_in_telegram') setStatus('unauth')
    else if (auth === 'failed') setStatus('error')
  }, [server, auth, refresh])

  const place = useCallback(
    async (input: PickupPlaceInput): Promise<PickupPlaceOutcome> => {
      const errors = contactErrors(input.contact)
      if (Object.keys(errors).length) return { ok: false, reason: 'contact', errors }
      if (input.lines.length === 0) return { ok: false, reason: 'empty' }
      if (!backend) return { ok: false, reason: 'error', kind: 'misconfigured', code: 'NO_BACKEND' } // demo mode: never pretend
      try {
        const res = await backend.pickupPlace({
          idempotencyKey: input.attemptId,
          contact: { name: input.contact.name.replace(/\s+/g, ' ').trim(), phone: normalizePhone(input.contact.phone) as string, comment: input.contact.comment.trim() },
          items: input.lines.map((l) => ({ productId: l.productId, size: l.size, color: l.color, qty: l.qty })),
        })
        // success only for a well-formed order that the SERVER returned
        const order = sanitizePickupOrder(res.order)
        // the server answered 2xx but with something unreadable: the order may exist, so this is NOT "not created"
        if (!order) return { ok: false, reason: 'unconfirmed', kind: 'format' }
        put(order)
        void reload() // stock changed (reserved): show fresh numbers
        return { ok: true, order, duplicate: res.duplicate }
      } catch (e) {
        if (!(e instanceof BackendError)) return { ok: false, reason: 'error', kind: 'server', code: 'UNKNOWN' }
        // no answer, a 5xx, or a 2xx we could not read: the order MAY have been created
        if (e.kind === 'offline' || e.kind === 'timeout' || (e.status ?? 0) >= 500 || e.code === 'BAD_RESPONSE') return { ok: false, reason: 'unconfirmed', kind: e.kind }
        switch (e.code) {
          case 'ITEMS_UNAVAILABLE':
            void reload()
            return { ok: false, reason: 'stock', issues: issuesFromServer(e.detail) }
          case 'SAMPLE_PRODUCT':
            return { ok: false, reason: 'sample', name: typeof e.detail.name === 'string' ? e.detail.name : '' }
          case 'ACTIVE_LIMIT':
            return { ok: false, reason: 'limit', max: typeof e.detail.max === 'number' ? e.detail.max : 3 }
          case 'TOO_MANY_LINES':
            return { ok: false, reason: 'lines', max: typeof e.detail.max === 'number' ? e.detail.max : 10 }
          case 'INVALID_CONTACT': {
            const fields = Array.isArray(e.detail.fields) ? (e.detail.fields as unknown[]) : []
            const errs: ContactErrors = {}
            for (const f of fields) {
              if (f === 'name') errs.name = validateName(input.contact.name) ?? 'err.nameInvalid'
              else if (f === 'phone') errs.phone = validatePhone(input.contact.phone) ?? 'err.phoneInvalid'
              else if (f === 'comment') errs.comment = validateComment(input.contact.comment) ?? 'err.commentLong'
            }
            return { ok: false, reason: 'contact', errors: errs }
          }
          case 'EMPTY_ORDER':
          case 'INVALID_ITEM':
            void reload()
            return { ok: false, reason: 'stock', issues: [] }
          default:
            return { ok: false, reason: 'error', kind: e.kind, code: e.code }
        }
      }
    },
    [put, reload],
  )

  const cancel = useCallback(
    async (id: string): Promise<PickupCancelOutcome> => {
      if (!backend) return { ok: false, kind: 'misconfigured', code: 'NO_BACKEND' }
      try {
        const order = sanitizePickupOrder(await backend.pickupCancel(id))
        if (!order) return { ok: false, kind: 'format', code: 'BAD_ORDER' }
        put(order)
        void reload() // the reservation was released
        return { ok: true, order }
      } catch (e) {
        if (!(e instanceof BackendError)) return { ok: false, kind: 'server', code: 'UNKNOWN' }
        return { ok: false, kind: e.kind, code: e.code }
      }
    },
    [put, reload],
  )

  const load = useCallback(
    async (id: string): Promise<PickupOrder | null> => {
      if (!backend) return null
      const o = sanitizePickupOrder(await backend.pickupOrder(id)) // throws BackendError for 404 / network: the caller decides
      if (o) put(o)
      return o
    },
    [put],
  )

  const value = useMemo(() => ({ orders, status, refresh: () => void refresh(), place, cancel, load }), [orders, status, refresh, place, cancel, load])
  return <Ctx_.Provider value={value}>{children}</Ctx_.Provider>
}
