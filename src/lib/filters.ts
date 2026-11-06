import type { Product } from '../data/types'
import { activeProducts, brands, categories } from '../data/catalog'

export type SortKey = 'popular' | 'newest' | 'price_asc' | 'price_desc'
export type Tag = 'new' | 'original' | 'other' | 'discount'

export interface FilterState {
  cat: string
  brands: string[]
  sizes: string[]
  colors: string[]
  min: number | null
  max: number | null
  avail: boolean
  tag: Tag | ''
  sort: SortKey
  q: string
}

export const SORTS: SortKey[] = ['popular', 'newest', 'price_asc', 'price_desc']
export const TAGS: Tag[] = ['new', 'discount', 'original', 'other']

export const EMPTY: FilterState = {
  cat: 'all', brands: [], sizes: [], colors: [], min: null, max: null, avail: false, tag: '', sort: 'popular', q: '',
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', 'Yagona']

/** Facets derived from the active catalog so filter options always match real products. */
export function facets(products: Product[] = activeProducts()) {
  const sizes = [...new Set(products.flatMap((p) => p.sizes))].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b))
  const colorMap = new Map<string, string>()
  products.forEach((p) => p.colors.forEach((c) => colorMap.set(c.name, c.hex)))
  const colors = [...colorMap].map(([name, hex]) => ({ name, hex }))
  const prices = products.map((p) => p.price)
  const STEP = 10000
  const bounds = { min: Math.floor(Math.min(...prices) / STEP) * STEP, max: Math.ceil(Math.max(...prices) / STEP) * STEP, step: STEP }
  return { sizes, colors, bounds }
}

const list = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])
const num = (v: string | null) => {
  if (v === null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

/** URL -> state. Unknown values are dropped, so a hand-edited link can never break the page. */
export function parseFilters(params: URLSearchParams): FilterState {
  const f = facets()
  const catRaw = params.get('cat') ?? 'all'
  const tagRaw = params.get('f') ?? ''
  const sortRaw = (params.get('sort') ?? 'popular') as SortKey
  let min = num(params.get('min'))
  let max = num(params.get('max'))
  if (min !== null && max !== null && min > max) [min, max] = [max, min]
  return {
    cat: categories.some((c) => c.id === catRaw) ? catRaw : 'all',
    brands: list(params.get('brand')).filter((id) => brands.some((b) => b.id === id)),
    sizes: list(params.get('size')).filter((s) => f.sizes.includes(s)),
    colors: list(params.get('color')).filter((c) => f.colors.some((x) => x.name === c)),
    min: min !== null && min > f.bounds.min ? min : null,
    max: max !== null && max < f.bounds.max ? max : null,
    avail: params.get('avail') === '1',
    tag: (TAGS as string[]).includes(tagRaw) ? (tagRaw as Tag) : '',
    sort: SORTS.includes(sortRaw) ? sortRaw : 'popular',
    q: params.get('q') ?? '',
  }
}

/** state -> URL (defaults omitted). */
export function serializeFilters(f: FilterState): URLSearchParams {
  const p = new URLSearchParams()
  if (f.cat !== 'all') p.set('cat', f.cat)
  if (f.brands.length) p.set('brand', f.brands.join(','))
  if (f.sizes.length) p.set('size', f.sizes.join(','))
  if (f.colors.length) p.set('color', f.colors.join(','))
  if (f.min !== null) p.set('min', String(f.min))
  if (f.max !== null) p.set('max', String(f.max))
  if (f.avail) p.set('avail', '1')
  if (f.tag) p.set('f', f.tag)
  if (f.sort !== 'popular') p.set('sort', f.sort)
  if (f.q.trim()) p.set('q', f.q)
  return p
}

/** Number of active filter groups (category counts; sorting and text search do not). */
export function activeGroups(f: FilterState): number {
  return [f.cat !== 'all', f.brands.length > 0, f.sizes.length > 0, f.colors.length > 0, f.min !== null || f.max !== null, f.avail, f.tag !== ''].filter(Boolean).length
}

export function applyFilters(all: Product[], f: FilterState): Product[] {
  const needle = f.q.trim().toLowerCase()
  let out = all.filter((p) => {
    if (f.cat !== 'all' && p.categoryId !== f.cat) return false
    if (f.brands.length && !f.brands.includes(p.brandId)) return false
    if (f.sizes.length && !p.sizes.some((s) => f.sizes.includes(s))) return false
    if (f.colors.length && !p.colors.some((c) => f.colors.includes(c.name))) return false
    if (f.min !== null && p.price < f.min) return false
    if (f.max !== null && p.price > f.max) return false
    if (f.avail && p.stock <= 0) return false
    if (f.tag === 'new' && !p.isNew) return false
    if (f.tag === 'discount' && !(p.oldPrice && p.oldPrice > p.price)) return false
    if (f.tag === 'original' && p.type !== 'original') return false
    if (f.tag === 'other' && p.type !== 'other') return false
    if (needle) {
      const brand = brands.find((b) => b.id === p.brandId)?.name.toLowerCase() ?? ''
      if (!p.name.toLowerCase().includes(needle) && !brand.includes(needle)) return false
    }
    return true
  })
  const by: Record<SortKey, (a: Product, b: Product) => number> = {
    popular: (a, b) => b.popularity - a.popularity,
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
  }
  out = [...out].sort((a, b) => by[f.sort](a, b) || a.id.localeCompare(b.id))
  return out
}
