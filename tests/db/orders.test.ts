import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import postgres from 'postgres'
import { CONTACT, line, newTestDb, placeFails, placeOrder, seed, type Fixture } from './fixtures'

let sql: postgres.Sql
let url: string
let fx: Fixture
const open: postgres.Sql[] = []

beforeEach(async () => {
  while (open.length) await open.pop()!.end()
  if (sql) await sql.end()
  ;({ sql, url } = await newTestDb('orders'))
  fx = await seed(sql)
})
afterAll(async () => {
  while (open.length) await open.pop()!.end()
  await sql?.end()
  void inject
})

const stock = async (pid: string, size: string) =>
  (await sql`select i.quantity from inventory i join product_variants v on v.id = i.variant_id where v.product_id = ${pid} and v.size = ${size}`)[0].quantity as number
const orderCount = async () => (await sql`select count(*)::int as n from orders`)[0].n as number
const customer = async (tg: number) => (await sql`select upsert_customer(${tg}, 'Kimdir', null, null, null, null) as id`)[0].id as string
const conn = () => { const c = postgres(url, { max: 1, onnotice: () => {} }); open.push(c); return c }

describe('happy path', () => {
  it('creates the order, prices it on the server, takes stock, writes history and bot messages', async () => {
    const r = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2), line('P2', 'Yagona', 'Oq', 1)], { contact: { phone: '90 123 45 67', name: '  Ali   Valiyev ' } })
    expect(r.duplicate).toBe(false)
    const o = r.order
    expect(o.orderNumber).toMatch(/^AYN-\d{6}-\d{5}$/)
    expect(o.status).toBe('new')
    expect(o.subtotal).toBe(2 * 100000 + 250000)
    expect(o.contact).toMatchObject({ name: 'Ali Valiyev', phone: '+998901234567' })
    expect(o.items).toHaveLength(2)
    expect(o.items.find((i: any) => i.productId === 'P1')).toMatchObject({ qty: 2, unitPrice: 100000, size: 'M', color: 'Qora' })
    expect(await stock('P1', 'M')).toBe(3)
    expect(await stock('P2', 'Yagona')).toBe(2)
    expect((await sql`select status from order_status_history where order_id = ${o.id}`).map((h) => h.status)).toEqual(['new'])
    const out = await sql`select kind, chat_id::text from notification_outbox where order_id = ${o.id} order by kind`
    expect(out.map((x) => `${x.kind}:${x.chat_id}`)).toEqual([`order_admin:${fx.adminTg}`, `order_customer:${fx.customerTg}`])
    expect((await sql`select phone from customers where id = ${fx.customer}`)[0].phone).toBe('+998901234567')
  })

  it('delivery is "pending" (not invented) while the shop has not configured it', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)])
    expect(order).toMatchObject({ deliveryPending: true, deliveryFee: null, total: 100000, subtotal: 100000 })
  })

  it('uses the configured delivery fee, and free delivery above the threshold', async () => {
    await sql`update settings set delivery_fee = 30000, delivery_free_from = 200000`
    const a = (await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)])).order
    expect(a).toMatchObject({ deliveryPending: false, deliveryFee: 30000, total: 130000 })
    const b = (await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2)])).order
    expect(b).toMatchObject({ deliveryFee: 0, total: 200000 })
  })

  it('merges duplicate lines of the same variant', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1), line('P1', 'M', 'Qora', 2)])
    expect(order.items).toHaveLength(1)
    expect(order.items[0].qty).toBe(3)
    expect(await stock('P1', 'M')).toBe(2)
  })

  it('ignores any price the client sends', async () => {
    const { order } = await placeOrder(sql, fx.customer, [{ ...line('P1', 'M', 'Qora', 1), price: 1, unitPrice: 1 }])
    expect(order.total).toBe(100000)
  })

  it('snapshots names and prices: later catalog edits do not change the order', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)])
    await sql`update products set price = 1, name = 'Boshqa' where id = 'P1'`
    const [o] = await sql`select my_orders(${fx.customer}::uuid) as o`
    expect(o.o[0].items[0]).toMatchObject({ name: 'Mahsulot P1', unitPrice: 100000 })
    expect(o.o[0].id).toBe(order.id)
  })
})

