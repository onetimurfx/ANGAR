import { describe, expect, it } from 'vitest'
import { activeProducts, getProduct, products } from '../../src/data/sample'
import { EMPTY, applyFilters, activeGroups, facets, parseFilters, serializeFilters, type FilterState } from '../../src/lib/filters'

const all = activeProducts()
const f = (patch: Partial<FilterState>): FilterState => ({ ...EMPTY, ...patch })
const ids = (list: { id: string }[]) => list.map((p) => p.id)

describe('sample data', () => {
  it('has availability variety for testing', () => {
    expect(products.some((p) => p.stock === 0)).toBe(true)
    expect(products.some((p) => p.stock > 0 && p.stock <= 5)).toBe(true)
    expect(getProduct('s-dress-2')?.stock).toBe(0)
    expect(getProduct('s-sweater-1')?.stock).toBe(3)
  })
  it('every product is marked sample', () => expect(products.every((p) => p.sample)).toBe(true))
})

describe('applyFilters', () => {
  it('returns everything by default', () => expect(applyFilters(all, EMPTY)).toHaveLength(all.length))
  it('filters by category', () => {
    const r = applyFilters(all, f({ cat: 'shoes' }))
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((p) => p.categoryId === 'shoes')).toBe(true)
  })
  it('filters by brand (multi)', () => {
    const r = applyFilters(all, f({ brands: ['aynimo', 'sample-a'] }))
    expect(r.every((p) => ['aynimo', 'sample-a'].includes(p.brandId))).toBe(true)
    expect(r.length).toBe(all.filter((p) => p.brandId !== 'sample-b').length)
  })
  it('filters by size', () => {
    const r = applyFilters(all, f({ sizes: ['XL'] }))
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((p) => p.sizes.includes('XL'))).toBe(true)
    expect(r.some((p) => p.categoryId === 'shoes')).toBe(false)
    expect(applyFilters(all, f({ sizes: ['42'] })).every((p) => p.categoryId === 'shoes')).toBe(true)
  })
  it('filters by colour name', () => {
    const r = applyFilters(all, f({ colors: ['Marjon'] }))
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((p) => p.colors.some((c) => c.name === 'Marjon'))).toBe(true)
  })
  it('filters by price range (inclusive)', () => {
    const r = applyFilters(all, f({ min: 400000, max: 700000 }))
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((p) => p.price >= 400000 && p.price <= 700000)).toBe(true)
    expect(applyFilters(all, f({ min: 690000, max: 690000 })).map((p) => p.id)).toContain('s-sneaker-1')
  })
  it('filters by availability', () => {
    const r = applyFilters(all, f({ avail: true }))
    expect(r.every((p) => p.stock > 0)).toBe(true)
    expect(r.length).toBe(all.filter((p) => p.stock > 0).length)
    expect(ids(r)).not.toContain('s-dress-2')
  })
  it('filters by tag', () => {
    expect(applyFilters(all, f({ tag: 'new' })).every((p) => p.isNew)).toBe(true)
    expect(applyFilters(all, f({ tag: 'discount' })).every((p) => p.oldPrice && p.oldPrice > p.price)).toBe(true)
    expect(applyFilters(all, f({ tag: 'original' })).every((p) => p.type === 'original')).toBe(true)
    expect(applyFilters(all, f({ tag: 'other' })).every((p) => p.type === 'other')).toBe(true)
  })
  it('combines filters with AND', () => {
    const r = applyFilters(all, f({ cat: 'hoodies', brands: ['aynimo'], colors: ['Marjon'], avail: true }))
    expect(ids(r)).toEqual(['s-hoodie-1'])
  })
  it('searches name and brand', () => {
    expect(ids(applyFilters(all, f({ q: 'krossovka' }))).sort()).toEqual(['s-sneaker-1', 's-sneaker-2'])
    expect(applyFilters(all, f({ q: 'namuna brend a' })).every((p) => p.brandId === 'sample-a')).toBe(true)
    expect(applyFilters(all, f({ q: 'zzzz' }))).toHaveLength(0)
  })
})

describe('sorting', () => {
  it('price ascending / descending', () => {
    const asc = applyFilters(all, f({ sort: 'price_asc' })).map((p) => p.price)
    const desc = applyFilters(all, f({ sort: 'price_desc' })).map((p) => p.price)
    expect(asc).toEqual([...asc].sort((a, b) => a - b))
    expect(desc).toEqual([...desc].sort((a, b) => b - a))
  })
  it('newest first', () => {
    const d = applyFilters(all, f({ sort: 'newest' })).map((p) => p.createdAt)
    expect(d).toEqual([...d].sort().reverse())
  })
  it('popularity first', () => {
    const r = applyFilters(all, f({ sort: 'popular' }))
    expect(r[0].id).toBe('s-sneaker-1')
    const pop = r.map((p) => p.popularity)
    expect(pop).toEqual([...pop].sort((a, b) => b - a))
  })
  it('does not mutate the input', () => {
    const before = ids(all)
    applyFilters(all, f({ sort: 'price_desc' }))
    expect(ids(all)).toEqual(before)
  })
})

describe('URL state', () => {
  it('round-trips', () => {
    const s = f({ cat: 'jackets', brands: ['aynimo'], sizes: ['M', 'L'], colors: ['Qora'], min: 300000, max: 900000, avail: true, tag: 'new', sort: 'price_asc', q: 'kurtka' })
    expect(parseFilters(serializeFilters(s))).toEqual(s)
  })
  it('omits defaults', () => expect(serializeFilters(EMPTY).toString()).toBe(''))
  it('drops unknown / malformed values', () => {
    const p = parseFilters(new URLSearchParams('cat=nope&brand=x,aynimo&size=ZZ,M&color=Yo&min=abc&max=-5&f=bad&sort=zzz'))
    expect(p).toEqual(f({ brands: ['aynimo'], sizes: ['M'] }))
  })
  it('swaps reversed price bounds and ignores bounds that equal the catalog range', () => {
    const b = facets().bounds
    const p = parseFilters(new URLSearchParams(`min=900000&max=400000`))
    expect([p.min, p.max]).toEqual([400000, 900000])
    expect(parseFilters(new URLSearchParams(`min=${b.min}&max=${b.max}`)).min).toBeNull()
  })
  it('keeps legacy ?f=popular links working', () => expect(parseFilters(new URLSearchParams('f=popular')).tag).toBe(''))
  it('counts active groups', () => {
    expect(activeGroups(EMPTY)).toBe(0)
    expect(activeGroups(f({ cat: 'bags', min: 1, avail: true, sort: 'newest', q: 'x' }))).toBe(3)
  })
})

describe('facets', () => {
  it('lists real sizes, colours and price bounds', () => {
    const x = facets()
    expect(x.sizes).toEqual(expect.arrayContaining(['S', 'M', 'L', 'XL', '39', '44', 'Yagona']))
    expect(x.sizes.indexOf('S')).toBeLessThan(x.sizes.indexOf('XL'))
    expect(new Set(x.colors.map((c) => c.name)).size).toBe(x.colors.length)
    expect(x.bounds.min).toBeLessThanOrEqual(Math.min(...all.map((p) => p.price)))
    expect(x.bounds.max).toBeGreaterThanOrEqual(Math.max(...all.map((p) => p.price)))
  })
})
