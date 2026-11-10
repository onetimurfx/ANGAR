import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { PackageX, ShoppingBag, Zap } from 'lucide-react'
import { PageHeader, EmptyState, Section, primaryBtn } from '../components/ui'
import { Gallery } from '../components/Gallery'
import { ProductRail } from '../components/ProductCard'
import { OutfitCard } from '../components/OutfitCard'
import { QtyStepper } from '../components/QtyStepper'
import { DockPanel } from '../components/Dock'
import { activeProducts, categories, getBrand, getProduct, outfits, variantQty } from '../data/catalog'
import { useCatalogVersion } from '../lib/backendContext'
import { discountPercent, formatUZS } from '../lib/format'
import { pushRecent } from '../lib/recent'
import { useCart } from '../lib/cart'
import { useQuick } from '../lib/quick'
import { useToast } from '../lib/toast'
import { haptic } from '../lib/telegram'
import { t } from '../i18n'

export function CartLink() {
  const { count } = useCart()
  return (
    <Link to="/savatcha" aria-label={t('nav.cart')} data-testid="header-cart" className="glass relative grid size-10 place-items-center rounded-full">
      <ShoppingBag className="size-[19px]" />
      {count > 0 && (
        <span data-testid="header-cart-badge" className="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-coral px-1 text-[10px] font-extrabold leading-[18px] text-white">
          {count}
        </span>
      )}
    </Link>
  )
}

