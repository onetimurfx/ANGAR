/**
 * Stage E: the admin-api Edge Function against a REAL PostgreSQL (all migrations applied).
 * Authentication and authorization on every request, client-supplied identity being ignored, input validation,
 * error mapping, owner-only actions, Storage signing (mocked, server-only key) and secret hygiene.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { issueSession } from '../../supabase/functions/_shared/session.ts'
import type { Deps } from '../../supabase/functions/_shared/types.ts'
import { handler as authHandler } from '../../supabase/functions/telegram-auth/handler.ts'
import { handler as apiHandler } from '../../supabase/functions/admin-api/handler.ts'
import { line, newTestDb, placeOrder, seed, type Fixture } from './fixtures'

const BOT_TOKEN = '7000000001:AAFakeTokenForTestsOnly_abcdefghijklmnopqrstu'
const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const SERVICE_KEY = 'service-role-key-SECRET-0123456789-abcdefghijklmnop'
const SUPABASE_URL = 'https://proj.supabase.co'
const ORIGIN = 'https://shop.example'
const NOW = Date.now()
const OWNER = 900001
const MANAGER = 900002

const signInitData = (fields: Record<string, string>) => {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString()
}
const initFor = (id: number) => signInitData({ auth_date: String(Math.floor(NOW / 1000) - 60), query_id: 'AAH', user: JSON.stringify({ id, first_name: 'Ali', language_code: 'uz' }) })

let sql: postgres.Sql
let fx: Fixture
let logs: string[] = []
let bg: Promise<unknown>[] = []
let fetches: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
let storageOk = true
let env: Deps['env']

const deps = (): Deps => ({
  sql: sql as unknown as Deps['sql'],
  env,
  now: () => NOW,
  log: (msg, extra) => void logs.push(JSON.stringify({ msg, ...extra })),
  background: (p) => void bg.push(p),
  fetch: (async (url: string, init: RequestInit = {}) => {
    fetches.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined })
    if (url.includes('/storage/v1/object/upload/sign/')) {
      return storageOk
        ? new Response(JSON.stringify({ url: `/object/upload/sign/product-images/x?token=tok123` }), { status: 200 })
        : new Response('{}', { status: 500 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch,
})
const call = (method: string, o: { token?: string; body?: unknown; query?: string; headers?: Record<string, string> } = {}) =>
  apiHandler(deps())(new Request(`https://x.supabase.co/functions/v1/admin-api${o.query ?? ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(o.token ? { 'x-aynimo-session': o.token } : {}), ...o.headers },
    body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
  }))
const get = (token: string | undefined, query: string) => call('GET', { token, query })
const post = (token: string | undefined, body: unknown) => call('POST', { token, body })
const login = async (tg: number) => {
  const res = await authHandler(deps())(new Request('https://x/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: initFor(tg) }) }))
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; customerId: string; isAdmin: boolean }
}
const j = async (r: Response) => (await r.json()) as any

let O: { token: string; customerId: string; isAdmin: boolean }
let M: { token: string }
let C: { token: string; customerId: string; isAdmin: boolean }

beforeAll(async () => {
  ;({ sql } = await newTestDb('aapi'))
  fx = await seed(sql)
  await sql`insert into administrators (telegram_id, name, role) values (${MANAGER}, 'Menejer', 'manager')`
  env = { BOT_TOKEN, SESSION_SECRET, ALLOWED_ORIGINS: ORIGIN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }
  O = await login(OWNER)
  M = await login(MANAGER)
  C = await login(fx.customerTg)
})
afterAll(async () => void (await sql?.end()))

describe('authentication and authorization (every request)', () => {
  const requests: [string, () => Promise<Response>][] = []
  const mk = (tok: string | undefined) => [
    ['GET me', () => get(tok, '?r=me')],
    ['GET dashboard', () => get(tok, '?r=dashboard')],
    ['GET orders', () => get(tok, '?r=orders')],
    ['GET settings', () => get(tok, '?r=settings')],
    ['POST set_status', () => post(tok, { r: 'order', action: 'set_status', id: randomUUID(), status: 'confirmed' })],
    ['POST settings', () => post(tok, { r: 'settings', action: 'update', settings: { deliveryFee: 1 } })],
  ] as [string, () => Promise<Response>][]
  void requests

  it('no token, garbage, wrong secret and expired tokens -> 401 on every route', async () => {
    const wrong = (await issueSession({ sub: C.customerId, tg: OWNER }, SESSION_SECRET + 'x', NOW)).token
    const expired = (await issueSession({ sub: C.customerId, tg: OWNER }, SESSION_SECRET, NOW - 2 * 3600 * 1000)).token
    for (const t of [undefined, 'garbage', 'a.b', wrong, expired]) for (const [n, f] of mk(t)) expect((await f()).status, `${n} ${t}`).toBe(401)
  })
  it('a customer (not an administrator) gets 403 everywhere and nothing is changed', async () => {
    const before = Number((await sql`select count(*) from admin_audit_log`)[0].count)
    for (const [n, f] of mk(C.token)) expect((await f()).status, n).toBe(403)
    expect(Number((await sql`select count(*) from admin_audit_log`)[0].count)).toBe(before)
  })
  it('an administrator deactivated after login is refused on the very next call', async () => {
    const x = await login(900050)
    await sql`insert into administrators (telegram_id, name, role) values (900050, 'Vaqtincha', 'manager')`
    expect((await get(x.token, '?r=me')).status).toBe(200)
    await sql`update administrators set active = false where telegram_id = 900050`
    expect((await get(x.token, '?r=me')).status).toBe(403)
  })
  it('identity comes from the session only: tg / admin in the query, headers or body change nothing', async () => {
    const r = await call('GET', { token: C.token, query: `?r=me&tg=${OWNER}&admin=${OWNER}`, headers: { 'x-telegram-id': String(OWNER), 'x-admin': 'true' } })
    expect(r.status).toBe(403)
    const p = await call('POST', { token: C.token, body: { r: 'settings', action: 'update', tg: OWNER, admin: OWNER, role: 'owner', settings: { deliveryFee: 1 } } })
    expect(p.status).toBe(403)
    expect((await j(await get(M.token, `?r=me&tg=${OWNER}`))).role).toBe('manager')
    expect((await j(await get(O.token, '?r=me'))).role).toBe('owner')
  })
  it('a manager cannot use owner actions, and the owner can', async () => {
    expect((await post(M.token, { r: 'settings', action: 'update', settings: { deliveryFee: 1 } })).status).toBe(403)
    expect((await post(M.token, { r: 'settings', action: 'update_pickup', pickup: { maxLines: 5 } })).status).toBe(403)
    expect((await post(M.token, { r: 'category', action: 'delete', id: 'c1' })).status).toBe(403)
    const ok = await post(O.token, { r: 'settings', action: 'update', settings: { deliveryFee: 25000 } })
    expect(ok.status).toBe(200)
    expect((await j(ok)).settings.deliveryFee).toBe(25000) // arrived as an object, not as a double-encoded string
    expect((await j(await get(M.token, '?r=settings'))).admins).toBeNull()
    expect((await j(await get(O.token, '?r=settings'))).admins.length).toBeGreaterThan(1)
  })
  it('admin rights cannot be granted through the API', async () => {
    const before = await sql`select telegram_id, role, active from administrators order by telegram_id`
    for (const body of [
      { r: 'admin', action: 'add', telegramId: 123, role: 'owner' }, { r: 'administrators', action: 'save', telegramId: 123 },
      { r: 'customer', action: 'make_admin', id: C.customerId },
    ]) expect((await post(O.token, body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
    // unknown keys inside a valid settings update are ignored: they reach no table
    expect((await post(O.token, { r: 'settings', action: 'update', settings: { administrators: [{ telegramId: 123 }], role: 'owner' } })).status).toBe(200)
    for (const q of ['?r=admins', '?r=administrators']) expect((await get(O.token, q)).status).toBe(400)
    expect(await sql`select telegram_id, role, active from administrators order by telegram_id`).toEqual(before)
  })
  it('methods and unknown routes', async () => {
    expect((await call('PUT', { token: O.token })).status).toBe(405)
    expect((await call('DELETE', { token: O.token })).status).toBe(405)
    expect((await get(O.token, '')).status).toBe(400)
    expect((await get(O.token, '?r=nope')).status).toBe(400)
    for (const body of ['not json', '[]', '"x"', 'null', { r: 'order' }, { r: 'order', action: 'nope' }, { action: 'set_status' }, '{"r":"' + 'x'.repeat(70000) + '"}']) {
      expect((await post(O.token, body)).status, String(body).slice(0, 30)).toBe(400)
    }
  })
  it('CORS: preflight works and only the allowed origin is echoed', async () => {
    const r = await call('OPTIONS', { headers: { origin: ORIGIN } })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const x = await call('GET', { token: O.token, query: '?r=me', headers: { origin: 'https://evil.example' } })
    expect(x.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('reads', () => {
  it('every resource answers 200 for an administrator', async () => {
    const order = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    for (const q of ['?r=me', '?r=dashboard', '?r=orders', `?r=order&id=${order.order.id}`, '?r=categories', '?r=brands', '?r=products', '?r=product&id=P1', '?r=inventory', '?r=customers', `?r=customer&id=${fx.customer}`, '?r=settings']) {
      expect((await get(M.token, q)).status, q).toBe(200)
    }
    const d = await j(await get(M.token, '?r=dashboard'))
    expect(d.cart).toBeTruthy()
    expect(d.pickup).toBeTruthy()
  })
  it('validates query parameters', async () => {
    for (const q of ['?r=order', '?r=order&id=nope', '?r=product&id=a/b', '?r=customer&id=1', '?r=orders&limit=0', '?r=orders&limit=101', '?r=orders&limit=x', '?r=orders&offset=-1', `?r=orders&q=${'x'.repeat(101)}`, '?r=inventory&low=-1', '?r=orders&status=bogus', '?r=orders&source=bogus', '?r=inventory&filter=bogus', '?r=products&status=bogus']) {
      expect((await get(M.token, q)).status, q).toBe(400)
    }
    expect((await get(M.token, `?r=order&id=${randomUUID()}`)).status).toBe(404)
    expect((await get(M.token, '?r=product&id=yo-q')).status).toBe(404)
    expect((await get(M.token, `?r=customer&id=${randomUUID()}`)).status).toBe(404)
  })
  it('a hostile search string is just text', async () => {
    for (const q of ["'; drop table orders; --", '%', '_', '\\', '😀']) {
      expect((await get(M.token, `?r=orders&q=${encodeURIComponent(q)}`)).status, q).toBe(200)
      expect((await get(M.token, `?r=customers&q=${encodeURIComponent(q)}`)).status, q).toBe(200)
    }
    expect(Number((await sql`select count(*) from orders`)[0].count)).toBeGreaterThan(0)
  })
})

describe('Cart orders', () => {
  it('moves an order through the flow; the customer is notified through the outbox + bot in the background', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P1', 'M', 'Qora', 1)])
    fetches = []; bg = []
    const r = await post(M.token, { r: 'order', action: 'set_status', id: order.id, status: 'confirmed' })
    expect(r.status).toBe(200)
    expect((await j(r)).order.status).toBe('confirmed')
    await Promise.all(bg)
    expect(fetches.some((f) => f.url.includes('api.telegram.org') && f.url.includes('/sendMessage'))).toBe(true)
    expect((await j(await get(M.token, `?r=order&id=${order.id}`))).history.map((h: any) => h.status)).toEqual(['new', 'confirmed'])
  })
  it('maps database errors to clean answers', async () => {
    const { order } = await placeOrder(sql, fx.customer, [line('P3', 'S', 'Oq', 1)])
    const s = (status: unknown, note?: unknown) => post(M.token, { r: 'order', action: 'set_status', id: order.id, status, note })
    expect((await s('delivered')).status).toBe(409)
    expect((await j(await s('delivered'))).error.code).toBe('INVALID_TRANSITION')
    expect((await s('cancelled')).status).toBe(422)
    expect((await j(await s('cancelled'))).error.code).toBe('INVALID_REASON')
    expect((await s('bogus')).status).toBe(400)
    expect((await post(M.token, { r: 'order', action: 'set_status', id: 'nope', status: 'confirmed' })).status).toBe(400)
    expect((await post(M.token, { r: 'order', action: 'set_status', id: randomUUID(), status: 'confirmed' })).status).toBe(404)
    expect((await s('cancelled', 'Mijoz rad etdi')).status).toBe(200)
  })
  it('sets the delivery fee', async () => {
    await post(O.token, { r: 'settings', action: 'update', settings: { deliveryFee: null } })
    const { order } = await placeOrder(sql, fx.customer, [line('P2', 'Yagona', 'Oq', 1)])
    const r = await post(M.token, { r: 'order', action: 'set_delivery', id: order.id, fee: 20000 })
    expect(r.status).toBe(200)
    expect((await j(r)).order.total).toBe(270000)
    for (const fee of ['20', -1, 1.5, null, undefined]) expect((await post(M.token, { r: 'order', action: 'set_delivery', id: order.id, fee })).status, String(fee)).toBe(400)
  })
})

describe('catalog management', () => {
  it('categories and brands', async () => {
    const c = await j(await post(M.token, { r: 'category', action: 'save', name: 'Yangi', sortOrder: 4, active: true }))
    expect(c.category.id).toBe('yangi')
    expect((await post(M.token, { r: 'category', action: 'save', id: 'c1', name: 'K', active: false })).status).toBe(409)
    expect((await j(await post(M.token, { r: 'category', action: 'save', id: 'c1', name: 'K', active: false }))).error.code).toBe('IN_USE')
    expect((await post(M.token, { r: 'category', action: 'save', id: 'Bad Id', name: 'K', active: true })).status).toBe(400)
    expect((await post(O.token, { r: 'category', action: 'delete', id: 'yangi' })).status).toBe(200)
    expect((await post(M.token, { r: 'brand', action: 'save', name: 'Yangi brend', type: 'other', active: true })).status).toBe(200)
    expect((await post(M.token, { r: 'brand', action: 'save', name: 'X', type: 'weird', active: true })).status).toBe(400)
  })
  let pid = ''
  it('creates and edits a product with variants', async () => {
    const product = { name: "Yangi ko'ylak", brandId: 'b1', categoryId: 'c1', description: 'T', price: 150000, oldPrice: null, active: true, variants: [{ size: 'M', colorName: 'Oq', colorHex: '#FFFFFF', quantity: 5 }] }
    const r = await post(M.token, { r: 'product', action: 'save', product })
    expect(r.status).toBe(200)
    pid = (await j(r)).product.id
    const bad = await post(M.token, { r: 'product', action: 'save', product: { ...product, price: -5 } })
    expect(bad.status).toBe(400)
    expect((await j(bad)).error).toMatchObject({ code: 'INVALID_REQUEST', field: 'price' })
    const dup = await post(M.token, { r: 'product', action: 'save', product: { ...product, id: pid } })
    expect(dup.status).toBe(409)
    expect((await j(dup)).error.code).toBe('DUPLICATE_VARIANT')
    expect((await post(M.token, { r: 'product', action: 'save', product: [] })).status).toBe(400)
    expect((await post(M.token, { r: 'product', action: 'set_active', id: pid, active: false })).status).toBe(200)
    expect((await post(M.token, { r: 'product', action: 'set_active', id: pid, active: 'no' })).status).toBe(400)
  })
  it('only the owner may flag a product as a sample', async () => {
    const cur = (await j(await get(M.token, `?r=product&id=${pid}`))).product
    const send = (t: string) => post(t, { r: 'product', action: 'save', product: { id: pid, name: cur.name, brandId: 'b1', categoryId: 'c1', price: cur.price, isSample: true } })
    expect((await send(M.token)).status).toBe(403)
    expect((await send(O.token)).status).toBe(200)
  })
  it('stock: adjusts, refuses below the reserved amount', async () => {
    const v = (await sql`select id from product_variants where product_id = 'P3' limit 1`)[0].id as string
    const r = await post(M.token, { r: 'inventory', action: 'adjust', variantId: v, mode: 'set', value: 12, reason: 'Sanoq' })
    expect(r.status).toBe(200)
    expect((await j(r)).quantity).toBe(12)
    await sql`select place_pickup_order(${fx.customer}::uuid, ${randomUUID()}::uuid, 'Ali Valiyev', '+998901234567', null, ${sql.json([{ productId: 'P3', size: 'S', color: 'Oq', qty: 5 }] as never)})`
    const low = await post(M.token, { r: 'inventory', action: 'adjust', variantId: v, mode: 'set', value: 2 })
    expect(low.status).toBe(409)
    expect((await j(low)).error).toMatchObject({ code: 'STOCK_BELOW_RESERVED', reserved: 5 })
    for (const body of [{ variantId: 'x', mode: 'set', value: 1 }, { variantId: v, mode: 'set', value: '1' }, { variantId: v, mode: 'set', value: 1.5 }, { variantId: v, mode: 'set' }, { variantId: v, value: 1 }]) {
      expect((await post(M.token, { r: 'inventory', action: 'adjust', ...body })).status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('product images (Storage signing happens on the server)', () => {
  let pid = ''
  beforeAll(async () => {
    pid = (await j(await post(M.token, { r: 'product', action: 'save', product: { name: 'Rasmli', brandId: 'b1', categoryId: 'c1', price: 1000 } }))).product.id
  })
  it('issues a signed upload URL for one path of THIS product; the service key never leaves the server', async () => {
    fetches = []
    const r = await post(M.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: 'image/jpeg' })
    expect(r.status).toBe(200)
    const b = await j(r)
    expect(b.path).toMatch(new RegExp(`^products/${pid}/[0-9a-f-]{36}\\.jpg$`))
    expect(b.uploadUrl).toBe(`${SUPABASE_URL}/storage/v1/object/upload/sign/product-images/x?token=tok123`)
    expect(JSON.stringify(b)).not.toContain(SERVICE_KEY)
    const sign = fetches.find((f) => f.url.includes('/upload/sign/'))!
    expect(sign.url).toContain(`/product-images/${b.path}`)
    expect(sign.headers.authorization).toBe(`Bearer ${SERVICE_KEY}`)
  })
  it('refuses other types, unknown products, customers; reports Storage being down', async () => {
    for (const ct of ['image/gif', 'text/html', 'image/svg+xml', 'application/pdf', '', 5]) expect((await post(M.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: ct })).status, String(ct)).toBeGreaterThanOrEqual(400)
    expect((await post(M.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: 'image/gif' })).status).toBe(415)
    expect((await post(M.token, { r: 'product', action: 'image_upload_url', id: 'yo-q', contentType: 'image/png' })).status).toBe(404)
    expect((await post(C.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: 'image/png' })).status).toBe(403)
    storageOk = false
    expect((await post(M.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: 'image/png' })).status).toBe(502)
    storageOk = true
    const saved = env
    env = { ...env, SUPABASE_SERVICE_ROLE_KEY: undefined }
    expect((await post(M.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: 'image/png' })).status).toBe(503)
    env = saved
  })
  it('registers, covers and deletes an image (the file is removed from Storage in the background)', async () => {
    const path = (await j(await post(M.token, { r: 'product', action: 'image_upload_url', id: pid, contentType: 'image/webp' }))).path as string
    const add = await post(M.token, { r: 'product', action: 'image_add', id: pid, path })
    expect(add.status).toBe(200)
    const imgs = (await j(add)).product.images
    expect(imgs.length).toBe(1)
    expect((await post(M.token, { r: 'product', action: 'image_add', id: pid, path: `products/other/${randomUUID()}.webp` })).status).toBe(400)
    expect((await post(M.token, { r: 'product', action: 'image_cover', id: imgs[0].id })).status).toBe(200)
    fetches = []; bg = []
    const del = await post(M.token, { r: 'product', action: 'image_delete', id: imgs[0].id })
    expect(del.status).toBe(200)
    await Promise.all(bg)
    expect(fetches.find((f) => f.method === 'DELETE')?.url).toBe(`${SUPABASE_URL}/storage/v1/object/product-images/${path}`)
    expect((await post(M.token, { r: 'product', action: 'image_delete', id: imgs[0].id })).status).toBe(404)
  })
})

describe('secret hygiene', () => {
  it('no response or log line contains the service-role key, bot token or session secret', async () => {
    const seen: string[] = []
    for (const q of ['?r=me', '?r=settings', '?r=dashboard', '?r=orders', '?r=nope']) seen.push(await (await get(O.token, q)).text())
    seen.push(await (await post(O.token, { r: 'product', action: 'image_upload_url', id: 'P1', contentType: 'image/png' })).text())
    seen.push(await (await get(undefined, '?r=me')).text(), await (await get(C.token, '?r=me')).text())
    for (const t of [...seen, ...logs]) for (const secret of [SERVICE_KEY, BOT_TOKEN, SESSION_SECRET]) expect(t).not.toContain(secret)
  })
  it('an unexpected database failure is a generic 500', async () => {
    const broken = { ...deps(), sql: ((s: TemplateStringsArray) => (s.join('').includes('is_admin') ? Promise.resolve([{ a: true }]) : Promise.reject(new Error('relation secret_table is broken')))) as unknown as Deps['sql'] }
    const r = await apiHandler(broken)(new Request('https://x/f?r=orders', { headers: { 'x-aynimo-session': O.token } }))
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('secret_table')
  })
})
