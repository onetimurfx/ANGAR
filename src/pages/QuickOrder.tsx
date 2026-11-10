import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CloudOff, Plus, Store, Trash2, Zap } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { QtyStepper } from '../components/QtyStepper'
import { ContactFields } from '../components/ContactFields'
import { NoBackendNotice } from '../components/NoticeBanner'
import { activeProducts, getBrand, getProduct } from '../data/catalog'
import { formatUZS } from '../lib/format'
import { clearAttemptId, getAttemptId, useContactDraft } from '../lib/drafts'
import { focusFirstInvalid } from '../lib/useOrderForm'
import { errorMessage, useBackend, useCatalogVersion } from '../lib/backendContext'
import { usePickup, type PickupPlaceOutcome } from '../lib/pickupStore'
import { useQuick } from '../lib/quick'
import { capFor, colorsInStock, lineKey, MAX_LINES, sampleNames, sizesInStock } from '../lib/quickBasket'
import { useToast } from '../lib/toast'
import { getTelegramUser } from '../lib/telegram'
import { validateField, type ContactErrors, type ContactField } from '../lib/validation'
import { t } from '../i18n'

const H = 'mb-3 text-[13px] font-extrabold uppercase tracking-wider text-stone'
const SCOPE = 'pickup'
/** the pickup form has no address: only these three are validated */
const FIELDS: ContactField[] = ['name', 'phone', 'comment']

interface Problem {
  title: string
  lines: string[]
  /** the order may exist on the server: offer the way to check */
  unconfirmed?: boolean
}

export function describePickupFailure(out: Exclude<PickupPlaceOutcome, { ok: true }>): Problem | null {
  switch (out.reason) {
    case 'contact':
      return null
    case 'empty':
      return { title: t('pickup.emptyErr'), lines: [] }
    case 'stock':
      return out.issues.length
        ? { title: t('pickup.stockProblem'), lines: [...out.issues.map((i) => t('checkout.stockLine', { name: i.size && i.color ? `${i.name} (${i.color}, ${i.size})` : i.name, r: i.requested, a: i.available })), t('pickup.stockFixed')] }
        : { title: t('err.conflict'), lines: [t('pickup.stockFixed')] }
    case 'sample':
      return { title: t('err.conflict'), lines: [t('pickup.sampleBlocked', { name: out.name })] }
    case 'limit':
      return { title: t('pickup.limitTitle'), lines: [t('pickup.limitBody', { max: out.max })] }
    case 'lines':
      return { title: t('pickup.maxLines', { n: out.max }), lines: [] }
    case 'unconfirmed':
      return { title: t('pickup.unconfirmedTitle'), lines: [errorMessage(out.kind), t('pickup.unconfirmedBody')], unconfirmed: true }
    case 'error':
      return { title: errorMessage(out.kind), lines: [t('pickup.notCreated')] }
  }
}

