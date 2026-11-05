import type { Banner, Brand, Category, ColorOption, Outfit, Product } from './types'

/**
 * TEMPORARY SAMPLE DATA. Names, prices and stock are placeholders for design review only.
 * Phase 5 replaces this file with data from Supabase.
 */

export const categories: Category[] = [
  { id: 'all', name: 'Barcha mahsulotlar' },
  { id: 'shoes', name: 'Poyabzal' },
  { id: 'trousers', name: 'Shim' },
  { id: 'shirts', name: "Ko'ylak" },
  { id: 'tshirts', name: 'Futbolka' },
  { id: 'dresses', name: 'Libos' },
  { id: 'jackets', name: 'Kurtka' },
  { id: 'hoodies', name: 'Xudi' },
  { id: 'sweaters', name: 'Sviter' },
  { id: 'outerwear', name: 'Ustki kiyim' },
  { id: 'accessories', name: 'Aksessuarlar' },
  { id: 'bags', name: 'Sumkalar' },
]

export const brands: Brand[] = [
  { id: 'aynimo', name: 'AYNIMO Original', type: 'original' },
  { id: 'sample-a', name: 'Namuna brend A', type: 'other' },
  { id: 'sample-b', name: 'Namuna brend B', type: 'other' },
]

const C = {
  ivory: { name: 'Fil suyagi', hex: '#EDE6D8' },
  black: { name: 'Qora', hex: '#23262B' },
  navy: { name: "To'q ko'k", hex: '#172B3A' },
  coral: { name: 'Marjon', hex: '#D94B59' },
  beige: { name: 'Bej', hex: '#D9BFA3' },
  olive: { name: 'Zaytun', hex: '#6F745A' },
  gray: { name: 'Kulrang', hex: '#A5A9AD' },
  white: { name: 'Oq', hex: '#F4F2EE' },
  denim: { name: 'Jinsi', hex: '#5C7C99' },
} satisfies Record<string, ColorOption>

const CLOTH = ['S', 'M', 'L', 'XL']
const SHOE = ['39', '40', '41', '42', '43', '44']

let n = 0
const p = (
  id: string,
  name: string,
  categoryId: Product['categoryId'],
  brandId: string,
  price: number,
  colors: ColorOption[],
  extra: Partial<Product> = {},
): Product => ({
  id,
  name,
  brandId,
  categoryId,
  price,
  colors,
  description: `${name}: namunaviy tavsif. Haqiqiy mahsulot ma'lumotlari admin panel orqali kiritiladi.`,
  sizes: categoryId === 'shoes' ? SHOE : categoryId === 'bags' || categoryId === 'accessories' ? ['Yagona'] : CLOTH,
  stock: 12,
  type: brandId === 'aynimo' ? 'original' : 'other',
  isNew: false,
  active: true,
  popularity: 50,
  createdAt: `2026-10-${String(28 - n++).padStart(2, '0')}`,
  sample: true,
  ...extra,
})

