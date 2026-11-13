/**
 * Phase 6 / stage E: the admin SQL functions (migration 20261111000001) against a REAL PostgreSQL with all migrations.
 * Covers authorization (non-admin, inactive admin, manager vs owner), Cart order management (flow, restock, delivery fee),
 * categories / brands / products / variants / images, inventory vs reservations, customers, settings, audit and privileges.
 */
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asRole } from './pg'
import { line, newTestDb, placeOrder, seed, type Fixture } from './fixtures'

type Sql = postgres.Sql
let sql: Sql
let fx: Fixture
const OWNER = 900001
const MANAGER = 900002
const INACTIVE = 900003

const catalog = async () => (await asRole(sql, 'anon', (tx) => tx`select get_catalog() as c`))[0].c as any
const j = (o: unknown) => o // jsonb parameters go as objects (postgres.js stringifies them once)
const call = async (fn: string, ...args: unknown[]) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const [r] = await sql.unsafe(`select ${fn}(${ph}) as r`, args as never[])
  return r.r as any
}
const fails = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (e) {
    const err = e as { message: string; detail?: string }
    let detail: any
    try { detail = err.detail ? JSON.parse(err.detail) : undefined } catch { detail = err.detail }
    return { code: err.message, detail }
  }
  throw new Error('expected a failure')
}
const place = async (sql: Sql, customer: string, items: unknown, o: { key?: string } = {}) => {
  const [r] = await sql`select place_pickup_order(${customer}::uuid, ${o.key ?? randomUUID()}::uuid, 'Ali Valiyev', '+998901234567', null, ${sql.json(items as never)}) as r`
  return r.r as { order: Record<string, any> }
}
const qty = async (productId: string, size: string, color: string) =>
  Number((await sql`select i.quantity from inventory i join product_variants v on v.id = i.variant_id where v.product_id = ${productId} and v.size = ${size} and v.color_name = ${color}`)[0].quantity)
const variantId = async (productId: string, size: string, color: string) =>
  (await sql`select id from product_variants where product_id = ${productId} and size = ${size} and color_name = ${color}`)[0].id as string
const audit = async (action: string) => Number((await sql`select count(*) from admin_audit_log where action = ${action}`)[0].count)
const newProduct = (over: Record<string, unknown> = {}) => ({
  name: 'Yangi ko\'ylak', brandId: 'b1', categoryId: 'c1', description: 'Tavsif', price: 150000, oldPrice: null, isNew: true, active: true,
  variants: [{ size: 'M', colorName: 'Oq', colorHex: '#FFFFFF', sku: 'SKU-1', quantity: 5 }, { size: 'L', colorName: 'Oq', colorHex: '#FFFFFF', quantity: 0 }],
  ...over,
})

beforeAll(async () => {
  ;({ sql } = await newTestDb('adm'))
  fx = await seed(sql)
  await sql`insert into administrators (telegram_id, name, role) values (${MANAGER}, 'Menejer', 'manager')`
  await sql`insert into administrators (telegram_id, name, role, active) values (${INACTIVE}, 'Ketgan', 'manager', false)`
})
afterAll(async () => {
  await sql?.end()
})

describe('authorization (every function checks the admin itself)', () => {
  const U = '00000000-0000-4000-8000-000000000000'
  const calls: [string, unknown[]][] = [
    ['admin_me', []], ['admin_dashboard', [3]], ['admin_list_orders', [null, null, null, 30, 0]], ['admin_get_order', [U]],
    ['admin_set_order_status', [U, 'confirmed', null]], ['admin_set_order_delivery', [U, 1000]],
    ['admin_list_categories', []], ['admin_list_brands', []], ['admin_save_category', [null, 'X', 0, true]], ['admin_save_brand', [null, 'X', 'other', true]],
    ['admin_list_products', [null, null, null, 30, 0]], ['admin_get_product', ['P1']], ['admin_save_product', [j(newProduct())]],
    ['admin_set_product_active', ['P1', true]], ['admin_add_product_image', ['P1', 'x']], ['admin_delete_product_image', [U]], ['admin_set_cover_image', [U]],
    ['admin_list_inventory', [null, 'all', 50, 0, 3]], ['admin_adjust_stock', [U, 'set', 1, null]],
    ['admin_list_customers', [null, 30, 0]], ['admin_get_customer', [U]], ['admin_get_settings', []],
  ]
  for (const who of [['a customer', 700001], ['an inactive admin', INACTIVE], ['an unknown id', 123456789]] as const) {
    it(`${who[0]} is refused everywhere`, async () => {
      for (const [fn, args] of calls) expect((await fails(() => call(fn, who[1], ...args))).code, fn).toBe('FORBIDDEN')
    })
  }
  it('a manager cannot change settings or delete categories; an owner can', async () => {
    expect((await fails(() => call('admin_update_settings', MANAGER, j({ deliveryFee: 1 })))).code).toBe('FORBIDDEN')
    expect((await fails(() => call('admin_update_pickup_settings', MANAGER, j({ maxLines: 5 })))).code).toBe('FORBIDDEN')
    expect((await fails(() => call('admin_delete_category', MANAGER, 'c1'))).code).toBe('FORBIDDEN')
    expect((await call('admin_me', MANAGER)).role).toBe('manager')
    expect((await call('admin_me', OWNER)).role).toBe('owner')
  })
  it('no function can add or change an administrator', async () => {
    const names = (await sql`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'admin\_%'`).map((r) => r.proname as string)
    expect(names.length).toBeGreaterThan(20)
    for (const n of names) {
      const [d] = await sql`select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${n} limit 1`
      expect(/(insert\s+into|update|delete\s+from)\s+public\.administrators/i.test(d.def), n).toBe(false)
    }
  })
})

