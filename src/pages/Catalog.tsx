import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowUpDown, Check, PackageSearch, Search, SlidersHorizontal, X } from 'lucide-react'
import { PageHeader, EmptyState } from '../components/ui'
import { ProductCard } from '../components/ProductCard'
import { BottomSheet } from '../components/BottomSheet'
import { FilterSheet } from '../components/FilterSheet'
import { activeProducts, brands, categories } from '../data/catalog'
import { EMPTY, SORTS, activeGroups, applyFilters, facets, parseFilters, serializeFilters, type FilterState } from '../lib/filters'
import { formatUZS } from '../lib/format'
import type { Key } from '../i18n/uz'
import { useCatalogVersion } from '../lib/backendContext'
import { t } from '../i18n'

export function Catalog() {
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => parseFilters(params), [params])
  const input = useRef<HTMLInputElement>(null)
  const [sheet, setSheet] = useState<'filter' | 'sort' | null>(null)
  const [draft, setDraft] = useState<FilterState>(state)
  const version = useCatalogVersion()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => activeProducts(), [version])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { bounds } = useMemo(() => facets(), [version])

  useEffect(() => {
    if (params.get('focus')) input.current?.focus()
  }, [params])

  const commit = (next: FilterState) => setParams(serializeFilters(next), { replace: true })
  const items = useMemo(() => applyFilters(all, state), [all, state])
  const draftCount = useMemo(() => applyFilters(all, draft).length, [all, draft])
  const groups = activeGroups(state)

  // removable summary chips for every active filter
  const chips: { key: string; label: string; clear: () => void }[] = []
  if (state.cat !== 'all') chips.push({ key: 'cat', label: categories.find((c) => c.id === state.cat)?.name ?? '', clear: () => commit({ ...state, cat: 'all' }) })
  if (state.tag) chips.push({ key: 'tag', label: t(`tag.${state.tag}` as Key), clear: () => commit({ ...state, tag: '' }) })
  state.brands.forEach((b) => chips.push({ key: `b-${b}`, label: brands.find((x) => x.id === b)?.name ?? b, clear: () => commit({ ...state, brands: state.brands.filter((x) => x !== b) }) }))
  state.sizes.forEach((s) => chips.push({ key: `s-${s}`, label: `${t('filter.size')} ${s}`, clear: () => commit({ ...state, sizes: state.sizes.filter((x) => x !== s) }) }))
  state.colors.forEach((c) => chips.push({ key: `c-${c}`, label: c, clear: () => commit({ ...state, colors: state.colors.filter((x) => x !== c) }) }))
  if (state.min !== null || state.max !== null)
    chips.push({ key: 'price', label: `${formatUZS(state.min ?? bounds.min)} - ${formatUZS(state.max ?? bounds.max)}`, clear: () => commit({ ...state, min: null, max: null }) })
  if (state.avail) chips.push({ key: 'avail', label: t('filter.availOnly'), clear: () => commit({ ...state, avail: false }) })

  const clearAll = () => commit({ ...EMPTY, sort: state.sort, q: state.q })

  return (
    <div className="pb-36">
      <PageHeader title={t('catalog.title')} />
      <div className="px-4">
        <label className="glass flex items-center gap-2 rounded-2xl px-3.5 py-2.5">
          <Search className="size-[18px] text-stone" />
          <input
            ref={input}
            value={state.q}
            onChange={(e) => commit({ ...state, q: e.target.value })}
            placeholder={t('catalog.search')}
            aria-label={t('home.search')}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-stone"
          />
          {state.q && (
            <button type="button" aria-label={t('filter.clear')} onClick={() => commit({ ...state, q: '' })} className="grid size-6 place-items-center rounded-full bg-navy/10">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => commit({ ...state, cat: c.id })}
            aria-pressed={state.cat === c.id}
            className={`shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold ${state.cat === c.id ? 'bg-navy text-white' : 'glass'}`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => {
            setDraft(state)
            setSheet('filter')
          }}
          className="glass relative flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-bold"
        >
          <SlidersHorizontal className="size-4" />
          {t('catalog.filter')}
          {groups > 0 && (
            <span data-testid="filter-badge" className="grid min-w-5 place-items-center rounded-full bg-coral px-1 text-[11px] font-extrabold leading-5 text-white">
              {groups}
            </span>
          )}
        </button>
        <button type="button" onClick={() => setSheet('sort')} className="glass flex min-w-0 items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-bold">
          <ArrowUpDown className="size-4 shrink-0" />
          <span className="truncate">{t(`sort.${state.sort}` as Key)}</span>
        </button>
      </div>

      {chips.length > 0 && (
        <div className="no-scrollbar mt-3 flex items-center gap-2 overflow-x-auto px-4" aria-label={t('filter.title')}>
          {chips.map((c) => (
            <button key={c.key} type="button" onClick={c.clear} aria-label={`${c.label} ×`} className="flex shrink-0 items-center gap-1.5 rounded-full bg-coral-soft py-1.5 pl-3 pr-2 text-[12px] font-bold text-coral">
              {c.label}
              <X className="size-3.5" />
            </button>
          ))}
          <button type="button" onClick={clearAll} className="shrink-0 px-1 text-[12px] font-bold text-navy-soft underline">
            {t('catalog.clearAll')}
          </button>
        </div>
      )}

      <p data-testid="result-count" className="mt-4 px-4 text-[12px] font-semibold text-stone">
        {items.length} {t('catalog.found')}
      </p>
      {items.length === 0 ? (
        <EmptyState
          icon={<PackageSearch className="size-7" />}
          title={t('catalog.empty')}
          hint={t('catalog.emptyHint')}
          action={
            groups > 0 || state.q ? (
              <button type="button" onClick={clearAll} className="rounded-full bg-coral px-6 py-3 text-sm font-bold text-white">
                {t('catalog.clearAll')}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-6 px-4">
          {items.map((p) => (
            <ProductCard key={p.id} product={p} grid />
          ))}
        </div>
      )}

      <FilterSheet
        open={sheet === 'filter'}
        onClose={() => setSheet(null)}
        draft={draft}
        setDraft={setDraft}
        resultCount={draftCount}
        onApply={() => {
          commit(draft)
          setSheet(null)
        }}
      />

      <BottomSheet open={sheet === 'sort'} onClose={() => setSheet(null)} title={t('sort.title')}>
        <div role="radiogroup" aria-label={t('sort.title')} className="space-y-2 pb-4 pt-1">
          {SORTS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={state.sort === s}
              onClick={() => {
                commit({ ...state, sort: s })
                setSheet(null)
              }}
              className={`flex w-full items-center justify-between rounded-2xl px-4 py-3.5 text-left text-[15px] font-semibold ${state.sort === s ? 'bg-navy text-white' : 'bg-white shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]'}`}
            >
              {t(`sort.${s}` as Key)}
              {state.sort === s && <Check className="size-5 text-coral" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  )
}
