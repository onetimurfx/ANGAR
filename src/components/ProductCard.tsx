import { Link } from 'react-router-dom'
import type { Product } from '../data/types'
import { getBrand } from '../data/catalog'
import { imageUrl } from '../lib/backend'
import { discountPercent, formatUZS } from '../lib/format'
import { t } from '../i18n'
import { ProductImage } from './ProductImage'

export function ProductCard({ product, grid = false }: { product: Product; grid?: boolean }) {
  const off = discountPercent(product.price, product.oldPrice)
  const out = product.stock <= 0
  const low = !out && product.stock <= 5
  const shown = product.colors.slice(0, 4)
  return (
    <Link
      to={`/mahsulot/${product.id}`}
      data-testid="product-card"
      data-product-id={product.id}
      className={`group block ${grid ? 'w-full' : 'w-[160px]'} transition-transform active:scale-[0.98]`}
    >
      <div className="relative aspect-[6/7] overflow-hidden rounded-[24px] bg-white shadow-[0_12px_28px_-16px_rgba(23,43,58,0.55)]">
        <ProductImage categoryId={product.categoryId} color={product.colors[0].hex} src={product.images?.[0] ? imageUrl(product.images[0]) : null} className={`size-full transition-transform duration-500 group-active:scale-105 ${out ? 'opacity-45 grayscale-[0.4]' : ''}`} />
        <div className="absolute left-2.5 top-2.5 flex flex-col items-start gap-1">
          {product.isNew && <span className="rounded-full bg-navy px-2.5 py-1 text-[10px] font-extrabold tracking-wider text-white">{t('common.new')}</span>}
          {off > 0 && <span className="rounded-full bg-coral px-2.5 py-1 text-[10px] font-extrabold text-white">-{off}%</span>}
        </div>
        {product.sample && <span className="glass-chip absolute bottom-2.5 left-2.5 rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wider text-navy-soft">{t('common.sample')}</span>}
        {out && (
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 bg-navy/85 py-1.5 text-center text-[11px] font-extrabold uppercase tracking-wider text-white">
            {t('common.outOfStock')}
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[10.5px] font-bold uppercase tracking-[0.12em] text-stone">{getBrand(product.brandId)?.name}</p>
        <span className="flex shrink-0 -space-x-1" aria-hidden>
          {shown.map((c) => (
            <span key={c.name} className="size-3 rounded-full border border-white ring-1 ring-navy/15" style={{ background: c.hex }} />
          ))}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[14.5px] font-semibold leading-tight">{product.name}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
        <span className="whitespace-nowrap text-[14.5px] font-extrabold text-navy">{formatUZS(product.price)}</span>
        {product.oldPrice && <span className="whitespace-nowrap text-[11px] text-stone line-through">{formatUZS(product.oldPrice)}</span>}
      </p>
      {low && <p className="mt-0.5 text-[11.5px] font-bold text-coral">{t('product.lowStock', { n: product.stock })}</p>}
    </Link>
  )
}

export function ProductRail({ items }: { items: Product[] }) {
  return (
    <div className="rail">
      {items.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  )
}