describe('stock validation', () => {
  it('rejects more than available, names the variant and changes nothing', async () => {
    const f = await placeFails(sql, fx.customer, [line('P1', 'L', 'Qora', 3), line('P2', 'Yagona', 'Oq', 1)])
    expect(f.code).toBe('ITEMS_UNAVAILABLE')
    expect(f.detail.issues).toEqual([expect.objectContaining({ productId: 'P1', size: 'L', reason: 'stock', requested: 3, available: 2 })])
    expect(await orderCount()).toBe(0)
    expect(await stock('P1', 'L')).toBe(2)
    expect(await stock('P2', 'Yagona')).toBe(3)
  })
  it('counts merged duplicates against the stock', async () => {
    const f = await placeFails(sql, fx.customer, [line('P1', 'L', 'Qora', 1), line('P1', 'L', 'Qora', 2)])
    expect(f.code).toBe('ITEMS_UNAVAILABLE')
    expect(f.detail.issues[0]).toMatchObject({ requested: 3, available: 2 })
  })
  it.each([
    ['inactive product', line('INACTIVE', 'M', 'Qora', 1)],
    ['inactive variant', line('P1', 'XL', 'Qora', 1)],
    ['unknown product', line('NOPE', 'M', 'Qora', 1)],
    ['unknown size', line('P1', 'XXL', 'Qora', 1)],
    ['unknown colour', line('P1', 'M', 'Qizil', 1)],
  ])('rejects %s', async (_n, it_) => {
    const f = await placeFails(sql, fx.customer, [it_])
    expect(f.code).toBe('ITEMS_UNAVAILABLE')
    expect(f.detail.issues[0].reason).toBe('unavailable')
    expect(await orderCount()).toBe(0)
  })
  it('sold-out variant (0) cannot be ordered', async () => {
    await sql`update inventory set quantity = 0 where variant_id = (select id from product_variants where product_id = 'P3')`
    expect((await placeFails(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])).detail.issues[0]).toMatchObject({ reason: 'stock', available: 0 })
  })
})

describe('sample products are never sold as real', () => {
  it('place_order refuses them by default', async () => {
    const f = await placeFails(sql, fx.customer, [line('SAMPLE', 'M', 'Qora', 1)])
    expect(f.code).toBe('SAMPLE_PRODUCT')
    expect(await orderCount()).toBe(0)
  })
  it('only the owner can allow them (settings.allow_sample_orders)', async () => {
    await sql`update settings set allow_sample_orders = true`
    expect((await placeOrder(sql, fx.customer, [line('SAMPLE', 'M', 'Qora', 1)])).order.total).toBe(10000)
  })
})

describe('input validation (server side, independent of the browser)', () => {
  it.each([
    ['name too short', { name: 'A' }, 'name'],
    ['name has no letters', { name: '12345' }, 'name'],
    ['name has markup', { name: 'Ali <b>' }, 'name'],
    ['name too long', { name: 'A'.repeat(61) }, 'name'],
    ['bad phone', { phone: '12345' }, 'phone'],
    ['phone starts with 0', { phone: '+998 01 123 45 67' }, 'phone'],
    ['foreign phone', { phone: '+7 912 345 67 89' }, 'phone'],
    ['address too short', { address: 'uy' }, 'address'],
    ['address too long', { address: 'x'.repeat(201) }, 'address'],
    ['comment too long', { comment: 'x'.repeat(301) }, 'comment'],
  ])('%s', async (_n, contact, field) => {
    const f = await placeFails(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { contact })
    expect(f.code).toBe('INVALID_CONTACT')
    expect(f.detail.fields).toContain(field)
    expect(await orderCount()).toBe(0)
    expect(await stock('P1', 'M')).toBe(5)
  })
  it('reports every bad field at once', async () => {
    const f = await placeFails(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { contact: { name: '', phone: '', address: '' } })
    expect(f.detail.fields.sort()).toEqual(['address', 'name', 'phone'])
  })
  it.each([
    ['empty list', [], 'EMPTY_ORDER'],
    ['not an array', { a: 1 }, 'EMPTY_ORDER'],
    ['qty 0', [line('P1', 'M', 'Qora', 0)], 'INVALID_ITEM'],
    ['qty 100', [line('P1', 'M', 'Qora', 100)], 'INVALID_ITEM'],
    ['qty negative', [line('P1', 'M', 'Qora', -1)], 'INVALID_ITEM'],
    ['qty fractional', [{ productId: 'P1', size: 'M', color: 'Qora', qty: 1.5 }], 'INVALID_ITEM'],
    ['qty as string', [{ productId: 'P1', size: 'M', color: 'Qora', qty: '2' }], 'INVALID_ITEM'],
    ['missing fields', [{ productId: 'P1' }], 'INVALID_ITEM'],
    ['item is not an object', ['P1'], 'INVALID_ITEM'],
    ['more than 50 lines', Array.from({ length: 51 }, () => line('P1', 'M', 'Qora', 1)), 'INVALID_ITEM'],
  ])('rejects %s', async (_n, items, code) => {
    expect((await placeFails(sql, fx.customer, items)).code).toBe(code)
    expect(await orderCount()).toBe(0)
  })
  it('rejects an unknown customer and a bad source', async () => {
    expect((await placeFails(sql, randomUUID(), [line('P1', 'M', 'Qora', 1)])).code).toBe('UNKNOWN_CUSTOMER')
    const [e] = await sql`select 1`.then(async () => {
      try { await sql`select place_order(${fx.customer}::uuid, ${randomUUID()}::uuid, 'hack', 'Ali', '+998901234567', 'Toshkent, uy 1-2', null, '[]'::jsonb)`; return [null] } catch (x) { return [x as Error] }
    })
    expect(e?.message).toBe('INVALID_REQUEST')
  })
})