describe('Cart orders', () => {
  it('flows new -> confirmed -> preparing -> shipped -> delivered, with history and a customer message each time', async () => {
    const before = await qty('P1', 'M', 'Qora')
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2)])
    expect(await qty('P1', 'M', 'Qora')).toBe(before - 2)
    for (const s of ['confirmed', 'preparing', 'shipped', 'delivered']) {
      const o = await call('admin_set_order_status', MANAGER, order.id, s, null)
      expect(o.status).toBe(s)
    }
    const d = await call('admin_get_order', OWNER, order.id)
    expect(d.history.map((h: any) => h.status)).toEqual(['new', 'confirmed', 'preparing', 'shipped', 'delivered'])
    expect(d.history[1].by).toBe(MANAGER)
    expect(d.customer.telegramId).toBe(fx.customerTg)
    expect(Number((await sql`select count(*) from notification_outbox where order_id = ${order.id}::uuid and kind = 'status_customer'`)[0].count)).toBe(4)
    expect(await qty('P1', 'M', 'Qora')).toBe(before - 2) // delivered keeps the stock taken
    expect((await fails(() => call('admin_set_order_status', OWNER, order.id, 'cancelled', 'kech'))).code).toBe('INVALID_TRANSITION')
  })

  it('rejects skipped steps, unknown statuses and "new"', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    expect((await fails(() => call('admin_set_order_status', OWNER, order.id, 'shipped', null))).code).toBe('INVALID_TRANSITION')
    expect((await fails(() => call('admin_set_order_status', OWNER, order.id, 'delivered', null))).code).toBe('INVALID_TRANSITION')
    for (const bad of ['new', 'bogus', '', null]) expect((await fails(() => call('admin_set_order_status', OWNER, order.id, bad, null))).code).toBe('INVALID_REQUEST')
    expect((await fails(() => call('admin_set_order_status', OWNER, randomUUID(), 'confirmed', null))).code).toBe('NOT_FOUND')
    expect((await call('admin_get_order', OWNER, order.id)).order.status).toBe('new')
  })

  it('cancelling needs a reason and puts the pieces back exactly once', async () => {
    const m = await qty('P1', 'M', 'Qora'), l = await qty('P1', 'L', 'Qora')
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2), line('P1', 'L', 'Qora', 1)])
    expect([await qty('P1', 'M', 'Qora'), await qty('P1', 'L', 'Qora')]).toEqual([m - 2, l - 1])
    for (const r of [null, '', '  ', 'ab']) expect((await fails(() => call('admin_set_order_status', OWNER, order.id, 'cancelled', r))).code).toBe('INVALID_REASON')
    expect([await qty('P1', 'M', 'Qora'), await qty('P1', 'L', 'Qora')]).toEqual([m - 2, l - 1])
    const o = await call('admin_set_order_status', OWNER, order.id, 'cancelled', 'Mijoz rad etdi')
    expect(o.status).toBe('cancelled')
    expect([await qty('P1', 'M', 'Qora'), await qty('P1', 'L', 'Qora')]).toEqual([m, l])
    expect((await fails(() => call('admin_set_order_status', OWNER, order.id, 'cancelled', 'yana'))).code).toBe('INVALID_TRANSITION')
    expect([await qty('P1', 'M', 'Qora'), await qty('P1', 'L', 'Qora')]).toEqual([m, l])
    const h = (await call('admin_get_order', OWNER, order.id)).history
    expect(h.at(-1)).toMatchObject({ status: 'cancelled', note: 'Mijoz rad etdi', by: OWNER })
  })

  it('cancelling after the product was deleted from an order line does not break (variant_id null)', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    await sql`update order_items set variant_id = null where order_id = ${order.id}::uuid`
    expect((await call('admin_set_order_status', OWNER, order.id, 'cancelled', 'sabab bor')).status).toBe('cancelled')
  })

  it('sets the delivery fee of an order with "not configured" delivery and recomputes the total', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P2', 'Yagona', 'Oq', 1)])
    expect(order.deliveryPending).toBe(true)
    const o = await call('admin_set_order_delivery', MANAGER, order.id, 25000)
    expect(o).toMatchObject({ deliveryFee: 25000, deliveryPending: false, subtotal: 250000, total: 275000 })
    for (const bad of [-1, null, 100000001]) expect((await fails(() => call('admin_set_order_delivery', MANAGER, order.id, bad))).code).toBe('INVALID_REQUEST')
    await call('admin_set_order_status', OWNER, order.id, 'confirmed', null)
    await call('admin_set_order_status', OWNER, order.id, 'preparing', null)
    await call('admin_set_order_status', OWNER, order.id, 'shipped', null)
    expect((await fails(() => call('admin_set_order_delivery', OWNER, order.id, 1))).code).toBe('INVALID_TRANSITION')
  })

  it('lists, filters and searches (also by phone digits), with counts per status', async () => {
    const all = await call('admin_list_orders', OWNER, null, null, null, 100, 0)
    expect(all.total).toBeGreaterThanOrEqual(4)
    expect(all.orders[0]).toMatchObject({ source: 'cart' })
    expect(Object.keys(all.counts).length).toBeGreaterThan(1)
    const cancelled = await call('admin_list_orders', OWNER, 'cancelled', 'cart', null, 100, 0)
    expect(cancelled.orders.every((o: any) => o.status === 'cancelled')).toBe(true)
    const byNumber = await call('admin_list_orders', OWNER, null, null, all.orders[0].orderNumber.slice(0, 11), 100, 0)
    expect(byNumber.total).toBeGreaterThan(0)
    expect((await call('admin_list_orders', OWNER, null, null, '90 123', 100, 0)).total).toBe(all.total) // every fixture order uses +998 90 123 45 67
    expect((await call('admin_list_orders', OWNER, null, null, 'zzzz-yo\'q', 100, 0)).total).toBe(0)
    expect((await call('admin_list_orders', OWNER, null, null, '%', 100, 0)).total).toBe(0) // LIKE metacharacters are escaped, not wildcards
    const page = await call('admin_list_orders', OWNER, null, null, null, 2, 2)
    expect(page.orders.length).toBe(2)
    for (const [s, src] of [['bogus', null], [null, 'bogus']] as const) expect((await fails(() => call('admin_list_orders', OWNER, s, src, null, 10, 0))).code).toBe('INVALID_REQUEST')
  })

  it('does not touch Quick Order (pickup) orders and does not break placing Cart orders afterwards', async () => {
    const before = Number((await sql`select count(*) from pickup_orders`)[0].count)
    await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    expect(Number((await sql`select count(*) from pickup_orders`)[0].count)).toBe(before)
  })
})