function useOnline() {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  useEffect(() => {
    const up = () => setOn(true)
    const down = () => setOn(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return on
}

export function QuickOrder() {
  useCatalogVersion()
  const { mode } = useBackend()
  const quick = useQuick()
  const pickup = usePickup()
  const toast = useToast()
  const navigate = useNavigate()
  const online = useOnline()
  const tg = getTelegramUser()
  const tgName = tg ? [tg.first_name, tg.last_name].filter(Boolean).join(' ') : ''
  const draft = useContactDraft(SCOPE, { name: tgName })
  const formRef = useRef<HTMLFormElement>(null)
  const lock = useRef(false)
  const lastSig = useRef('')
  const [errors, setErrors] = useState<ContactErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  // ---- variant picker (what is being added to the basket)
  const [pid, setPid] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [size, setSize] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [pickErr, setPickErr] = useState<'size' | null>(null)

  const products = activeProducts().filter((p) => colorsInStock(p).length > 0)
  const product = pid ? getProduct(pid) : undefined
  const colors = product ? colorsInStock(product) : []
  const col = product && color ? colors.find((c) => c.name === color) : undefined
  const sizes = product && col ? sizesInStock(product, col.name) : []
  const cap = product && col && size ? capFor(product, size, col.name) : 0

  // the picked product can vanish when fresh stock arrives
  useEffect(() => {
    if (pid && (!product || colorsInStock(product).length === 0)) {
      setPid(null)
      setColor(null)
      setSize(null)
    }
  }, [pid, product])

  const pick = (id: string) => {
    const p = getProduct(id)
    if (!p) return
    const cs = colorsInStock(p)
    const c = cs[0]?.name ?? null
    const ss = c ? sizesInStock(p, c) : []
    setPid(id)
    setColor(c)
    setSize(ss.length === 1 ? ss[0] : null)
    setQty(1)
    setPickErr(null)
  }
  const chooseColor = (name: string) => {
    if (!product) return
    setColor(name)
    setSize((s) => (s && sizesInStock(product, name).includes(s) ? s : null))
    setQty(1)
  }

  const addToBasket = () => {
    if (!product || !col) return
    if (!size) {
      setPickErr('size')
      return
    }
    const res = quick.add({ productId: product.id, size, color: col.name, qty })
    if (!res.ok) {
      toast.show(res.reason === 'lines' ? t('pickup.maxLines', { n: res.max }) : res.reason === 'stock' ? t('pickup.maxStock', { n: res.max }) : t('pickup.variantGone'), { tone: 'warn' })
      return
    }
    toast.show(t('pickup.added'))
    setProblem(null)
    setPid(null)
    setColor(null)
    setSize(null)
    setQty(1)
  }

  // ---- contact
  const onChange = (patch: Partial<{ name: string; phone: string; comment: string; address: string }>) => {
    draft.update(patch)
    setErrors((cur) => {
      let next = cur
      for (const f of Object.keys(patch) as ContactField[]) {
        if (cur[f] && !validateField(f, patch[f] ?? '')) {
          if (next === cur) next = { ...cur }
          delete next[f]
        }
      }
      return next
    })
  }
  const onBlurField = (f: ContactField) => {
    if (!FIELDS.includes(f)) return
    const v = draft.value[f]
    if (!v.trim() && f !== 'comment') return
    const e = validateField(f, v)
    setErrors((cur) => {
      const next = { ...cur }
      if (e) next[f] = e
      else delete next[f]
      return next
    })
  }

  const samples = sampleNames(quick.lines, getProduct)
  const full = quick.lines.length >= MAX_LINES
  const demo = mode !== 'server'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (lock.current || demo) return // one submit at a time (a ref: two taps in the same frame cannot both pass)
    setProblem(null)
    const errs: ContactErrors = {}
    for (const f of FIELDS) {
      const m = validateField(f, draft.value[f] ?? '')
      if (m) errs[f] = m
    }
    setErrors(errs)
    if (Object.keys(errs).length > 0 || quick.lines.length === 0 || samples.length > 0) {
      if (quick.lines.length === 0) setProblem({ title: t('pickup.emptyErr'), lines: [] })
      else if (samples.length > 0) setProblem({ title: t('err.conflict'), lines: [t('pickup.sampleBlocked', { name: samples[0] })] })
      focusFirstInvalid(formRef.current)
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // known offline: nothing is sent, and we say so
      setProblem({ title: t('err.offline'), lines: [t('pickup.offline')] })
      return
    }
    lock.current = true
    setSubmitting(true)
    // one idempotency key per attempt; a CHANGED order gets a new key, so an earlier unconfirmed attempt can never swallow it
    const sig = JSON.stringify([quick.lines, draft.value.name, draft.value.phone, draft.value.comment])
    if (lastSig.current && lastSig.current !== sig) clearAttemptId(SCOPE)
    lastSig.current = sig
    const out = await pickup.place({ attemptId: getAttemptId(SCOPE), contact: { name: draft.value.name, phone: draft.value.phone, comment: draft.value.comment }, lines: quick.lines })
    if (out.ok) {
      // success only now, with the order the SERVER returned. The screen is REPLACED, so Back cannot re-open the form.
      draft.clear()
      clearAttemptId(SCOPE)
      quick.clear()
      if (out.duplicate) toast.show(t('pickup.duplicate'))
      navigate(`/tezkor-buyurtma/${out.order.id}`, { replace: true })
      return // the lock stays: the form is gone
    }
    if (out.reason === 'contact') {
      setErrors(out.errors)
      focusFirstInvalid(formRef.current)
    } else {
      if (out.reason === 'stock' || out.reason === 'sample') clearAttemptId(SCOPE)
      if (out.reason === 'stock') quick.revalidate()
      setProblem(describePickupFailure(out))
    }
    lock.current = false
    setSubmitting(false)
  }

  return (
    <div className="pb-40">
      <PageHeader title={t('quick.title')} />
      <form ref={formRef} onSubmit={submit} noValidate className="px-4" data-testid="quick-form">
        <p className="mb-3 text-[14px] text-navy-soft">{t('quick.subtitle')}</p>
        <div data-testid="pickup-note" role="note" className="flex gap-3 rounded-2xl bg-white px-3.5 py-3 text-[13px] font-medium leading-snug text-navy-soft shadow-[0_6px_18px_-14px_rgba(23,43,58,0.5)]">
          <Store className="mt-0.5 size-[18px] shrink-0 text-coral" />
          <p>{t('pickup.note')}</p>
        </div>
        <div className="mt-3 space-y-3">
          <NoBackendNotice />
          {!online && (
            <div data-testid="offline-banner" role="alert" className="flex gap-3 rounded-2xl bg-coral-soft px-3.5 py-3 text-[13px] font-semibold leading-snug text-coral-deep">
              <CloudOff className="mt-0.5 size-[18px] shrink-0" />
              <p>{t('pickup.offlineBanner')}</p>
            </div>
          )}
        </div>

        {/* 1. add products */}
        <h2 className={`${H} mt-6`} style={{ fontFamily: 'var(--font-sans)' }}>
          1. {t('pickup.stepTitle1')}
        </h2>
        {products.length === 0 ? (
          <p data-testid="quick-no-stock" className="rounded-2xl bg-white px-4 py-4 text-[14px] text-navy-soft">
            {t('pickup.noStock')}
          </p>
        ) : (
          <div data-testid="quick-rail" className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-3 pt-1">
            {products.map((p) => {
              const on = pid === p.id
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
                  {p.sample && <p className="px-1 pb-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[#8a5217]">{t('common.sample')}</p>}
                </button>
              )
            })}
          </div>
        )}
        <p className="mt-1 text-[12px] text-stone">
          {t('quick.inStockOnly')} · <Link to="/katalog" className="font-bold text-coral">{t('quick.toCatalog')}</Link>
        </p>

        {product && col && (
          <div data-testid="quick-item" className="glass mt-4 rounded-[28px] p-4">
            <div className="flex gap-3.5">
              <Link to={`/mahsulot/${product.id}`} className="size-24 shrink-0 overflow-hidden rounded-[20px]">
                <ProductImage categoryId={product.categoryId} color={col.hex} className="size-full" />
              </Link>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-stone">{getBrand(product.brandId)?.name}</p>
                <p className="truncate text-[18px] font-semibold leading-tight" style={{ fontFamily: 'var(--font-display)' }}>
                  {product.name}
                </p>
                <p className="mt-1 text-[15px] font-extrabold tabular-nums">{formatUZS(product.price)}</p>
                {size && cap > 0 && (
                  <p data-testid="quick-stock" className="text-[12px] font-semibold text-[#4f6a3c]">
                    {t('pickup.stockLeft', { n: cap })}
                  </p>
                )}
              </div>
            </div>

            <h3 className="mt-5 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('common.color')}: <span className="normal-case tracking-normal text-navy">{col.name}</span>
            </h3>
            <div className="mt-2.5 flex flex-wrap gap-3">
              {colors.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  data-testid="quick-color"
                  aria-label={c.name}
                  aria-pressed={col.name === c.name}
                  onClick={() => chooseColor(c.name)}
                  className={`size-10 rounded-full border border-navy/15 transition active:scale-90 ${col.name === c.name ? 'ring-2 ring-coral ring-offset-2 ring-offset-white' : ''}`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>

            <h3 className="mt-5 flex justify-between text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              <span>
                {t('common.size')} <span className="text-coral">*</span>
              </span>
              {size && <span className="normal-case tracking-normal text-navy">{size}</span>}
            </h3>
            <div role="radiogroup" aria-label={t('common.size')} data-invalid={pickErr ? 'true' : undefined} className="mt-2.5 flex flex-wrap gap-2">
              {/* only sizes that are in stock for this colour */}
              {sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  data-testid="quick-size"
                  aria-checked={size === s}
                  onClick={() => {
                    setSize(s)
                    setPickErr(null)
                    setQty(1)
                  }}
                  className={`min-w-12 rounded-2xl px-4 py-2.5 text-sm font-bold transition active:scale-95 ${size === s ? 'bg-navy text-white' : 'bg-white shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]'} ${pickErr ? 'ring-1 ring-coral' : ''}`}
                >
                  {s}
                </button>
              ))}
            </div>
            {pickErr && (
              <p role="alert" data-testid="err-size" className="mt-2 text-[13px] font-semibold text-coral">
                {t('pickup.sizeRequired')}
              </p>
            )}

            <div className="mt-5 flex items-center justify-between">
              <h3 className="text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
                {t('quick.qty')}
              </h3>
              <QtyStepper value={qty} max={Math.max(1, cap)} onChange={setQty} />
            </div>

            <button
              type="button"
              data-testid="quick-add"
              disabled={full}
              onClick={addToBasket}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-navy px-5 py-3.5 text-[14.5px] font-bold text-white transition active:scale-[0.98] disabled:opacity-50"
            >
              <Plus className="size-[18px]" />
              {t('pickup.add')}
            </button>
            {full && <p className="mt-2 text-[12.5px] font-semibold text-coral">{t('pickup.maxLines', { n: MAX_LINES })}</p>}
          </div>
        )}

        {/* 2. the basket */}
        <h2 className={`${H} mt-8 flex justify-between`} style={{ fontFamily: 'var(--font-sans)' }}>
          <span>2. {t('pickup.stepTitle2')}</span>
          {quick.lines.length > 0 && <span className="normal-case tracking-normal">{t('pickup.linesCount', { n: quick.lines.length, max: MAX_LINES })}</span>}
        </h2>
        {quick.lines.length === 0 ? (
          <p data-testid="quick-basket-empty" className="rounded-2xl bg-white px-4 py-4 text-[14px] text-navy-soft">
            {t('pickup.basketEmpty')}
          </p>
        ) : (
          <ul data-testid="quick-basket" className="space-y-2.5">
            {quick.lines.map((l) => {
              const p = getProduct(l.productId)!
              const hex = p.colors.find((c) => c.name === l.color)?.hex ?? p.colors[0].hex
              const key = lineKey(l)
              return (
                <li key={key} data-testid="quick-line" data-key={key} className="flex gap-3 rounded-[22px] bg-white p-3 shadow-[0_8px_22px_-16px_rgba(23,43,58,0.5)]">
                  <div className="size-[68px] shrink-0 overflow-hidden rounded-2xl">
                    <ProductImage categoryId={p.categoryId} color={hex} className="size-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-semibold leading-tight">{p.name}</p>
                    <p className="text-[12.5px] text-navy-soft">
                      {l.color} · {l.size}
                      {p.sample && <span className="ml-1.5 text-[10px] font-extrabold uppercase tracking-wider text-[#8a5217]">{t('common.sample')}</span>}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <QtyStepper compact value={l.qty} max={Math.max(1, capFor(p, l.size, l.color))} onChange={(v) => quick.setQty(key, v)} />
                      <span className="text-[14px] font-extrabold tabular-nums">{formatUZS(p.price * l.qty)}</span>
                    </div>
                  </div>
                  <button type="button" data-testid="quick-remove" aria-label={t('pickup.remove')} onClick={() => quick.remove(key)} className="grid size-9 shrink-0 place-items-center self-start rounded-full text-stone transition active:scale-90">
                    <Trash2 className="size-[18px]" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {/* 3. contact: name + phone required, comment optional, NO address */}
        <h2 className={`${H} mt-8`} style={{ fontFamily: 'var(--font-sans)' }}>
          3. {t('pickup.stepTitle3')}
        </h2>
        <ContactFields value={draft.value} errors={errors} onChange={onChange} onBlurField={onBlurField} nameFromTelegram={Boolean(tgName) && draft.value.name === tgName} hideAddress />
        <p className="mt-2 text-[12px] text-navy-soft">{t('pickup.contactHint')}</p>

        <div data-testid="pickup-total" className="mt-6 flex items-baseline justify-between gap-3 rounded-[26px] bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
          <span className="min-w-0 text-[12px] font-extrabold uppercase leading-tight tracking-wider text-stone">{t('pickup.total')}</span>
          <span data-testid="cart-total" className="whitespace-nowrap text-[21px] font-extrabold tabular-nums">
            {formatUZS(quick.subtotal)}
          </span>
        </div>

        {demo && (
          <div data-testid="pickup-demo-blocked" role="alert" className="mt-4 rounded-2xl bg-[#fbeedd] px-4 py-3 text-[13.5px] font-semibold text-[#7a4a14]">
            {t('pickup.demoBlocked')}
          </div>
        )}
        {problem && (
          <div role="alert" data-testid="submit-problem" data-kind={problem.unconfirmed ? 'unconfirmed' : 'failed'} className="mt-4 rounded-2xl bg-coral-soft px-4 py-3 text-[13.5px] font-semibold text-coral-deep">
            <p>{problem.title}</p>
            {problem.lines.length > 0 && (
              <ul className="mt-1 list-disc pl-5 font-medium">
                {problem.lines.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            {problem.unconfirmed && (
              <Link to="/profil" data-testid="check-orders" className="mt-2 inline-block rounded-full bg-coral px-4 py-2 text-[13px] font-bold text-white">
                {t('pickup.checkOrders')}
              </Link>
            )}
          </div>
        )}
        {Object.keys(errors).length > 0 && (
          <p role="alert" className="mt-4 text-[13.5px] font-semibold text-coral">
            {t('form.invalid')}
          </p>
        )}

        <button
          type="submit"
          data-testid="submit-order"
          disabled={submitting || demo}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-coral px-5 py-4 text-[15px] font-bold text-white shadow-[0_14px_28px_-10px_rgba(217,75,89,0.75)] transition active:scale-[0.98] disabled:opacity-60"
        >
          <Zap className="size-[18px]" fill="currentColor" />
          {submitting ? t('pickup.sending') : t('pickup.submit')}
        </button>
      </form>
    </div>
  )
}
