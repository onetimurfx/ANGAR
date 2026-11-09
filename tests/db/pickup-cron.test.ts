/**
 * Stage C against a REAL PostgreSQL (all migrations applied): Uzbek bot messages with HTML safety, the outbox retry /
 * no-duplicate mechanism, the pickup-sweep Edge Function (secret check, expiry, reservations), cron health detection
 * and the cron installation script (run against stand-in cron/vault/net schemas, since those extensions are Supabase's).
 */
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import type { Deps } from '../../supabase/functions/_shared/types.ts'
import { composePickupMessage, deliverPickupOutbox, whenUz } from '../../supabase/functions/_shared/pickupNotify.ts'
import { handler as authHandler } from '../../supabase/functions/telegram-auth/handler.ts'
import { handler as customerHandler } from '../../supabase/functions/pickup-order/handler.ts'
import { handler as adminHandler } from '../../supabase/functions/admin-pickup/handler.ts'
import { handler as sweepHandler } from '../../supabase/functions/pickup-sweep/handler.ts'
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
const initFor = (id: number) => signInitData({ auth_date: String(Math.floor(NOW / 1000) - 60), query_id: 'AAH', user: JSON.stringify({ id, first_name: 'Ali', language_code: 'uz' }) })

let sql: postgres.Sql
let fx: Fixture
let logs: { msg: string; extra?: Record<string, unknown> }[]
let env: Deps['env']
let tg: { url: string; body: any }[]
let tgMode: 'ok' | 'throw' | 'http403' | 'slow'