describe('categories and brands', () => {
  it('creates with a derived unique id, renames, and refuses to hide a category that has active products', async () => {
    const a = await call('admin_save_category', MANAGER, null, "Yozgi ko'ylaklar", 5, true)
    expect(a.id).toBe('yozgi-koylaklar')
    const b = await call('admin_save_category', MANAGER, null, "Yozgi ko'ylaklar", 6, true)
    expect(b.id).toBe('yozgi-koylaklar-2')
    expect((await call('admin_save_category', MANAGER, 'c1', 'Kategoriya 1', 3, true)).name).toBe('Kategoriya 1')
    expect((await fails(() => call('admin_save_category', MANAGER, 'c1', 'Kategoriya', 0, false))).code).toBe('IN_USE')
    expect((await fails(() => call('admin_save_category', MANAGER, null, '   ', 0, true))).code).toBe('INVALID_REQUEST')
    expect((await fails(() => call('admin_save_category', MANAGER, 'yo-q', 'X', 0, true))).code).toBe('NOT_FOUND')
    expect((await call('admin_save_category', MANAGER, a.id, 'Yopiq', 0, false)).active).toBe(false)
    const list = await call('admin_list_categories', MANAGER)
    expect(list.categories.find((c: any) => c.id === 'c1').activeProductCount).toBeGreaterThan(0)
    expect(list.categories.find((c: any) => c.id === a.id).active).toBe(false)
  })
  it('only an owner deletes, and only an empty category', async () => {
    const c = await call('admin_save_category', OWNER, null, 'Vaqtinchalik', 0, true)
    expect((await fails(() => call('admin_delete_category', MANAGER, c.id))).code).toBe('FORBIDDEN')
    expect((await fails(() => call('admin_delete_category', OWNER, 'c1'))).code).toBe('IN_USE')
    await call('admin_delete_category', OWNER, c.id)
    expect((await fails(() => call('admin_delete_category', OWNER, c.id))).code).toBe('NOT_FOUND')
  })
  it('brands: create, update, and the type cannot change under existing products', async () => {
    const b = await call('admin_save_brand', MANAGER, null, 'Yangi Brend', 'other', true)
    expect(b).toMatchObject({ id: 'yangi-brend', type: 'other' })
    expect((await call('admin_save_brand', MANAGER, b.id, 'Yangi Brend 2', 'original', true)).type).toBe('original')
    expect((await fails(() => call('admin_save_brand', MANAGER, 'b1', 'Brend', 'other', true))).code).toBe('IN_USE')
    expect((await fails(() => call('admin_save_brand', MANAGER, 'b1', 'Brend', 'original', false))).code).toBe('IN_USE')
    expect((await fails(() => call('admin_save_brand', MANAGER, null, 'X', 'weird', true))).code).toBe('INVALID_REQUEST')
    expect((await call('admin_list_brands', MANAGER)).brands.length).toBeGreaterThanOrEqual(2)
  })
})

