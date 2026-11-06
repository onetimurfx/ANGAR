import { describe, expect, it } from 'vitest'
import { CatalogFormatError, mapCatalog, mapSettings } from '../../src/data/serverCatalog'
import { variantQty } from '../../src/data/catalog'

const good = () => ({
  categories: [{ id: 'hoodies', name: 'Xudilar' }],
  brands: [{ id: 'b1', name: 'Brend', type: 'original' }],
  products: [
    {
      id: 'P1', name: 'Xudi', description: 'Tavsif', brandId: 'b1', categoryId: 'hoodies', price: 100000, oldPrice: 120000, type: 'original', isNew: true, popularity: 5,
      createdAt: '2026-11-01T10:00:00+05:00', images: ['p1/a.jpg'], sample: false,
      variants: [
        { size: 'L', color: 'Qora', colorHex: '#222222', qty: 2 },
        { size: 'M', color: 'Qora', colorHex: '#222222', qty: 5 },
        { size: 'M', color: 'Oq', colorHex: '#FFFFFF', qty: 0 },
      ],
    },
  ],
  outfits: [{ id: 'o1', title: 'Komplekt', note: '', productIds: ['P1', 'P1'] }],
  banners: [{ id: 'bn1', title: 'Yangi', subtitle: '', to: '/katalog', tone: 'navy' }],
  settings: { deliveryConfigured: false, deliveryFee: null, deliveryFreeFrom: null, supportContact: null },
})

describe('server catalog mapper', () => {
  it('maps products with sizes, colours and per-variant stock', () => {
    const c = mapCatalog(good())
    const p = c.products[0]
    expect(p.sizes).toEqual(['M', 'L']) // fashion order, not alphabetical
    expect(p.colors.map((x) => x.name)).toEqual(['Qora', 'Oq'])
    expect(p.stock).toBe(7)
    expect(p.oldPrice).toBe(120000)
    expect(p.sample).toBe(false)
    expect(variantQty(p, 'M', 'Qora')).toBe(5)
    expect(variantQty(p, 'M', 'Oq')).toBe(0)
    expect(variantQty(p, 'XL', 'Qora')).toBe(0)
    expect(variantQty(p, null, 'Qora')).toBe(7)
    expect(c.categories[0].id).toBe('all')
    expect(c.categories[1].name).toBe('Xudilar')
  })

  it('keeps the NAMUNA flag from the server and never invents it', () => {
    const g = good()
    ;(g.products[0] as { sample: boolean }).sample = true
    expect(mapCatalog(g).products[0].sample).toBe(true)
    delete (g.products[0] as { sample?: boolean }).sample
    expect(mapCatalog(g).products[0].sample).toBe(false)
  })

  it('drops malformed products instead of rendering them half-broken', () => {
    const g = good()
    g.products.push({ ...g.products[0], id: 'bad1', price: -5 } as never)
    g.products.push({ ...g.products[0], id: 'bad2', price: 1.5 } as never)
    g.products.push({ ...g.products[0], id: 'bad3', name: '' } as never)
    g.products.push({ ...g.products[0], id: 'bad4', brandId: 'unknown' } as never)
    g.products.push({ ...g.products[0], id: 'bad5', categoryId: 'unknown' } as never)
    g.products.push({ ...g.products[0], id: 'bad6', variants: [] } as never)
    g.products.push({ ...g.products[0], id: 'bad7', variants: [{ size: 'M', color: 'X', colorHex: 'red', qty: 1 }] } as never)
    g.products.push({ ...g.products[0], id: 'bad8', type: 'weird' } as never)
    g.products.push(null as never, 'str' as never, 5 as never)
    expect(mapCatalog(g).products.map((p) => p.id)).toEqual(['P1'])
  })

  it('ignores duplicate variants, unsafe image paths and a fake oldPrice', () => {
    const g = good()
    const p = g.products[0] as Record<string, unknown>
    p.variants = [
      { size: 'M', color: 'Qora', colorHex: '#222222', qty: 5 },
      { size: 'M', color: 'Qora', colorHex: '#222222', qty: 99 },
    ]
    p.images = ['../../etc/passwd', 'ok/1.jpg', 42]
    p.oldPrice = 90000 // lower than the price: not a discount
    const m = mapCatalog(g).products[0]
    expect(m.stock).toBe(5)
    expect(m.images).toEqual(['ok/1.jpg'])
    expect(m.oldPrice).toBeUndefined()
  })

  it('rejects a response that is not a catalog and tolerates missing sections', () => {
    expect(() => mapCatalog(null)).toThrow(CatalogFormatError)
    expect(() => mapCatalog([])).toThrow(CatalogFormatError)
    const empty = mapCatalog({})
    expect(empty.products).toEqual([])
    expect(empty.settings.deliveryConfigured).toBe(false)
  })

  it('only keeps outfits whose products exist and safe banner links', () => {
    const g = good()
    g.outfits.push({ id: 'o2', title: 'Yomon', note: '', productIds: ['P1', 'nope'] })
    g.banners.push({ id: 'bn2', title: 'X', subtitle: '', to: 'https://evil.example', tone: 'weird' } as never)
    g.banners.push({ id: 'bn3', title: 'Y', subtitle: '', to: '//evil.example', tone: 'coral' })
    const c = mapCatalog(g)
    expect(c.outfits.map((o) => o.id)).toEqual(['o1'])
    expect(c.banners.map((b) => b.to)).toEqual(['/katalog', '/katalog', '/katalog'])
    expect(c.banners[1].tone).toBe('coral')
  })
})

describe('delivery settings', () => {
  it('is "not configured" unless the server says so with a usable fee', () => {
    expect(mapSettings(undefined).deliveryConfigured).toBe(false)
    expect(mapSettings({ deliveryConfigured: true, deliveryFee: null }).deliveryConfigured).toBe(false)
    expect(mapSettings({ deliveryConfigured: false, deliveryFee: 25000 })).toMatchObject({ deliveryConfigured: false, deliveryFee: null })
    expect(mapSettings({ deliveryConfigured: true, deliveryFee: -1 }).deliveryConfigured).toBe(false)
    expect(mapSettings({ deliveryConfigured: true, deliveryFee: 0, deliveryFreeFrom: 500000, supportContact: '@aynimo' })).toEqual({ deliveryConfigured: true, deliveryFee: 0, deliveryFreeFrom: 500000, supportContact: '@aynimo' })
  })
})
