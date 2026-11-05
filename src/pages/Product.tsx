import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PackageX } from 'lucide-react'
import { PageHeader, EmptyState, Section, primaryBtn } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { ProductRail } from '../components/ProductCard'
import { OutfitCard } from '../components/OutfitCard'
import { activeProducts, getBrand, getProduct, outfits } from '../data/sample'
import { discountPercent, formatUZS } from '../lib/format'
import { pushRecent } from '../lib/recent'
import { t } from '../i18n'

/** Phase 2 detail view (read-only). Variant validation, cart and Quick Order buttons arrive in Phases 3-4. */
export function Product() {
  const { id = '' } = useParams()
  const product = getProduct(id)
  const [view, setView] = useState(0)
  const [color, setColor] = useState(0)
  const [size, setSize] = useState<string | null>(null)

  useEffect(() => {
    if (product) pushRecent(product.id)
    setView(0)
    setColor(0)
    setSize(null)
  }, [product])

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

  const off = discountPercent(product.price, product.oldPrice)
  const similar = activeProducts().filter((x) => x.categoryId === product.categoryId && x.id !== product.id)
  const matching = outfits.filter((o) => o.productIds.includes(product.id))
  const activeColor = product.colors[color]

  return (
    <div className="pb-36">
      <PageHeader title={getBrand(product.brandId)?.name ?? ''} />
      <div className="px-4">
        <div className="relative aspect-[6/7] overflow-hidden rounded-[30px] bg-white shadow-[0_18px_40px_-22px_rgba(23,43,58,0.6)]">
          <ProductImage categoryId={product.categoryId} color={activeColor.hex} view={view} className="size-full" label={product.name} />
          <span className="glass-chip absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wider text-navy-soft">{t('common.sample')}</span>
        </div>
        <div className="mt-3 flex gap-2">
          {[0, 1, 2].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-label={`${v + 1}`}
              aria-pressed={view === v}
              className={`size-16 overflow-hidden rounded-2xl ${view === v ? 'ring-2 ring-coral ring-offset-2 ring-offset-ivory' : 'opacity-80'}`}
            >
              <ProductImage categoryId={product.categoryId} color={activeColor.hex} view={v} className="size-full" />
            </button>
          ))}
        </div>

        <h1 className="mt-5 text-[26px]">{product.name}</h1>
        <p className="mt-2 flex items-baseline gap-2.5">
          <span className="text-[24px] font-extrabold">{formatUZS(product.price)}</span>
          {product.oldPrice && <span className="text-sm text-stone line-through">{formatUZS(product.oldPrice)}</span>}
          {off > 0 && <span className="rounded-full bg-coral px-2 py-0.5 text-[11px] font-bold text-white">-{off}%</span>}
        </p>
        <p className={`mt-1 text-[13px] font-semibold ${product.stock > 0 ? 'text-[#4f6a3c]' : 'text-coral'}`}>
          {product.stock > 0 ? `${t('common.inStock')}: ${product.stock} ${t('common.pcs')}` : t('common.outOfStock')}
        </p>
        <p className="mt-4 text-[14.5px] leading-relaxed text-navy-soft">{product.description}</p>

        <h2 className="mb-2 mt-6 text-[15px] font-bold" style={{ fontFamily: 'var(--font-sans)' }}>
          {t('common.color')}: <span className="font-medium text-navy-soft">{activeColor.name}</span>
        </h2>
        <div className="flex gap-3">
          {product.colors.map((c, i) => (
            <button
              key={c.name}
              type="button"
              aria-label={c.name}
              aria-pressed={color === i}
              onClick={() => setColor(i)}
              className={`size-9 rounded-full border border-navy/15 ${color === i ? 'ring-2 ring-coral ring-offset-2 ring-offset-ivory' : ''}`}
              style={{ background: c.hex }}
            />
          ))}
        </div>

        <h2 className="mb-2 mt-5 text-[15px] font-bold" style={{ fontFamily: 'var(--font-sans)' }}>
          {t('common.size')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {product.sizes.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={size === s}
              onClick={() => setSize(s)}
              className={`min-w-12 rounded-2xl px-3.5 py-2 text-sm font-bold ${size === s ? 'bg-navy text-white' : 'glass'}`}
            >
              {s}
            </button>
          ))}
        </div>

        <p className="mt-6 rounded-2xl bg-beige-soft px-3.5 py-2.5 text-[12.5px] font-medium text-navy-soft">{t('product.soon')}</p>
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
    </div>
  )
}