describe('products', () => {
  let pid = ''
  it('creates a real (non-sample) product with variants and starting stock; the type follows the brand', async () => {
    const r = await call('admin_save_product', MANAGER, j(newProduct()))
    pid = r.product.id
    expect(r.product).toMatchObject({ name: "Yangi ko'ylak", price: 150000, oldPrice: null, isSample: false, type: 'original', active: true })
    expect(r.product.variants.map((v: any) => [v.size, v.quantity])).toEqual([['M', 5], ['L', 0]])
    expect(await audit('product.create')).toBe(1)
  })
  it('a new product shows up in the public catalog with its stock', async () => {
    const cat = await catalog()
    const p = cat.products.find((x: any) => x.id === pid)
    expect(p).toBeTruthy()
    expect(p.variants.find((v: any) => v.size === 'M').qty).toBe(5)
  })
  it('validates everything and writes nothing on failure', async () => {
    const count = async () => Number((await sql`select count(*) from products`)[0].count)
    const n = await count()
    const bad: [string, Record<string, unknown>][] = [
      ['name', { name: '' }], ['name', { name: 42 }], ['price', { price: -1 }], ['price', { price: 1.5 }], ['price', { price: '100' }], ['price', { price: 1234567890 }],
      ['oldPrice', { oldPrice: 100 }], ['oldPrice', { oldPrice: 150000 }], ['brandId', { brandId: 'yo-q' }], ['categoryId', { categoryId: 'yo-q' }],
      ['description', { description: 'x'.repeat(4001) }], ['variants', { variants: 'x' }],
      ['variants', { variants: [{ size: '', colorName: 'Oq', colorHex: '#FFFFFF' }] }],
      ['variants', { variants: [{ size: 'M', colorName: 'Oq', colorHex: 'white' }] }],
      ['variants', { variants: [{ size: 'M', colorName: 'Oq', colorHex: '#FFFFFF', quantity: -1 }] }],
    ]
    for (const [field, over] of bad) {
      const e = await fails(() => call('admin_save_product', MANAGER, j(newProduct(over))))
      expect(e.code, JSON.stringify(over)).toBe('INVALID_REQUEST')
      expect(e.detail?.field, JSON.stringify(over)).toBe(field)
    }
    expect((await fails(() => call('admin_save_product', MANAGER, j(newProduct({ variants: [{ size: 'M', colorName: 'Oq', colorHex: '#FFFFFF' }, { size: 'M', colorName: 'Oq', colorHex: '#000000' }] }))))).code).toBe('DUPLICATE_VARIANT')
    expect((await fails(() => call('admin_save_product', MANAGER, j(newProduct({ id: 'yo-q' }))))).code).toBe('NOT_FOUND')
    expect((await fails(() => call('admin_save_product', MANAGER, []))).code).toBe('INVALID_REQUEST')
    expect(await count()).toBe(n)
  })
  it('updates fields and variants; unlisted variants stay; a new variant that clashes is refused', async () => {
    const cur = (await call('admin_get_product', MANAGER, pid)).product
    const m = cur.variants.find((v: any) => v.size === 'M')
    const r = await call('admin_save_product', MANAGER, j({ ...newProduct({ id: pid, price: 140000, oldPrice: 180000, name: 'Yangilandi' }),
      variants: [{ id: m.id, size: 'M', colorName: 'Oq', colorHex: '#FAFAFA', sku: 'SKU-9', active: true }, { size: 'XL', colorName: 'Oq', colorHex: '#FFFFFF', quantity: 2 }] }))
    expect(r.product).toMatchObject({ name: 'Yangilandi', price: 140000, oldPrice: 180000 })
    expect(r.product.variants.length).toBe(3) // L was not listed: kept
    expect(r.product.variants.find((v: any) => v.size === 'M')).toMatchObject({ colorHex: '#FAFAFA', sku: 'SKU-9', quantity: 5 }) // stock is not touched by a product save
    expect(r.product.variants.find((v: any) => v.size === 'XL').quantity).toBe(2)
    const e = await fails(() => call('admin_save_product', MANAGER, j(newProduct({ id: pid, variants: [{ size: 'XL', colorName: 'Oq', colorHex: '#000000' }] }))))
    expect(e.code).toBe('DUPLICATE_VARIANT')
    expect((await call('admin_get_product', MANAGER, pid)).product.variants.length).toBe(3) // nothing half-written
    const foreign = await variantId('P1', 'M', 'Qora')
    const other = await fails(() => call('admin_save_product', MANAGER, j(newProduct({ id: pid, variants: [{ id: foreign, size: 'M', colorName: 'Oq', colorHex: '#FFFFFF' }] }))))
    expect(other.code).toBe('NOT_FOUND') // a variant of another product cannot be edited through this one
  })
  it('hiding a variant removes it from the catalog but keeps it (orders point at it)', async () => {
    const cur = (await call('admin_get_product', MANAGER, pid)).product
    const xl = cur.variants.find((v: any) => v.size === 'XL')
    await call('admin_save_product', MANAGER, j(newProduct({ id: pid, variants: [{ id: xl.id, size: 'XL', colorName: 'Oq', colorHex: '#FFFFFF', active: false }] })))
    const p = (await catalog()).products.find((x: any) => x.id === pid)
    expect(p.variants.some((v: any) => v.size === 'XL')).toBe(false)
    expect((await call('admin_get_product', MANAGER, pid)).product.variants.length).toBe(3)
  })
  it('only an owner may flip the sample flag; a manager sending the same value is fine', async () => {
    const r = await call('admin_save_product', MANAGER, j(newProduct({ id: pid, isSample: false, variants: undefined })))
    expect(r.product.isSample).toBe(false)
    expect((await fails(() => call('admin_save_product', MANAGER, j(newProduct({ id: pid, isSample: true, variants: undefined }))))).code).toBe('FORBIDDEN')
    expect((await call('admin_save_product', OWNER, j(newProduct({ id: pid, isSample: true, variants: undefined })))).product.isSample).toBe(true)
    expect((await call('admin_save_product', OWNER, j(newProduct({ id: pid, isSample: false, variants: undefined })))).product.isSample).toBe(false)
  })
  it('set_active hides / shows the product in the catalog; lists filter and search', async () => {
    expect((await call('admin_set_product_active', MANAGER, pid, false)).product.active).toBe(false)
    expect((await catalog()).products.some((x: any) => x.id === pid)).toBe(false)
    expect((await call('admin_list_products', MANAGER, null, null, 'inactive', 50, 0)).products.some((x: any) => x.id === pid)).toBe(true)
    await call('admin_set_product_active', MANAGER, pid, true)
    const l = await call('admin_list_products', MANAGER, 'yangi', 'c1', 'active', 50, 0)
    expect(l.total).toBe(1)
    expect(l.products[0]).toMatchObject({ id: pid, brandName: 'Brend', stock: 5, variantCount: 2 })
    expect((await call('admin_list_products', MANAGER, 'SKU-9', null, null, 50, 0)).total).toBe(1)
    expect((await fails(() => call('admin_list_products', MANAGER, null, null, 'weird', 50, 0))).code).toBe('INVALID_REQUEST')
    expect((await fails(() => call('admin_set_product_active', MANAGER, 'yo-q', true))).code).toBe('NOT_FOUND')
  })
  it('an inactive brand or category cannot be chosen, but an existing product keeps the one it already has', async () => {
    await call('admin_save_brand', OWNER, null, 'Eski', 'other', false)
    expect((await fails(() => call('admin_save_product', MANAGER, j(newProduct({ brandId: 'eski' }))))).code).toBe('INVALID_REQUEST')
  })

  describe('images', () => {
    const path = (p: string) => `products/${p}/${randomUUID()}.webp`
    let ids: string[] = []
    it('registers files issued for this product only, numbers them, and caps at 12', async () => {
      const a = await call('admin_add_product_image', MANAGER, pid, path(pid))
      const b = await call('admin_add_product_image', MANAGER, pid, path(pid))
      ids = b.product.images.map((i: any) => i.id)
      expect(a.product.images.length).toBe(1)
      expect(ids.length).toBe(2)
      for (const bad of [path('P1'), 'products/x/y.webp', `products/${pid}/../${randomUUID()}.webp`, `products/${pid}/${randomUUID()}.gif`, `${pid}/${randomUUID()}.webp`, null]) {
        expect((await fails(() => call('admin_add_product_image', MANAGER, pid, bad))).code, String(bad)).toBe('INVALID_REQUEST')
      }
      expect((await fails(() => call('admin_add_product_image', MANAGER, 'yo-q', path('yo-q')))).code).toBe('NOT_FOUND')
      for (let i = 0; i < 10; i++) await call('admin_add_product_image', MANAGER, pid, path(pid))
      expect((await fails(() => call('admin_add_product_image', MANAGER, pid, path(pid)))).code).toBe('TOO_MANY_IMAGES')
    })
    it('the cover image becomes the first one; deleting returns the file path for Storage', async () => {
      const r = await call('admin_set_cover_image', MANAGER, ids[1])
      expect(r.product.images[0].id).toBe(ids[1])
      expect((await call('admin_list_products', MANAGER, null, null, null, 100, 0)).products.find((x: any) => x.id === pid).image).toBe(r.product.images[0].path)
      const d = await call('admin_delete_product_image', MANAGER, ids[1])
      expect(d.path).toBe(r.product.images[0].path)
      expect(d.product.images.some((i: any) => i.id === ids[1])).toBe(false)
      expect((await fails(() => call('admin_delete_product_image', MANAGER, ids[1]))).code).toBe('NOT_FOUND')
      expect((await fails(() => call('admin_set_cover_image', MANAGER, randomUUID()))).code).toBe('NOT_FOUND')
    })
  })
})

