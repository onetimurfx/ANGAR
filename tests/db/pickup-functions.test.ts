/**
 * Stage B: the pickup-order and admin-pickup Edge Functions against a REAL PostgreSQL (all migrations applied).
 * Covers authentication, forged/expired tokens, admin authorization on every request, client-supplied identity being
 * ignored, error mapping, one-time code (also in parallel) and secret hygiene.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { issueSession } from '../../supabase/functions/_shared/session.ts'
import type { Deps } from '../../supabase/functions/_shared/types.ts'
import { handler as authHandler } from '../../supabase/functions/telegram-auth/handler.ts'
import { handler as customerHandler } from '../../supabase/functions/pickup-order/handler.ts'
import { handler as adminHandler } from '../../supabase/functions/admin-pickup/handler.ts'
import { CONTACT, newTestDb, seed, type Fixture } from './fixtures'

const BOT_TOKEN = '7000000001:AAFakeTokenForTestsOnly_abcdefghijklmnopqrstu'
const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const CRON_SECRET = 'test-cron-secret-0123456789'
const ORIGIN = 'https://shop.example'
const NOW = Date.now()

function signInitData(fields: Record<string, string>) {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString()
}
const initFor = (id: number) =>
  signInitData({ auth_date: String(Math.floor(NOW / 1000) - 60), query_id: 'AAH', user: JSON.stringify({ id, first_name: 'Ali', language_code: 'uz' }) })

let sql: postgres.Sql
let fx: Fixture
let logs: { msg: string; extra?: Record<string, unknown> }[]
let env: Deps['env']

const deps = (): Deps => ({
  sql: sql as unknown as Deps['sql'],
  env,
  now: () => NOW,
  log: (msg, extra) => void logs.push({ msg, extra }),
  background: () => undefined,
  fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
})
const call = (h: (r: Request) => Promise<Response>, method: string, opts: { token?: string; body?: unknown; query?: string; headers?: Record<string, string> } = {}) =>
  h(new Request(`https://x.supabase.co/functions/v1/f${opts.query ?? ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { 'x-aynimo-session': opts.token } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  }))
const cust = (m: string, o?: Parameters<typeof call>[2]) => call(customerHandler(deps()), m, o)
const adm = (m: string, o?: Parameters<typeof call>[2]) => call(adminHandler(deps()), m, o)

async function login(tg: number) {
  const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(tg) } })
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; customerId: string; isAdmin: boolean }
}
const place = (token: string, over: Record<string, unknown> = {}) =>
  cust('POST', {
    token,
    body: { action: 'place', idempotencyKey: randomUUID(), contact: { name: CONTACT.name, phone: CONTACT.phone, comment: 'Ertalab' }, items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 2 }], ...over },
  })
const codeOf = async (id: string) => (await sql`select pickup_code from pickup_orders where id = ${id}::uuid`)[0].pickup_code as string
async function toReady(token: string, adminToken: string) {
  const o = ((await (await place(token)).json()) as any).order
  expect((await adm('POST', { token: adminToken, body: { action: 'start_preparing', id: o.id } })).status).toBe(200)
  expect((await adm('POST', { token: adminToken, body: { action: 'mark_ready', id: o.id } })).status).toBe(200)
  return o.id as string
}
const complete = (token: string, id: string | null, code: string, over: Record<string, unknown> = {}) =>
  adm('POST', { token, body: { action: 'complete', id, code, paymentConfirmed: true, amount: 200000, ...over } })

let A: { token: string; customerId: string } // customer
let B: { token: string; customerId: string } // another customer
let ADM: { token: string }

beforeEach(async () => {
  if (sql) await sql.end()
  ;({ sql } = await newTestDb('pf'))
  fx = await seed(sql)
  logs = []
  env = { BOT_TOKEN, SESSION_SECRET, ALLOWED_ORIGINS: ORIGIN, CRON_SECRET }
  A = await login(fx.customerTg)
  B = await login(700002)
  ADM = await login(fx.adminTg)
})
afterAll(async () => void (await sql?.end()))

describe('authentication on both functions', () => {
  for (const [name, f] of [['pickup-order', cust], ['admin-pickup', adm]] as const) {
    it(`${name}: no token, garbage token, wrong-secret token and expired token -> 401`, async () => {
      const wrong = (await issueSession({ sub: A.customerId, tg: fx.adminTg }, SESSION_SECRET + 'x', NOW)).token
      const expired = (await issueSession({ sub: A.customerId, tg: fx.adminTg }, SESSION_SECRET, NOW - 2 * 3600 * 1000)).token
      for (const token of [undefined, 'garbage', 'a.b', wrong, expired]) {
        const r = await f('GET', { token })
        expect(r.status, `${name} ${token}`).toBe(401)
        expect(((await r.json()) as any).error.code).toBe('UNAUTHENTICATED')
      }
    })
    it(`${name}: a payload edited after signing (tg swapped for the admin id) is rejected`, async () => {
      const [, mac] = A.token.split('.')
      const forged = Buffer.from(JSON.stringify({ sub: A.customerId, tg: fx.adminTg, exp: Math.floor(NOW / 1000) + 3600 })).toString('base64url')
      expect((await f('GET', { token: `${forged}.${mac}` })).status).toBe(401)
    })
    it(`${name}: rejects other HTTP methods and answers CORS preflight only for the allowed origin`, async () => {
      expect([405, 404]).toContain((await f('DELETE', { token: A.token })).status)
      const ok = await f('OPTIONS', { headers: { origin: ORIGIN } })
      expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
      const bad = await f('OPTIONS', { headers: { origin: 'https://evil.example' } })
      expect(bad.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    })
  }
  it('a Telegram initData with a bad signature cannot even obtain a session', async () => {
    const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(fx.adminTg).replace(/hash=[0-9a-f]/, 'hash=0') } })
    expect(res.status).toBe(401)
  })
})

describe('admin authorization on every request', () => {
  const cases: [string, Parameters<typeof call>[1], Parameters<typeof call>[2]][] = [
    ['list', 'GET', {}],
    ['one', 'GET', { query: `?id=${randomUUID()}` }],
    ['start_preparing', 'POST', { body: { action: 'start_preparing', id: randomUUID() } }],
    ['mark_ready', 'POST', { body: { action: 'mark_ready', id: randomUUID() } }],
    ['cancel', 'POST', { body: { action: 'cancel', id: randomUUID(), reason: 'sabab' } }],
    ['complete', 'POST', { body: { action: 'complete', code: 'ABCDEFGH', paymentConfirmed: true, amount: 1 } }],
  ]
  it('a plain customer gets 403 on every admin endpoint and cannot change anything', async () => {
    const id = ((await (await place(A.token)).json()) as any).order.id
    for (const [name, method, opts] of cases) {
      const r = await adm(method as string, { ...opts, token: A.token })
      expect(r.status, name).toBe(403)
      expect(((await r.json()) as any).error.code).toBe('FORBIDDEN')
    }
    const real = await adm('POST', { token: A.token, body: { action: 'start_preparing', id } })
    expect(real.status).toBe(403)
    expect((await sql`select status from pickup_orders where id = ${id}::uuid`)[0].status).toBe('pending')
  })
  it('client-supplied isAdmin / telegramId / customerId / admin headers are ignored', async () => {
    const hdr = { 'x-telegram-id': String(fx.adminTg), 'x-is-admin': 'true' }
    const r = await adm('GET', { token: A.token, query: `?telegramId=${fx.adminTg}&isAdmin=true&group=active`, headers: hdr })
    expect(r.status).toBe(403)
    const r2 = await adm('POST', { token: A.token, headers: hdr, body: { action: 'start_preparing', id: randomUUID(), telegramId: fx.adminTg, isAdmin: true, admin: fx.adminTg } })
    expect(r2.status).toBe(403)
  })
  it('an admin who is deactivated after logging in loses access on the very next request', async () => {
    expect((await adm('GET', { token: ADM.token })).status).toBe(200)
    await sql`update administrators set active = false where telegram_id = ${fx.adminTg}`
    expect((await adm('GET', { token: ADM.token })).status).toBe(403)
    expect((await adm('POST', { token: ADM.token, body: { action: 'mark_ready', id: randomUUID() } })).status).toBe(403)
  })
  it('a manager can work orders; admin identity is the session Telegram id only', async () => {
    await sql`insert into administrators (telegram_id, name, role) values (900002, 'Manager', 'manager')`
    const M = await login(900002)
    expect((await adm('GET', { token: M.token })).status).toBe(200)
  })
})

describe('customer: place, read, cancel', () => {
  it('places an order (201), same key returns the same order (200, no second order, no second reservation)', async () => {
    const key = randomUUID()
    const r1 = await place(A.token, { idempotencyKey: key })
    expect(r1.status).toBe(201)
    const b1 = (await r1.json()) as any
    expect(b1).toMatchObject({ duplicate: false, order: { status: 'pending', total: 200000, payment: { status: 'unpaid', method: 'pay_at_store' } } })
    expect(b1.order.orderNumber).toMatch(/^PU-/)
    const r2 = await place(A.token, { idempotencyKey: key })
    expect(r2.status).toBe(200)
    expect(((await r2.json()) as any)).toMatchObject({ duplicate: true, order: { id: b1.order.id } })
    expect((await sql`select count(*)::int n from pickup_orders`)[0].n).toBe(1)
    expect((await sql`select count(*)::int n from stock_reservations`)[0].n).toBe(1)
  })
  it('parallel requests with one key create exactly one order', async () => {
    const key = randomUUID()
    const rs = await Promise.all(Array.from({ length: 6 }, () => place(A.token, { idempotencyKey: key })))
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true)
    expect((await sql`select count(*)::int n from pickup_orders`)[0].n).toBe(1)
  })
  it('parallel orders for the last unit: one wins, the rest get 409 ITEMS_UNAVAILABLE', async () => {
    await sql`update inventory set quantity = 1 where variant_id = (select id from product_variants where product_id='P2')`
    const rs = await Promise.all([A, B].flatMap((u) => [0, 1, 2].map(() => place(u.token, { items: [{ productId: 'P2', size: 'Yagona', color: 'Oq', qty: 1 }] }))))
    expect(rs.filter((r) => r.status === 201).length).toBe(1)
    for (const r of rs.filter((x) => x.status !== 201)) expect([409]).toContain(r.status)
  })
  it('the order is always created for the SESSION customer, even if the body names another', async () => {
    const r = await place(A.token, { customerId: B.customerId, telegramId: 700002, customer_id: B.customerId })
    expect(r.status).toBe(201)
    const rows = await sql`select customer_id from pickup_orders`
    expect(rows.map((x) => x.customer_id)).toEqual([A.customerId])
  })
  it('error mapping: bad input -> 4xx with stable codes and no stack/SQL in the body', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ contact: { name: '1', phone: '123' } }, 422, 'INVALID_CONTACT'],
      [{ items: [] }, 400, 'EMPTY_ORDER'],
      [{ items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 99 }] }, 409, 'ITEMS_UNAVAILABLE'],
      [{ items: [{ productId: 'SAMPLE', size: 'M', color: 'Qora', qty: 1 }] }, 409, 'SAMPLE_PRODUCT'],
      [{ items: [{ productId: 'INACTIVE', size: 'M', color: 'Qora', qty: 1 }] }, 409, 'ITEMS_UNAVAILABLE'],
      [{ items: Array.from({ length: 11 }, (_, i) => ({ productId: 'P1', size: 'M', color: 'Qora' + i, qty: 1 })) }, 422, 'TOO_MANY_LINES'],
      [{ idempotencyKey: 'not-a-uuid' }, 400, 'INVALID_REQUEST'],
      [{ contact: 'x' }, 400, 'INVALID_REQUEST'],
    ]
    for (const [over, status, code] of cases) {
      const r = await place(A.token, over)
      const text = await r.text()
      expect(r.status, code).toBe(status)
      expect(JSON.parse(text).error.code).toBe(code)
      expect(text).not.toMatch(/select |postgres|stack|at .*\.ts/i)
    }
    expect((await cust('POST', { token: A.token, body: 'not json' })).status).toBe(400)
    expect((await cust('POST', { token: A.token, body: { action: 'nope' } })).status).toBe(400)
    expect((await cust('POST', { token: A.token, body: [1] })).status).toBe(400)
    expect((await sql`select count(*)::int n from pickup_orders`)[0].n).toBe(0)
  })
  it('a delivery address in the body is not stored anywhere (pickup only)', async () => {
    const r = await place(A.token, { contact: { name: CONTACT.name, phone: CONTACT.phone, address: 'Toshkent, Chilonzor 1', delivery: true } })
    expect(r.status).toBe(201)
    expect(JSON.stringify(await sql`select * from pickup_orders`)).not.toContain('Chilonzor')
  })
  it('the 4th active order is refused with ACTIVE_LIMIT', async () => {
    for (let i = 0; i < 3; i++) expect((await place(A.token, { items: [{ productId: 'P3', size: 'S', color: 'Oq', qty: 1 }] })).status).toBe(201)
    const r = await place(A.token, { items: [{ productId: 'P3', size: 'S', color: 'Oq', qty: 1 }] })
    expect(r.status).toBe(409)
    expect(((await r.json()) as any)).toMatchObject({ error: { code: 'ACTIVE_LIMIT', max: 3 } })
  })
  it('lists only my orders; another customer cannot read or cancel mine (404, nothing changes)', async () => {
    const o = ((await (await place(A.token)).json()) as any).order
    expect(((await (await cust('GET', { token: A.token })).json()) as any).orders.map((x: any) => x.id)).toEqual([o.id])
    expect(((await (await cust('GET', { token: B.token })).json()) as any).orders).toEqual([])
    expect((await cust('GET', { token: B.token, query: `?id=${o.id}` })).status).toBe(404)
    expect((await cust('POST', { token: B.token, body: { action: 'cancel', id: o.id } })).status).toBe(404)
    expect((await cust('GET', { token: A.token, query: `?id=${o.id}` })).status).toBe(200)
    expect((await cust('GET', { token: A.token, query: '?id=not-a-uuid' })).status).toBe(400)
    expect((await sql`select status from pickup_orders where id=${o.id}::uuid`)[0].status).toBe('pending')
  })
  it('customer cancels while pending (reservation released), is idempotent, and cannot cancel once preparing', async () => {
    const o = ((await (await place(A.token)).json()) as any).order
    const c1 = await cust('POST', { token: A.token, body: { action: 'cancel', id: o.id } })
    expect(c1.status).toBe(200)
    expect(((await c1.json()) as any).order.status).toBe('cancelled')
    expect((await sql`select count(*)::int n from stock_reservations where status='active'`)[0].n).toBe(0)
    expect((await cust('POST', { token: A.token, body: { action: 'cancel', id: o.id } })).status).toBe(200)

    const o2 = ((await (await place(A.token)).json()) as any).order
    await adm('POST', { token: ADM.token, body: { action: 'start_preparing', id: o2.id } })
    const c2 = await cust('POST', { token: A.token, body: { action: 'cancel', id: o2.id } })
    expect(c2.status).toBe(409)
    expect(((await c2.json()) as any).error.code).toBe('NOT_CANCELLABLE')
  })
})

describe('admin flow and the one-time pickup code', () => {
  it('pending -> preparing -> ready -> completed; customer sees the code only when ready; admin never does', async () => {
    const o = ((await (await place(A.token)).json()) as any).order
    expect(o.pickupCode).toBeNull()
    const list = (await (await adm('GET', { token: ADM.token, query: '?group=pending' })).json()) as any
    expect(list.orders.map((x: any) => x.id)).toContain(o.id)
    await adm('POST', { token: ADM.token, body: { action: 'start_preparing', id: o.id } })
    expect(((await (await cust('GET', { token: A.token, query: `?id=${o.id}` })).json()) as any).order.pickupCode).toBeNull()
    const ready = (await (await adm('POST', { token: ADM.token, body: { action: 'mark_ready', id: o.id } })).json()) as any
    const mine = ((await (await cust('GET', { token: A.token, query: `?id=${o.id}` })).json()) as any).order
    expect(mine.status).toBe('ready_for_pickup')
    expect(mine.pickupCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    const code = mine.pickupCode as string
    // the admin must never be able to read the code
    const everything = [JSON.stringify(ready), await (await adm('GET', { token: ADM.token, query: '?group=ready' })).text(), await (await adm('GET', { token: ADM.token, query: `?id=${o.id}` })).text()].join('')
    expect(everything).not.toContain(code)
    // someone else's customer view does not leak it either
    expect(await (await cust('GET', { token: B.token })).text()).not.toContain(code)
    const done = await complete(ADM.token, o.id, code)
    expect(done.status).toBe(200)
    expect(((await done.json()) as any).order).toMatchObject({ status: 'completed', payment: { status: 'paid' } })
    expect((await sql`select quantity from inventory where variant_id=(select id from product_variants where product_id='P1' and size='M')`)[0].quantity).toBe(3)
    const hist = await sql`select kind, actor_telegram_id, amount from pickup_status_history where kind='payment'`
    expect(hist).toHaveLength(1)
    expect(Number(hist[0].actor_telegram_id)).toBe(fx.adminTg)
    expect(Number(hist[0].amount)).toBe(200000)
  })
  it('invalid transitions return 409 and change nothing', async () => {
    const o = ((await (await place(A.token)).json()) as any).order
    expect((await adm('POST', { token: ADM.token, body: { action: 'mark_ready', id: o.id } })).status).toBe(409)
    expect((await adm('POST', { token: ADM.token, body: { action: 'start_preparing', id: randomUUID() } })).status).toBe(404)
    await adm('POST', { token: ADM.token, body: { action: 'start_preparing', id: o.id } })
    const again = await adm('POST', { token: ADM.token, body: { action: 'start_preparing', id: o.id } })
    expect(again.status).toBe(409)
    expect(((await again.json()) as any).error.code).toBe('INVALID_TRANSITION')
  })
  it('admin cancel needs a reason; releases the reservation', async () => {
    const o = ((await (await place(A.token)).json()) as any).order
    expect((await adm('POST', { token: ADM.token, body: { action: 'cancel', id: o.id, reason: '  ' } })).status).toBe(422)
    expect((await adm('POST', { token: ADM.token, body: { action: 'cancel', id: o.id } })).status).toBe(400)
    const r = await adm('POST', { token: ADM.token, body: { action: 'cancel', id: o.id, reason: 'Tovar singan' } })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).order.status).toBe('cancelled')
    expect((await sql`select count(*)::int n from stock_reservations where status='active'`)[0].n).toBe(0)
    expect((await adm('POST', { token: ADM.token, body: { action: 'cancel', id: o.id, reason: 'yana' } })).status).toBe(409)
  })
  it('completion needs the right code, a real boolean true confirmation and the exact amount', async () => {
    const id = await toReady(A.token, ADM.token)
    const code = await codeOf(id)
    const wrongCode = code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1)
    const r = await complete(ADM.token, id, wrongCode)
    expect(r.status).toBe(422)
    expect(((await r.json()) as any).error.code).toBe('INVALID_CODE')
    for (const bad of [false, 'true', 1, 'yes', null, undefined]) {
      const x = await complete(ADM.token, id, code, { paymentConfirmed: bad })
      expect(x.status, String(bad)).toBe(422)
      expect(((await x.json()) as any).error.code).toBe('PAYMENT_REQUIRED')
    }
    for (const bad of [199999, 0, null, '200000', 200000.5]) {
      const x = await complete(ADM.token, id, code, { amount: bad })
      expect(x.status, String(bad)).toBe(422)
      expect(((await x.json()) as any).error.code).toBe('AMOUNT_MISMATCH')
    }
    expect((await sql`select status, payment_status from pickup_orders where id=${id}::uuid`)[0]).toMatchObject({ status: 'ready_for_pickup', payment_status: 'unpaid' })
    expect((await complete(ADM.token, id, code)).status).toBe(200)
  })
  it('the code is single-use: replaying it fails, also for another order lookup by code alone', async () => {
    const id = await toReady(A.token, ADM.token)
    const code = await codeOf(id)
    expect((await complete(ADM.token, id, code)).status).toBe(200)
    expect((await complete(ADM.token, id, code)).status).toBeGreaterThanOrEqual(409)
    expect((await complete(ADM.token, null, code)).status).toBeGreaterThanOrEqual(409)
    expect((await sql`select quantity from inventory where variant_id=(select id from product_variants where product_id='P1' and size='M')`)[0].quantity).toBe(3)
  })
  it('parallel completions with the same code: exactly one succeeds, stock is deducted once', async () => {
    const id = await toReady(A.token, ADM.token)
    const code = await codeOf(id)
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => complete(ADM.token, i % 2 ? id : null, code)))
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1)
    expect((await sql`select quantity from inventory where variant_id=(select id from product_variants where product_id='P1' and size='M')`)[0].quantity).toBe(3)
    expect((await sql`select count(*)::int n from pickup_status_history where kind='payment'`)[0].n).toBe(1)
  })
  it('lookup by code alone works for a ready order (id omitted)', async () => {
    const id = await toReady(A.token, ADM.token)
    expect((await complete(ADM.token, null, await codeOf(id))).status).toBe(200)
  })
  it('guessing codes is rate limited (429) and a non-admin cannot use the endpoint to guess at all', async () => {
    await toReady(A.token, ADM.token)
    let last = 0
    for (let i = 0; i < 12; i++) last = (await complete(ADM.token, null, 'ZZZZZZZZ')).status
    expect(last).toBe(429)
    expect((await complete(A.token, null, 'ZZZZZZZZ')).status).toBe(403)
  })
  it('a pending/preparing order cannot be completed, even with its code read from the database', async () => {
    const o = ((await (await place(A.token)).json()) as any).order
    expect(await codeOf(o.id)).toBeNull() // no code exists before the order is ready
    const r = await complete(ADM.token, o.id, 'ABCDEFGH')
    expect(r.status).toBe(409)
    expect((await sql`select status from pickup_orders where id=${o.id}::uuid`)[0].status).toBe('pending')
  })
  it('input validation on admin endpoints', async () => {
    expect((await adm('GET', { token: ADM.token, query: '?group=evil' })).status).toBe(400)
    expect((await adm('GET', { token: ADM.token, query: '?limit=0' })).status).toBe(400)
    expect((await adm('GET', { token: ADM.token, query: '?limit=999' })).status).toBe(400)
    expect((await adm('GET', { token: ADM.token, query: '?id=zzz' })).status).toBe(400)
    expect((await adm('POST', { token: ADM.token, body: { action: 'start_preparing' } })).status).toBe(400)
    expect((await adm('POST', { token: ADM.token, body: { action: 'drop_table' } })).status).toBe(400)
    expect((await adm('POST', { token: ADM.token, body: { action: 'complete', code: 'x'.repeat(100) } })).status).toBe(400)
  })
})

describe('secret hygiene', () => {
  it('no response or log line contains the bot token, session secret, cron secret or the pickup code of a hidden view', async () => {
    const id = await toReady(A.token, ADM.token)
    const code = await codeOf(id)
    const texts: string[] = []
    for (const r of [await place(A.token, { contact: 'x' }), await cust('GET', { token: B.token }), await adm('GET', { token: A.token }), await complete(ADM.token, id, 'WRONGCODE'), await adm('GET', { token: ADM.token, query: '?group=ready' })])
      texts.push(await r.text())
    const all = texts.join('\n') + JSON.stringify(logs)
    for (const secret of [BOT_TOKEN, SESSION_SECRET, CRON_SECRET, code]) expect(all).not.toContain(secret)
  })
  it('the frontend source holds no service-role key or database url (only the guard that REFUSES such a key)', async () => {
    const { execSync } = await import('node:child_process')
    const hit = execSync(`grep -rIlE "service_role|SUPABASE_DB_URL|SERVICE_ROLE" src || true`, { cwd: process.cwd() }).toString().trim()
    // src/lib/backend.ts contains isPrivilegedKey(), which rejects a service_role key if one is ever configured
    expect(hit.split('\n').filter((f) => f && f !== 'src/lib/backend.ts')).toEqual([])
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('src/lib/backend.ts', 'utf8')).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9]{10,}|postgres(ql)?:\/\//)
  })
})
