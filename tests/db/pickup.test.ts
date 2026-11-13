/**
 * Phase 6 / stage A: store-pickup schema, reservations, payment rules, privileges, upgrade and rollback safety.
 * Everything runs against a REAL PostgreSQL with the real migrations.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inject } from 'vitest'
import { asRole, url } from './pg'
import { line, newTestDb, placeOrder, seed, type Fixture } from './fixtures'

type Sql = postgres.Sql
const MIG = resolve('supabase/migrations')
const migrations = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
const PHASE5 = migrations.filter((f) => f.startsWith('20261106'))
const PHASE6 = migrations.filter((f) => f.startsWith('20261109'))

const place = async (sql: Sql, customer: string, items: unknown, o: { key?: string; name?: string; phone?: string; comment?: string | null } = {}) => {
  const [r] = await sql`select place_pickup_order(${customer}::uuid, ${o.key ?? randomUUID()}::uuid, ${o.name ?? 'Ali Valiyev'},
    ${o.phone ?? '+998 90 123 45 67'}, ${o.comment ?? null}, ${sql.json(items as never)}) as r`
  return r.r as { duplicate: boolean; order: Record<string, any> }
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
const call = async (sql: Sql, fn: string, ...args: unknown[]) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const [r] = await sql.unsafe(`select ${fn}(${ph}) as r`, args as never[])
  return r.r as any
}
const mkCustomer = async (sql: Sql) => (await sql`select upsert_customer(${700000 + Math.floor(Math.random() * 1e8)}, 'Test', null, null, null, 'uz') as id`)[0].id as string
const rows = async (sql: Sql, q: string, ...a: unknown[]) => (await sql.unsafe(q, a as never[])) as any[]

/** Things that must hold after ANY sequence of operations. */
async function invariants(sql: Sql) {
  expect(await rows(sql, `select i.variant_id, i.quantity, (select array_agg(r.order_id::text || ':' || r.qty || ':' || r.status) from stock_reservations r where r.variant_id = i.variant_id and r.status = 'active') as res
    from inventory i where (select coalesce(sum(qty),0) from stock_reservations r
    where r.variant_id = i.variant_id and r.status = 'active') > i.quantity`), 'reserved more than exists').toEqual([])
  expect(await rows(sql, `select o.id from pickup_orders o where (o.status in ('pending','preparing','ready_for_pickup'))
    <> exists (select 1 from stock_reservations r where r.order_id = o.id and r.status = 'active')`), 'active reservation <=> active order').toEqual([])
  expect(await rows(sql, `select o.id from pickup_orders o join stock_reservations r on r.order_id = o.id
    where (o.status = 'completed' and r.status <> 'consumed') or (o.status in ('cancelled','expired') and r.status <> 'released')`), 'closed orders settle reservations').toEqual([])
  expect(await rows(sql, `select id from pickup_orders where status = 'completed' and (payment_status <> 'paid' or paid_at is null)`)).toEqual([])
}

let sql: Sql
let fx: Fixture
let MGR: number
const OWNER = 900001
const NOBODY = 123456
const INACTIVE_ADMIN = 900003
const code8 = /^[A-HJ-NP-Z2-9]{8}$/

beforeAll(async () => {
  ;({ sql } = await newTestDb('pickup'))
  fx = await seed(sql)
  MGR = 900002
  await sql`insert into administrators (telegram_id, name, role) values (${MGR}, 'Manager', 'manager')`
  await sql`insert into administrators (telegram_id, name, role, active) values (${INACTIVE_ADMIN}, 'Gone', 'manager', false)`
  // P3 is the "plenty of stock" product for tests that are not about stock (the stock tests use P1 / P2 explicitly)
  await sql`update inventory set quantity = 500 where variant_id = (select id from product_variants where product_id = 'P3')`
})
afterAll(async () => {
  await invariants(sql)
  await sql.end()
})

const variantId = async (pid: string, size: string, color: string) =>
  (await sql`select id from product_variants where product_id = ${pid} and size = ${size} and color_name = ${color}`)[0].id as string
const qty = async (pid: string, size: string, color: string) =>
  (await sql`select quantity from inventory where variant_id = ${await variantId(pid, size, color)}`)[0].quantity as number
const avail = async (pid: string, size: string, color: string) =>
  (await sql`select available_qty(${await variantId(pid, size, color)}::uuid) as a`)[0].a as number
const setStock = async (pid: string, size: string, color: string, n: number) =>
  sql`update inventory set quantity = ${n} where variant_id = ${await variantId(pid, size, color)}`

/** order that is already `preparing` / `ready_for_pickup`, for a fresh customer */
async function orderAt(stage: 'pending' | 'preparing' | 'ready', items = [line('P3', 'S', 'Oq', 1)]) {
  const c = await mkCustomer(sql)
  const { order } = await place(sql, c, items)
  if (stage !== 'pending') await call(sql, 'admin_start_preparing', OWNER, order.id)
  if (stage === 'ready') await call(sql, 'admin_mark_ready', OWNER, order.id)
  const code = (await rows(sql, `select pickup_code from pickup_orders where id = $1`, order.id))[0].pickup_code as string | null
  return { id: order.id as string, customer: c, code, total: Number(order.total) }
}

describe('pre-flight 1: migrations never delete existing data', () => {
  it('the Phase 6 migrations contain no destructive statement', () => {
    for (const f of PHASE6) {
      // only statements that run when the migration is applied: function bodies ($$ ... $$) run later, per request
      const text = readFileSync(resolve(MIG, f), 'utf8').replace(/--.*$/gm, '').replace(/\$\$[\s\S]*?\$\$/g, '$$$$')
      expect(text, f).not.toMatch(/\bdrop\s+(table|column|schema|type|sequence)\b/i)
      expect(text, f).not.toMatch(/\btruncate\b/i)
      expect(text, f).not.toMatch(/\bdelete\s+from\b/i)
      expect(text, f).not.toMatch(/\balter\s+table\s+\S+\s+(drop|alter\s+column)/i)
      expect(text, f).not.toMatch(/\bupdate\s+public\.(orders|order_items|inventory|cart_items|customers|products|product_variants)\b/i)
    }
  })

  it('upgrading a Phase 5 database with real data keeps every row byte-for-byte (pre-flight 2 too)', async () => {
    const port = inject('pgPort')
    const admin = postgres(url(port, 'postgres'), { max: 1, onnotice: () => {} })
    const name = `upg_${process.pid}_${Date.now()}`
    await admin.unsafe(`create database ${name}`)
    await admin.end()
    const up = postgres(url(port, name), { max: 4, onnotice: () => {} })
    try {
      for (const f of PHASE5) await up.unsafe(readFileSync(resolve(MIG, f), 'utf8'))
      const f2 = await seed(up)
      const o1 = await placeOrder(up, f2.customer, [line('P1', 'M', 'Qora', 2), line('P3', 'S', 'Oq', 1)], { source: 'cart' })
      await up`select set_cart(${f2.customer}::uuid, ${up.json([line('P2', 'Yagona', 'Oq', 1)] as never)})`
      const tables = ['orders', 'order_items', 'order_status_history', 'inventory', 'cart_items', 'customers', 'products', 'product_variants', 'administrators', 'settings', 'notification_outbox', 'brands', 'categories']
      const snap = async () => {
        const out: Record<string, string> = {}
        for (const t of tables) out[t] = (await up.unsafe(`select count(*) || ':' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as s from public.${t} x`))[0].s
        return out
      }
      const before = await snap()
      const stockBefore = (await up`select quantity from inventory order by variant_id`).map((r) => r.quantity)
      for (const f of PHASE6) await up.unsafe(readFileSync(resolve(MIG, f), 'utf8'))
      expect(await snap()).toEqual(before)
      expect((await up`select quantity from inventory order by variant_id`).map((r) => r.quantity)).toEqual(stockBefore)
      // old orders still readable, catalog quantities identical to inventory (no reservations yet)
      expect((await up`select my_orders(${f2.customer}::uuid) as r`)[0].r[0].orderNumber).toBe(o1.order.orderNumber)
      const cat = (await up`select get_catalog() as c`)[0].c
      const p1 = cat.products.find((p: any) => p.id === 'P1')
      expect(p1.variants.find((v: any) => v.size === 'M').qty).toBe(3)
      // the Cart still deducts stock immediately
      await placeOrder(up, f2.customer, [line('P1', 'M', 'Qora', 1)], { source: 'cart' })
      expect((await up`select quantity from inventory where variant_id = (select id from product_variants where product_id='P1' and size='M')`)[0].quantity).toBe(2)
    } finally {
      await up.end()
    }
  })
})

