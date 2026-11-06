/**
 * Turns the JSON of public.get_catalog() into the UI model. The JSON is treated as UNTRUSTED input:
 * every field is checked, malformed products are dropped (never rendered half-broken), and the numbers are clamped.
 */
import type { Banner, Brand, Category, Outfit, Product, ShopSettings, VariantStock } from './types'
import type { CatalogData } from './catalog'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export class CatalogFormatError extends Error {}

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']
const sizeRank = (s: string) => {
  const i = SIZE_ORDER.indexOf(s.toUpperCase())
  return i >= 0 ? i : Number.isFinite(Number(s)) ? 100 + Number(s) : 1000
}

function mapProduct(raw: unknown): Product | null {
  if (!isObj(raw)) return null
  const id = str(raw.id, 60)
  const name = str(raw.name, 200)
  const brandId = str(raw.brandId, 40)
  const categoryId = str(raw.categoryId, 40)
  const price = int(raw.price)
  const type = raw.type === 'original' || raw.type === 'other' ? raw.type : null
  if (!id || !name || !brandId || !categoryId || price === null || !type) return null
  const old = int(raw.oldPrice)

  const variants: VariantStock[] = []
  const colorHex = new Map<string, string>()
  for (const v of arr(raw.variants)) {
    if (!isObj(v)) continue
    const size = str(v.size, 20)
    const color = str(v.color, 40)
    const hex = typeof v.colorHex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.colorHex) ? v.colorHex : null
    const qty = int(v.qty)
    if (!size || !color || !hex || qty === null) continue
    if (variants.some((x) => x.size === size && x.color === color)) continue
    variants.push({ size, color, qty: Math.min(qty, 100000) })
    if (!colorHex.has(color)) colorHex.set(color, hex)
  }
  // a product nobody can pick a size/colour for cannot be shown or bought
  if (variants.length === 0) return null

  const sizes = [...new Set(variants.map((v) => v.size))].sort((a, b) => sizeRank(a) - sizeRank(b))
  const created = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString()
  return {
    id,
    name,
    brandId,
    categoryId,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '',
    price,
    ...(old !== null && old > price ? { oldPrice: old } : {}),
    sizes,
    colors: [...colorHex].map(([name, hex]) => ({ name, hex })),
    stock: variants.reduce((s, v) => s + v.qty, 0),
    variants,
    images: arr(raw.images).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300 && !x.includes('..')).slice(0, 12),
    type,
    isNew: raw.isNew === true,
    active: true, // the server only returns active products
    popularity: int(raw.popularity) ?? 0,
    createdAt: created,
    sample: raw.sample === true,
  }
}

export function mapSettings(raw: unknown): ShopSettings {
  const s = isObj(raw) ? raw : {}
  const fee = int(s.deliveryFee)
  const free = int(s.deliveryFreeFrom)
  return {
    // never "configured" unless the server says so AND gave a usable number
    deliveryConfigured: s.deliveryConfigured === true && fee !== null,
    deliveryFee: s.deliveryConfigured === true ? fee : null,
    deliveryFreeFrom: free !== null && free > 0 ? free : null,
    supportContact: str(s.supportContact, 200),
  }
}

export function mapCatalog(raw: unknown): CatalogData {
  if (!isObj(raw)) throw new CatalogFormatError('catalog is not an object')
  const categories: Category[] = [{ id: 'all', name: 'Barcha mahsulotlar' }]
  for (const c of arr(raw.categories)) if (isObj(c) && str(c.id, 40) && str(c.name, 80) && c.id !== 'all') categories.push({ id: c.id as string, name: c.name as string })
  const brands: Brand[] = []
  for (const b of arr(raw.brands)) if (isObj(b) && str(b.id, 40) && str(b.name, 80) && (b.type === 'original' || b.type === 'other')) brands.push({ id: b.id as string, name: b.name as string, type: b.type })

  const brandIds = new Set(brands.map((b) => b.id))
  const catIds = new Set(categories.map((c) => c.id))
  const products = arr(raw.products).map(mapProduct).filter((p): p is Product => p !== null && brandIds.has(p.brandId) && catIds.has(p.categoryId))
  const known = new Set(products.map((p) => p.id))

  const outfits: Outfit[] = []
  for (const o of arr(raw.outfits)) {
    if (!isObj(o) || !str(o.id, 60) || !str(o.title, 120)) continue
    const productIds = arr(o.productIds).filter((x): x is string => typeof x === 'string' && known.has(x))
    if (productIds.length >= 2) outfits.push({ id: o.id as string, title: o.title as string, note: typeof o.note === 'string' ? o.note : '', productIds })
  }
  const banners: Banner[] = []
  for (const b of arr(raw.banners)) {
    if (!isObj(b) || !str(b.id, 60) || !str(b.title, 120)) continue
    const to = typeof b.to === 'string' && b.to.startsWith('/') && !b.to.startsWith('//') ? b.to : '/katalog'
    const tone = b.tone === 'navy' || b.tone === 'beige' ? b.tone : 'coral'
    banners.push({ id: b.id as string, title: b.title as string, subtitle: typeof b.subtitle === 'string' ? b.subtitle : '', to, tone })
  }
  return { categories, brands, products, outfits, banners, settings: mapSettings(raw.settings) }
}