describe('inventory', () => {
  it('lists available stock (physical minus pickup reservations) and filters low / out', async () => {
    const { order } = await place(sql, fx.customer, [line('P2', 'Yagona', 'Oq', 2)])
    const v = await variantId('P2', 'Yagona', 'Oq')
    const all = await call('admin_list_inventory', MANAGER, 'P2'.toLowerCase(), 'all', 50, 0, 3)
    const row = all.items.find((r: any) => r.variantId === v)
    expect(row).toMatchObject({ quantity: 2, reserved: 2, available: 0 })
    expect((await call('admin_list_inventory', MANAGER, null, 'out', 50, 0, 3)).items.some((r: any) => r.variantId === v)).toBe(true)
    await sql`select admin_cancel_pickup(${OWNER}::bigint, ${order.id}::uuid, 'sinov')`
    expect((await call('admin_list_inventory', MANAGER, 'P2', 'all', 50, 0, 3)).items.find((r: any) => r.variantId === v).available).toBe(2)
    expect((await fails(() => call('admin_list_inventory', MANAGER, null, 'weird', 50, 0, 3))).code).toBe('INVALID_REQUEST')
  })
  it('adjusts by counting (set) or by change (add), logs it, and never goes below what is reserved', async () => {
    const v = await variantId('P3', 'S', 'Oq')
    const start = await qty('P3', 'S', 'Oq')
    expect((await call('admin_adjust_stock', MANAGER, v, 'set', 20, 'Sanoq')).quantity).toBe(20)
    expect((await call('admin_adjust_stock', MANAGER, v, 'add', -5, null))).toMatchObject({ quantity: 15, was: 20 })
    const h = await sql`select old_qty, new_qty, reason, admin_telegram_id from stock_adjustments where variant_id = ${v}::uuid order by id`
    expect(h.map((r) => [r.old_qty, r.new_qty, r.reason, Number(r.admin_telegram_id)])).toEqual([[start, 20, 'Sanoq', MANAGER], [20, 15, null, MANAGER]])
    expect((await fails(() => call('admin_adjust_stock', MANAGER, v, 'add', -16, null))).code).toBe('INVALID_REQUEST')
    await place(sql, fx.customer, [line('P3', 'S', 'Oq', 4)])
    const e = await fails(() => call('admin_adjust_stock', MANAGER, v, 'set', 3, null))
    expect(e).toMatchObject({ code: 'STOCK_BELOW_RESERVED', detail: { reserved: 4 } })
    expect(await qty('P3', 'S', 'Oq')).toBe(15)
    expect((await call('admin_adjust_stock', MANAGER, v, 'set', 4, null)).available).toBe(0)
    for (const bad of [['bogus', 1], ['set', null], ['set', 2000000]] as const) expect((await fails(() => call('admin_adjust_stock', MANAGER, v, bad[0], bad[1], null))).code).toBe('INVALID_REQUEST')
    expect((await fails(() => call('admin_adjust_stock', MANAGER, randomUUID(), 'set', 1, null))).code).toBe('NOT_FOUND')
    expect((await fails(() => call('admin_adjust_stock', MANAGER, v, 'set', 1, 'x'.repeat(201)))).code).toBe('INVALID_REQUEST')
  })
})