describe('pre-flight 3: payment and completion rules live in the database', () => {
  const base = async () => (await orderAt('ready')).id
  const reject = async (q: string, id: string, re: RegExp) => {
    const e = await fails(() => sql.unsafe(q, [id] as never[]))
    expect(`${e.code}`).toMatch(re)
  }

  it('cannot complete an order without payment (even with a direct UPDATE)', async () => {
    const id = await base()
    await reject(`update pickup_orders set status = 'completed', completed_at = now() where id = $1`, id, /pickup_completed_requires_payment|violates check/)
    await reject(`update pickup_orders set status = 'completed', completed_at = now(), payment_status = 'unpaid' where id = $1`, id, /violates check/)
    await reject(`update pickup_orders set status = 'completed', completed_at = now(), payment_status = 'paid' where id = $1`, id, /violates check/) // no paid_at
  })
  it("'refunded' is not usable and does not satisfy completed", async () => {
    const id = await base()
    await reject(`update pickup_orders set status = 'completed', completed_at = now(), payment_status = 'refunded', paid_at = now() where id = $1`, id, /violates check/)
    await reject(`update pickup_orders set payment_status = 'refunded', paid_at = now() where id = $1`, id, /violates check/)
  })
  it("'paid' only exists on a completed order, and paid_at only with paid", async () => {
    const id = await base()
    await reject(`update pickup_orders set payment_status = 'paid', paid_at = now() where id = $1`, id, /violates check/)
    await reject(`update pickup_orders set paid_at = now() where id = $1`, id, /violates check/)
  })
  it('status, code and closing fields must agree', async () => {
    const p = await orderAt('pending')
    await reject(`update pickup_orders set pickup_code = 'ABCDEFGH' where id = $1`, p.id, /violates check/) // no code before ready
    const r = await base()
    await reject(`update pickup_orders set pickup_code = 'ABCDEF0O' where id = $1`, r, /violates check/) // forbidden symbols
    await reject(`update pickup_orders set pickup_code = null where id = $1`, r, /violates check/) // ready needs a code
    await reject(`update pickup_orders set status = 'cancelled' where id = $1`, r, /violates check/) // needs reason + time
    await reject(`update pickup_orders set status = 'cancelled', closed_reason = 'admin_cancelled', closed_at = now() where id = $1`, r, /violates check/) // admin cancel needs a note
    await reject(`update pickup_orders set status = 'expired', closed_reason = 'customer_cancelled', closed_at = now() where id = $1`, r, /violates check/)
  })
  it('a settled reservation cannot keep an expiry; payment history needs an amount and an admin', async () => {
    const r = await orderAt('pending')
    await reject(`update stock_reservations set status = 'released', settled_at = now(), expires_at = now() where order_id = $1`, r.id, /violates check/)
    await reject(`insert into pickup_status_history (order_id, kind, status, actor_role, actor_telegram_id) values ($1, 'payment', 'completed', 'admin', 1)`, r.id, /violates check/)
    await reject(`insert into pickup_status_history (order_id, kind, status, actor_role, amount, payment_method) values ($1, 'payment', 'completed', 'system', 5, 'pay_at_store')`, r.id, /violates check/)
  })
  it('the pickup code is unique', async () => {
    const a = await orderAt('ready')
    const b = await orderAt('preparing')
    await reject(`update pickup_orders set pickup_code = '${a.code}', status = 'ready_for_pickup', ready_at = now(), ready_expires_at = now() + interval '1 day' where id = $1`, b.id, /unique|duplicate/)
  })
})