describe('duplicate protection', () => {
  it('the same key twice returns the SAME order and takes stock once', async () => {
    const key = randomUUID()
    const a = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2)], { key })
    const b = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2)], { key })
    expect(b.duplicate).toBe(true)
    expect(b.order.id).toBe(a.order.id)
    expect(b.order.orderNumber).toBe(a.order.orderNumber)
    expect(await orderCount()).toBe(1)
    expect(await stock('P1', 'M')).toBe(3)
    expect((await sql`select count(*)::int as n from notification_outbox`)[0].n).toBe(2) // admin + customer, not doubled
  })
  it('a retry with the same key keeps the first order even if the data was edited', async () => {
    const key = randomUUID()
    const a = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { key })
    const b = await placeOrder(sql, fx.customer, [line('P2', 'Yagona', 'Oq', 1)], { key, contact: { name: 'Boshqa Odam' } })
    expect(b.order.id).toBe(a.order.id)
    expect(b.order.contact.name).toBe('Ali Valiyev')
    expect(await stock('P2', 'Yagona')).toBe(3)
  })
  it('a retry is accepted even after the stock ran out (it returns the existing order, no new stock check)', async () => {
    const key = randomUUID()
    await placeOrder(sql, fx.customer, [line('P1', 'L', 'Qora', 2)], { key })
    expect(await stock('P1', 'L')).toBe(0)
    expect((await placeOrder(sql, fx.customer, [line('P1', 'L', 'Qora', 2)], { key })).duplicate).toBe(true)
  })
  it('10 PARALLEL requests with one key create exactly one order', async () => {
    const key = randomUUID()
    const conns = Array.from({ length: 10 }, conn)
    const res = await Promise.all(conns.map((c) => placeOrder(c, fx.customer, [line('P1', 'M', 'Qora', 1)], { key })))
    expect(new Set(res.map((r) => r.order.id)).size).toBe(1)
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1)
    expect(await orderCount()).toBe(1)
    expect(await stock('P1', 'M')).toBe(4)
  })
  it('different customers may use the same key', async () => {
    const other = await customer(700002)
    const key = randomUUID()
    const a = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)], { key })
    const b = await placeOrder(sql, other, [line('P3', 'S', 'Oq', 1)], { key })
    expect(a.order.id).not.toBe(b.order.id)
  })
})

describe('concurrency', () => {
  it('never oversells: 12 parallel orders for 5 pieces -> exactly 5 succeed, stock is 0, never negative', async () => {
    const conns = Array.from({ length: 12 }, conn)
    const results = await Promise.allSettled(conns.map((c) => placeOrder(c, fx.customer, [line('P1', 'M', 'Qora', 1)])))
    const ok = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(5)
    expect(failed).toHaveLength(7)
    expect(failed.every((f) => f.reason.message === 'ITEMS_UNAVAILABLE')).toBe(true)
    expect(await stock('P1', 'M')).toBe(0)
    expect(await orderCount()).toBe(5)
  })
  it('opposite lock orders do not deadlock (A: v1,v2 / B: v2,v1)', async () => {
    await sql`update inventory set quantity = 100`
    const conns = Array.from({ length: 16 }, conn)
    const res = await Promise.allSettled(
      conns.map((c, i) => placeOrder(c, fx.customer, i % 2 ? [line('P1', 'M', 'Qora', 1), line('P3', 'S', 'Oq', 1)] : [line('P3', 'S', 'Oq', 1), line('P1', 'M', 'Qora', 1)])),
    )
    expect(res.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.message)).toEqual([])
    expect(await stock('P1', 'M')).toBe(100 - 16)
    expect(await stock('P3', 'S')).toBe(100 - 16)
  })
  it('a failed order leaves no partial data (atomic)', async () => {
    await placeFails(sql, fx.customer, [line('P3', 'S', 'Oq', 1), line('P1', 'L', 'Qora', 99)])
    expect(await orderCount()).toBe(0)
    expect(await stock('P3', 'S')).toBe(4)
    expect((await sql`select count(*)::int as n from order_items`)[0].n).toBe(0)
    expect((await sql`select count(*)::int as n from notification_outbox`)[0].n).toBe(0)
  })
})