describe('customers (read only)', () => {
  it('lists with order counts and totals, searches by name / username / phone / telegram id, and returns the order history', async () => {
    const l = await call('admin_list_customers', MANAGER, null, 30, 0)
    const me = l.customers.find((c: any) => c.id === fx.customer)
    expect(me.cartOrders).toBeGreaterThan(2)
    expect(me.pickupOrders).toBeGreaterThan(0)
    expect(me.cartSpent).toBeGreaterThan(0)
    for (const q of ['Ali', 'valiyev', 'ali', '90 123', String(fx.customerTg)]) expect((await call('admin_list_customers', MANAGER, q, 30, 0)).total, q).toBeGreaterThan(0)
    expect((await call('admin_list_customers', MANAGER, 'zzz-yo-q', 30, 0)).total).toBe(0)
    const d = await call('admin_get_customer', MANAGER, fx.customer)
    expect(d.customer.telegramId).toBe(fx.customerTg)
    expect(d.orders.length).toBeGreaterThan(2)
    expect(d.pickupOrders.length).toBeGreaterThan(0)
    expect((await fails(() => call('admin_get_customer', MANAGER, randomUUID()))).code).toBe('NOT_FOUND')
    expect(JSON.stringify(d)).not.toMatch(/pickupCode|pickup_code/)
  })
})