describe('pre-flight 4: EXECUTE and table privileges', () => {
  const PUBLIC_FUNCTIONS = ['get_catalog', 'available_qty']
  it('only the allow-listed functions are callable by anon / authenticated; every other function is service_role only', async () => {
    const fns = await rows(sql, `select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'`)
    expect(fns.length).toBeGreaterThan(30)
    for (const f of fns) {
      for (const role of ['anon', 'authenticated']) {
        const can = (await rows(sql, `select has_function_privilege('${role}', ${f.oid}::oid, 'EXECUTE') as ok`))[0].ok
        expect(can, `${role} must ${PUBLIC_FUNCTIONS.includes(f.proname) ? '' : 'NOT '}execute ${f.proname}(${f.args})`).toBe(PUBLIC_FUNCTIONS.includes(f.proname))
      }
      expect((await rows(sql, `select has_function_privilege('service_role', ${f.oid}::oid, 'EXECUTE') as ok`))[0].ok, f.proname).toBe(true)
    }
    const names = fns.map((f) => f.proname)
    for (const n of ['place_pickup_order', 'admin_complete_pickup', 'admin_start_preparing', 'admin_mark_ready', 'admin_cancel_pickup', 'admin_list_pickup', 'admin_get_pickup', 'sweep_pickup', 'cancel_pickup_order_customer', 'my_pickup_orders', 'get_pickup_order', 'claim_pickup_outbox', 'finish_pickup_outbox', 'reserved_qty', 'generate_pickup_code', 'pickup_require_admin'])
      expect(names, n).toContain(n)
  })
  it('the browser roles really get "permission denied" when they call them', async () => {
    const o = await orderAt('ready')
    for (const role of ['anon', 'authenticated'] as const) {
      for (const q of [
        (tx: Sql) => tx`select admin_complete_pickup(${OWNER}::bigint, ${o.id}::uuid, ${o.code}, true, ${o.total}::bigint)`,
        (tx: Sql) => tx`select admin_list_pickup(${OWNER}::bigint)`,
        (tx: Sql) => tx`select place_pickup_order(${fx.customer}::uuid, ${randomUUID()}::uuid, 'Ali', '+998901234567', null, '[]'::jsonb)`,
        (tx: Sql) => tx`select sweep_pickup()`,
        (tx: Sql) => tx`select reserved_qty(${randomUUID()}::uuid)`,
      ]) {
        const e = await asRole(sql, role, async (tx) => fails(() => q(tx)))
        expect(e.code, role).toMatch(/permission denied/)
      }
      const ok = await asRole(sql, role, async (tx) => (await tx`select available_qty(${await variantId('P1', 'M', 'Qora')}::uuid) as a`)[0].a)
      expect(typeof ok).toBe('number')
    }
  })
  it('RLS is on for every new table and the browser cannot read any of them', async () => {
    const tbls = ['pickup_settings', 'pickup_orders', 'pickup_order_items', 'stock_reservations', 'pickup_status_history', 'pickup_code_attempts', 'pickup_outbox', 'job_heartbeats']
    for (const t of tbls) {
      expect((await rows(sql, `select relrowsecurity as r from pg_class where oid = 'public.${t}'::regclass`))[0].r, t).toBe(true)
      expect(await rows(sql, `select 1 from pg_policies where schemaname='public' and tablename = '${t}'`), `${t} has no policies`).toEqual([])
      for (const role of ['anon', 'authenticated'] as const) {
        for (const stmt of [`select * from public.${t}`, `delete from public.${t}`]) {
          const e = await asRole(sql, role, async (tx) => fails(() => tx.unsafe(stmt)))
          expect(e.code, `${role}: ${stmt}`).toMatch(/permission denied/)
        }
      }
    }
  })
  it('service_role can reach the new tables', async () => {
    const n = await asRole(sql, 'service_role', async (tx) => (await tx`select count(*)::int as n from pickup_orders`)[0].n)
    expect(n).toBeGreaterThan(0)
  })
})