describe('rate limit', () => {
  it('blocks the 21st order within an hour', async () => {
    await sql`update inventory set quantity = 1000`
    for (let i = 0; i < 20; i++) await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    expect((await placeFails(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])).code).toBe('RATE_LIMITED')
  })
})

describe('cart on the server', () => {
  it('stores, merges, clamps and drops unknown variants', async () => {
    const [{ c }] = await sql`select set_cart(${fx.customer}::uuid, ${sql.json([
      line('P1', 'M', 'Qora', 2), line('P1', 'M', 'Qora', 3), line('P1', 'XL', 'Qora', 1), line('NOPE', 'M', 'Qora', 1),
      line('INACTIVE', 'M', 'Qora', 1), { productId: 'P2', size: 'Yagona', color: 'Oq', qty: 500 }, { productId: 'P3', size: 'S', color: 'Oq', qty: 'x' },
    ] as never)}) as c`
    const items = c as any[]
    expect(items.map((i) => `${i.productId}/${i.size}/${i.qty}`).sort()).toEqual(['P1/M/5', 'P2/Yagona/99'])
  })
  it('set_cart replaces, get_cart reads, carts are per customer', async () => {
    const other = await customer(700003)
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P1', 'M', 'Qora', 1)] as never)})`
    await sql`select set_cart(${other}::uuid, ${sql.json([line('P2', 'Yagona', 'Oq', 2)] as never)})`
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P3', 'S', 'Oq', 1)] as never)})`
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c.map((i: any) => i.productId)).toEqual(['P3'])
    expect((await sql`select get_cart(${other}::uuid) as c`)[0].c.map((i: any) => i.productId)).toEqual(['P2'])
    await sql`select set_cart(${fx.customer}::uuid, '[]'::jsonb)`
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c).toEqual([])
  })
  it('a cart order empties the cart, a quick order does not', async () => {
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P1', 'M', 'Qora', 1)] as never)})`
    await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)], { source: 'quick' })
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c).toHaveLength(1)
    await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { source: 'cart' })
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c).toEqual([])
  })
  it('get_cart hides items that became unavailable', async () => {
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P1', 'M', 'Qora', 1), line('P3', 'S', 'Oq', 1)] as never)})`
    await sql`update products set active = false where id = 'P3'`
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c.map((i: any) => i.productId)).toEqual(['P1'])
  })
})

describe('my_orders', () => {
  it("returns only the caller's orders, newest first", async () => {
    const other = await customer(700004)
    const a = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    await placeOrder(sql, other, [line('P3', 'S', 'Oq', 1)])
    const b = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    const mine = (await sql`select my_orders(${fx.customer}::uuid) as o`)[0].o as any[]
    expect(mine.map((o) => o.id)).toEqual([b.order.id, a.order.id])
    expect(JSON.stringify(mine)).not.toContain(other)
  })
})

describe('admins', () => {
  it('is_admin is true only for active listed Telegram ids', async () => {
    const ask = async (id: number) => (await sql`select is_admin(${id}) as a`)[0].a
    expect(await ask(fx.adminTg)).toBe(true)
    expect(await ask(fx.customerTg)).toBe(false)
    await sql`update administrators set active = false where telegram_id = ${fx.adminTg}`
    expect(await ask(fx.adminTg)).toBe(false)
  })
  it('deactivated admins get no order alerts', async () => {
    await sql`update administrators set active = false`
    const { order } = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    expect((await sql`select kind from notification_outbox where order_id = ${order.id}`).map((r) => r.kind)).toEqual(['order_customer'])
  })
})

describe('bot outbox', () => {
  it('claims each message once, backs off on failure, gives up after 6 attempts', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    const first = await sql`select * from claim_outbox(10)`
    expect(first).toHaveLength(2)
    expect(await sql`select * from claim_outbox(10)`).toHaveLength(0) // already claimed (backoff)
    const adminMsg = first.find((m) => m.kind === 'order_admin')!
    await sql`select finish_outbox(${adminMsg.id}, true)`
    await sql`select finish_outbox(${first.find((m) => m.kind === 'order_customer')!.id}, false, 'Forbidden: bot was blocked')`
    const rows = await sql`select kind, status, last_error from notification_outbox where order_id = ${order.id} order by kind`
    expect(rows.map((r) => `${r.kind}:${r.status}`)).toEqual(['order_admin:sent', 'order_customer:pending'])
    for (let i = 0; i < 6; i++) {
      await sql`update notification_outbox set next_attempt_at = now() where kind = 'order_customer'`
      const c = await sql`select * from claim_outbox(10)`
      if (c.length) await sql`select finish_outbox(${c[0].id}, false, 'x')`
    }
    expect((await sql`select status from notification_outbox where kind = 'order_customer'`)[0].status).toBe('failed')
  })
})