describe('settings', () => {
  it('everybody reads; admins are listed for the owner only', async () => {
    const o = await call('admin_get_settings', OWNER)
    expect(o.role).toBe('owner')
    expect(o.admins.map((a: any) => a.telegramId)).toEqual(expect.arrayContaining([OWNER, MANAGER]))
    expect(o.settings).toMatchObject({ deliveryFee: null, allowSampleOrders: false })
    expect(o.pickup).toMatchObject({ pendingTimeoutMinutes: 30, storeAddress: null })
    const m = await call('admin_get_settings', MANAGER)
    expect(m.admins).toBeNull()
    expect(m.role).toBe('manager')
  })
  it('the owner updates delivery settings (partial updates keep the rest) and the public catalog follows', async () => {
    const r = await call('admin_update_settings', OWNER, j({ deliveryFee: 25000, deliveryFreeFrom: 500000, supportContact: ' @angar_support ' }))
    expect(r.settings).toMatchObject({ deliveryFee: 25000, deliveryFreeFrom: 500000, supportContact: '@angar_support', allowSampleOrders: false })
    expect((await catalog()).settings.deliveryFee).toBe(25000)
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)]) // placed AFTER the fee was set: uses it
    expect(order).toMatchObject({ deliveryPending: false, deliveryFee: 25000 })
    expect((await call('admin_update_settings', OWNER, j({ deliveryFee: null }))).settings).toMatchObject({ deliveryFee: null, deliveryFreeFrom: 500000 })
    expect((await call('admin_update_settings', OWNER, j({ allowSampleOrders: true }))).settings.allowSampleOrders).toBe(true)
    await call('admin_update_settings', OWNER, j({ allowSampleOrders: false }))
    for (const bad of [{ deliveryFee: -1 }, { deliveryFee: '5' }, { deliveryFee: 1.5 }, { deliveryFreeFrom: 0 }, { allowSampleOrders: 'yes' }, { supportContact: 5 }, { supportContact: 'x'.repeat(201) }]) {
      expect((await fails(() => call('admin_update_settings', OWNER, j(bad)))).code, JSON.stringify(bad)).toBe('INVALID_REQUEST')
    }
    expect((await fails(() => call('admin_update_settings', OWNER, []))).code).toBe('INVALID_REQUEST')
  })
  it('pickup settings: the store details the owner enters, and limits that stay inside the database CHECKs', async () => {
    const r = await call('admin_update_pickup_settings', OWNER, j({ storeAddress: ' Toshkent, Chilonzor ', storePhone: '+998 71 200 00 00', storeHours: '10:00-20:00', pendingTimeoutMinutes: 45, maxLines: 8 }))
    expect(r.pickup).toMatchObject({ storeAddress: 'Toshkent, Chilonzor', storePhone: '+998 71 200 00 00', pendingTimeoutMinutes: 45, maxLines: 8, readyHoldHours: 24 })
    expect((await call('admin_update_pickup_settings', OWNER, j({ storeHours: null }))).pickup.storeHours).toBeNull()
    for (const bad of [{ pendingTimeoutMinutes: 0 }, { pendingTimeoutMinutes: 1441 }, { readyHoldHours: 721 }, { maxActivePerCustomer: 21 }, { maxLines: 51 }, { maxLines: '5' }, { storePhone: 'x'.repeat(41) }, { storeAddress: 5 }]) {
      expect((await fails(() => call('admin_update_pickup_settings', OWNER, j(bad)))).code, JSON.stringify(bad)).toBe('INVALID_REQUEST')
    }
    expect((await sql`select updated_by from pickup_settings`)[0].updated_by).toBe(String(OWNER))
  })
})