describe('placing a pickup order and the reservation', () => {
  it('reserves stock without touching inventory, no address, no delivery, unpaid', async () => {
    const c = await mkCustomer(sql)
    const before = { phys: await qty('P1', 'M', 'Qora'), av: await avail('P1', 'M', 'Qora') }
    const { duplicate, order } = await place(sql, c, [line('P1', 'M', 'Qora', 2)], { comment: 'Kechqurun' })
    expect(duplicate).toBe(false)
    expect(order.orderNumber).toMatch(/^PU-\d{6}-\d{5}$/)
    expect(order).toMatchObject({ status: 'pending', subtotal: 200000, total: 200000, payment: { status: 'unpaid', method: 'pay_at_store', paidAt: null }, pickupCode: null })
    expect(JSON.stringify(order)).not.toMatch(/address|delivery/i)
    expect(order.contact).toEqual({ name: 'Ali Valiyev', phone: '+998901234567', comment: 'Kechqurun' })
    expect(await qty('P1', 'M', 'Qora')).toBe(before.phys) // physical stock unchanged
    expect(await avail('P1', 'M', 'Qora')).toBe(before.av - 2)
    const res = await rows(sql, `select r.status, r.qty, extract(epoch from (r.expires_at - now())) as secs from stock_reservations r where order_id = $1`, order.id)
    expect(res).toHaveLength(1)
    expect(res[0].status).toBe('active')
    expect(Number(res[0].secs)).toBeGreaterThan(29 * 60)
    expect(Number(res[0].secs)).toBeLessThanOrEqual(30 * 60)
    const hist = await rows(sql, `select kind, status, actor_role from pickup_status_history where order_id = $1`, order.id)
    expect(hist).toEqual([{ kind: 'status', status: 'pending', actor_role: 'customer' }])
    await call(sql, 'admin_cancel_pickup', OWNER, order.id, 'sinov tugadi')
    await invariants(sql)
  })

  it('shows reduced availability to the browser (get_catalog) without exposing reservations', async () => {
    const o = await orderAt('pending', [line('P2', 'Yagona', 'Oq', 2)])
    const q = await asRole(sql, 'anon', async (tx) => {
      const cat = (await tx`select get_catalog() as c`)[0].c
      return cat.products.find((p: any) => p.id === 'P2').variants[0].qty
    })
    expect(q).toBe(1)
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(3)
  })

  it('bot messages go to pickup_outbox only; the Cart outbox is untouched', async () => {
    const cartBefore = (await sql`select count(*)::int n from notification_outbox`)[0].n
    const o = await orderAt('pending')
    const rowsOut = await rows(sql, `select kind, event, chat_id::text from pickup_outbox where pickup_order_id = $1 order by kind, chat_id`, o.id)
    // active admins (owner + manager) are told; the deactivated admin and everybody else are not
    expect(rowsOut.filter((r) => r.kind === 'pickup_admin').map((r) => r.chat_id)).toEqual([String(OWNER), String(MGR)])
    expect(rowsOut.filter((r) => r.kind === 'pickup_customer')).toHaveLength(1)
    expect(rowsOut.every((r) => r.event === 'new')).toBe(true)
    expect((await sql`select count(*)::int n from notification_outbox`)[0].n).toBe(cartBefore)
    // the existing worker's queue never sees pickup rows, and the pickup worker's queue returns only pickup rows
    expect((await sql`select count(*)::int n from claim_outbox(100)`)[0].n).toBe(0)
    const claimed = await rows(sql, `select kind from claim_pickup_outbox(100)`)
    expect(claimed.length).toBeGreaterThan(0)
    expect(claimed.every((r) => r.kind.startsWith('pickup_'))).toBe(true)
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })

  it('a retry with the same key returns the same order (10 parallel taps -> 1 order, 1 reservation set)', async () => {
    const c = await mkCustomer(sql)
    const key = randomUUID()
    const out = await Promise.all(Array.from({ length: 10 }, () => place(sql, c, [line('P3', 'S', 'Oq', 1)], { key })))
    expect(new Set(out.map((r) => r.order.id)).size).toBe(1)
    expect(out.filter((r) => !r.duplicate)).toHaveLength(1)
    expect((await rows(sql, `select count(*)::int n from stock_reservations where order_id = $1`, out[0].order.id))[0].n).toBe(1)
    await call(sql, 'admin_cancel_pickup', OWNER, out[0].order.id, 'sinov tugadi')
  })

  it('never oversells: 8 customers fight for 3 pieces -> exactly 3 win', async () => {
    await setStock('P2', 'Yagona', 'Oq', 3)
    const cs = await Promise.all(Array.from({ length: 8 }, () => mkCustomer(sql)))
    const res = await Promise.allSettled(cs.map((c) => place(sql, c, [line('P2', 'Yagona', 'Oq', 1)])))
    const won = res.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[]
    expect(won).toHaveLength(3)
    for (const r of res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]) expect(r.reason.message).toBe('ITEMS_UNAVAILABLE')
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(0)
    await invariants(sql)
    for (const w of won) await call(sql, 'admin_cancel_pickup', OWNER, w.value.order.id, 'sinov tugadi')
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(3)
  })

  it('Cart and Quick Order share ONE stock: 3 pickup + 3 cart orders for 3 pieces -> exactly 3 succeed in total', async () => {
    await setStock('P2', 'Yagona', 'Oq', 3)
    const cs = await Promise.all(Array.from({ length: 6 }, () => mkCustomer(sql)))
    const jobs = cs.map((c, i) =>
      i < 3
        ? place(sql, c, [line('P2', 'Yagona', 'Oq', 1)]).then((r) => ({ kind: 'pickup' as const, id: r.order.id as string }))
        : placeOrder(sql, c, [line('P2', 'Yagona', 'Oq', 1)], { source: 'cart' }).then(() => ({ kind: 'cart' as const, id: '' })),
    )
    const res = await Promise.allSettled(jobs)
    const ok = res.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ kind: string; id: string }>[]
    expect(ok).toHaveLength(3)
    const pickups = ok.filter((r) => r.value.kind === 'pickup').length
    const carts = ok.length - pickups
    expect(await qty('P2', 'Yagona', 'Oq')).toBe(3 - carts) // the Cart deducts immediately
    expect((await rows(sql, `select coalesce(sum(qty),0)::int s from stock_reservations where status='active' and variant_id = $1`, await variantId('P2', 'Yagona', 'Oq')))[0].s).toBe(pickups)
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(0)
    await invariants(sql)
    for (const r of ok.filter((r) => r.value.kind === 'pickup')) await call(sql, 'admin_cancel_pickup', OWNER, r.value.id, 'sinov tugadi')
    await setStock('P2', 'Yagona', 'Oq', 3)
  })

  it('the Cart respects pickup reservations', async () => {
    const a = await orderAt('pending', [line('P1', 'L', 'Qora', 2)]) // reserves both L pieces
    const c = await mkCustomer(sql)
    const e = await fails(() => placeOrder(sql, c, [line('P1', 'L', 'Qora', 1)], { source: 'cart' }))
    expect(e.code).toBe('ITEMS_UNAVAILABLE')
    expect(e.detail.issues[0]).toMatchObject({ reason: 'stock', requested: 1, available: 0 })
    await call(sql, 'admin_cancel_pickup', OWNER, a.id, 'sinov tugadi')
    await placeOrder(sql, c, [line('P1', 'L', 'Qora', 1)], { source: 'cart' }) // free again
    await setStock('P1', 'L', 'Qora', 2)
  })

  it('limits: 3 active orders per customer (also under parallel taps) and 10 lines per order', async () => {
    const c = await mkCustomer(sql)
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => place(sql, c, [line('P3', 'S', 'Oq', 1)])))
    const won = settled.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[]
    expect(won).toHaveLength(3)
    for (const r of settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]) expect(r.reason.message).toBe('ACTIVE_LIMIT')
    const e = await fails(() => place(sql, c, [line('P3', 'S', 'Oq', 1)]))
    expect(e).toEqual({ code: 'ACTIVE_LIMIT', detail: { max: 3 } })
    await call(sql, 'admin_cancel_pickup', OWNER, won[0].value.order.id, 'sinov tugadi') // a closed order frees a slot
    await place(sql, c, [line('P3', 'S', 'Oq', 1)])
    for (const r of await rows(sql, `select id from pickup_orders where customer_id = $1 and status = 'pending'`, c)) await call(sql, 'admin_cancel_pickup', OWNER, r.id, 'sinov tugadi')

    const d = await mkCustomer(sql)
    await sql`update pickup_settings set max_lines = 2`
    expect(await fails(() => place(sql, d, [line('P1', 'M', 'Qora', 1), line('P1', 'L', 'Qora', 1), line('P3', 'S', 'Oq', 1)]))).toEqual({ code: 'TOO_MANY_LINES', detail: { max: 2 } })
    await sql`update pickup_settings set max_lines = 10`
    expect(await rows(sql, `select pending_timeout_minutes, ready_hold_hours, max_active_per_customer, max_lines from pickup_settings`)).toEqual([{ pending_timeout_minutes: 30, ready_hold_hours: 24, max_active_per_customer: 3, max_lines: 10 }])
  })

  it('validates contact and items; refuses sample, inactive and unknown variants; nothing is written on failure', async () => {
    const c = await mkCustomer(sql)
    const before = (await sql`select count(*)::int n from pickup_orders`)[0].n
    expect((await fails(() => place(sql, c, [line('P3', 'S', 'Oq', 1)], { name: 'X', phone: '123' }))).detail.fields.sort()).toEqual(['name', 'phone'])
    expect((await fails(() => place(sql, c, [], {}))).code).toBe('EMPTY_ORDER')
    for (const bad of [[{ productId: 'P3', size: 'S', color: 'Oq' }], [{ productId: 'P3', size: 'S', color: 'Oq', qty: 0 }], [{ productId: 'P3', size: 'S', color: 'Oq', qty: '1' }], [null]])
      expect((await fails(() => place(sql, c, bad))).code).toBe('INVALID_ITEM')
    expect((await fails(() => place(sql, c, 'x'))).code).toBe('EMPTY_ORDER') // not an array: same as the Cart
    expect((await fails(() => place(sql, c, [line('P3', 'S', 'Oq', 60), line('P3', 'S', 'Oq', 60)]))).code).toBe('INVALID_ITEM') // merged > 99
    expect((await fails(() => place(sql, c, [line('SAMPLE', 'M', 'Qora', 1)]))).code).toBe('SAMPLE_PRODUCT')
    expect((await fails(() => place(sql, c, [line('INACTIVE', 'M', 'Qora', 1)]))).detail.issues[0].reason).toBe('unavailable')
    expect((await fails(() => place(sql, c, [line('P1', 'XL', 'Qora', 1)]))).detail.issues[0].reason).toBe('unavailable')
    expect((await fails(() => place(sql, c, [line('NOPE', 'M', 'Qora', 1)]))).detail.issues[0].reason).toBe('unavailable')
    expect((await fails(() => place(sql, c, [line('P1', 'M', 'Qora', 99)]))).detail.issues[0]).toMatchObject({ reason: 'stock', available: 5 })
    expect((await fails(() => place(sql, randomUUID(), [line('P3', 'S', 'Oq', 1)]))).code).toBe('UNKNOWN_CUSTOMER')
    expect((await sql`select count(*)::int n from pickup_orders`)[0].n).toBe(before)
  })
})