const deps = (): Deps => ({
  sql: sql as unknown as Deps['sql'],
  env,
  now: () => NOW,
  log: (msg, extra) => void logs.push({ msg, extra }),
  background: () => undefined, // tests call the delivery explicitly: deterministic
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    tg.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (tgMode === 'throw') throw new Error(`network down while calling ${url}`)
    if (tgMode === 'slow') await new Promise((r) => setTimeout(r, 40))
    if (tgMode === 'http403') return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
  }) as typeof fetch,
})
// place()/act() queue messages and the handlers also start a background delivery. That would race with the explicit
// deliveries the tests assert on, so the background run is neutralised (no BOT_TOKEN => it claims nothing).
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const saved = env
  env = { ...env, BOT_TOKEN: undefined }
  try {
    return await fn()
  } finally {
    env = saved
  }
}
const call = (h: (r: Request) => Promise<Response>, method: string, opts: { token?: string; body?: unknown; query?: string; headers?: Record<string, string> } = {}) =>
  h(new Request(`https://x.supabase.co/functions/v1/f${opts.query ?? ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { 'x-aynimo-session': opts.token } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }))
const cust = (m: string, o?: Parameters<typeof call>[2]) => call(customerHandler(deps()), m, o)
const adm = (m: string, o?: Parameters<typeof call>[2]) => call(adminHandler(deps()), m, o)
const sweep = (secret: string | null = CRON_SECRET, method = 'POST') => call(sweepHandler(deps()), method, { headers: secret === null ? {} : { 'x-cron-secret': secret } })

async function login(id: number) {
  const res = await call(authHandler(deps()), 'POST', { body: { initData: initFor(id) } })
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string }
}
const place = (token: string, over: Record<string, unknown> = {}) => quiet(async () => {
  const r = await cust('POST', { token, body: { action: 'place', idempotencyKey: randomUUID(), contact: { name: CONTACT.name, phone: CONTACT.phone, comment: 'Ertalab' }, items: [{ productId: 'P1', size: 'M', color: 'Qora', qty: 2 }], ...over } })
  expect(r.status).toBe(201)
  return ((await r.json()) as any).order as { id: string; orderNumber: string }
})
const act = (action: string, id: string) => quiet(async () => expect((await adm('POST', { token: ADM.token, body: { action, id } })).status).toBe(200))
const status = async (id: string) => (await sql`select status, closed_reason from pickup_orders where id = ${id}::uuid`)[0]
const avail = async () => Number((await sql`select available_qty(id) a from product_variants where product_id='P1' and size='M'`)[0].a)
const outbox = () => sql`select id, kind, event, status, attempts, last_error, next_attempt_at > now() as leased from pickup_outbox order by id`
const sentTexts = (chat?: number) => tg.filter((c) => c.url.includes('/sendMessage') && (chat === undefined || c.body.chat_id === chat)).map((c) => c.body.text as string)

let A: { token: string }
let ADM: { token: string }

beforeEach(async () => {
  if (sql) await sql.end()
  ;({ sql } = await newTestDb('pc'))
  fx = await seed(sql)
  logs = []
  tg = []
  tgMode = 'ok'
  env = { BOT_TOKEN, SESSION_SECRET, ALLOWED_ORIGINS: ORIGIN, CRON_SECRET }
  A = await login(fx.customerTg)
  ADM = await login(fx.adminTg)
})
afterAll(async () => void (await sql?.end()))

// ---------------------------------------------------------------------------------------------- messages
describe('bot messages (Uzbek, HTML-safe)', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    orderNumber: 'PU-000001', status: 'ready_for_pickup', pickupCode: 'K7M2QX9A', total: 200000, closedReason: null, closeNote: null,
    readyExpiresAt: '2026-11-10T07:00:00Z',
    contact: { name: 'Ali <b>Valiyev</b> & Co', phone: '+998901234567', comment: '<script>alert(1)</script>' },
    items: [{ name: 'Ko\'ylak <i>x</i>', color: 'Qora', size: 'M', qty: 2, unitPrice: 100000 }], ...over,
  })
  it('every customer event has a Uzbek text; only "ready" carries the code', () => {
    for (const ev of ['new', 'preparing', 'ready', 'completed', 'cancelled', 'expired']) {
      const t = composePickupMessage('pickup_customer', ev, order({ status: ev === 'ready' ? 'ready_for_pickup' : 'preparing' }), { pendingMinutes: 30 })
      expect(t, ev).toBeTruthy()
      expect(t!.includes('K7M2QX9A'), ev).toBe(ev === 'ready')
    }
    expect(composePickupMessage('pickup_customer', 'ready', order(), {})).toContain('<code>K7M2QX9A</code>')
    expect(composePickupMessage('pickup_customer', 'ready', order(), {})).toContain("Pickup kodi")
    expect(composePickupMessage('pickup_customer', 'new', order(), { pendingMinutes: 30 })).toContain('30 daqiqa')
  })
  it('user text is escaped: no raw tags can reach Telegram', () => {
    for (const [kind, ev] of [['pickup_admin', 'new'], ['pickup_customer', 'new']] as const) {
      const t = composePickupMessage(kind, ev, order(), {})!
      expect(t).not.toContain('<script>')
      expect(t).not.toContain('<i>x')
      expect(t).not.toContain('Ali <b>Valiyev')
      expect(t).toContain('&lt;')
    }
  })
  it('admin messages never contain the pickup code', () => {
    for (const ev of ['new', 'cancelled']) expect(composePickupMessage('pickup_admin', ev, order(), {}) ?? '').not.toContain('K7M2QX9A')
    expect(composePickupMessage('pickup_admin', 'ready', order(), {})).toBeNull()
  })
  it('a stale "ready" message (order already completed/cancelled) is not produced, so an old code is never sent', () => {
    expect(composePickupMessage('pickup_customer', 'ready', order({ status: 'completed', pickupCode: null }), {})).toBeNull()
    expect(composePickupMessage('pickup_customer', 'ready', order({ status: 'cancelled' }), {})).toBeNull()
  })
  it('store address / hours / phone appear only when the owner has set them, and are escaped', () => {
    const none = composePickupMessage('pickup_customer', 'ready', order(), {})!
    expect(none).not.toMatch(/Manzil|Ish vaqti|Telefon/)
    const set = composePickupMessage('pickup_customer', 'ready', order(), { address: 'Toshkent <1>', hours: '09:00-18:00', phone: '+998 71 000' })!
    expect(set).toContain('Manzil: Toshkent &lt;1&gt;')
    expect(set).toContain('09:00-18:00')
  })
  it('admin-cancel reason is shown to the customer (escaped); a customer cancel shows none; expiry text depends on the reason', () => {
    expect(composePickupMessage('pickup_customer', 'cancelled', order({ status: 'cancelled', closedReason: 'admin_cancelled', closeNote: 'Tovar <singan>' }), {})).toContain('Sabab: Tovar &lt;singan&gt;')
    expect(composePickupMessage('pickup_customer', 'cancelled', order({ status: 'cancelled', closedReason: 'customer_cancelled' }), {})).not.toContain('Sabab')
    expect(composePickupMessage('pickup_customer', 'expired', order({ closedReason: 'pending_timeout' }), {})).toContain('qabul qilinmagani')
    expect(composePickupMessage('pickup_customer', 'expired', order({ closedReason: 'pickup_timeout' }), {})).toContain('olib ketilmagani')
  })
  it('deadline is shown in Uzbekistan time', () => {
    expect(whenUz('2026-11-10T07:00:00Z')).toBe('10.11.2026 12:00')
    expect(whenUz('garbage')).toBe('')
  })
  it('real flow: new order -> 1 admin + 1 customer message; ready -> code to the customer only', async () => {
    const o = await place(A.token)
    expect(await deliverPickupOutbox(deps())).toMatchObject({ sent: 2, failed: 0 })
    expect(sentTexts(fx.adminTg)[0]).toContain('Yangi buyurtma')
    expect(sentTexts(fx.customerTg)[0]).toContain('qabul qilindi')
    expect(tg.every((c) => c.body.parse_mode === 'HTML' && c.url.startsWith('https://api.telegram.org/bot'))).toBe(true)
    await act('start_preparing', o.id)
    await act('mark_ready', o.id)
    tg = []
    await deliverPickupOutbox(deps())
    const code = (await sql`select pickup_code c from pickup_orders where id=${o.id}::uuid`)[0].c as string
    expect(sentTexts(fx.customerTg).join('\n')).toContain(code)
    expect(sentTexts(fx.adminTg).join('\n')).not.toContain(code)
    expect(sentTexts(fx.customerTg).filter((t) => t.includes(code))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------- outbox
describe('outbox retry and no duplicate sends', () => {
  it('a failed send is retried later with backoff, then sent exactly once', async () => {
    await place(A.token)
    tgMode = 'throw'
    expect(await deliverPickupOutbox(deps())).toMatchObject({ sent: 0, failed: 2 })
    let rows = await outbox()
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 1 && r.leased)).toBe(true)
    expect(rows.every((r) => r.last_error && !String(r.last_error).includes(BOT_TOKEN))).toBe(true)
    tgMode = 'ok'
    tg = []
    expect(await deliverPickupOutbox(deps())).toMatchObject({ sent: 0 }) // backoff: not due yet
    expect(tg).toHaveLength(0)
    await sql`update pickup_outbox set next_attempt_at = now() - interval '1 second'`
    expect(await deliverPickupOutbox(deps())).toMatchObject({ sent: 2, failed: 0 })
    rows = await outbox()
    expect(rows.every((r) => r.status === 'sent' && r.last_error === null)).toBe(true)
    tg = []
    await sql`update pickup_outbox set next_attempt_at = now() - interval '1 second'`
    expect(await deliverPickupOutbox(deps())).toMatchObject({ sent: 0 }) // sent rows are never sent again
    expect(tg).toHaveLength(0)
  })
  it('after 6 failed attempts the message is marked failed and no longer retried; Telegram errors are recorded without the token', async () => {
    await place(A.token)
    tgMode = 'http403'
    for (let i = 0; i < 6; i++) {
      await deliverPickupOutbox(deps())
      await sql`update pickup_outbox set next_attempt_at = now() - interval '1 second' where status = 'pending'`
    }
    const rows = await outbox()
    expect(rows.every((r) => r.status === 'failed' && r.attempts === 6)).toBe(true)
    expect(rows[0].last_error).toContain('blocked by the user')
    tg = []
    await deliverPickupOutbox(deps())
    expect(tg).toHaveLength(0)
    expect(JSON.stringify(logs)).not.toContain(BOT_TOKEN)
  })
  it('parallel deliveries (cron + background + retries) send every message exactly once', async () => {
    tgMode = 'slow'
    for (let i = 0; i < 3; i++) await place(A.token, { items: [{ productId: 'P3', size: 'S', color: 'Oq', qty: 1 }] })
    const total = Number((await sql`select count(*)::int n from pickup_outbox`)[0].n)
    await Promise.all(Array.from({ length: 6 }, () => deliverPickupOutbox(deps())))
    expect(sentTexts()).toHaveLength(total)
    expect((await outbox()).every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true)
  })
  it('without BOT_TOKEN nothing is sent and the messages stay queued untouched', async () => {
    await place(A.token)
    env = { ...env, BOT_TOKEN: undefined }
    expect(await deliverPickupOutbox(deps())).toMatchObject({ reason: 'NO_BOT_TOKEN', sent: 0 })
    expect((await outbox()).every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true)
  })
  it('a "ready" message is skipped (not sent) if the order was cancelled meanwhile', async () => {
    const o = await place(A.token)
    await deliverPickupOutbox(deps())
    await act('start_preparing', o.id)
    await act('mark_ready', o.id)
    expect((await quiet(() => adm('POST', { token: ADM.token, body: { action: 'cancel', id: o.id, reason: 'Xato' } }))).status).toBe(200)
    tg = []
    const r = await deliverPickupOutbox(deps())
    expect(r.skipped).toBeGreaterThanOrEqual(1)
    expect(sentTexts(fx.customerTg).join('\n')).not.toMatch(/Pickup kodi/)
  })
  it("the Cart's notification_outbox is untouched by pickup delivery", async () => {
    await place(A.token)
    const before = (await sql`select count(*)::int n from notification_outbox`)[0].n
    await deliverPickupOutbox(deps())
    expect((await sql`select count(*)::int n from notification_outbox`)[0].n).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------- sweep endpoint
describe('pickup-sweep: authentication', () => {
  it('wrong, empty or missing CRON_SECRET -> 401 and NOTHING runs', async () => {
    const o = await place(A.token)
    await sql`update pickup_orders set pending_expires_at = now() - interval '1 minute' where id = ${o.id}::uuid`
    for (const s of ['wrong-secret-value-0123456789', '', CRON_SECRET + 'x', CRON_SECRET.slice(0, -1), null]) {
      const r = await sweep(s)
      expect(r.status, String(s)).toBe(401)
      expect(((await r.json()) as any).error.code).toBe('UNAUTHENTICATED')
    }
    expect((await status(o.id)).status).toBe('pending')
    expect((await sql`select count(*)::int n from job_heartbeats`)[0].n).toBe(0)
    expect(tg).toHaveLength(0)
  })
  it('the correct secret -> 200 with the sweep result; GET is refused; a short/missing server secret is a config error', async () => {
    const r = await sweep()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ sweep: { expiredPending: 0, expiredReady: 0 }, outbox: { sent: 0 } })
    expect([404, 405]).toContain((await sweep(CRON_SECRET, 'GET')).status)
    env = { ...env, CRON_SECRET: undefined }
    expect((await sweep()).status).toBe(500)
    env = { ...env, CRON_SECRET: 'short' }
    expect((await sweep('short')).status).toBe(500)
  })
  it('a customer or admin session token is not a substitute for the cron secret', async () => {
    const r = await call(sweepHandler(deps()), 'POST', { token: ADM.token })
    expect(r.status).toBe(401)
  })
})

describe('pickup-sweep: expiry rules', () => {
  const ageReservation = (id: string) => sql`update stock_reservations set expires_at = now() - interval '1 second' where order_id = ${id}::uuid and expires_at is not null`

  it('pending lasts 30 minutes: not expired at 29, expired at 30 -> reservation released, customer told', async () => {
    const o = await place(A.token)
    const t = (await sql`select extract(epoch from (pending_expires_at - created_at)) s from pickup_orders where id=${o.id}::uuid`)[0].s
    expect(Number(t)).toBe(1800)
    const free = await avail()
    expect(free).toBe(3) // 5 - 2 reserved
    await sql`update pickup_orders set pending_expires_at = now() + interval '1 minute' where id = ${o.id}::uuid` // 29 minutes old
    expect((await (await sweep()).json() as any).sweep.expiredPending).toBe(0)
    expect((await status(o.id)).status).toBe('pending')
    await sql`update pickup_orders set pending_expires_at = now() - interval '1 second' where id = ${o.id}::uuid` // 30 minutes old
    await ageReservation(o.id)
    const res = (await (await sweep()).json()) as any
    expect(res.sweep).toMatchObject({ expiredPending: 1, expiredReady: 0 })
    expect(await status(o.id)).toEqual({ status: 'expired', closed_reason: 'pending_timeout' })
    expect(await avail()).toBe(5)
    expect((await sql`select status from stock_reservations where order_id=${o.id}::uuid`)[0].status).toBe('released')
    expect(res.outbox.sent).toBeGreaterThanOrEqual(1)
    expect(sentTexts(fx.customerTg).join('\n')).toContain('qabul qilinmagani')
    expect((await sql`select quantity from inventory where variant_id=(select id from product_variants where product_id='P1' and size='M')`)[0].quantity).toBe(5) // stock itself untouched
  })
  it('ready_for_pickup holds 24 hours: not expired at 23h59, expired after 24h -> reservation released', async () => {
    const o = await place(A.token)
    await act('start_preparing', o.id)
    await act('mark_ready', o.id)
    const s = (await sql`select extract(epoch from (ready_expires_at - ready_at)) s from pickup_orders where id=${o.id}::uuid`)[0].s
    expect(Number(s)).toBe(86400)
    await sql`update pickup_orders set ready_expires_at = now() + interval '1 minute' where id = ${o.id}::uuid`
    expect(((await (await sweep()).json()) as any).sweep.expiredReady).toBe(0)
    expect((await status(o.id)).status).toBe('ready_for_pickup')
    expect(await avail()).toBe(3)
    await sql`update pickup_orders set ready_expires_at = now() - interval '1 second' where id = ${o.id}::uuid`
    await ageReservation(o.id)
    expect(((await (await sweep()).json()) as any).sweep).toMatchObject({ expiredPending: 0, expiredReady: 1 })
    expect(await status(o.id)).toEqual({ status: 'expired', closed_reason: 'pickup_timeout' })
    expect(await avail()).toBe(5)
    expect(sentTexts(fx.customerTg).join('\n')).toContain('olib ketilmagani')
  })
  it('the 30-minute rule does not apply to ready orders and the 24-hour rule not to pending ones', async () => {
    const p = await place(A.token, { items: [{ productId: 'P3', size: 'S', color: 'Oq', qty: 1 }] })
    const r = await place(A.token)
    await act('start_preparing', r.id)
    await act('mark_ready', r.id)
    // pending is overdue for 40 minutes but its 24h-style field is irrelevant; ready is 40 minutes old
    await sql`update pickup_orders set pending_expires_at = now() - interval '1 second' where id = ${p.id}::uuid`
    await sql`update pickup_orders set ready_at = now() - interval '40 minutes', pending_expires_at = now() - interval '40 minutes' where id = ${r.id}::uuid`
    await sweep()
    expect((await status(p.id)).status).toBe('expired')
    expect((await status(r.id)).status).toBe('ready_for_pickup')
  })
  it('a "preparing" order is NEVER auto-cancelled, however old; its reservation stays active with no expiry', async () => {
    const o = await place(A.token)
    await act('start_preparing', o.id)
    await sql`update pickup_orders set created_at = now() - interval '10 days', pending_expires_at = now() - interval '10 days' where id = ${o.id}::uuid`
    for (let i = 0; i < 3; i++) expect((await sweep()).status).toBe(200)
    expect((await status(o.id)).status).toBe('preparing')
    expect((await sql`select status, expires_at from stock_reservations where order_id=${o.id}::uuid`)[0]).toEqual({ status: 'active', expires_at: null })
    expect(await avail()).toBe(3)
  })
  it('completed, cancelled and expired orders are left alone; repeated sweeps are idempotent', async () => {
    const a = await place(A.token, { items: [{ productId: 'P3', size: 'S', color: 'Oq', qty: 1 }] })
    const b = await place(A.token, { items: [{ productId: 'P3', size: 'S', color: 'Oq', qty: 1 }] })
    expect((await quiet(() => cust('POST', { token: A.token, body: { action: 'cancel', id: a.id } }))).status).toBe(200)
    await sql`update pickup_orders set pending_expires_at = now() - interval '1 second' where id = ${b.id}::uuid`
    await ageReservation(b.id)
    expect(((await (await sweep()).json()) as any).sweep.expiredPending).toBe(1)
    const again = (await (await sweep()).json()) as any
    expect(again.sweep).toMatchObject({ expiredPending: 0, expiredReady: 0 })
    expect(await status(a.id)).toEqual({ status: 'cancelled', closed_reason: 'customer_cancelled' })
    expect(await status(b.id)).toEqual({ status: 'expired', closed_reason: 'pending_timeout' })
    const ev = await sql`select event from pickup_outbox where pickup_order_id=${b.id}::uuid and kind='pickup_customer'`
    expect(ev.filter((e) => e.event === 'expired')).toHaveLength(1) // one expiry message, not one per sweep
  })
  it('even if cron is down, an expired reservation stops blocking stock for new orders', async () => {
    const o = await place(A.token, { items: [{ productId: 'P2', size: 'Yagona', color: 'Oq', qty: 3 }] })
    const B = await login(700002)
    const blocked = await cust('POST', { token: B.token, body: { action: 'place', idempotencyKey: randomUUID(), contact: { name: 'Vali Aliyev', phone: CONTACT.phone }, items: [{ productId: 'P2', size: 'Yagona', color: 'Oq', qty: 1 }] } })
    expect(blocked.status).toBe(409)
    await sql`update stock_reservations set expires_at = now() - interval '1 second' where order_id=${o.id}::uuid`
    const ok = await cust('POST', { token: B.token, body: { action: 'place', idempotencyKey: randomUUID(), contact: { name: 'Vali Aliyev', phone: CONTACT.phone }, items: [{ productId: 'P2', size: 'Yagona', color: 'Oq', qty: 1 }] } })
    expect(ok.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------------------------- health
describe('cron health detection (job_heartbeats)', () => {
  const health = async () => ((await (await adm('GET', { token: ADM.token, query: '?view=health' })).json()) as any)

  it("'never' before the first run, 'ok' after a sweep", async () => {
    expect(await health()).toMatchObject({ healthy: false, sweep: { status: 'never' } })
    await sweep()
    const h = await health()
    expect(h).toMatchObject({ healthy: true, sweep: { status: 'ok' }, overdue: { pending: 0, ready: 0 } })
    expect(h.sweep.ageSeconds).toBeLessThan(5)
  })
  it("'stale' when no run for more than 3 minutes (cron stopped)", async () => {
    await sweep()
    await sql`update job_heartbeats set last_run_at = now() - interval '10 minutes', last_ok_at = now() - interval '10 minutes'`
    expect(await health()).toMatchObject({ healthy: false, sweep: { status: 'stale' } })
  })
  it("'failing' when the job keeps running but the sweep raises; recovers to 'ok' afterwards; never fakes a success", async () => {
    await sweep()
    await sql`update job_heartbeats set last_ok_at = now() - interval '10 minutes'`
    await sql`alter function public.sweep_pickup() rename to sweep_pickup_real`
    await sql`create function public.sweep_pickup() returns jsonb language plpgsql as $$ begin raise exception 'boom: internal detail'; end $$`
    const r = await sweep()
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('boom')
    const h = await health()
    expect(h).toMatchObject({ healthy: false, sweep: { status: 'failing' } })
    expect((await sql`select last_result from job_heartbeats`)[0].last_result).toEqual({ error: 'SWEEP_FAILED' })
    await sql`drop function public.sweep_pickup()`
    await sql`alter function public.sweep_pickup_real() rename to sweep_pickup`
    expect((await sweep()).status).toBe(200)
    expect(await health()).toMatchObject({ healthy: true, sweep: { status: 'ok' } })
  })
  it('overdue open orders make the system unhealthy even when the heartbeat is fresh', async () => {
    const o = await place(A.token)
    await sweep()
    await sql`update pickup_orders set pending_expires_at = now() - interval '5 minutes' where id=${o.id}::uuid`
    expect(await health()).toMatchObject({ healthy: false, sweep: { status: 'ok' }, overdue: { pending: 1 } })
  })
  it('reports the bot-message backlog', async () => {
    await place(A.token)
    expect((await health()).outbox).toMatchObject({ pending: 2, failed: 0 })
  })
  it('the health view is admin only (customers 403, no token 401)', async () => {
    expect((await adm('GET', { token: A.token, query: '?view=health' })).status).toBe(403)
    expect((await adm('GET', { query: '?view=health' })).status).toBe(401)
    for (const fn of ['pickup_health(900001)', 'pickup_sweep_failed(\'x\')']) {
      const [{ ok }] = await sql.unsafe(`select has_function_privilege('anon', 'public.${fn.replace(/\(.*/, '')}(${fn.startsWith('pickup_health') ? 'bigint' : 'text'})', 'execute') ok`)
      expect(ok).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------- cron script
describe('supabase/ops/cron_pickup.sql', () => {
  const script = readFileSync('supabase/ops/cron_pickup.sql', 'utf8')
  // pg_cron / pg_net / Vault are Supabase extensions: tiny stand-ins let us run the real script text
  const stubs = async () => {
    await sql.unsafe(`
      create schema cron; create schema net; create schema vault;
      create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text);
      create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
      create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
      create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as $$ select 1::bigint $$;
      create table vault.decrypted_secrets (name text, decrypted_secret text);`)
  }
  const run = () => sql.unsafe(script.replace(/create extension[^;]*;/g, ''))

  it('contains no secret value, only the Vault secret NAMES', () => {
    expect(script).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|\b[0-9a-f]{32,}\b/i)
    expect(script).not.toContain(CRON_SECRET)
    expect(script).toContain("'aynimo_cron_secret'")
    expect(script).toContain("'* * * * *'")
    expect(script).toContain('/functions/v1/pickup-sweep')
    expect(script).toMatch(/vault\.decrypted_secrets/)
  })
  it('refuses to schedule while the Vault secrets are missing or too short', async () => {
    await stubs()
    await expect(run()).rejects.toThrow(/aynimo_cron_secret/)
    await sql`insert into vault.decrypted_secrets values ('aynimo_cron_secret', 'short')`
    await expect(run()).rejects.toThrow(/aynimo_cron_secret/)
    await sql`update vault.decrypted_secrets set decrypted_secret = ${CRON_SECRET}`
    await expect(run()).rejects.toThrow(/aynimo_project_url/)
    await sql`insert into vault.decrypted_secrets values ('aynimo_project_url', 'http://evil.example')`
    await expect(run()).rejects.toThrow(/aynimo_project_url/)
    expect((await sql`select count(*)::int n from cron.job`)[0].n).toBe(0)
  })
  it('schedules exactly one every-minute job, is idempotent, and the job text holds no secret value', async () => {
    await stubs()
    await sql`insert into vault.decrypted_secrets values ('aynimo_cron_secret', ${CRON_SECRET}), ('aynimo_project_url', 'https://abcdefgh.supabase.co')`
    await run()
    await run()
    const jobs = await sql`select jobname, schedule, command from cron.job`
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ jobname: 'aynimo-pickup-sweep', schedule: '* * * * *' })
    expect(jobs[0].command).not.toContain(CRON_SECRET)
    expect(jobs[0].command).toContain('x-cron-secret')
  })
  it('the read-only check script parses as SQL (against the same stand-ins)', async () => {
    const check = readFileSync('supabase/ops/cron_pickup_check.sql', 'utf8')
    expect(check).not.toMatch(/insert |update |delete |drop |alter /i)
    expect(check).not.toMatch(/decrypted_secret/)
  })
})

// ---------------------------------------------------------------------------------------------- secret hygiene
describe('secret hygiene (stage C)', () => {
  it('no response or log line of any stage-C path contains the bot token, session secret or cron secret', async () => {
    const o = await place(A.token)
    tgMode = 'throw'
    const bodies = [await (await sweep('nope-nope-nope-nope-1234')).text(), await (await sweep()).text()]
    await act('start_preparing', o.id)
    bodies.push(await (await adm('GET', { token: ADM.token, query: '?view=health' })).text())
    const all = bodies.join('\n') + JSON.stringify(logs) + JSON.stringify(await outbox())
    for (const s of [BOT_TOKEN, SESSION_SECRET, CRON_SECRET]) expect(all).not.toContain(s)
  })
  it('the frontend (src) never mentions BOT_TOKEN, CRON_SECRET or pickup-sweep', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]))
    for (const f of walk('src')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/BOT_TOKEN|CRON_SECRET|pickup-sweep|aynimo_cron_secret/)
  })
  it('no tracked source/ops/workflow file holds a bot-token-shaped or JWT-shaped secret', () => {
    const files = ['supabase/ops/cron_pickup.sql', 'supabase/ops/cron_pickup_check.sql', ...readdirSync('supabase/functions/_shared').map((f) => `supabase/functions/_shared/${f}`),
      ...['pickup-sweep', 'pickup-order', 'admin-pickup'].flatMap((d) => readdirSync(`supabase/functions/${d}`).map((f) => `supabase/functions/${d}/${f}`)), '.github/workflows/supabase-deploy.yml']
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\./)
  })
})