export const products: Product[] = [
  p('s-sneaker-1', 'Oq krossovka', 'shoes', 'aynimo', 690000, [C.white, C.beige], { isNew: true, popularity: 95 }),
  p('s-sneaker-2', 'Shahar krossovkasi', 'shoes', 'sample-a', 820000, [C.black, C.gray], { popularity: 80, oldPrice: 990000 }),
  p('s-shirt-1', 'Klassik ko\'ylak', 'shirts', 'aynimo', 420000, [C.white, C.denim], { isNew: true, popularity: 70 }),
  p('s-shirt-2', 'Kundalik ko\'ylak', 'shirts', 'sample-b', 360000, [C.beige, C.olive], { popularity: 55, oldPrice: 450000 }),
  p('s-tee-1', 'Oddiy futbolka', 'tshirts', 'aynimo', 190000, [C.coral, C.white, C.black], { isNew: true, popularity: 88 }),
  p('s-tee-2', 'Keng futbolka', 'tshirts', 'sample-a', 210000, [C.navy, C.gray], { popularity: 60 }),
  p('s-pants-1', 'Klassik shim', 'trousers', 'aynimo', 480000, [C.navy, C.black], { popularity: 75 }),
  p('s-pants-2', 'Keng shim', 'trousers', 'sample-b', 520000, [C.olive, C.beige], { oldPrice: 640000, popularity: 58 }),
  p('s-dress-1', 'Yozgi libos', 'dresses', 'aynimo', 760000, [C.coral, C.ivory], { isNew: true, popularity: 92 }),
  p('s-dress-2', 'Kechki libos', 'dresses', 'sample-a', 1190000, [C.navy, C.black], { popularity: 66 }),
  p('s-jacket-1', 'Yengil kurtka', 'jackets', 'aynimo', 890000, [C.olive, C.black], { popularity: 72 }),
  p('s-jacket-2', 'Jinsi kurtka', 'jackets', 'sample-b', 740000, [C.denim], { oldPrice: 920000, popularity: 61 }),
  p('s-hoodie-1', 'Yumshoq xudi', 'hoodies', 'aynimo', 540000, [C.gray, C.coral, C.navy], { isNew: true, popularity: 90 }),
  p('s-hoodie-2', 'Oversayz xudi', 'hoodies', 'sample-a', 580000, [C.black, C.beige], { popularity: 64 }),
  p('s-sweater-1', 'Trikotaj sviter', 'sweaters', 'sample-b', 460000, [C.ivory, C.beige], { popularity: 52 }),
  p('s-sweater-2', 'Yo\'l-yo\'l sviter', 'sweaters', 'aynimo', 490000, [C.navy, C.ivory], { oldPrice: 590000, popularity: 57 }),
  p('s-coat-1', 'Uzun palto', 'outerwear', 'aynimo', 1490000, [C.beige, C.black], { isNew: true, popularity: 78 }),
  p('s-coat-2', 'Issiq paxta kurtka', 'outerwear', 'sample-a', 1290000, [C.navy, C.olive], { popularity: 59 }),
  p('s-acc-1', 'Quyosh ko\'zoynagi', 'accessories', 'sample-b', 240000, [C.black, C.coral], { popularity: 68 }),
  p('s-acc-2', 'Charm kamar', 'accessories', 'aynimo', 220000, [C.black, C.beige], { popularity: 54, oldPrice: 280000 }),
  p('s-bag-1', 'Ayollar sumkasi', 'bags', 'aynimo', 650000, [C.coral, C.beige], { isNew: true, popularity: 85 }),
  p('s-bag-2', 'Shahar sumkasi', 'bags', 'sample-a', 570000, [C.black, C.navy], { popularity: 62 }),
]

export const outfits: Outfit[] = [
  { id: 'o-classic', title: 'Kundalik klassika', note: "Ko'ylak + shim + krossovka", productIds: ['s-shirt-1', 's-pants-1', 's-sneaker-1'] },
  { id: 'o-street', title: 'Shahar uslubi', note: 'Xudi + shim + krossovka', productIds: ['s-hoodie-1', 's-pants-2', 's-sneaker-2'] },
  { id: 'o-evening', title: 'Yozgi kun', note: 'Libos + sumka + ko\'zoynak', productIds: ['s-dress-1', 's-bag-1', 's-acc-1'] },
  { id: 'o-light', title: 'Yengil qatlam', note: 'Kurtka + futbolka + krossovka', productIds: ['s-jacket-1', 's-tee-1', 's-sneaker-1'] },
]

export const banners: Banner[] = [
  { id: 'b-new', title: 'Yangi kolleksiya', subtitle: "Eng so'nggi qo'shilgan modellar", to: '/katalog?f=new', tone: 'coral' },
  { id: 'b-original', title: 'AYNIMO Original', subtitle: "Faqat bizning mahsulotlar", to: '/katalog?f=original', tone: 'navy' },
  { id: 'b-sale', title: 'Chegirmadagi mahsulotlar', subtitle: 'Narxi pasaytirilgan modellar', to: '/katalog?f=discount', tone: 'beige' },
]

export const getProduct = (id: string) => products.find((x) => x.id === id)
export const getBrand = (id: string) => brands.find((b) => b.id === id)
export const getOutfit = (id: string) => outfits.find((o) => o.id === id)
export const outfitProducts = (o: Outfit) => o.productIds.map(getProduct).filter((x): x is Product => Boolean(x))
export const outfitTotal = (o: Outfit) => outfitProducts(o).reduce((s, x) => s + x.price, 0)
export const activeProducts = () => products.filter((x) => x.active)