describe('customer: read and cancel; isolation between customers', () => {
  it('a customer sees only their own orders; another customer\'s id is just NOT_FOUND', async () => {
    const a = await orderAt('pending')
    const other = await mkCustomer(sql)
    expect((await call(sql, 'my_pickup_orders', other, 30))).toEqual([])
    expect((await call(sql, 'my_pickup_orders', a.customer, 30)).map((o: any) => o.id)).toEqual([a.id])
    expect(await fails(() => call(sql, 'get_pickup_order', other, a.id))).toEqual({ code: 'NOT_FOUND', detail: undefined })
    expect(await fails(() => call(sql, 'get_pickup_order', other, randomUUID()))).toEqual({ code: 'NOT_FOUND', detail: undefined })
    expect((await fails(() => call(sql, 'cancel_pickup_order_customer', other, a.id))).code).toBe('NOT_FOUND')
    expect((await rows(sql, `select status from pickup_orders where id = $1`, a.id))[0].status).toBe('pending') // untouched
    await call(sql, 'admin_cancel_pickup', OWNER, a.id, 'sinov tugadi')
  })

  it('the customer can cancel only while pending; reservation is released; a repeated tap is harmless', async () => {
    const a = await orderAt('pending', [line('P2', 'Yagona', 'Oq', 2)])
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(1)
    const c1 = await call(sql, 'cancel_pickup_order_customer', a.customer, a.id)
    expect(c1).toMatchObject({ status: 'cancelled', closedReason: 'customer_cancelled' })
    expect(await call(sql, 'cancel_pickup_order_customer', a.customer, a.id)).toMatchObject({ status: 'cancelled' })
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(3)
    expect((await rows(sql, `select count(*)::int n from pickup_status_history where order_id = $1 and status = 'cancelled'`, a.id))[0].n).toBe(1)
    const b = await orderAt('preparing')
    expect(await fails(() => call(sql, 'cancel_pickup_order_customer', b.customer, b.id))).toEqual({ code: 'NOT_CANCELLABLE', detail: { status: 'preparing' } })
    const r = await orderAt('ready')
    expect((await fails(() => call(sql, 'cancel_pickup_order_customer', r.customer, r.id))).code).toBe('NOT_CANCELLABLE')
    await call(sql, 'admin_cancel_pickup', OWNER, b.id, 'sinov tugadi')
    await call(sql, 'admin_cancel_pickup', OWNER, r.id, 'sinov tugadi')
  })
})

describe('admin authorization is checked by the database on every call', () => {
  it('an id that is not an active admin is FORBIDDEN everywhere (unknown, deactivated, negative, zero)', async () => {
    const o = await orderAt('ready')
    for (const tg of [NOBODY, INACTIVE_ADMIN, fx.customerTg, 0, -1]) {
      for (const [fn, args] of [
        ['admin_list_pickup', [tg]], ['admin_get_pickup', [tg, o.id]], ['admin_start_preparing', [tg, o.id]],
        ['admin_mark_ready', [tg, o.id]], ['admin_cancel_pickup', [tg, o.id, 'sabab bor']],
        ['admin_complete_pickup', [tg, o.id, o.code, true, o.total]],
      ] as [string, unknown[]][]) {
        expect((await fails(() => call(sql, fn, ...args))).code, `${fn} tg=${tg}`).toBe('FORBIDDEN')
      }
    }
    expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('ready_for_pickup')
    expect((await rows(sql, `select count(*)::int n from pickup_code_attempts where admin_telegram_id = any($1)`, [NOBODY, INACTIVE_ADMIN]))[0].n).toBe(0)
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })
  it('owner and manager may run orders; only an owner passes the owner-only check', async () => {
    const o = await orderAt('pending')
    expect(await call(sql, 'admin_start_preparing', MGR, o.id)).toMatchObject({ status: 'preparing' })
    await expect(sql`select pickup_require_admin(${MGR}::bigint, true)`).rejects.toThrow('FORBIDDEN')
    await expect(sql`select pickup_require_admin(${OWNER}::bigint, true)`).resolves.toBeTruthy()
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })
  it('a deactivated admin loses access immediately', async () => {
    await sql`insert into administrators (telegram_id, name, role) values (900010, 'Temp', 'manager')`
    expect(await call(sql, 'admin_list_pickup', 900010)).toHaveProperty('orders')
    await sql`update administrators set active = false where telegram_id = 900010`
    expect((await fails(() => call(sql, 'admin_list_pickup', 900010))).code).toBe('FORBIDDEN')
  })
})

