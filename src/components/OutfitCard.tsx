import { Link } from 'react-router-dom'
import type { Outfit } from '../data/types'
import { outfitProducts, outfitTotal } from '../data/catalog'
import { formatUZS } from '../lib/format'
import { t } from '../i18n'
import { ProductImage } from './ProductImage'

export function OutfitCard({ outfit }: { outfit: Outfit }) {
  const items = outfitProducts(outfit)
  return (
    <Link to={`/komplekt/${outfit.id}`} className="block w-[250px] rounded-[26px] bg-white p-2.5 shadow-[0_14px_30px_-18px_rgba(23,43,58,0.55)] active:scale-[0.98] transition-transform">
      <div className="grid grid-cols-3 gap-1.5">
        {items.map((p) => (
          <div key={p.id} className="aspect-[3/4] overflow-hidden rounded-2xl">
            <ProductImage categoryId={p.categoryId} color={p.colors[0].hex} view={1} className="size-full" />
          </div>
        ))}
      </div>
      <div className="px-1.5 pb-1 pt-3">
        <h3 className="text-[17px]">{outfit.title}</h3>
        <p className="mt-0.5 text-[12px] text-navy-soft">{outfit.note}</p>
        <p className="mt-2.5">
          <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-stone">{t('outfit.total')}</span>
          <span className="block whitespace-nowrap text-[16px] font-extrabold tabular-nums">{formatUZS(outfitTotal(outfit))}</span>
        </p>
      </div>
    </Link>
  )
}