export function Product() {
  useCatalogVersion()
  const { id = '' } = useParams()
  const product = getProduct(id)
  const navigate = useNavigate()
  const cart = useCart()
  const quick = useQuick()
  const toast = useToast()

  const [colorIdx, setColorIdx] = useState(0)
  const [size, setSize] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [sizeError, setSizeError] = useState(false)
  const sizeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (product) pushRecent(product.id)
    setColorIdx(0)
    setSize(product && product.sizes.length === 1 ? product.sizes[0] : null)
    setQty(1)
    setSizeError(false)
  }, [product?.id]) // NOT the object: a catalog refresh must not reset the customer's choice

  if (!product || !product.active) {
    return (
      <div className="pb-36">
        <PageHeader title={t('product.notFound')} />
        <EmptyState
          icon={<PackageX className="size-7" />}
          title={t('product.notFound')}
          action={
            <Link to="/katalog" className={primaryBtn}>
              {t('cart.toCatalog')}
            </Link>
          }
        />
      </div>
    )
  }

  const brand = getBrand(product.brandId)
  const off = discountPercent(product.price, product.oldPrice)
  const color = product.colors[colorIdx] ?? product.colors[0]
  /** pieces of the chosen colour (+ size once chosen) */
  const avail = variantQty(product, size, color.name)
  const out = avail <= 0
  const low = !out && avail <= 5
  const similar = activeProducts().filter((x) => x.categoryId === product.categoryId && x.id !== product.id)
  const matching = outfits.filter((o) => o.productIds.includes(product.id))
  const inCart = cart.qtyOf(product.id)

  /** Shared validation for both buttons: variant chosen, stock available. */
  const validate = (): { size: string } | null => {
    if (out) {
      toast.show(t('product.unavailable'), { tone: 'warn' })
      return null
    }
    if (!size) {
      setSizeError(true)
      sizeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      toast.show(t('product.chooseSize'), { tone: 'warn' })
      return null
    }
    if (qty < 1 || qty > avail) {
      toast.show(t('product.maxStock', { n: avail }), { tone: 'warn' })
      return null
    }
    return { size }
  }

  const addToCart = () => {
    const v = validate()
    if (!v) return
    const res = cart.add({ productId: product.id, size: v.size, color: color.name, qty })
    if (!res.ok) {
      toast.show(res.max > 0 ? `${t('product.maxStock', { n: res.max })} (${inCart})` : t('product.cartFull'), { tone: 'warn' })
      return
    }
    haptic()
    setQty(1)
    toast.show(t('product.added'), { action: { label: t('product.viewCart'), to: '/savatcha' } })
  }

  const quickOrder = () => {
    const v = validate()
    if (!v) return
    // Quick Order has its own basket (store pickup), separate from the cart
    const res = quick.add({ productId: product.id, size: v.size, color: color.name, qty })
    if (!res.ok) {
      toast.show(res.reason === 'lines' ? t('pickup.maxLines', { n: res.max }) : res.max > 0 ? t('pickup.maxStock', { n: res.max }) : t('pickup.variantGone'), { tone: 'warn' })
      return
    }
    haptic()
    navigate('/tezkor-buyurtma')
  }

  const kindLabel = product.type === 'original' ? t('product.original') : t('product.otherBrand')
  const rows: [string, string][] = [
    [t('product.brand'), brand?.name ?? ''],
    [t('product.kind'), kindLabel],
    [t('product.category'), categories.find((c) => c.id === product.categoryId)?.name ?? ''],
    [t('product.colors'), product.colors.map((c) => c.name).join(', ')],
    [t('product.sizes'), product.sizes.join(', ')],
  ]

  return (
    <div className="pb-56">
      <PageHeader title={brand?.name ?? ''} right={<CartLink />} />
      <div className="px-4">
        <Gallery categoryId={product.categoryId} color={color.hex} name={product.name} images={product.images} sample={product.sample} />

        <div className="mt-6 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-stone">{kindLabel}</p>
            <h1 className="mt-1 text-[27px]">{product.name}</h1>
          </div>
          {product.isNew && <span className="mt-1 shrink-0 rounded-full bg-navy px-2.5 py-1 text-[10px] font-extrabold tracking-wider text-white">{t('common.new')}</span>}
        </div>

        <p className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-[26px] font-extrabold tabular-nums">{formatUZS(product.price)}</span>
          {product.oldPrice && <span className="text-[15px] text-stone line-through">{formatUZS(product.oldPrice)}</span>}
          {off > 0 && <span className="rounded-full bg-coral px-2.5 py-0.5 text-[12px] font-extrabold text-white">-{off}%</span>}
        </p>

        <p data-testid="stock-status" className={`mt-2 flex items-center gap-2 text-[13px] font-bold ${out ? 'text-coral' : low ? 'text-[#b5651d]' : 'text-[#4f6a3c]'}`}>
          <span className={`size-2 rounded-full ${out ? 'bg-coral' : low ? 'bg-[#e0922f]' : 'bg-[#6f9a52]'}`} />
          {out ? t('common.outOfStock') : low ? t('product.lowStock', { n: avail }) : `${t('common.inStock')}: ${avail} ${t('common.pcs')}`}
        </p>

        <div className="glass mt-5 rounded-[26px] p-4">
          <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
            {t('common.color')}: <span className="text-navy normal-case tracking-normal">{color.name}</span>
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {product.colors.map((c, i) => (
              <button
                key={c.name}
                type="button"
                aria-label={c.name}
                aria-pressed={colorIdx === i}
                onClick={() => {
                  setColorIdx(i)
                  // the chosen size may not exist in the new colour
                  if (size && variantQty(product, size, c.name) <= 0) setSize(null)
                }}
                className={`size-10 rounded-full border border-navy/15 transition active:scale-90 ${colorIdx === i ? 'ring-2 ring-coral ring-offset-2 ring-offset-white' : ''}`}
                style={{ background: c.hex }}
              />
            ))}
          </div>

          <div ref={sizeRef} className="mt-5">
            <h2 className="flex items-center justify-between text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('common.size')}
              {size && <span className="text-navy normal-case tracking-normal">{size}</span>}
            </h2>
            <motion.div
              key={sizeError ? 'err' : 'ok'}
              animate={sizeError ? { x: [0, -7, 7, -5, 5, 0] } : undefined}
              transition={{ duration: 0.35 }}
              role="radiogroup"
              aria-label={t('common.size')}
              className="mt-3 flex flex-wrap gap-2"
            >
              {product.sizes.map((s) => {
                const none = variantQty(product, s, color.name) <= 0
                return (
                <button
                  key={s}
                  disabled={none}
                  title={none ? t('common.outOfStock') : undefined}
                  type="button"
                  role="radio"
                  aria-checked={size === s}
                  onClick={() => {
                    setSize(s)
                    setSizeError(false)
                  }}
                  className={`min-w-12 rounded-2xl px-4 py-2.5 text-sm font-bold transition active:scale-95 ${none ? 'opacity-35 line-through' : ''} ${size === s ? 'bg-navy text-white' : 'bg-white shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]'} ${sizeError ? 'ring-1 ring-coral' : ''}`}
                >
                  {s}
                </button>
                )
              })}
            </motion.div>
            {sizeError && (
              <p role="alert" className="mt-2 text-[13px] font-semibold text-coral">
                {t('product.chooseSize')}
              </p>
            )}
          </div>

          <div className="mt-5 flex items-center justify-between">
            <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('product.qty')}
            </h2>
            <QtyStepper value={qty} max={Math.max(avail, 1)} onChange={setQty} />
          </div>
          {!out && qty >= avail && <p className="mt-2 text-right text-[12px] font-semibold text-navy-soft">{t('product.maxStock', { n: avail })}</p>}
          <div className="mt-4 flex items-baseline justify-between border-t border-navy/[0.07] pt-3">
            <span className="text-[13px] font-extrabold uppercase tracking-wider text-stone">{t('product.total')}</span>
            <span data-testid="total-price" className="text-[20px] font-extrabold tabular-nums">
              {formatUZS(product.price * qty)}
            </span>
          </div>
        </div>

        <h2 className="mt-7 text-[19px]">{t('product.description')}</h2>
        <p className="mt-2 text-[14.5px] leading-relaxed text-navy-soft">{product.description}</p>

        <h2 className="mt-7 text-[19px]">{t('product.details')}</h2>
        <dl className="mt-2 divide-y divide-navy/[0.07] rounded-[22px] bg-white px-4 text-[14px] shadow-[0_8px_26px_-18px_rgba(23,43,58,0.5)]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-3">
              <dt className="text-stone">{k}</dt>
              <dd className="text-right font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {matching.length > 0 && (
        <Section title={t('product.outfits')}>
          <div className="rail">
            {matching.map((o) => (
              <OutfitCard key={o.id} outfit={o} />
            ))}
          </div>
        </Section>
      )}
      {similar.length > 0 && (
        <Section title={t('product.similar')}>
          <ProductRail items={similar} />
        </Section>
      )}

      {/* Separate action panel ABOVE the five-item tab bar (the tab bar stays visible on this screen) */}
      <DockPanel>
        <div data-testid="action-bar" className="glass-nav grid grid-cols-2 gap-2.5 rounded-[28px] p-2.5">
          <button
            type="button"
            data-testid="add-to-cart"
            onClick={addToCart}
            disabled={out}
            className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-navy px-2 py-3.5 text-[12.5px] font-bold text-white transition active:scale-[0.97] disabled:opacity-40"
          >
            <ShoppingBag className="size-4 max-[339px]:hidden" />
            {t('product.addToCart')}
          </button>
          <button
            type="button"
            data-testid="quick-order"
            onClick={quickOrder}
            disabled={out}
            className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-coral px-2 py-3.5 text-[12.5px] font-bold text-white shadow-[0_10px_22px_-8px_rgba(217,75,89,0.7)] transition active:scale-[0.97] disabled:opacity-40 disabled:shadow-none"
          >
            <Zap className="size-4 max-[339px]:hidden" fill="currentColor" />
            {t('nav.quick')}
          </button>
        </div>
      </DockPanel>
    </div>
  )
}