describe('transitions and reservation expiry', () => {
  it('pending -> preparing (expiry cleared) -> ready (24h, code) with the code visible to the customer only', async () => {
    const p = await orderAt('pending')
    expect((await rows(sql, `select expires_at from stock_reservations where order_id = $1`, p.id))[0].expires_at).not.toBeNull()
    const prep = await call(sql, 'admin_start_preparing', OWNER, p.id)
    expect(prep.status).toBe('preparing')
    expect((await rows(sql, `select expires_at, status from stock_reservations where order_id = $1`, p.id))[0]).toEqual({ expires_at: null, status: 'active' })
    expect(prep.pendingExpiresAt).toBeNull()
    const ready = await call(sql, 'admin_mark_ready', OWNER, p.id)
    expect(ready.status).toBe('ready_for_pickup')
    expect(ready.pickupCode).toBeNull() // admin view never carries the code
    const code = (await rows(sql, `select pickup_code from pickup_orders where id = $1`, p.id))[0].pickup_code
    expect(code).toMatch(code8)
    const mine = await call(sql, 'get_pickup_order', p.customer, p.id)
    expect(mine.pickupCode).toBe(code)
    const list = await call(sql, 'admin_list_pickup', OWNER, 'ready', 100)
    expect(JSON.stringify(list)).not.toContain(code)
    const res = (await rows(sql, `select extract(epoch from (r.expires_at - now())) as secs from stock_reservations r where order_id = $1`, p.id))[0]
    expect(Number(res.secs)).toBeGreaterThan(23.9 * 3600)
    expect(Number(res.secs)).toBeLessThanOrEqual(24 * 3600)
    expect(Number((await rows(sql, `select extract(epoch from (ready_expires_at - now())) as s from pickup_orders where id = $1`, p.id))[0].s)).toBeGreaterThan(23.9 * 3600)
    await invariants(sql)
    await call(sql, 'admin_cancel_pickup', OWNER, p.id, 'sinov tugadi')
  })

  it('the code is hidden from the customer once the order is no longer ready', async () => {
    const r = await orderAt('ready')
    await call(sql, 'admin_cancel_pickup', OWNER, r.id, 'mahsulot topilmadi')
    const mine = await call(sql, 'get_pickup_order', r.customer, r.id)
    expect(mine).toMatchObject({ status: 'cancelled', pickupCode: null, closeNote: 'mahsulot topilmadi', closedReason: 'admin_cancelled' })
  })

  it('only the allowed order of transitions works', async () => {
    const p = await orderAt('pending')
    expect(await fails(() => call(sql, 'admin_mark_ready', OWNER, p.id))).toEqual({ code: 'INVALID_TRANSITION', detail: { status: 'pending' } })
    await call(sql, 'admin_start_preparing', OWNER, p.id)
    expect((await fails(() => call(sql, 'admin_start_preparing', OWNER, p.id))).code).toBe('INVALID_TRANSITION')
    await call(sql, 'admin_mark_ready', OWNER, p.id)
    expect((await fails(() => call(sql, 'admin_mark_ready', OWNER, p.id))).code).toBe('INVALID_TRANSITION')
    expect((await fails(() => call(sql, 'admin_start_preparing', OWNER, randomUUID()))).code).toBe('NOT_FOUND')
    await call(sql, 'admin_cancel_pickup', OWNER, p.id, 'sinov tugadi')
    for (const fn of ['admin_start_preparing', 'admin_mark_ready']) expect((await fails(() => call(sql, fn, OWNER, p.id))).code).toBe('INVALID_TRANSITION')
  })

  it('admin cancel needs a reason and works until completed; reservations return', async () => {
    for (const stage of ['pending', 'preparing', 'ready'] as const) {
      const o = await orderAt(stage, [line('P2', 'Yagona', 'Oq', 1)])
      expect(await avail('P2', 'Yagona', 'Oq')).toBe(2)
      for (const bad of ['', '  ', 'ab', null]) expect((await fails(() => call(sql, 'admin_cancel_pickup', OWNER, o.id, bad))).code).toBe('INVALID_REASON')
      expect(await call(sql, 'admin_cancel_pickup', OWNER, o.id, '  mijoz kelmadi  ')).toMatchObject({ status: 'cancelled', closeNote: 'mijoz kelmadi' })
      expect(await avail('P2', 'Yagona', 'Oq')).toBe(3)
      expect((await fails(() => call(sql, 'admin_cancel_pickup', OWNER, o.id, 'yana'))).code).toBe('NOT_CANCELLABLE')
      const h = await rows(sql, `select actor_role, actor_telegram_id, note from pickup_status_history where order_id = $1 and status = 'cancelled'`, o.id)
      expect(h).toEqual([{ actor_role: 'admin', actor_telegram_id: String(OWNER), note: 'mijoz kelmadi' }])
    }
    await invariants(sql)
  })

  it('a pending order past its deadline frees its stock by itself, cannot be accepted, and the sweeper closes it', async () => {
    const o = await orderAt('pending', [line('P2', 'Yagona', 'Oq', 3)])
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(0)
    await sql`update pickup_orders set pending_expires_at = now() - interval '1 minute' where id = ${o.id}`
    await sql`update stock_reservations set expires_at = now() - interval '1 minute' where order_id = ${o.id}`
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(3) // cron not needed for stock to be free again
    expect((await fails(() => call(sql, 'admin_start_preparing', OWNER, o.id))).code).toBe('EXPIRED')
    expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('pending')
    const out = await call(sql, 'sweep_pickup')
    expect(out.expiredPending).toBeGreaterThanOrEqual(1)
    expect(await rows(sql, `select status, closed_reason from pickup_orders where id = $1`, o.id)).toEqual([{ status: 'expired', closed_reason: 'pending_timeout' }])
    expect((await rows(sql, `select status from stock_reservations where order_id = $1`, o.id))[0].status).toBe('released')
    expect(await rows(sql, `select actor_role, status from pickup_status_history where order_id = $1 order by id`, o.id)).toEqual([
      { actor_role: 'customer', status: 'pending' }, { actor_role: 'system', status: 'expired' }])
    expect((await rows(sql, `select event from pickup_outbox where pickup_order_id = $1 and kind = 'pickup_customer' order by id`, o.id)).map((r) => r.event)).toEqual(['new', 'expired'])
    const hb = (await rows(sql, `select last_ok_at, last_result from job_heartbeats where job_name = 'pickup-sweep'`))[0]
    expect(hb.last_ok_at).not.toBeNull()
    expect(hb.last_result.expiredPending).toBeGreaterThanOrEqual(1)
    expect(await call(sql, 'sweep_pickup')).toEqual({ expiredPending: 0, expiredReady: 0 }) // idempotent
    expect((await call(sql, 'get_pickup_order', o.customer, o.id)).closedReason).toBe('pending_timeout')
    await invariants(sql)
  })

  it('a PREPARING order is never auto-cancelled, however old', async () => {
    const o = await orderAt('preparing')
    await sql`update pickup_orders set created_at = now() - interval '30 days' where id = ${o.id}`
    await call(sql, 'sweep_pickup')
    expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('preparing')
    expect((await rows(sql, `select status, expires_at from stock_reservations where order_id = $1`, o.id))[0]).toEqual({ status: 'active', expires_at: null })
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })

  it('a ready order past 24h expires: stock released, code dead', async () => {
    const o = await orderAt('ready', [line('P2', 'Yagona', 'Oq', 1)])
    await sql`update pickup_orders set ready_expires_at = now() - interval '1 second' where id = ${o.id}`
    await sql`update stock_reservations set expires_at = now() - interval '1 second' where order_id = ${o.id}`
    expect((await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, true, o.total))).code).toBe('EXPIRED')
    await call(sql, 'sweep_pickup')
    expect(await rows(sql, `select status, closed_reason from pickup_orders where id = $1`, o.id)).toEqual([{ status: 'expired', closed_reason: 'pickup_timeout' }])
    expect(await avail('P2', 'Yagona', 'Oq')).toBe(3)
    expect((await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, true, o.total))).code).toBe('NOT_READY')
    expect(await call(sql, 'admin_complete_pickup', OWNER, null, o.code, true, o.total)).toEqual({ ok: false, error: 'INVALID_CODE' }) // lookup by code finds READY orders only
    expect((await call(sql, 'get_pickup_order', o.customer, o.id)).pickupCode).toBeNull()
    await invariants(sql)
  })

  it('a sweeper never fights an admin: a row locked by an admin action is skipped, not corrupted', async () => {
    const o = await orderAt('pending')
    await sql`update pickup_orders set pending_expires_at = now() - interval '1 minute' where id = ${o.id}`
    await sql`update stock_reservations set expires_at = now() - interval '1 minute' where order_id = ${o.id}`
    const holder = postgres(url(inject('pgPort'), (await sql`select current_database() as d`)[0].d), { max: 1, onnotice: () => {} })
    try {
      await holder.begin(async (tx) => {
        await tx`select id from pickup_orders where id = ${o.id} for update`
        const swept = await call(sql, 'sweep_pickup') // runs while the admin holds the row
        expect(swept.expiredPending).toBe(0)
        expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('pending')
      })
    } finally {
      await holder.end()
    }
    await call(sql, 'sweep_pickup')
    expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('expired')
  })
})

