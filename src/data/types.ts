export type CategoryId =
  | 'all' | 'shoes' | 'trousers' | 'shirts' | 'tshirts' | 'dresses'
  | 'jackets' | 'hoodies' | 'sweaters' | 'outerwear' | 'accessories' | 'bags'

export interface Category {
  /** 'all' is a UI-only pseudo category; every other id comes from the catalog (sample data or the server) */
  id: string
  name: string
}

export interface Brand {
  id: string
  name: string
  type: 'original' | 'other'
}

export interface ColorOption {
  name: string
  hex: string
}

/** Stock of one purchasable variant (size + colour). Present for server products; sample products use `stock`. */
export interface VariantStock {
  size: string
  /** colour NAME (matches ColorOption.name) */
  color: string
  qty: number
}

export interface Product {
  id: string
  name: string
  brandId: string
  description: string
  categoryId: string
  /** UZS */
  price: number
  oldPrice?: number
  sizes: string[]
  colors: ColorOption[]
  /** total pieces over all variants */
  stock: number
  /** per-variant stock (server catalog). When absent, `stock` is the only limit. */
  variants?: VariantStock[]
  /** object paths in the public Storage bucket "product-images" (server catalog). Empty = show the illustration. */
  images?: string[]
  type: 'original' | 'other'
  isNew: boolean
  active: boolean
  popularity: number
  /** ISO date, used for "newest" ordering */
  createdAt: string
  /** true = placeholder product (marked NAMUNA, cannot be ordered unless the shop allows sample orders) */
  sample: boolean
}

export interface ShopSettings {
  /** false until the shop sets a delivery fee: the UI then says "not set yet" and never guesses a price */
  deliveryConfigured: boolean
  deliveryFee: number | null
  deliveryFreeFrom: number | null
  supportContact: string | null
}

export interface Outfit {
  id: string
  title: string
  note: string
  productIds: string[]
}

export interface Banner {
  id: string
  title: string
  subtitle: string
  to: string
  tone: 'coral' | 'navy' | 'beige'
}
