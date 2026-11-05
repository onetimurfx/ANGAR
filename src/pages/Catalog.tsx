import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PackageSearch, Search } from 'lucide-react'
import { PageHeader, EmptyState } from '../components/ui'
import { ProductCard } from '../components/ProductCard'
import { activeProducts, brands, categories } from '../data/sample'
import { t } from '../i18n'

/** Phase 2 catalog: category chips, quick tags and text search. Full filters/sorting arrive in Phase 3. */
const TAGS = [
  { id: 'new', label: 'Yangi' },
  { id: 'original', label: 'AYNIMO Original' },
  { id: 'other', label: 'Boshqa brendlar' },
  { id: 'popular', label: 'Mashhur' },
  { id: 'discount', label: 'Chegirma' },
]

export function Catalog() {
  const [params, setParams] = useSearchParams()
  const cat = params.get('cat') ?? 'all'
  const tag = params.get('f') ?? ''
  const q = params.get('q') ?? ''
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (params.get('focus')) input.current?.focus()
  }, [params])

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    next.delete('focus')
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  let items = activeProducts()
  if (cat !== 'all') items = items.filter((p) => p.categoryId === cat)
  if (tag === 'new') items = items.filter((p) => p.isNew)
  if (tag === 'original' || tag === 'other') items = items.filter((p) => p.type === tag)
  if (tag === 'discount') items = items.filter((p) => p.oldPrice)
  if (tag === 'popular') items = [...items].sort((a, b) => b.popularity - a.popularity)
  const needle = q.trim().toLowerCase()
  if (needle) {
    items = items.filter(
      (p) => p.name.toLowerCase().includes(needle) || (brands.find((b) => b.id === p.brandId)?.name.toLowerCase().includes(needle) ?? false),
    )
  }

  return (
    <div className="pb-36">
      <PageHeader title={t('catalog.title')} />
      <div className="px-4">
        <label className="glass flex items-center gap-2 rounded-2xl px-3.5 py-2.5">
          <Search className="size-[18px] text-stone" />
          <input
            ref={input}
            value={q}
            onChange={(e) => set('q', e.target.value)}
            placeholder={t('catalog.search')}
            aria-label={t('home.search')}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-stone"
          />
        </label>
      </div>

      <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => set('cat', c.id === 'all' ? '' : c.id)}
            aria-pressed={cat === c.id}
            className={`shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold ${cat === c.id ? 'bg-navy text-white' : 'glass'}`}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-4">
        {TAGS.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => set('f', tag === x.id ? '' : x.id)}
            aria-pressed={tag === x.id}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-bold ${tag === x.id ? 'bg-coral text-white' : 'bg-coral-soft text-coral'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      <p className="mt-4 px-4 text-[12px] font-semibold text-stone">
        {items.length} {t('catalog.found')}
      </p>
      {items.length === 0 ? (
        <EmptyState icon={<PackageSearch className="size-7" />} title={t('catalog.empty')} hint={t('catalog.emptyHint')} />
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-5 px-4">
          {items.map((p) => (
            <ProductCard key={p.id} product={p} grid />
          ))}
        </div>
      )}
    </div>
  )
}
