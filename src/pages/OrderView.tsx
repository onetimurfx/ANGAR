import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CheckCircle2, CloudOff, FileX2, TriangleAlert } from 'lucide-react'
import { PageHeader, EmptyState, primaryBtn } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { DraftBadge } from '../components/NoticeBanner'
import { useOrders } from '../lib/ordersStore'
import { formatUZS } from '../lib/format'
import { t } from '../i18n'

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Confirmation / detail of a DEVICE-ONLY draft. It never claims the shop received anything. */
export function OrderView() {
  const { id = '' } = useParams()
  const { orders, remove, storageOk, status, refresh } = useOrders()
  const navigate = useNavigate()
  const [asking, setAsking] = useState(false)
  const order = orders.find((o) => o.id === id)

  if (!order && status === 'loading') {
    return (
      <div className="pb-36">
        <PageHeader title={t('order.title')} />
        <p role="status" className="px-4 py-10 text-center text-[14px] font-semibold text-navy-soft">{t('order.loading')}</p>
      </div>
    )
  }

  if (!order && status === 'error') {
    return (
      <div className="pb-36">
        <PageHeader title={t('order.title')} />
        <EmptyState
          icon={<CloudOff className="size-7" />}
          title={t('order.loadFailed')}
          action={
            <button type="button" onClick={refresh} className={primaryBtn}>
              {t('profile.retry')}
            </button>
          }
        />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="pb-36">
        <PageHeader title={t('order.title')} />
        <EmptyState
          icon={<FileX2 className="size-7" />}
          title={t('order.notFound')}
          hint={t('order.notFoundHint')}
          action={
            <Link to="/katalog" className={primaryBtn}>
              {t('order.toCatalog')}
            </Link>
          }
        />
      </div>
    )
  }

  const isServer = order.sync === 'server'

  return (
    <div className="pb-40">
      <PageHeader title={t('order.title')} right={isServer ? undefined : <DraftBadge />} />
      <div className="space-y-4 px-4">
        {isServer && (
          <section data-testid="order-confirmed" role="status" className="rounded-[28px] bg-[#e8f1df] p-5 text-[#2f4a1f]">
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#cfe3bd]">
                <CheckCircle2 className="size-5" />
              </span>
              <div>
                <p className="text-[12px] font-extrabold uppercase tracking-wider opacity-80">{t('order.status')}: {t(`order.status.${order.status ?? 'new'}`)}</p>
                <h2 className="text-[22px] leading-tight">{t('order.serverTitle')}</h2>
              </div>
            </div>
            <p className="mt-3 text-[14px] leading-snug">{t('order.serverBody')}</p>
          </section>
        )}
        {!isServer && (
        <section data-testid="not-sent" role="alert" className="rounded-[28px] bg-[#fbeedd] p-5 text-[#6b3f10]">
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#f3d9b6]">
              <CloudOff className="size-5" />
            </span>
            <div>
              <p className="text-[12px] font-extrabold uppercase tracking-wider opacity-80">{t('order.savedTitle')}</p>
              <h2 className="text-[22px] leading-tight">{t('order.notSentTitle')}</h2>
            </div>
          </div>
          <p className="mt-3 text-[14px] leading-snug">{t('order.notSentBody')}</p>
        </section>
        )}

        {!isServer && !storageOk && (
          <p data-testid="storage-warn" role="alert" className="flex gap-2.5 rounded-2xl bg-coral-soft px-3.5 py-3 text-[13px] font-semibold text-coral-deep">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {t('order.storageWarn')}
          </p>
        )}

        <section className="rounded-[26px] bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
          <p className="text-[12px] font-bold uppercase tracking-wider text-stone">{isServer ? t('order.numberLabel') : t('order.refLabel')}</p>
          <p data-testid="order-ref" className="mt-0.5 text-[22px] font-extrabold tracking-wide tabular-nums">
            {order.ref}
          </p>
          {!isServer && <p className="mt-1 text-[12px] leading-snug text-navy-soft">{t('order.refNote')}</p>}
          <dl className="mt-3 divide-y divide-navy/[0.07] text-[13.5px]">
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-stone">{t('order.date')}</dt>
              <dd className="text-right font-semibold">{fmtDate(order.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-stone">{t('order.source')}</dt>
              <dd className="text-right font-semibold">{order.source === 'quick' ? t('order.source.quick') : t('order.source.cart')}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
            {t('order.items')}
          </h2>
          <ul className="divide-y divide-navy/[0.07] rounded-[24px] bg-white px-3 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
            {order.items.map((it) => (
              <li key={`${it.productId}|${it.size}|${it.color}`} data-testid="order-item" className="flex items-center gap-3 py-3">
                <div className="size-14 shrink-0 overflow-hidden rounded-2xl">
                  <ProductImage categoryId={it.categoryId} color={it.colorHex} className="size-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[14px] font-semibold leading-tight">{it.name}</p>
                  <p className="text-[12px] text-navy-soft">
                    {it.color} · {t('common.size')} {it.size} · {it.qty} {t('cart.line')}
                  </p>
                </div>
                <span className="whitespace-nowrap text-[14px] font-extrabold tabular-nums">{formatUZS(it.unitPrice * it.qty)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section data-testid="order-totals" className="rounded-[26px] bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
          <div className="flex justify-between text-[14px] text-navy-soft">
            <span>{t('totals.goods')}</span>
            <span className="font-semibold tabular-nums">{formatUZS(order.subtotal)}</span>
          </div>
          <div className="mt-2 flex justify-between gap-3 text-[14px] text-navy-soft">
            <span>{t('totals.delivery')}</span>
            <span className="font-semibold tabular-nums">
              {order.deliveryPending ? t('totals.deliveryPending') : order.deliveryFee === 0 ? t('totals.deliveryFree') : formatUZS(order.deliveryFee ?? 0)}
            </span>
          </div>
          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-navy/[0.07] pt-3">
            <span className="text-[13px] font-extrabold uppercase tracking-wider text-stone">{order.deliveryPending ? t('totals.totalNoDelivery') : t('totals.total')}</span>
            <span data-testid="order-total" className="text-[22px] font-extrabold tabular-nums">
              {formatUZS(order.total)}
            </span>
          </div>
          {order.deliveryPending && <p className="mt-2 text-[12px] leading-snug text-navy-soft">{t('totals.deliveryNote')}</p>}
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
            {t('order.customer')}
          </h2>
          <dl className="divide-y divide-navy/[0.07] rounded-[24px] bg-white px-4 text-[14px] shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
            {(
              [
                [t('form.name'), order.contact.name],
                [t('form.phone'), order.contact.phone],
                [t('form.address'), order.contact.address],
                ...(order.contact.comment ? [[t('form.comment'), order.contact.comment]] : []),
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-3">
                <dt className="shrink-0 text-stone">{k}</dt>
                <dd className="min-w-0 break-words text-right font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link to="/katalog" className={primaryBtn}>
            {t('order.toCatalog')}
          </Link>
          <Link to="/profil" className="text-[14px] font-bold text-coral">
            {t('order.toProfile')}
          </Link>
        </div>

        <div className="pt-2">
          {isServer ? null : !asking ? (
            <button type="button" data-testid="delete-draft" onClick={() => setAsking(true)} className="text-[13.5px] font-bold text-stone underline underline-offset-4">
              {t('order.delete')}
            </button>
          ) : (
            <div role="alertdialog" aria-label={t('order.delete')} className="rounded-2xl bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
              <p className="text-[14px]">{t('order.deleteAsk')}</p>
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  data-testid="delete-confirm"
                  onClick={() => {
                    remove(order.id)
                    navigate('/profil', { replace: true })
                  }}
                  className="rounded-full bg-coral px-4 py-2.5 text-[13.5px] font-bold text-white"
                >
                  {t('order.deleteYes')}
                </button>
                <button type="button" onClick={() => setAsking(false)} className="rounded-full bg-navy/[0.07] px-4 py-2.5 text-[13.5px] font-bold">
                  {t('order.deleteNo')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
