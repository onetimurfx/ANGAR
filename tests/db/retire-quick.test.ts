/**
 * Phase 6 / stage D: the old Quick Order path (place_order with source 'quick') is closed, the Cart keeps working, and
 * Quick Order (pickup_*) and the Cart (orders) stay separate. Real PostgreSQL, all migrations applied.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import type { Deps } from '../../supabase/functions/_shared/types.ts'
import { handler as placeHandler } from '../../supabase/functions/place-order/handler.ts'
import { handler as ordersHandler } from '../../supabase/functions/my-orders/handler.ts'
import { issueSession } from '../../supabase/functions/_shared/session.ts'
import { CONTACT, line, newTestDb, placeFails, placeOrder, seed, type Fixture } from './fixtures'

const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
let sql: postgres.Sql
let fx: Fixture

const deps = (): Deps => ({
  sql: sql as unknown as Deps['sql'],
  env: { SESSION_SECRET, ALLOWED_ORIGINS: 'https://shop.example' },
  now: () => Date.now(),
  log: () => undefined,
  background: () => undefined,
  fetch: (async () => new Response('{}')) as typeof fetch,
})
const token = async () => (await issueSession({ sub: fx.customer, tg: fx.customerTg }, SESSION_SECRET, Date.now())).token
const post = async (body: unknown) =>
  placeHandler(deps())(new Request('https://x.supabase.co/functions/v1/place-order', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aynimo-session': await token() }, body: JSON.stringify(body) }))
const stock = async () => Number((await sql`select quantity from inventory where variant_id = (select id from product_variants where product_id='P1' and size='M')`)[0].quantity)
const count = async (table: string) => Number((await sql.unsafe(`select count(*)::int n from ${table}`))[0].n)

beforeEach(async () => {
  if (sql) await sql.end()
  ;({ sql } = await newTestDb('rq'))
  fx = await seed(sql)
})
afterAll(async () => void (await sql?.end()))

describe("place_order: source 'quick' is closed", () => {
  it('raises QUICK_ORDER_MOVED, creates nothing, deducts nothing, keeps the cart', async () => {
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P1', 'M', 'Qora', 1)] as never)})`
    const before = await stock()
    expect((await placeFails(sql, fx.customer, [line('P1', 'M', 'Qora', 2)], { source: 'quick' })).code).toBe('QUICK_ORDER_MOVED')
    expect(await count('orders')).toBe(0)
    expect(await stock()).toBe(before)
    expect(await count('notification_outbox')).toBe(0)
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c).toHaveLength(1)
  })
  it('other unknown sources are still INVALID_REQUEST', async () => {
    expect((await placeFails(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { source: 'bogus' as never })).code).toBe('INVALID_REQUEST')
  })
  it('the Cart path still works exactly as before: order, immediate stock deduction, cart emptied, outbox', async () => {
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P1', 'M', 'Qora', 2)] as never)})`
    const r = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2)], { source: 'cart' })
    expect(r.duplicate).toBe(false)
    expect(r.order.orderNumber).toMatch(/^AYN-/)
    expect(await stock()).toBe(3)
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c).toEqual([])
    expect(await count('notification_outbox')).toBeGreaterThan(0)
    const again = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 2)], { key: r.order.idempotencyKey ?? undefined, source: 'cart' })
    expect(typeof again.duplicate).toBe('boolean')
  })
  it('a Cart order still respects stock reserved by pickup orders', async () => {
    const [{ r }] = await sql`select place_pickup_order(${fx.customer}::uuid, ${randomUUID()}::uuid, ${CONTACT.name}, ${CONTACT.phone}, null, ${sql.json([line('P1', 'M', 'Qora', 4)] as never)}) as r`
    expect((r as any).order.status).toBe('pending')
    expect((await placeFails(sql, fx.customer, [line('P1', 'M', 'Qora', 2)], { source: 'cart' })).code).toBe('ITEMS_UNAVAILABLE')
    await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { source: 'cart' })
    expect(await stock()).toBe(4)
  })
  it("orders that already carry source 'quick' stay readable (history is not rewritten)", async () => {
    // a Phase 5 order, inserted the way the old function stored it
    await sql`alter table orders disable trigger user`
    const o = randomUUID()
    await sql`insert into orders (id, order_number, customer_id, idempotency_key, source, contact_name, contact_phone, contact_address,
              subtotal, delivery_fee, delivery_pending, total) values (${o}::uuid, 'AYN-OLD-00001', ${fx.customer}::uuid, ${randomUUID()}::uuid, 'quick',
              'Ali Valiyev', '+998901234567', 'Toshkent, Chilonzor 9', 100000, null, true, 100000)`
    await sql`alter table orders enable trigger user`
    const mine = (await sql`select my_orders(${fx.customer}::uuid) as o`)[0].o as any[]
    expect(mine.map((x) => x.id)).toContain(o)
  })
})

describe('place-order Edge Function', () => {
  const body = (over: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), source: 'cart', contact: CONTACT, items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 1 }], ...over })
  it("source 'quick' -> 410 QUICK_ORDER_MOVED, nothing created", async () => {
    const r = await post(body({ source: 'quick' }))
    expect(r.status).toBe(410)
    expect(((await r.json()) as any).error.code).toBe('QUICK_ORDER_MOVED')
    expect(await count('orders')).toBe(0)
  })
  it('missing / unknown source -> 400, nothing created', async () => {
    for (const source of [undefined, 'bogus', 5, null]) {
      const r = await post(body({ source }))
      expect(r.status, String(source)).toBe(400)
    }
    expect(await count('orders')).toBe(0)
  })
  it("source 'cart' -> 201 as before", async () => {
    const r = await post(body())
    expect(r.status).toBe(201)
    expect(await count('orders')).toBe(1)
  })
})

describe('Quick Order (pickup) and Cart orders are separate', () => {
  it("a pickup order never appears in the Cart's my-orders, and a Cart order never in the pickup list", async () => {
    await sql`select place_pickup_order(${fx.customer}::uuid, ${randomUUID()}::uuid, ${CONTACT.name}, ${CONTACT.phone}, null, ${sql.json([line('P3', 'S', 'Oq', 1)] as never)})`
    await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)], { source: 'cart' })
    const cartList = (await sql`select my_orders(${fx.customer}::uuid) as o`)[0].o as any[]
    const pickupList = (await sql`select my_pickup_orders(${fx.customer}::uuid, 30) as o`)[0].o as any[]
    expect(cartList).toHaveLength(1)
    expect(cartList[0].orderNumber).toMatch(/^AYN-/)
    expect(pickupList).toHaveLength(1)
    expect(pickupList[0].orderNumber).toMatch(/^PU-/)
    const res = await ordersHandler(deps())(new Request('https://x.supabase.co/functions/v1/my-orders', { headers: { 'x-aynimo-session': await token() } }))
    expect(JSON.stringify(await res.json())).not.toContain('PU-')
  })
  it('placing a pickup order does not touch the cart; placing a cart order does not create a pickup order', async () => {
    await sql`select set_cart(${fx.customer}::uuid, ${sql.json([line('P1', 'M', 'Qora', 1)] as never)})`
    await sql`select place_pickup_order(${fx.customer}::uuid, ${randomUUID()}::uuid, ${CONTACT.name}, ${CONTACT.phone}, null, ${sql.json([line('P3', 'S', 'Oq', 1)] as never)})`
    expect((await sql`select get_cart(${fx.customer}::uuid) as c`)[0].c).toHaveLength(1)
    expect(await count('orders')).toBe(0)
    await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)], { source: 'cart' })
    expect(await count('pickup_orders')).toBe(1)
  })
  it('pickup needs no address column; the pickup tables hold no delivery data', async () => {
    const cols = (await sql`select column_name from information_schema.columns where table_name in ('pickup_orders','pickup_order_items')`).map((c) => c.column_name as string)
    expect(cols.filter((c) => /address|delivery|courier|shipping/i.test(c))).toEqual([])
  })
})
