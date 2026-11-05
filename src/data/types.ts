export type CategoryId =
  | 'all' | 'shoes' | 'trousers' | 'shirts' | 'tshirts' | 'dresses'
  | 'jackets' | 'hoodies' | 'sweaters' | 'outerwear' | 'accessories' | 'bags'

export interface Category {
  id: CategoryId
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

export interface Product {
  id: string
  name: string
  brandId: string
  description: string
  categoryId: Exclude<CategoryId, 'all'>
  /** UZS */
  price: number
  oldPrice?: number
  sizes: string[]
  colors: ColorOption[]
  stock: number
  type: 'original' | 'other'
  isNew: boolean
  active: boolean
  popularity: number
  /** ISO date, used for "newest" ordering */
  createdAt: string
  /** every product in this build is a temporary sample */
  sample: true
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
