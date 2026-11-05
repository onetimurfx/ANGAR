import { Link, useParams } from 'react-router-dom'
import { PackageX } from 'lucide-react'
import { PageHeader, EmptyState, primaryBtn } from '../components/ui'
import { ProductCard } from '../components/ProductCard'
import { getOutfit, outfitProducts, outfitTotal } from '../data/sample'
import { formatUZS } from '../lib/format'
import { t } from '../i18n'

export function Outfit() {
  const { id = '' } = useParams()
  const outfit = getOutfit(id)
  if (!outfit) {
    return (
      <div className="pb-36">
        <PageHeader title={t('notfound.title')} />
        <EmptyState
          icon={<PackageX className="size-7" />}
          title={t('notfound.title')}
          action={
            <Link to="/" className={primaryBtn}>
              {t('notfound.home')}
            </Link>
          }
        />
      </div>
    )
  }
  return (
    <div className="pb-36">
      <PageHeader title={outfit.title} />
      <div className="px-4">
        <p className="text-[14px] text-navy-soft">{outfit.note}</p>
        <div className="glass mt-3 flex items-baseline justify-between rounded-2xl px-4 py-3">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-stone">{t('outfit.total')}</span>
          <span className="text-xl font-extrabold">{formatUZS(outfitTotal(outfit))}</span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-5">
          {outfitProducts(outfit).map((p) => (
            <ProductCard key={p.id} product={p} grid />
          ))}
        </div>
      </div>
    </div>
  )
}
