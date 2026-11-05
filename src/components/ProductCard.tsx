import { Link } from 'react-router-dom'
import type { Product } from '../data/types'
import { getBrand } from '../data/sample'
import { discountPercent, formatUZS } from '../lib/format'
import { t } from '../i18n'
import { ProductImage } from './ProductImage'

export function ProductCard({ product, grid = false }: { product: Product; grid?: boolean }) {
  const off = discountPercent(product.price, product.oldPrice)
  const out = product.stock <= 0
  return (
    <Link
      to={`/mahsulot/${product.id}`}
      className={`group block ${grid ? 'w-full' : 'w-[156px]'} active:scale-[0.98] transition-transform`}
    >
      <div className="relative aspect-[6/7] overflow-hidden rounded-[22px] bg-white shadow-[0_10px_26px_-16px_rgba(23,43,58,0.5)]">
        <ProductImage
          categoryId={product.categoryId}
          color={product.colors[0].hex}
          className={`size-full ${out ? 'opacity-50' : ''}`}
        />
        <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
          {product.isNew && <span className="rounded-full bg-navy px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">{t('common.new')}</span>}
          {off > 0 && <span className="rounded-full bg-coral px-2 py-0.5 text-[10px] font-bold text-white">-{off}%</span>}
        </div>
        <span className="glass-chip absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wider text-navy-soft">
          {t('common.sample')}
        </span>
        {out && (
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 bg-navy/80 py-1 text-center text-[11px] font-bold text-white">
            {t('common.outOfStock')}
          </span>
        )}
      </div>
      <p className="mt-2 truncate text-[11px] font-semibold uppercase tracking-wider text-stone">{getBrand(product.brandId)?.name}</p>
      <p className="truncate text-[14px] font-semibold leading-tight">{product.name}</p>
      <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className="whitespace-nowrap text-[14px] font-extrabold text-navy">{formatUZS(product.price)}</span>
        {product.oldPrice && <span className="whitespace-nowrap text-[11px] text-stone line-through">{formatUZS(product.oldPrice)}</span>}
      </p>
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