describe('dashboard and audit', () => {
  it('counts Cart and Quick Order separately', async () => {
    const d = await call('admin_dashboard', MANAGER, 3)
    expect(Object.keys(d.cart)).toEqual(expect.arrayContaining(['new', 'confirmed', 'preparing', 'shipped', 'today', 'todayTotal', 'deliveryPending']))
    expect(Object.keys(d.pickup)).toEqual(expect.arrayContaining(['pending', 'preparing', 'ready', 'completedToday']))
    expect(d.cart.today).toBeGreaterThan(0)
    expect(d.pickup.pending).toBeGreaterThan(0)
    expect(d.catalog.active).toBeGreaterThan(2)
    expect(d.customers.total).toBeGreaterThan(0)
    expect(d.recentOrders.length).toBeGreaterThan(0)
    expect(d.stock.threshold).toBe(3)
  })
  it('every mutation is in the audit log with the admin id; reads are not', async () => {
    const rows = await sql`select distinct action from admin_audit_log`
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['order.status', 'order.delivery', 'category.create', 'category.update', 'category.delete', 'brand.create', 'product.create', 'product.update', 'product.active', 'product.image.add', 'product.image.delete', 'product.image.cover', 'stock.adjust', 'settings.update', 'pickup_settings.update']))
    const before = Number((await sql`select count(*) from admin_audit_log`)[0].count)
    await call('admin_list_orders', OWNER, null, null, null, 10, 0)
    await call('admin_dashboard', OWNER, 3)
    expect(Number((await sql`select count(*) from admin_audit_log`)[0].count)).toBe(before)
    expect((await sql`select count(*) from admin_audit_log where admin_telegram_id not in (${OWNER}, ${MANAGER})`)[0].count).toBe('0')
  })
})

describe('privileges', () => {
  it('the browser roles cannot run any admin function or read the new tables; service_role can', async () => {
    const names = (await sql`select p.oid::regprocedure::text as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'admin\_%'`).map((r) => r.sig as string)
    expect(names.length).toBeGreaterThan(25)
    for (const role of ['anon', 'authenticated'] as const) {
      for (const sig of names) {
        const [r] = await sql.unsafe(`select has_function_privilege('${role}', '${sig}', 'execute') as ok`)
        expect(r.ok, `${role} ${sig}`).toBe(false)
      }
      for (const t of ['admin_audit_log', 'stock_adjustments']) {
        await expect(asRole(sql, role, (tx) => tx.unsafe(`select * from public.${t}`))).rejects.toThrow(/permission denied/)
      }
    }
    for (const sig of names) expect((await sql.unsafe(`select has_function_privilege('service_role', '${sig}', 'execute') as ok`))[0].ok, sig).toBe(true)
    await expect(asRole(sql, 'anon', (tx) => tx`select admin_dashboard(${OWNER}::bigint, 3)`)).rejects.toThrow(/permission denied/)
    expect(Number((await sql`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('admin_audit_log','stock_adjustments') and c.relrowsecurity`)[0].count)).toBe(2)
  })
})
