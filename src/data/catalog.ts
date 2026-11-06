/**
 * The catalog the UI reads. Two sources, never mixed:
 *   'sample' - the built-in placeholder products (data/sample.ts). Used only when no backend is configured.
 *   'server' - what Supabase returned (get_catalog). Replaces the sample data completely.
 * The exports are live bindings: `setCatalog` swaps them and the app re-renders (BackendProvider bumps a version).
 */
import * as sample from './sample'
import type { Banner, Brand, Category, Outfit, Product, ShopSettings, VariantStock } from './types'

export type CatalogSource = 'sample' | 'server'

export interface CatalogData {
  categories: Category[]
  brands: Brand[]
  products: Product[]
  outfits: Outfit[]
  banners: Banner[]
  settings: ShopSettings
}

export const NO_SETTINGS: ShopSettings = { deliveryConfigured: false, deliveryFee: null, deliveryFreeFrom: null, supportContact: null }

export let source: CatalogSource = 'sample'
export let categories: Category[] = sample.categories
export let brands: Brand[] = sample.brands
export let products: Product[] = sample.products
export let outfits: Outfit[] = sample.outfits
export let banners: Banner[] = sample.banners
export let settings: ShopSettings = NO_SETTINGS

export function setCatalog(data: CatalogData, from: CatalogSource) {
  source = from
  categories = data.categories
  brands = data.brands
  products = data.products
  outfits = data.outfits
  banners = data.banners
  settings = data.settings
}

export const getProduct = (id: string) => products.find((x) => x.id === id)
export const getBrand = (id: string) => brands.find((b) => b.id === id)
export const getOutfit = (id: string) => outfits.find((o) => o.id === id)
export const outfitProducts = (o: Outfit) => o.productIds.map(getProduct).filter((x): x is Product => Boolean(x))
export const outfitTotal = (o: Outfit) => outfitProducts(o).reduce((s, x) => s + x.price, 0)
export const activeProducts = () => products.filter((x) => x.active)

/** Pieces available for a size + colour. Without per-variant data the product total is the limit. */
export function variantQty(p: Product, size: string | null, color: string): number {
  if (!p.variants) return p.stock
  if (size === null) return p.variants.filter((v: VariantStock) => v.color === color).reduce((s, v) => s + v.qty, 0)
  return p.variants.find((v) => v.size === size && v.color === color)?.qty ?? 0
}