describe('handover: pickup code + explicit payment confirmation, atomically, once', () => {
  it('a wrong code is refused and logged; after 10 misses the admin is rate limited', async () => {
    const o = await orderAt('ready')
    const wrong = o.code!.replace(/^./, o.code![0] === 'A' ? 'B' : 'A')
    expect(await call(sql, 'admin_complete_pickup', OWNER, o.id, wrong, true, o.total)).toEqual({ ok: false, error: 'INVALID_CODE' })
    expect(await call(sql, 'admin_complete_pickup', OWNER, o.id, 'xx', true, o.total)).toEqual({ ok: false, error: 'INVALID_CODE' })
    expect(await call(sql, 'admin_complete_pickup', OWNER, o.id, null, true, o.total)).toEqual({ ok: false, error: 'INVALID_CODE' })
    expect((await rows(sql, `select count(*)::int n from pickup_code_attempts where admin_telegram_id = $1 and not ok and order_id = $2`, OWNER, o.id))[0].n).toBe(3)
    for (let i = 0; i < 8; i++) await call(sql, 'admin_complete_pickup', MGR, o.id, wrong, true, o.total)
    // 8 misses + the 3 above < 10 per admin: the manager is a different admin, so the correct code still works for him
    expect((await call(sql, 'admin_complete_pickup', MGR, o.id, o.code, true, o.total)).ok).toBe(true)
  })
  it('rate limit blocks even the correct code (brute force cannot be finished by luck)', async () => {
    const o = await orderAt('ready')
    const m = 900020
    await sql`insert into administrators (telegram_id, name, role) values (${m}, 'Rate', 'manager')`
    for (let i = 0; i < 10; i++) await call(sql, 'admin_complete_pickup', m, o.id, 'AAAAAAAA', true, o.total)
    expect(await call(sql, 'admin_complete_pickup', m, o.id, o.code, true, o.total)).toEqual({ ok: false, error: 'RATE_LIMITED' })
    expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('ready_for_pickup')
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })

  it('no completion without the admin\'s explicit confirmation; nothing changes when it is missing', async () => {
    const o = await orderAt('ready', [line('P3', 'S', 'Oq', 2)])
    const stock = await qty('P3', 'S', 'Oq')
    for (const confirmed of [false, null]) {
      expect((await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, confirmed, o.total))).code).toBe('PAYMENT_REQUIRED')
    }
    expect(await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, true, o.total - 1))).toEqual({ code: 'AMOUNT_MISMATCH', detail: { expected: o.total } })
    expect((await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, true, null))).code).toBe('AMOUNT_MISMATCH')
    expect(await rows(sql, `select status, payment_status, paid_at from pickup_orders where id = $1`, o.id)).toEqual([{ status: 'ready_for_pickup', payment_status: 'unpaid', paid_at: null }])
    expect(await qty('P3', 'S', 'Oq')).toBe(stock)
    expect((await rows(sql, `select status from stock_reservations where order_id = $1`, o.id))[0].status).toBe('active')
    expect((await rows(sql, `select count(*)::int n from pickup_status_history where order_id = $1 and kind = 'payment'`, o.id))[0].n).toBe(0)
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })

  it('success: paid + completed + inventory down + reservation consumed + who/when/how much recorded', async () => {
    const o = await orderAt('ready', [line('P1', 'M', 'Qora', 2), line('P3', 'S', 'Oq', 1)])
    const stock = { m: await qty('P1', 'M', 'Qora'), s: await qty('P3', 'S', 'Oq') }
    const r = await call(sql, 'admin_complete_pickup', MGR, o.id, ` ${o.code!.toLowerCase()} `, true, o.total)
    expect(r.ok).toBe(true)
    expect(r.order).toMatchObject({ status: 'completed', payment: { status: 'paid', method: 'pay_at_store' }, pickupCode: null })
    expect(r.order.payment.paidAt).not.toBeNull()
    expect(await qty('P1', 'M', 'Qora')).toBe(stock.m - 2)
    expect(await qty('P3', 'S', 'Oq')).toBe(stock.s - 1)
    expect(await rows(sql, `select status, expires_at from stock_reservations where order_id = $1 order by qty`, o.id)).toEqual([{ status: 'consumed', expires_at: null }, { status: 'consumed', expires_at: null }])
    const pay = await rows(sql, `select actor_role, actor_telegram_id, amount, payment_method, created_at from pickup_status_history where order_id = $1 and kind = 'payment'`, o.id)
    expect(pay).toHaveLength(1)
    expect(pay[0]).toMatchObject({ actor_role: 'admin', actor_telegram_id: String(MGR), amount: String(o.total), payment_method: 'pay_at_store' })
    expect(Math.abs(Date.now() - new Date(pay[0].created_at).getTime())).toBeLessThan(60_000)
    expect((await rows(sql, `select status from pickup_status_history where order_id = $1 and kind = 'status' order by id`, o.id)).map((x) => x.status)).toEqual(['pending', 'preparing', 'ready_for_pickup', 'completed'])
    expect((await call(sql, 'get_pickup_order', o.customer, o.id)).pickupCode).toBeNull()
    expect((await rows(sql, `select event from pickup_outbox where pickup_order_id = $1 and kind = 'pickup_customer' order by id`, o.id)).map((x) => x.event)).toEqual(['new', 'preparing', 'ready', 'completed'])
    // available == physical now (nothing left reserved for this order)
    expect(await avail('P1', 'M', 'Qora')).toBe(await qty('P1', 'M', 'Qora') - (await rows(sql, `select coalesce(sum(qty),0)::int s from stock_reservations where status='active' and variant_id = $1`, await variantId('P1', 'M', 'Qora')))[0].s)
    await invariants(sql)
  })

  it('the code works exactly ONCE: repeat, parallel and cancel-after are all refused; stock is deducted once', async () => {
    const o = await orderAt('ready', [line('P3', 'S', 'Oq', 1)])
    const stock = await qty('P3', 'S', 'Oq')
    const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => call(sql, 'admin_complete_pickup', i % 2 ? OWNER : MGR, o.id, o.code, true, o.total)))
    const ok = res.filter((r) => r.status === 'fulfilled' && (r.value as any).ok)
    expect(ok).toHaveLength(1)
    for (const r of res.filter((x) => !(x.status === 'fulfilled' && (x.value as any).ok))) expect((r as PromiseRejectedResult).reason?.message).toBe('NOT_READY')
    expect(await qty('P3', 'S', 'Oq')).toBe(stock - 1)
    expect((await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, true, o.total))).code).toBe('NOT_READY')
    expect(await call(sql, 'admin_complete_pickup', OWNER, null, o.code, true, o.total)).toEqual({ ok: false, error: 'INVALID_CODE' })
    expect((await fails(() => call(sql, 'admin_cancel_pickup', OWNER, o.id, 'kech bo\'ldi'))).code).toBe('NOT_CANCELLABLE')
    expect((await fails(() => call(sql, 'cancel_pickup_order_customer', o.customer, o.id))).code).toBe('NOT_CANCELLABLE')
    expect((await rows(sql, `select count(*)::int n from pickup_status_history where order_id = $1 and kind = 'payment'`, o.id))[0].n).toBe(1)
    await invariants(sql)
  })

  it('an admin can find the order by code alone', async () => {
    const o = await orderAt('ready')
    expect((await call(sql, 'admin_complete_pickup', OWNER, null, o.code, true, o.total)).ok).toBe(true)
    expect((await rows(sql, `select status from pickup_orders where id = $1`, o.id))[0].status).toBe('completed')
  })

  it('all-or-nothing: if inventory cannot cover the reservation the whole handover (payment too) rolls back', async () => {
    const o = await orderAt('ready', [line('P3', 'S', 'Oq', 1)])
    // simulate corruption: physical stock vanished while reserved (a trigger-free way to force the failure)
    await sql`alter table inventory disable trigger all`
    await sql`update inventory set quantity = 0 where variant_id = ${await variantId('P3', 'S', 'Oq')}`
    await sql`alter table inventory enable trigger all`
    const e = await fails(() => call(sql, 'admin_complete_pickup', OWNER, o.id, o.code, true, o.total))
    expect(e.code).toMatch(/violates check constraint/)
    expect(await rows(sql, `select status, payment_status, paid_at from pickup_orders where id = $1`, o.id)).toEqual([{ status: 'ready_for_pickup', payment_status: 'unpaid', paid_at: null }])
    expect((await rows(sql, `select count(*)::int n from pickup_status_history where order_id = $1 and kind = 'payment'`, o.id))[0].n).toBe(0)
    expect((await rows(sql, `select status from stock_reservations where order_id = $1`, o.id))[0].status).toBe('active')
    await setStock('P3', 'S', 'Oq', 500)
    await call(sql, 'admin_cancel_pickup', OWNER, o.id, 'sinov tugadi')
  })
})

