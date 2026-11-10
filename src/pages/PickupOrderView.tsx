import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Copy, PackageX, RefreshCw, Store } from 'lucide-react'
import { EmptyState, PageHeader, primaryBtn } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { ProgressSteps, StatusChip } from '../components/PickupStatus'
import { BackendError } from '../lib/backend'
import { errorMessage, useBackend } from '../lib/backendContext'
import { formatUZS } from '../lib/format'
import { canCancel, isOpen, type PickupOrder } from '../lib/pickup'
import { usePickup } from '../lib/pickupStore'
import { useToast } from '../lib/toast'
import { haptic } from '../lib/telegram'
import { t } from '../i18n'

const POLL_MS = 15_000
const when = (iso: string) => new Date(iso).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

type Load = 'loading' | 'ok' | 'notfound' | 'error'

/**
 * Status screen of ONE of my pickup orders. Everything shown comes from the server (never from the form): status,
 * and the pickup code ONLY while the order is `ready_for_pickup` (pickup.ts drops the code in every other state).
 * Open orders refresh by themselves; if a refresh fails, the last known state stays with a "not updated" note.
 */
export function PickupOrderView() {
  const { id = '' } = useParams()
  const { orders, load, cancel } = usePickup()
  const { mode, auth } = useBackend()
  const toast = useToast()
  const order: PickupOrder | undefined = orders.find((o) => o.id === id)
  const [state, setState] = useState<Load>(order ? 'ok' : 'loading')
  const [stale, setStale] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cancelLock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const fetchOne = useCallback(async () => {
    try {
      const o = await load(id)
      if (!alive.current) return
      setStale(false)
      setErr(null)
      setState(o ? 'ok' : 'error')
    } catch (e) {
      if (!alive.current) return
      if (e instanceof BackendError && e.code === 'NOT_FOUND') return setState('notfound') // not mine, or does not exist
      setStale(true)
      setErr(e instanceof BackendError ? errorMessage(e.kind) : errorMessage('server'))
      setState((s) => (s === 'loading' ? 'error' : s))
    }
  }, [id, load])

  const ready = mode === 'server' && auth === 'ok'
  useEffect(() => {
    if (ready) void fetchOne()
  }, [ready, fetchOne])

  const open = order ? isOpen(order.status) : true
  useEffect(() => {
    if (!ready || !open) return
    const tick = () => {
      if (document.visibilityState === 'visible') void fetchOne()
    }
    const h = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(h)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ready, open, fetchOne])

  const doCancel = async () => {
    if (cancelLock.current || !order) return
    cancelLock.current = true
    setCancelling(true)
    const r = await cancel(order.id)
    cancelLock.current = false
    if (!alive.current) return
    setCancelling(false)
    setConfirming(false)
    if (r.ok) toast.show(t('pickup.cancelDone'))
    else {
      toast.show(r.code === 'NOT_CANCELLABLE' ? t('pickup.cancelFailed') : errorMessage(r.kind), { tone: 'warn' })
      void fetchOne() // the state changed under us (e.g. the shop started preparing): show the truth
    }
  }

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      haptic()
      toast.show(t('pickup.codeCopied'))
    } catch {
      /* clipboard unavailable: the code is on the screen */
    }
  }

  if (mode !== 'server') {
    return (
      <div className="pb-36">
        <PageHeader title={t('order.title')} />
        <EmptyState icon={<PackageX className="size-7" />} title={t('pickup.notFound')} hint={t('profile.pickupDemo')} action={<Link to="/tezkor-buyurtma" className={primaryBtn}>{t('pickup.toQuick')}</Link>} />
      </div>
    )
  }
  if (state === 'notfound') {
    return (
      <div className="pb-36">
        <PageHeader title={t('order.title')} />
        <EmptyState icon={<PackageX className="size-7" />} title={t('pickup.notFound')} hint={t('pickup.notFoundHint')} action={<Link to="/tezkor-buyurtma" className={primaryBtn}>{t('pickup.toQuick')}</Link>} />
      </div>
    )
  }
  if (!order) {
    return (
      <div className="pb-36">
        <PageHeader title={t('order.title')} />
        {state === 'error' || auth === 'failed' || auth === 'not_in_telegram' ? (
          <div role="alert" data-testid="pickup-load-error" className="mx-4 mt-6 rounded-2xl bg-coral-soft px-4 py-4 text-sm font-semibold text-coral-deep">
            <p>{t('pickup.loadFailed')}</p>
            {err && <p className="mt-1 font-medium">{err}</p>}
            <button type="button" onClick={() => void fetchOne()} className="mt-3 inline-flex items-center gap-2 rounded-full bg-coral px-4 py-2 text-[13px] font-bold text-white">
              <RefreshCw className="size-4" />
              {t('pickup.retry')}
            </button>
          </div>
        ) : (
          <p role="status" className="mx-4 mt-6 rounded-2xl bg-white px-4 py-4 text-sm text-navy-soft">{t('order.loading')}</p>
        )}
      </div>
    )
  }

  const o = order
  return (
    <div className="pb-40" data-testid="pickup-order" data-status={o.status}>
      <PageHeader title={o.orderNumber} right={<StatusChip status={o.status} />} />
      <div className="space-y-4 px-4">
        {stale && open && (
          <div data-testid="pickup-stale" role="status" className="rounded-2xl bg-[#fbeedd] px-4 py-3 text-[13px] font-semibold text-[#7a4a14]">
            {t('pickup.stale')}
          </div>
        )}

        <section className="glass rounded-[28px] p-4">
          <ProgressSteps status={o.status} />
          <p data-testid="pickup-hint" className="mt-4 text-[14px] leading-snug text-navy-soft">
            {o.status === 'pending' && (o.pendingExpiresAt ? t('pickup.pendingHint', { time: when(o.pendingExpiresAt) }) : t('pickup.receivedBody'))}
            {o.status === 'preparing' && t('pickup.preparingHint')}
            {o.status === 'ready_for_pickup' && t('pickup.readyHint')}
            {o.status === 'completed' && t('pickup.completedHint')}
            {o.status === 'cancelled' && (o.closedReason === 'admin_cancelled' ? t('pickup.cancelledAdmin') : t('pickup.cancelledCustomer'))}
            {o.status === 'expired' && (o.closedReason === 'pickup_timeout' ? t('pickup.expiredReady') : t('pickup.expiredPending'))}
          </p>
          {o.status === 'cancelled' && o.closedReason === 'admin_cancelled' && o.closeNote && <p className="mt-2 text-[13.5px] font-semibold">{t('pickup.reason', { text: o.closeNote })}</p>}
          {isOpen(o.status) && <p className="mt-2 text-[11.5px] text-stone">{t('pickup.statusChecked')}</p>}
        </section>

        {/* the code exists in the data only while ready_for_pickup */}
        {o.pickupCode && (
          <section data-testid="pickup-code-card" className="rounded-[28px] bg-navy p-5 text-center text-white shadow-[0_18px_40px_-22px_rgba(23,43,58,0.9)]">
            <p className="text-[12px] font-extrabold uppercase tracking-[0.18em] text-white/70">{t('pickup.codeTitle')}</p>
            <p data-testid="pickup-code" aria-label={t('pickup.codeTitle')} className="mt-2 select-all text-[38px] font-extrabold tracking-[0.22em] tabular-nums">
              {o.pickupCode}
            </p>
            <p className="mt-1 text-[12.5px] text-white/75">{t('pickup.codeWarn')}</p>
            <button type="button" data-testid="pickup-code-copy" onClick={() => void copy(o.pickupCode!)} className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-[13px] font-bold">
              <Copy className="size-4" />
              {t('pickup.codeCopy')}
            </button>
            {o.readyExpiresAt && <p className="mt-3 text-[12.5px] text-white/75">{t('pickup.readyUntil', { time: when(o.readyExpiresAt) })}</p>}
          </section>
        )}

        <section className="rounded-[26px] bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
          <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>{t('pickup.items')}</h2>
          <ul className="mt-3 space-y-3">
            {o.items.map((i, n) => (
              <li key={`${i.productId}-${i.size}-${i.color}-${n}`} className="flex gap-3">
                <div className="size-14 shrink-0 overflow-hidden rounded-xl">
                  <ProductImage categoryId={i.categoryId} color={i.colorHex} className="size-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold">{i.name}</p>
                  <p className="text-[12.5px] text-navy-soft">{i.color} · {i.size} · {i.qty} {t('common.pcs')}</p>
                </div>
                <span className="text-[14px] font-extrabold tabular-nums">{formatUZS(i.unitPrice * i.qty)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-baseline justify-between border-t border-navy/[0.07] pt-3">
            <span className="text-[12px] font-extrabold uppercase tracking-wider text-stone">{t('pickup.total')}</span>
            <span data-testid="pickup-order-total" className="text-[20px] font-extrabold tabular-nums">{formatUZS(o.total)}</span>
          </div>
          <p className="mt-2 flex items-center gap-2 text-[12.5px] text-navy-soft">
            <Store className="size-4 text-coral" />
            {t('pickup.payment')}: <b>{o.paymentStatus === 'paid' ? t('pickup.paid') : t('pickup.payAtStore')}</b>
          </p>
        </section>

        <section className="rounded-[26px] bg-white p-4 text-[14px] shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
          <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>{t('pickup.contactTitle')}</h2>
          <dl className="mt-3 space-y-2">
            <div className="flex justify-between gap-4"><dt className="text-navy-soft">{t('form.name')}</dt><dd className="text-right font-semibold">{o.contact.name}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-navy-soft">{t('form.phone')}</dt><dd className="text-right font-semibold tabular-nums">{o.contact.phone}</dd></div>
            {o.contact.comment && <div className="flex justify-between gap-4"><dt className="text-navy-soft">{t('form.comment')}</dt><dd className="text-right font-semibold">{o.contact.comment}</dd></div>}
            <div className="flex justify-between gap-4"><dt className="text-navy-soft">{t('pickup.date')}</dt><dd className="text-right font-semibold">{when(o.createdAt)}</dd></div>
          </dl>
        </section>

        {canCancel(o.status) && (
          <div>
            {!confirming ? (
              <button type="button" data-testid="pickup-cancel" onClick={() => setConfirming(true)} className="w-full rounded-full bg-white px-5 py-3.5 text-[14px] font-bold text-coral-deep shadow-[0_8px_22px_-16px_rgba(23,43,58,0.5)]">
                {t('pickup.cancel')}
              </button>
            ) : (
              <div role="alertdialog" aria-label={t('pickup.cancel')} className="rounded-2xl bg-coral-soft p-4 text-[13.5px] font-semibold text-coral-deep">
                <p>{t('pickup.cancelAsk')}</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" data-testid="pickup-cancel-yes" disabled={cancelling} onClick={() => void doCancel()} className="flex-1 rounded-full bg-coral px-4 py-3 text-[13.5px] font-bold text-white disabled:opacity-60">
                    {cancelling ? t('pickup.cancelling') : t('pickup.cancelYes')}
                  </button>
                  <button type="button" disabled={cancelling} onClick={() => setConfirming(false)} className="flex-1 rounded-full bg-white px-4 py-3 text-[13.5px] font-bold text-navy disabled:opacity-60">
                    {t('pickup.cancelNo')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <Link to="/profil" className="block text-center text-[13px] font-bold text-coral">{t('order.toProfile')}</Link>
      </div>
    </div>
  )
}
