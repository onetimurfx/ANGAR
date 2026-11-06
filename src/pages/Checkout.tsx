import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ShoppingBag } from 'lucide-react'
import { PageHeader, EmptyState, primaryBtn } from '../components/ui'
import { ContactFields } from '../components/ContactFields'
import { ProductImage } from '../components/ProductImage'
import { Totals } from '../components/Totals'
import { NoBackendNotice } from '../components/NoticeBanner'
import { getProduct } from '../data/catalog'
import { formatUZS } from '../lib/format'
import { lineKey, useCart } from '../lib/cart'
import { focusFirstInvalid, useOrderForm } from '../lib/useOrderForm'
import { describeFailure, type Problem } from '../lib/orderProblems'
import { useBackend, useCatalogVersion } from '../lib/backendContext'
import { t } from '../i18n'

export function Checkout() {
  const { lines, count, subtotal, clear } = useCart()
  useCatalogVersion()
  const { mode } = useBackend()
  const form = useOrderForm('cart')
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<Problem | null>(null)

  if (lines.length === 0) {
    return (
      <div className="pb-36">
        <PageHeader title={t('checkout.title')} />
        <EmptyState
          icon={<ShoppingBag className="size-7" />}
          title={t('checkout.emptyTitle')}
          hint={t('cart.emptyHint')}
          action={
            <Link to="/katalog" className={primaryBtn}>
              {t('cart.toCatalog')}
            </Link>
          }
        />
      </div>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (form.submitting) return
    setProblem(null)
    if (!form.checkContact()) {
      focusFirstInvalid(formRef.current)
      return
    }
    const out = await form.submit(
      'cart',
      lines.map((l) => ({ productId: l.productId, size: l.size, color: l.color, qty: l.qty })),
      clear,
    )
    if (out && !out.ok) {
      if (out.reason === 'contact') focusFirstInvalid(formRef.current)
      else setProblem(describeFailure(out))
    }
  }

  return (
    <div className="pb-40">
      <PageHeader title={t('checkout.title')} />
      <form ref={formRef} onSubmit={submit} noValidate className="px-4" data-testid="checkout-form">
        <NoBackendNotice />

        <h2 className="mb-3 mt-6 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
          {t('checkout.yourOrder')}
        </h2>
        <ul className="divide-y divide-navy/[0.07] rounded-[24px] bg-white px-3 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
          {lines.map((l) => {
            const p = getProduct(l.productId)
            if (!p) return null
            const hex = p.colors.find((c) => c.name === l.color)?.hex ?? p.colors[0].hex
            return (
              <li key={lineKey(l)} data-testid="checkout-line" className="flex items-center gap-3 py-3">
                <div className="size-14 shrink-0 overflow-hidden rounded-2xl">
                  <ProductImage categoryId={p.categoryId} color={hex} className="size-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[14px] font-semibold leading-tight">{p.name}</p>
                  <p className="text-[12px] text-navy-soft">
                    {l.color} · {t('common.size')} {l.size} · {l.qty} {t('cart.line')}
                  </p>
                </div>
                <span className="whitespace-nowrap text-[14px] font-extrabold tabular-nums">{formatUZS(p.price * l.qty)}</span>
              </li>
            )
          })}
        </ul>
        <Link to="/savatcha" className="mt-2 inline-block text-[13px] font-bold text-coral">
          {t('checkout.backToCart')}
        </Link>

        <h2 className="mb-3 mt-6 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
          {t('checkout.contact')}
        </h2>
        <ContactFields value={form.draft.value} errors={form.errors} onChange={form.onChange} onBlurField={form.onBlurField} nameFromTelegram={form.nameFromTelegram} />

        <div className="mt-6">
          <Totals subtotal={subtotal} count={count} />
        </div>

        {problem && (
          <div role="alert" data-testid="submit-problem" className="mt-4 rounded-2xl bg-coral-soft px-4 py-3 text-[13.5px] font-semibold text-coral-deep">
            <p>{problem.title}</p>
            <ul className="mt-1 list-disc pl-5 font-medium">
              {problem.lines.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {Object.keys(form.errors).length > 0 && <p role="alert" className="mt-4 text-[13.5px] font-semibold text-coral">{t('form.invalid')}</p>}

        <button
          type="submit"
          data-testid="submit-order"
          disabled={form.submitting}
          className="mt-4 w-full rounded-full bg-coral px-5 py-4 text-[15px] font-bold text-white shadow-[0_14px_28px_-10px_rgba(217,75,89,0.75)] transition active:scale-[0.98] disabled:opacity-60"
        >
          {form.submitting ? t('submit.saving') : mode === 'server' ? t('checkout.submitServer') : t('checkout.submit')}
        </button>
      </form>
    </div>
  )
}