describe('pickup code generator', () => {
  it('2000 codes: always 8 safe characters, all 32 symbols appear, no collisions', async () => {
    const codes = (await rows(sql, `select generate_pickup_code() as c from generate_series(1, 2000)`)).map((r) => r.c as string)
    for (const c of codes) expect(c).toMatch(code8)
    expect(new Set(codes).size).toBe(codes.length)
    const seen = new Set(codes.join(''))
    expect(seen.size).toBe(32)
    expect([...seen].some((ch) => '01IO'.includes(ch))).toBe(false)
  })
})

describe('admin list', () => {
  it('groups, counts, sweeper health and no code anywhere', async () => {
    const l = await call(sql, 'admin_list_pickup', OWNER, 'active', 100)
    expect(l.counts).toEqual(expect.objectContaining({ pending: expect.any(Number), preparing: expect.any(Number), ready: expect.any(Number) }))
    expect(l.sweep).toHaveProperty('lastOkAt')
    for (const o of l.orders) expect(['pending', 'preparing', 'ready_for_pickup']).toContain(o.status)
    const h = await call(sql, 'admin_list_pickup', OWNER, 'history', 100)
    for (const o of h.orders) expect(['completed', 'cancelled', 'expired']).toContain(o.status)
    expect(JSON.stringify([l, h])).not.toMatch(/"pickupCode":"/)
    expect((await fails(() => call(sql, 'admin_list_pickup', OWNER, 'bogus', 10))).code).toBe('INVALID_REQUEST')
    const d = await call(sql, 'admin_get_pickup', OWNER, h.orders[0].id)
    expect(d.history.length).toBeGreaterThan(0)
  })
})

describe('pre-flight 5: rollback script is safe', () => {
  // stage E (admin panel) sits on top of D: its own rollback runs first
  const script = () => readFileSync(resolve('supabase/rollback/20261111_admin_rollback.sql'), 'utf8') + '\n' + readFileSync(resolve('supabase/rollback/20261109_pickup_rollback.sql'), 'utf8')

  it('REFUSES while pickup data exists and changes nothing', async () => {
    const t = await newTestDb('rb_refuse')
    try {
      const f = await seed(t.sql)
      const o = await place(t.sql, f.customer, [line('P3', 'S', 'Oq', 1)])
      const one = postgres(t.url, { max: 1, onnotice: () => {} })
      const e = await fails(() => one.unsafe(script()))
      expect(e.code).toMatch(/ROLLBACK REFUSED/)
      await one.unsafe('rollback').catch(() => {})
      await one.end()
      expect((await t.sql`select count(*)::int n from pickup_orders`)[0].n).toBe(1)
      expect((await t.sql`select count(*)::int n from stock_reservations`)[0].n).toBe(1)
      expect(o.order.status).toBe('pending')
    } finally {
      await t.sql.end()
    }
  })

  it('REFUSES when only the store details were filled in (they are data too)', async () => {
    const t = await newTestDb('rb_store')
    try {
      await t.sql`update pickup_settings set store_address = 'Toshkent, ...'`
      const one = postgres(t.url, { max: 1, onnotice: () => {} })
      expect((await fails(() => one.unsafe(script()))).code).toMatch(/ROLLBACK REFUSED/)
      await one.unsafe('rollback').catch(() => {})
      await one.end()
      expect((await t.sql`select store_address from pickup_settings`)[0].store_address).toBe('Toshkent, ...')
    } finally {
      await t.sql.end()
    }
  })

  it('when empty it restores Phase 5 exactly and leaves Cart orders, inventory and customers untouched', async () => {
    const t = await newTestDb('rb_ok')
    try {
      const f = await seed(t.sql)
      const cartOrder = await placeOrder(t.sql, f.customer, [line('P1', 'M', 'Qora', 2)], { source: 'cart' })
      const snap = async () => (await t.sql`select (select count(*) from orders) o, (select md5(string_agg(x::text, '|' order by x::text)) from inventory x) i,
        (select md5(string_agg(x::text, '|' order by x::text)) from customers x) c, (select md5(string_agg(x::text, '|' order by x::text)) from order_items x) oi`)[0]
      const before = await snap()
      const one = postgres(t.url, { max: 1, onnotice: () => {} })
      await one.unsafe(script())
      await one.end()
      expect(await snap()).toEqual(before)
      expect(await rows(t.sql, `select to_regclass('public.pickup_orders') as x, to_regclass('public.stock_reservations') as y`)).toEqual([{ x: null, y: null }])
      expect(await rows(t.sql, `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname ~ 'pickup|reserved_qty|available_qty'`)).toEqual([])
      expect(await rows(t.sql, `select typname from pg_type where typnamespace = 'public'::regnamespace and typname ~ 'pickup|reservation'`)).toEqual([])
      // Phase 5 behaviour works again, including privileges
      const cat = (await t.sql`select get_catalog() as c`)[0].c
      expect(cat.products.find((p: any) => p.id === 'P1').variants.find((v: any) => v.size === 'M').qty).toBe(3)
      const again = await placeOrder(t.sql, f.customer, [line('P1', 'M', 'Qora', 1)], { source: 'cart' })
      expect(again.order.orderNumber).not.toBe(cartOrder.order.orderNumber)
      expect(await asRole(t.sql, 'anon', async (tx) => fails(() => tx`select place_order(${f.customer}::uuid, ${randomUUID()}::uuid, 'cart', 'Ali', '+998901234567', 'Toshkent, Chilonzor 1', null, '[]'::jsonb)`))).toMatchObject({ code: expect.stringMatching(/permission denied/) })
    } finally {
      await t.sql.end()
    }
  })
})
