/**
 * LIVE test backend for the browser E2E: a real PostgreSQL (all migrations) + the REAL Edge Function handlers
 * behind the same URLs Supabase uses (/rest/v1/rpc/get_catalog, /functions/v1/<name>), plus the built app.
 * Only Telegram's Bot API is faked (messages are recorded). Test-only controls live under /__test/.
 *
 *   tsx tests/e2e/live-server.ts   -> prints "READY <apiPort> <webPort>" when everything is up
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import postgres from 'postgres'
import { asRole, buildTemplate, createDb, startServer, stopServer } from '../db/pg'
import type { Deps } from '../../supabase/functions/_shared/types.ts'
import { handler as authHandler } from '../../supabase/functions/telegram-auth/handler.ts'
import { handler as adminHandler } from '../../supabase/functions/admin-whoami/handler.ts'
import { handler as cartHandler } from '../../supabase/functions/cart/handler.ts'
import { handler as ordersHandler } from '../../supabase/functions/my-orders/handler.ts'
import { handler as placeHandler } from '../../supabase/functions/place-order/handler.ts'
import { handler as outboxHandler } from '../../supabase/functions/notify-outbox/handler.ts'
import { handler as pickupHandler } from '../../supabase/functions/pickup-order/handler.ts'
import { handler as adminPickupHandler } from '../../supabase/functions/admin-pickup/handler.ts'
import { handler as adminApiHandler } from '../../supabase/functions/admin-api/handler.ts'
import { handler as sweepHandler } from '../../supabase/functions/pickup-sweep/handler.ts'

export const BOT_TOKEN = '7000000001:AAFakeTokenForE2eOnly_abcdefghijklmnopqrstu'
const SESSION_SECRET = 'e2e-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
const API_PORT = Number(process.env.LIVE_API_PORT ?? 54321)
const WEB_PORT = Number(process.env.LIVE_WEB_PORT ?? 4174)
const WEB_DIR = resolve(process.env.LIVE_WEB_DIR ?? 'dist-live')
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`

const pg = startServer()
await buildTemplate(pg.port)
const dbUrl = await createDb(pg.port, `live_${process.pid}`)
const sql = postgres(dbUrl, { max: 10, onnotice: () => {}, prepare: false })

// ----------------------------------------------------------------- data (real-looking, NOT sample, plus one sample)
await sql`insert into brands (id, name, type) values ('b1', 'Test Brend', 'original'), ('b2', 'Boshqa Brend', 'other')`
await sql`insert into categories (id, name) values ('hoodies', 'Xudilar'), ('shoes', 'Poyabzal')`
async function product(id: string, name: string, brand: string, cat: string, price: number, opts: { sample?: boolean; active?: boolean; old?: number } = {}) {
  await sql`insert into products (id, name, description, brand_id, category_id, price, old_price, type, active, is_sample, popularity)
            values (${id}, ${name}, ${'Tavsif: ' + name}, ${brand}, ${cat}, ${price}, ${opts.old ?? null}, ${brand === 'b1' ? 'original' : 'other'}, ${opts.active ?? true}, ${opts.sample ?? false}, 10)`
}
async function variant(pid: string, size: string, color: string, hex: string, qty: number, active = true) {
  const [v] = await sql`insert into product_variants (product_id, size, color_name, color_hex, active) values (${pid}, ${size}, ${color}, ${hex}, ${active}) returning id`
  await sql`insert into inventory (variant_id, quantity) values (${v.id}, ${qty})`
}
await product('P1', 'Server Xudi', 'b1', 'hoodies', 100000, { old: 120000 })
await variant('P1', 'M', 'Qora', '#222222', 5)
await variant('P1', 'L', 'Qora', '#222222', 2)
await variant('P1', 'M', 'Oq', '#F2F2F2', 0)
await variant('P1', 'XL', 'Qora', '#222222', 9, false)
await product('P2', 'Server Krossovka', 'b2', 'shoes', 250000)
await variant('P2', '42', 'Oq', '#F2F2F2', 3)
await product('GONE', 'Yashirin mahsulot', 'b1', 'hoodies', 10000, { active: false })
await variant('GONE', 'M', 'Qora', '#222222', 5)
await product('SMP', 'Namuna Futbolka', 'b1', 'hoodies', 50000, { sample: true })
await variant('SMP', 'M', 'Qora', '#222222', 5)
await sql`insert into administrators (telegram_id, name, role) values (900001, 'Admin', 'owner'), (900002, 'Menejer', 'manager')`

// ----------------------------------------------------------------- Telegram Bot API (fake) + fault injection
const telegram: { chat_id: number; text: string }[] = []
const inject = { fail: 0 }
const storageLog: { op: string; path: string }[] = []
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input)
  if (target.includes('/storage/v1/object/upload/sign/product-images/')) {
    const path = target.split('/product-images/')[1]
    storageLog.push({ op: 'sign', path })
    return new Response(JSON.stringify({ url: `/object/upload/sign/product-images/${path}?token=e2e-token` }), { status: 200 })
  }
  if (init?.method === 'DELETE' && target.includes('/storage/v1/object/product-images/')) {
    storageLog.push({ op: 'delete', path: target.split('/product-images/')[1] })
    return new Response('{}', { status: 200 })
  }
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  telegram.push({ chat_id: body.chat_id, text: body.text })
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
}) as typeof fetch
const pending: Promise<unknown>[] = []
const deps = (): Deps => ({
  sql: sql as unknown as Deps['sql'],
  env: { BOT_TOKEN, SESSION_SECRET, ALLOWED_ORIGINS: ORIGIN, CRON_SECRET: 'e2e-cron-secret-0123456789', SUPABASE_URL: `http://127.0.0.1:${API_PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'e2e-service-role-SECRET-0123456789-abcdefghij' },
  fetch: fakeFetch,
  now: () => Date.now(),
  background: (p) => void pending.push(p),
  log: () => {},
})
const FUNCTIONS: Record<string, (d: Deps) => (r: Request) => Promise<Response>> = {
  'telegram-auth': authHandler, 'admin-whoami': adminHandler, cart: cartHandler, 'my-orders': ordersHandler, 'place-order': placeHandler, 'notify-outbox': outboxHandler,
  'pickup-order': pickupHandler, 'admin-pickup': adminPickupHandler, 'pickup-sweep': sweepHandler, 'admin-api': adminApiHandler,
}

const readBody = (req: IncomingMessage) => new Promise<Buffer>((res) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))) })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra })
  res.end(JSON.stringify(body))
}

const api = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${API_PORT}`)
    if (req.method === 'OPTIONS' && !url.pathname.startsWith('/functions/')) { res.writeHead(204, cors); return void res.end() }

    if (url.pathname === '/rest/v1/rpc/get_catalog') {
      if (!req.headers.apikey) return send(res, 401, { message: 'No API key' }, cors)
      const cat = await asRole(sql, 'anon', async (tx) => (await tx`select public.get_catalog() as c`)[0].c)
      return send(res, 200, cat, cors)
    }

    // fake Storage: signed uploads accepted, public photos answered with a 1x1 PNG
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/product-images/') && req.method === 'PUT') {
      await readBody(req)
      storageLog.push({ op: 'put', path: url.pathname.split('/product-images/')[1] })
      return send(res, url.searchParams.get('token') === 'e2e-token' ? 200 : 401, { Key: 'ok' }, cors)
    }
    if (url.pathname.startsWith('/storage/v1/object/public/product-images/')) {
      res.writeHead(200, { 'content-type': 'image/png', ...cors })
      return void res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    }

    if (url.pathname.startsWith('/functions/v1/')) {
      const name = url.pathname.slice('/functions/v1/'.length)
      const h = FUNCTIONS[name]
      if (!h) return send(res, 404, { error: { code: 'NOT_FOUND' } }, cors)
      if (inject.fail > 0 && req.method !== 'OPTIONS') { inject.fail--; return send(res, 500, { error: { code: 'INJECTED_FAILURE' } }, cors) }
      const body = await readBody(req)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const r = new Request(`https://x.supabase.co${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
      const out = await h(deps())(r)
      const h2: Record<string, string> = {}
      out.headers.forEach((v, k) => (h2[k] = v))
      res.writeHead(out.status, h2)
      return void res.end(Buffer.from(await out.arrayBuffer()))
    }

    // ------------------------------------------------ test controls (never part of the product)
    if (url.pathname.startsWith('/__test/')) {
      await Promise.allSettled(pending.splice(0))
      const op = url.pathname.slice('/__test/'.length)
      const q = (k: string) => url.searchParams.get(k) ?? ''
      if (op === 'state') {
        const orders = await sql`select id, order_number, status, total, delivery_pending, delivery_fee from orders order by created_at`
        const stock = await sql`select p.product_id, p.size, p.color_name, i.quantity from product_variants p join inventory i on i.variant_id = p.id order by 1, 2, 3`
        const cart = await sql`select product_id, size, color_name, qty from cart_items order by 1, 2`
        const outbox = await sql`select kind, status, attempts from notification_outbox order by id`
        const pickup = await sql`select id, order_number, status, total, payment_status, pickup_code from pickup_orders order by created_at`
        const reservations = await sql`select status, qty from stock_reservations order by created_at`
        return send(res, 200, { orders, stock, cart, telegram, outbox, pickup, reservations, customers: (await sql`select count(*)::int n from customers`)[0].n }, cors)
      }
      if (op === 'admin-state') {
        return send(res, 200, {
          orders: await sql`select id, order_number, status, total, delivery_fee, delivery_pending from orders order by created_at`,
          products: await sql`select id, name, price, active, brand_id, category_id from products order by created_at`,
          stock: await sql`select p.product_id, p.size, p.color_name, i.quantity from product_variants p join inventory i on i.variant_id = p.id order by 1, 2, 3`,
          images: await sql`select product_id, path from product_images order by sort_order`,
          categories: await sql`select id, name, active from categories order by sort_order, name`,
          audit: await sql`select action, admin_telegram_id::int as admin from admin_audit_log order by id`,
          settings: (await sql`select delivery_fee, delivery_free_from from settings`)[0],
          pickupSettings: (await sql`select store_address, pending_timeout_minutes from pickup_settings`)[0],
          pickup: await sql`select id, order_number, status, total, pickup_code from pickup_orders order by created_at`,
          admins: await sql`select telegram_id::int as tg, role, active from administrators order by telegram_id`,
          telegram, storage: storageLog,
        }, cors)
      }
      if (op === 'seed-cart-order') {
        const tg = Number(q('tg') || 700001)
        const [c] = await sql`select public.upsert_customer(${tg}::bigint, 'Ali', 'Valiyev', ${'u' + tg}, null, 'uz') as id`
        const [r] = await sql`select public.place_order(${c.id}::uuid, gen_random_uuid(), 'cart', 'Ali Valiyev', '+998901234567', 'Toshkent, Chilonzor 9', 'Ertalab', ${sql.json([{ productId: q('product') || 'P1', size: q('size') || 'M', color: q('color') || 'Qora', qty: Number(q('qty') || 1) }] as never)}) as r`
        return send(res, 200, r.r, cors)
      }
      if (op === 'seed-pickup-order') {
        const tg = Number(q('tg') || 700001)
        const [c] = await sql`select public.upsert_customer(${tg}::bigint, 'Ali', 'Valiyev', ${'u' + tg}, null, 'uz') as id`
        const [r] = await sql`select public.place_pickup_order(${c.id}::uuid, gen_random_uuid(), 'Ali Valiyev', '+998901234567', null, ${sql.json([{ productId: q('product') || 'P2', size: q('size') || '42', color: q('color') || 'Oq', qty: Number(q('qty') || 1) }] as never)}) as r`
        return send(res, 200, r.r, cors)
      }
      if (op === 'reset-admin') { await sql`truncate orders, cart_items, notification_outbox, pickup_orders, pickup_outbox, admin_audit_log, stock_adjustments restart identity cascade`; telegram.length = 0; storageLog.length = 0; return send(res, 200, { ok: true }, cors) }
      if (op === 'set-stock') { await sql`update inventory set quantity = ${Number(q('qty'))} where variant_id = (select id from product_variants where product_id = ${q('product')} and size = ${q('size')} and color_name = ${q('color')})`; return send(res, 200, { ok: true }, cors) }
      if (op === 'delivery') { await sql`update settings set delivery_fee = ${q('fee') === '' ? null : Number(q('fee'))}, delivery_free_from = ${q('free') === '' ? null : Number(q('free'))}`; return send(res, 200, { ok: true }, cors) }
      if (op === 'allow-samples') { await sql`update settings set allow_sample_orders = ${q('on') === '1'}`; return send(res, 200, { ok: true }, cors) }
      if (op === 'deactivate') { await sql`update products set active = false where id = ${q('product')}`; return send(res, 200, { ok: true }, cors) }
      if (op === 'fail') { inject.fail = Number(q('n') || 1); return send(res, 200, { ok: true }, cors) }
      if (op === 'reset-telegram') { telegram.length = 0; return send(res, 200, { ok: true }, cors) }
      if (op === 'clear-cart') { await sql`truncate cart_items`; return send(res, 200, { ok: true }, cors) }
      if (op === 'reset-pickup') { await sql`truncate pickup_orders, pickup_outbox restart identity cascade`; telegram.length = 0; return send(res, 200, { ok: true }, cors) }
      if (op === 'reset-orders') { await sql`truncate orders, cart_items, notification_outbox restart identity cascade`; telegram.length = 0; return send(res, 200, { ok: true }, cors) }
      return send(res, 404, { error: 'unknown test op' }, cors)
    }
    send(res, 404, { error: { code: 'NOT_FOUND' } }, cors)
  } catch (e) {
    console.error('api error', e)
    send(res, 500, { error: { code: 'SERVER_ERROR' } }, cors)
  }
})

// ----------------------------------------------------------------- static app (SPA fallback)
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
const web = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? '/', ORIGIN).pathname)
  let file = join(WEB_DIR, p)
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIR, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

await new Promise<void>((r) => api.listen(API_PORT, '127.0.0.1', r))
await new Promise<void>((r) => web.listen(WEB_PORT, '127.0.0.1', r))
console.log(`READY ${API_PORT} ${WEB_PORT}`)

const stop = async () => {
  api.close(); web.close()
  await sql.end({ timeout: 2 }).catch(() => {})
  stopServer(pg)
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
