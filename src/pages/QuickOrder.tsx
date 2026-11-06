import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Zap } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { QtyStepper } from '../components/QtyStepper'
import { ContactFields } from '../components/ContactFields'
import { Totals } from '../components/Totals'
import { NoBackendNotice } from '../components/NoticeBanner'
import { activeProducts, getBrand, getProduct } from '../data/catalog'
import { formatUZS } from '../lib/format'
import { useCart } from '../lib/cart'
import { focusFirstInvalid, useOrderForm } from '../lib/useOrderForm'
import { describeFailure, type Problem } from '../lib/orderProblems'
import { useBackend, useCatalogVersion } from '../lib/backendContext'
import { t } from '../i18n'

const H = 'mb-3 text-[13px] font-extrabold uppercase tracking-wider text-stone'

export function QuickOrder() {
  const { quick, setQuick } = useCart()
  useCatalogVersion()
  const { mode } = useBackend()
  const form = useOrderForm('quick')
  const formRef = useRef<HTMLFormElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const [selErr, setSelErr] = useState<{ product?: boolean; size?: boolean }>({})
  const [problem, setProblem] = useState<Problem | null>(null)

  const products = activeProducts().filter((p) => p.stock > 0)
  const product = quick ? getProduct(quick.productId) : undefined
  const color = product?.colors.find((c) => c.name === quick?.color) ?? product?.colors[0]

  // bring the preselected tile into view without scrolling the page
  useEffect(() => {
    const r = rail.current
    const el = r?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (r && el) r.scrollLeft = Math.max(0, el.offsetLeft - (r.clientWidth - el.clientWidth) / 2)
  }, [quick?.productId])

  const pick = (id: string) => {
    const p = getProduct(id)
    if (!p) return
    setQuick({ productId: p.id, size: p.sizes.length === 1 ? p.sizes[0] : null, color: p.colors[0].name, qty: 1 })
    setSelErr({})
    setProblem(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (form.submitting) return
    setProblem(null)
    const contactOk = form.checkContact()
    const sel = { product: !product || !quick, size: Boolean(product && quick && !quick.size) }
    setSelErr(sel)
    if (!contactOk || sel.product || sel.size || !product || !quick || !quick.size) {
      focusFirstInvalid(formRef.current)
      return
    }
    const out = await form.submit('quick', [{ productId: product.id, size: quick.size, color: quick.color, qty: quick.qty }], () => setQuick(null))
    if (out && !out.ok) {
      if (out.reason === 'contact') focusFirstInvalid(formRef.current)
      else setProblem(describeFailure(out))
    }
  }

  const subtotal = product && quick ? product.price * quick.qty : 0

  return (
    <div className="pb-40">
      <PageHeader title={t('quick.title')} />
      <form ref={formRef} onSubmit={submit} noValidate className="px-4" data-testid="quick-form">
        <p className="mb-3 text-[14px] text-navy-soft">{t('quick.subtitle')}</p>
        <NoBackendNotice />

        <h2 className={`${H} mt-6`} style={{ fontFamily: 'var(--font-sans)' }}>
          1. {t('quick.product')} <span className="text-coral">*</span>
        </h2>
        <div ref={rail} data-testid="quick-rail" data-invalid={selErr.product ? 'true' : undefined} className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-3 pt-1">
          {products.map((p) => {
            const on = quick?.productId === p.id
            return (
              <button
                key={p.id}
                type="button"
                data-testid="quick-pick"
                data-product-id={p.id}
                aria-pressed={on}
                onClick={() => pick(p.id)}
                className={`w-[112px] shrink-0 rounded-[20px] p-1.5 text-left transition active:scale-[0.97] ${on ? 'bg-white ring-2 ring-coral shadow-[0_12px_26px_-14px_rgba(217,75,89,0.7)]' : 'bg-white/70'}`}
              >
                <div className="aspect-[6/7] overflow-hidden rounded-2xl">
                  <ProductImage categoryId={p.categoryId} color={p.colors[0].hex} className="size-full" />
                </div>
                <p className="mt-1.5 truncate px-1 text-[12.5px] font-semibold leading-tight">{p.name}</p>
                <p className="px-1 pb-0.5 text-[12px] font-extrabold tabular-nums">{formatUZS(p.price)}</p>
              </button>
            )
          })}
        </div>
        {selErr.product && (
          <p role="alert" data-testid="err-product" className="mt-1 text-[13px] font-semibold text-coral">
            {t('err.productRequired')}
          </p>
        )}
        <p className="mt-1 text-[12px] text-stone">{t('quick.inStockOnly')} · <Link to="/katalog" className="font-bold text-coral">{t('quick.toCatalog')}</Link></p>

        {product && quick && color && (
          <div data-testid="quick-item" className="glass mt-4 rounded-[28px] p-4">
            <div className="flex gap-3.5">
              <Link to={`/mahsulot/${product.id}`} className="size-24 shrink-0 overflow-hidden rounded-[20px]">
                <ProductImage categoryId={product.categoryId} color={color.hex} className="size-full" />
              </Link>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-stone">{getBrand(product.brandId)?.name}</p>
                <p className="truncate text-[18px] font-semibold leading-tight" style={{ fontFamily: 'var(--font-display)' }}>
                  {product.name}
                </p>
                <p className="mt-1 text-[15px] font-extrabold tabular-nums">{formatUZS(product.price)}</p>
                <p className="text-[12px] font-semibold text-[#4f6a3c]">
                  {t('common.inStock')}: {product.stock} {t('common.pcs')}
                </p>
              </div>
            </div>

            <h3 className="mt-5 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('common.color')}: <span className="normal-case tracking-normal text-navy">{color.name}</span>
            </h3>
            <div className="mt-2.5 flex flex-wrap gap-3">
              {product.colors.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  aria-label={c.name}
                  aria-pressed={color.name === c.name}
                  onClick={() => setQuick({ ...quick, color: c.name })}
                  className={`size-10 rounded-full border border-navy/15 transition active:scale-90 ${color.name === c.name ? 'ring-2 ring-coral ring-offset-2 ring-offset-white' : ''}`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>

            <h3 className="mt-5 flex justify-between text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              <span>
                {t('common.size')} <span className="text-coral">*</span>
              </span>
              {quick.size && <span className="normal-case tracking-normal text-navy">{quick.size}</span>}
            </h3>
            <div role="radiogroup" aria-label={t('common.size')} data-invalid={selErr.size ? 'true' : undefined} className="mt-2.5 flex flex-wrap gap-2">
              {product.sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={quick.size === s}
                  onClick={() => {
                    setQuick({ ...quick, size: s })
                    setSelErr((e) => ({ ...e, size: false }))
                  }}
                  className={`min-w-12 rounded-2xl px-4 py-2.5 text-sm font-bold transition active:scale-95 ${quick.size === s ? 'bg-navy text-white' : 'bg-white shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]'} ${selErr.size ? 'ring-1 ring-coral' : ''}`}
                >
                  {s}
                </button>
              ))}
            </div>
            {selErr.size && (
              <p role="alert" data-testid="err-size" className="mt-2 text-[13px] font-semibold text-coral">
                {t('err.sizeRequired')}
              </p>
            )}

            <div className="mt-5 flex items-center justify-between">
              <h3 className="text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
                {t('quick.qty')}
              </h3>
              <QtyStepper value={quick.qty} max={product.stock} onChange={(v) => setQuick({ ...quick, qty: v })} />
            </div>
          </div>
        )}

        <h2 className={`${H} mt-8`} style={{ fontFamily: 'var(--font-sans)' }}>
          2. {t('quick.contact')}
        </h2>
        <ContactFields value={form.draft.value} errors={form.errors} onChange={form.onChange} onBlurField={form.onBlurField} nameFromTelegram={form.nameFromTelegram} />

        <div className="mt-6">
          <Totals subtotal={subtotal} />
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
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-coral px-5 py-4 text-[15px] font-bold text-white shadow-[0_14px_28px_-10px_rgba(217,75,89,0.75)] transition active:scale-[0.98] disabled:opacity-60"
        >
          <Zap className="size-[18px]" fill="currentColor" />
          {form.submitting ? t('submit.saving') : mode === 'server' ? t('checkout.submitServer') : t('quick.submit')}
        </button>
      </form>
    </div>
  )
}
