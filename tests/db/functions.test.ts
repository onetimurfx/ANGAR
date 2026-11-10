/**
 * Edge Function code (supabase/functions) against a REAL PostgreSQL: Telegram initData verification, sessions,
 * admin authorization, order placement errors, bot messages and secret hygiene. Telegram's API is mocked.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { verifyInitData } from '../../supabase/functions/_shared/telegram.ts'
import { issueSession, verifySession } from '../../supabase/functions/_shared/session.ts'
import { composeMessage } from '../../supabase/functions/_shared/notify.ts'
import type { Deps } from '../../supabase/functions/_shared/types.ts'
import { handler as authHandler } from '../../supabase/functions/telegram-auth/handler.ts'
import { handler as adminHandler } from '../../supabase/functions/admin-whoami/handler.ts'
import { handler as cartHandler } from '../../supabase/functions/cart/handler.ts'
import { handler as ordersHandler } from '../../supabase/functions/my-orders/handler.ts'
import { handler as placeHandler } from '../../supabase/functions/place-order/handler.ts'
import { handler as outboxHandler } from '../../supabase/functions/notify-outbox/handler.ts'
import { CONTACT, newTestDb, seed, type Fixture } from './fixtures'

// ------------------------------------------------------------------ helpers
const BOT_TOKEN = '7000000001:AAFakeTokenForTestsOnly_abcdefghijklmnopqrstu'
const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const CRON_SECRET = 'test-cron-secret-0123456789'
const ORIGIN = 'https://shop.example'
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0)

function signInitData(fields: Record<string, string>, token = BOT_TOKEN) {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}
const tgUser = (id: number, extra: object = {}) => JSON.stringify({ id, first_name: 'Ali', last_name: 'Valiyev', username: 'ali', language_code: 'uz', ...extra })
const initFor = (id: number, authDate = Math.floor(NOW / 1000) - 60) => signInitData({ auth_date: String(authDate), query_id: 'AAH', user: tgUser(id) })

let sql: postgres.Sql
let fx: Fixture
let telegramCalls: { url: string; body: any }[]
let telegramMode: 'ok' | 'http-error' | 'throw'
let logs: { msg: string; extra?: Record<string, unknown> }[]
let background: Promise<unknown>[]
let env: Deps['env']

const deps = (): Deps => ({
  sql: sql as unknown as Deps['sql'],
  env,
  now: () => NOW,
  log: (msg, extra) => void logs.push({ msg, extra }),
  background: (p) => void background.push(p),
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    telegramCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (telegramMode === 'throw') throw new Error(`network down while calling ${url}`)
    if (telegramMode === 'http-error') return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
  }) as typeof fetch,
})

const call = (h: (r: Request) => Promise<Response>, method: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  h(new Request('https://x.supabase.co/functions/v1/f', {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { 'x-aynimo-session': opts.token } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }))

async function login(tg: number) {
  const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(tg) } })
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; customerId: string; isAdmin: boolean; user: { id: number } }
}
const orderBody = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  source: 'cart',
  contact: CONTACT,
  items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 2 }],
  ...over,
})

beforeEach(async () => {
  if (sql) await sql.end()
  ;({ sql } = await newTestDb('fn'))
  fx = await seed(sql)
  telegramCalls = []
  telegramMode = 'ok'
  logs = []
  background = []
  env = { BOT_TOKEN, SESSION_SECRET, ALLOWED_ORIGINS: ORIGIN, CRON_SECRET }
})
afterAll(async () => void (await sql?.end()))

// ------------------------------------------------------------------ initData
describe('Telegram initData verification', () => {
  const fields = () => ({ auth_date: String(Math.floor(NOW / 1000) - 60), query_id: 'AAH', user: tgUser(42) })

  it('accepts data signed with the bot token and returns the Telegram user', async () => {
    const r = await verifyInitData(signInitData(fields()), BOT_TOKEN, NOW)
    expect(r).toMatchObject({ ok: true, user: { id: 42, firstName: 'Ali', username: 'ali' } })
  })
  it('rejects data signed with another bot token', async () => {
    expect(await verifyInitData(signInitData(fields(), '1:other'), BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' })
  })
  it('rejects a changed user id (identity spoofing)', async () => {
    const good = new URLSearchParams(signInitData(fields()))
    good.set('user', tgUser(999999))
    expect(await verifyInitData(good.toString(), BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' })
  })
  it('rejects an added or removed field', async () => {
    const added = new URLSearchParams(signInitData(fields()))
    added.set('start_param', 'x')
    expect(await verifyInitData(added.toString(), BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' })
    const removed = new URLSearchParams(signInitData(fields()))
    removed.delete('query_id')
    expect(await verifyInitData(removed.toString(), BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' })
  })
  it('rejects expired and future-dated data even with a valid signature (replay protection)', async () => {
    const old = signInitData({ ...fields(), auth_date: String(Math.floor(NOW / 1000) - 86400 - 5) })
    expect(await verifyInitData(old, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'expired' })
    const future = signInitData({ ...fields(), auth_date: String(Math.floor(NOW / 1000) + 3600) })
    expect(await verifyInitData(future, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'expired' })
  })
  it('rejects malformed input without throwing', async () => {
    for (const bad of [undefined, null, 42, '', 'hash=abc', 'a=b', 'x'.repeat(5000), {}, [], `auth_date=1&hash=${'A'.repeat(64)}`, `auth_date=1&hash=${'a'.repeat(63)}`])
      expect(await verifyInitData(bad, BOT_TOKEN, NOW)).toMatchObject({ ok: false })
  })
  it('rejects signed data that has no valid user', async () => {
    const none = signInitData({ auth_date: String(Math.floor(NOW / 1000)), query_id: 'x' })
    expect(await verifyInitData(none, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'no_user' })
    const badId = signInitData({ auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: -5, first_name: 'X' }) })
    expect(await verifyInitData(badId, BOT_TOKEN, NOW)).toMatchObject({ ok: false, reason: 'no_user' })
  })
  it('the signature check is not fooled by the field order', async () => {
    const f = fields()
    const reordered = new URLSearchParams(signInitData(f))
    const entries = [...reordered.entries()].reverse()
    expect(await verifyInitData(new URLSearchParams(entries).toString(), BOT_TOKEN, NOW)).toMatchObject({ ok: true })
  })
})

describe('session tokens', () => {
  it('round-trips and expires', async () => {
    const { token } = await issueSession({ sub: 'c1', tg: 7 }, SESSION_SECRET, NOW)
    expect(await verifySession(token, SESSION_SECRET, NOW + 1000)).toMatchObject({ sub: 'c1', tg: 7 })
    expect(await verifySession(token, SESSION_SECRET, NOW + 3600 * 1000 + 1000)).toBeNull()
  })
  it('rejects another secret, a changed payload and garbage', async () => {
    const { token } = await issueSession({ sub: 'c1', tg: 7 }, SESSION_SECRET, NOW)
    expect(await verifySession(token, SESSION_SECRET + 'x', NOW)).toBeNull()
    const [body, mac] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'c1', tg: fx.adminTg, exp: Math.floor(NOW / 1000) + 3600 })).toString('base64url')
    expect(await verifySession(`${forged}.${mac}`, SESSION_SECRET, NOW)).toBeNull()
    expect(await verifySession(`${body}.`, SESSION_SECRET, NOW)).toBeNull()
    for (const g of [null, undefined, 5, '', 'a', 'a.b.c', '.', 'x'.repeat(2000)]) expect(await verifySession(g, SESSION_SECRET, NOW)).toBeNull()
  })
})

// ------------------------------------------------------------------ telegram-auth
describe('telegram-auth', () => {
  it('logs a customer in, creates the row and reports isAdmin=false', async () => {
    const me = await login(555)
    expect(me.isAdmin).toBe(false)
    expect((await sql`select telegram_id::int as t from customers where id = ${me.customerId}`)[0].t).toBe(555)
  })
  it('is idempotent: the same Telegram user always maps to the same customer', async () => {
    expect((await login(556)).customerId).toBe((await login(556)).customerId)
  })
  it('reports isAdmin=true only for a listed active administrator', async () => {
    expect((await login(fx.adminTg)).isAdmin).toBe(true)
    await sql`update administrators set active = false`
    expect((await login(fx.adminTg)).isAdmin).toBe(false)
  })
  it('refuses a forged signature and creates nothing', async () => {
    const before = (await sql`select count(*)::int n from customers`)[0].n
    const res = await call(authHandler(deps()), 'POST', { body: { initData: signInitData({ auth_date: String(NOW / 1000), user: tgUser(31337) }, 'wrong:token') } })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('INVALID_INIT_DATA')
    expect((await sql`select count(*)::int n from customers`)[0].n).toBe(before)
  })
  it('says EXPIRED_INIT_DATA for old data so the app can ask to reopen', async () => {
    const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(1, Math.floor(NOW / 1000) - 90000) } })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('EXPIRED_INIT_DATA')
  })
  it('rejects bad bodies, wrong methods and oversized bodies', async () => {
    const h = authHandler(deps())
    expect((await call(h, 'POST', { body: [] })).status).toBe(400)
    expect((await h(new Request('https://x/f', { method: 'POST', body: 'not json' }))).status).toBe(400)
    expect((await h(new Request('https://x/f', { method: 'POST', body: JSON.stringify({ initData: 'x'.repeat(100_000) }) }))).status).toBe(400)
    expect((await call(h, 'GET')).status).toBe(405)
  })
  it('fails closed (500) with a generic code when secrets are missing or weak', async () => {
    for (const bad of [{ ...env, BOT_TOKEN: undefined }, { ...env, SESSION_SECRET: undefined }, { ...env, SESSION_SECRET: 'short' }]) {
      env = bad
      const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(1) } })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: { code: 'SERVER_MISCONFIGURED' } })
    }
  })
  it('never returns or logs the bot token or the session secret', async () => {
    const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(777) } })
    const text = JSON.stringify([await res.text(), logs])
    expect(text).not.toContain(BOT_TOKEN)
    expect(text).not.toContain(SESSION_SECRET)
  })
})

// ------------------------------------------------------------------ admin authorization
describe('admin API authorization', () => {
  const whoami = (token?: string) => call(adminHandler(deps()), 'GET', { token })

  it('no session -> 401', async () => expect((await whoami()).status).toBe(401))
  it('garbage session -> 401', async () => expect((await whoami('abc.def')).status).toBe(401))
  it('an ordinary customer gets 403', async () => {
    const me = await login(fx.customerTg)
    const res = await whoami(me.token)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('FORBIDDEN')
  })
  it('a listed administrator gets 200', async () => {
    const res = await whoami((await login(fx.adminTg)).token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isAdmin: true, telegramId: fx.adminTg })
  })
  it('a token forged for the admin id (wrong secret) is refused', async () => {
    const { token } = await issueSession({ sub: fx.customer, tg: fx.adminTg }, 'attacker-secret-attacker-secret-attacker', NOW)
    expect((await whoami(token)).status).toBe(401)
  })
  it('editing a customer token to claim the admin id is refused', async () => {
    const me = await login(fx.customerTg)
    const [, mac] = me.token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: me.customerId, tg: fx.adminTg, exp: Math.floor(NOW / 1000) + 3600 })).toString('base64url')
    expect((await whoami(`${forged}.${mac}`)).status).toBe(401)
  })
  it('removing an admin takes effect immediately, even for a still-valid token', async () => {
    const adm = await login(fx.adminTg)
    expect((await whoami(adm.token)).status).toBe(200)
    await sql`update administrators set active = false where telegram_id = ${fx.adminTg}`
    expect((await whoami(adm.token)).status).toBe(403)
  })
  it('only GET is allowed', async () => expect((await call(adminHandler(deps()), 'POST', { token: (await login(fx.adminTg)).token })).status).toBe(405))
})

// ------------------------------------------------------------------ cart + orders through the API
describe('cart and my-orders', () => {
  it('require a session', async () => {
    expect((await call(cartHandler(deps()), 'GET')).status).toBe(401)
    expect((await call(ordersHandler(deps()), 'GET')).status).toBe(401)
  })
  it('save and read the cart per customer; unknown variants are dropped', async () => {
    const a = await login(1001)
    const b = await login(1002)
    const put = await call(cartHandler(deps()), 'PUT', {
      token: a.token,
      body: { items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 3 }, { productId: 'P1', size: 'ZZ', color: 'Qora', qty: 1 }] },
    })
    expect((await put.json()).items).toEqual([{ productId: 'P1', size: 'M', color: 'Qora', qty: 3 }])
    expect((await (await call(cartHandler(deps()), 'GET', { token: a.token })).json()).items).toHaveLength(1)
    expect((await (await call(cartHandler(deps()), 'GET', { token: b.token })).json()).items).toEqual([])
  })
  it('reject a malformed cart', async () => {
    const a = await login(1003)
    expect((await call(cartHandler(deps()), 'PUT', { token: a.token, body: { items: 'nope' } })).status).toBe(400)
    expect((await call(cartHandler(deps()), 'PUT', { token: a.token, body: { items: Array.from({ length: 60 }, () => ({})) } })).status).toBe(400)
  })
  it('my-orders returns only the caller\'s orders', async () => {
    const a = await login(1004)
    const b = await login(1005)
    await call(placeHandler(deps()), 'POST', { token: a.token, body: orderBody() })
    const mine = (await (await call(ordersHandler(deps()), 'GET', { token: a.token })).json()).orders
    const theirs = (await (await call(ordersHandler(deps()), 'GET', { token: b.token })).json()).orders
    expect(mine).toHaveLength(1)
    expect(theirs).toEqual([])
  })
})

describe('place-order', () => {
  it('requires a session', async () => expect((await call(placeHandler(deps()), 'POST', { body: orderBody() })).status).toBe(401))

  it('creates the order (201), server prices, and queues + sends the bot messages', async () => {
    const me = await login(fx.customerTg)
    await sql`update customers set id = id where id = ${me.customerId}` // no-op: make sure customer exists
    const res = await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody({ unitPrice: 1, total: 1 }) })
    expect(res.status).toBe(201)
    const out = await res.json()
    expect(out.duplicate).toBe(false)
    expect(out.order.subtotal).toBe(200000) // 2 x 100 000, the client sent nothing it could influence
    expect(out.order.deliveryPending).toBe(true)
    expect(out.order.orderNumber).toMatch(/^AYN-\d{6}-\d{5}$/)
    await Promise.all(background)
    const chats = telegramCalls.map((c) => c.body.chat_id).sort()
    expect(chats).toEqual([fx.customerTg, fx.adminTg].sort())
    expect(telegramCalls.every((c) => c.url === `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)).toBe(true)
    const adminMsg = telegramCalls.find((c) => c.body.chat_id === fx.adminTg)!.body.text as string
    expect(adminMsg).toContain(out.order.orderNumber)
    expect(adminMsg).toContain('hali belgilanmagan')
    expect(adminMsg).toContain('yetkazib berishsiz')
    expect((await sql`select status, count(*)::int n from notification_outbox group by 1`)).toEqual([{ status: 'sent', n: 2 }])
  })
  it('the order always belongs to the verified session, never to an id sent in the body', async () => {
    const a = await login(2001)
    const b = await login(2002)
    const res = await call(placeHandler(deps()), 'POST', { token: a.token, body: orderBody({ customerId: b.customerId, customer_id: b.customerId }) })
    expect(res.status).toBe(201)
    expect((await sql`select customer_id from orders`)[0].customer_id).toBe(a.customerId)
  })
  it('a repeated request (double tap / retry) returns 200 duplicate and sends no new messages', async () => {
    const me = await login(2003)
    const body = orderBody()
    const first = await call(placeHandler(deps()), 'POST', { token: me.token, body })
    await Promise.all(background)
    const sentBefore = telegramCalls.length
    const again = await call(placeHandler(deps()), 'POST', { token: me.token, body })
    await Promise.all(background)
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    const [f, g] = [await first.json(), await again.json()]
    expect(g.duplicate).toBe(true)
    expect(g.order.id).toBe(f.order.id)
    expect(telegramCalls.length).toBe(sentBefore)
    expect((await sql`select count(*)::int n from orders`)[0].n).toBe(1)
    expect((await sql`select i.quantity from inventory i join product_variants v on v.id = i.variant_id where v.product_id = 'P1' and v.size = 'M'`)[0].quantity).toBe(3)
  })
  it('10 simultaneous HTTP requests with one key create one order', async () => {
    const me = await login(2004)
    const body = orderBody()
    const results = await Promise.all(Array.from({ length: 10 }, () => call(placeHandler(deps()), 'POST', { token: me.token, body })))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 200)).toHaveLength(9)
    expect((await sql`select count(*)::int n from orders`)[0].n).toBe(1)
  })
  it('keeps the order when Telegram is down; messages stay queued and a retry delivers them', async () => {
    const me = await login(2005)
    telegramMode = 'throw'
    const res = await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody() })
    await Promise.all(background)
    expect(res.status).toBe(201)
    expect((await sql`select count(*)::int n from orders`)[0].n).toBe(1)
    expect((await sql`select count(*)::int n from notification_outbox where status = 'pending'`)[0].n).toBe(2)
    // the bot token must not leak into logs or the stored error text
    expect(JSON.stringify(logs)).not.toContain(BOT_TOKEN)
    expect(JSON.stringify(await sql`select last_error from notification_outbox`)).not.toContain(BOT_TOKEN)
    // backoff: nothing is due right away; make them due, Telegram recovers, the scheduler endpoint delivers
    await sql`update notification_outbox set next_attempt_at = now()`
    telegramMode = 'ok'
    const run = await call(outboxHandler(deps()), 'POST', { headers: { 'x-cron-secret': CRON_SECRET } })
    expect(await run.json()).toEqual({ sent: 2, failed: 0 })
  })
  it('a user who blocked the bot does not break the order', async () => {
    const me = await login(2006)
    telegramMode = 'http-error'
    expect((await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody() })).status).toBe(201)
    await Promise.all(background)
    expect((await sql`select last_error from notification_outbox limit 1`)[0].last_error).toContain('bot was blocked')
  })
  it('works without a bot token: order saved, messages stay queued', async () => {
    env = { ...env, BOT_TOKEN: undefined }
    const me = await (async () => {
      env = { ...env, BOT_TOKEN }
      const m = await login(2007)
      env = { ...env, BOT_TOKEN: undefined }
      return m
    })()
    expect((await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody() })).status).toBe(201)
    await Promise.all(background)
    expect(telegramCalls).toHaveLength(0)
    expect((await sql`select count(*)::int n from notification_outbox where status = 'pending'`)[0].n).toBe(2)
  })

  it('409 ITEMS_UNAVAILABLE names the problem items and changes nothing', async () => {
    const me = await login(2008)
    const res = await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody({ items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 6 }] }) })
    expect(res.status).toBe(409)
    const err = (await res.json()).error
    expect(err.code).toBe('ITEMS_UNAVAILABLE')
    expect(err.issues[0]).toMatchObject({ productId: 'P1', reason: 'stock', requested: 6, available: 5 })
    expect((await sql`select count(*)::int n from orders`)[0].n).toBe(0)
  })
  it('422 INVALID_CONTACT lists the bad fields', async () => {
    const me = await login(2009)
    const res = await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody({ contact: { name: 'A', phone: '123', address: 'x', comment: '' } }) })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatchObject({ code: 'INVALID_CONTACT', fields: ['name', 'phone', 'address'] })
  })
  it('409 SAMPLE_PRODUCT: placeholder products cannot be bought', async () => {
    const me = await login(2010)
    const res = await call(placeHandler(deps()), 'POST', { token: me.token, body: orderBody({ items: [{ productId: 'SAMPLE', size: 'M', color: 'Qora', qty: 1 }] }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SAMPLE_PRODUCT')
  })
  it('400 for a missing/invalid key, source, contact or items', async () => {
    const me = await login(2011)
    const send = (body: unknown) => call(placeHandler(deps()), 'POST', { token: me.token, body })
    for (const bad of [
      orderBody({ idempotencyKey: 'abc' }),
      orderBody({ idempotencyKey: undefined }),
      orderBody({ source: 'admin' }),
      orderBody({ contact: null }),
      null,
      'text',
    ])
      expect((await send(bad)).status).toBe(400)
    expect((await send(orderBody({ items: [] }))).status).toBe(400)
    expect((await send(orderBody({ items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: -1 }] }))).status).toBe(400)
    expect((await send(orderBody({ items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: '2' }] }))).status).toBe(400)
    expect((await send(orderBody({ items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 1000 }] }))).status).toBe(400)
  })
  it('an internal failure is a generic 500 with no stack, SQL or secret in the body', async () => {
    const me = await login(2012)
    const broken = { ...deps(), sql: (() => { throw new Error(`relation "orders" exploded, token ${BOT_TOKEN}`) }) as unknown as Deps['sql'] }
    const res = await call(placeHandler(broken), 'POST', { token: me.token, body: orderBody() })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'SERVER_ERROR' } })
  })
})

// ------------------------------------------------------------------ outbox endpoint + messages
describe('notify-outbox endpoint', () => {
  it('is closed to browsers: needs the shared secret', async () => {
    const h = outboxHandler(deps())
    expect((await call(h, 'POST')).status).toBe(401)
    expect((await call(h, 'POST', { headers: { 'x-cron-secret': 'wrong' } })).status).toBe(401)
    expect((await call(h, 'POST', { token: (await login(fx.adminTg)).token })).status).toBe(401) // even an admin session is not enough
    expect((await call(h, 'POST', { headers: { 'x-cron-secret': CRON_SECRET } })).status).toBe(200)
  })
  it('fails closed when CRON_SECRET is missing or too short', async () => {
    for (const bad of [undefined, 'short']) {
      env = { ...env, CRON_SECRET: bad }
      expect((await call(outboxHandler(deps()), 'POST', { headers: { 'x-cron-secret': bad ?? '' } })).status).toBe(500)
    }
  })
  it('reports NO_BOT_TOKEN and leaves the queue untouched', async () => {
    env = { ...env, BOT_TOKEN: undefined }
    expect(await (await call(outboxHandler(deps()), 'POST', { headers: { 'x-cron-secret': CRON_SECRET } })).json()).toEqual({ sent: 0, failed: 0, reason: 'NO_BOT_TOKEN' })
  })
})

describe('bot message text', () => {
  const order = {
    orderNumber: 'AYN-261106-00001', source: 'cart', status: 'new', subtotal: 200000, deliveryFee: null, deliveryPending: true, total: 200000,
    contact: { name: 'Ali', phone: '+998901234567', address: 'Toshkent <b>12</b> & uy', comment: null },
    items: [{ name: 'Oddiy <i>futbolka</i>', color: 'Qora', size: 'M', qty: 2, unitPrice: 100000 }],
  }
  it('escapes HTML coming from customers (no injected markup in the admin chat)', () => {
    const t = composeMessage('order_admin', order)
    expect(t).toContain('Toshkent &lt;b&gt;12&lt;/b&gt; &amp; uy')
    expect(t).toContain('Oddiy &lt;i&gt;futbolka&lt;/i&gt;')
    expect(t).not.toContain('<i>')
  })
  it('never claims a delivery price that is not set, and never says the order was confirmed by the shop', () => {
    const admin = composeMessage('order_admin', order)
    expect(admin).toContain('Yetkazib berish: hali belgilanmagan')
    const customer = composeMessage('order_customer', order)
    expect(customer).toContain('qabul qilindi')
    expect(customer).toContain('yetkazib berishsiz')
    expect(customer).not.toMatch(/tasdiqlandi/i)
  })
  it('shows a configured fee', () => {
    expect(composeMessage('order_admin', { ...order, deliveryPending: false, deliveryFee: 25000, total: 225000 })).toContain("25 000 so'm")
  })
})

// ------------------------------------------------------------------ CORS
describe('CORS', () => {
  it('answers preflight and only allows the configured Mini App origin', async () => {
    const h = cartHandler(deps())
    const ok = await h(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: ORIGIN } }))
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const evil = await h(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
    const noEnv = (env = { ...env, ALLOWED_ORIGINS: undefined })
    void noEnv
    const none = await cartHandler(deps())(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: ORIGIN } }))
    expect(none.headers.get('access-control-allow-origin')).toBeNull()
  })
})
