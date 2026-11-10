import { describe, expect, it } from 'vitest'
import { BackendError, createBackend, readBackendConfig } from '../../src/lib/backend'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const mk = (handler: (url: string, init: RequestInit) => Response | Promise<Response>, over: Partial<Parameters<typeof createBackend>[0]> = {}) => {
  const calls: { url: string; init: RequestInit }[] = []
  let t = 1_000_000
  const b = createBackend({
    url: 'https://p.supabase.co',
    anonKey: 'anon-key-0123456789-abcdef',
    initData: () => 'auth_date=1&hash=x',
    now: () => t,
    fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(u), init: init ?? {} })
      return handler(String(u), init ?? {})
    }) as typeof fetch,
    ...over,
  })
  return { b, calls, tick: (ms: number) => (t += ms) }
}
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof BackendError ? `${e.kind}:${e.code}` : 'other'
  }
  return 'no error'
}

describe('config', () => {
  it('needs both a URL and a plausible anon key', () => {
    expect(readBackendConfig({})).toBeNull()
    expect(readBackendConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBeNull()
    expect(readBackendConfig({ VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_ANON_KEY: 'k'.repeat(30) })).toBeNull()
    expect(readBackendConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co/', VITE_SUPABASE_ANON_KEY: 'k'.repeat(30) })).toEqual({ url: 'https://x.supabase.co', anonKey: 'k'.repeat(30) })
  })
})

describe('backend client', () => {
  it('reads the catalog with the anon key only', async () => {
    const { b, calls } = mk(() => json(200, { products: [] }))
    await b.catalog()
    expect(calls[0].url).toBe('https://p.supabase.co/rest/v1/rpc/get_catalog')
    const h = calls[0].init.headers as Record<string, string>
    expect(h.apikey).toBe('anon-key-0123456789-abcdef')
    expect(h['x-aynimo-session']).toBeUndefined()
  })

  it('signs in once with initData and reuses the session token', async () => {
    const { b, calls } = mk((url) => (url.endsWith('/telegram-auth') ? json(200, { token: 'T1', expiresAt: 1_000_000 + 3_600_000 }) : json(200, { items: [] })))
    await b.getCart()
    await b.getCart()
    expect(calls.filter((c) => c.url.endsWith('/telegram-auth'))).toHaveLength(1)
    expect((calls[0].init.body as string)).toContain('initData')
    expect((calls[1].init.headers as Record<string, string>)['x-aynimo-session']).toBe('T1')
  })

  it('shares one login between parallel calls', async () => {
    const { b, calls } = mk((url) => (url.endsWith('/telegram-auth') ? json(200, { token: 'T', expiresAt: 5_000_000 }) : json(200, { items: [] })))
    await Promise.all([b.getCart(), b.getCart(), b.myOrders().catch(() => 0)])
    expect(calls.filter((c) => c.url.endsWith('/telegram-auth'))).toHaveLength(1)
  })

  it('renews the session shortly before it expires', async () => {
    let n = 0
    const { b, calls, tick } = mk((url) => (url.endsWith('/telegram-auth') ? json(200, { token: `T${++n}`, expiresAt: 1_000_000 + 3_600_000 }) : json(200, { items: [] })))
    await b.getCart()
    tick(3_600_000 - 30_000) // inside the last minute
    await b.getCart()
    expect(calls.filter((c) => c.url.endsWith('/telegram-auth'))).toHaveLength(2)
  })

  it('re-signs in once when the server rejects the session, then succeeds', async () => {
    let auth = 0
    let first = true
    const { b, calls } = mk((url) => {
      if (url.endsWith('/telegram-auth')) return json(200, { token: `T${++auth}`, expiresAt: 9_000_000 })
      if (first) {
        first = false
        return json(401, { error: { code: 'UNAUTHENTICATED' } })
      }
      return json(200, { items: [{ productId: 'a', size: 'M', color: 'x', qty: 1 }] })
    })
    expect(await b.getCart()).toHaveLength(1)
    expect(auth).toBe(2)
    expect(calls.filter((c) => c.url.endsWith('/cart'))).toHaveLength(2)
  })

  it('does not loop forever on a permanently rejected session', async () => {
    const { b, calls } = mk((url) => (url.endsWith('/telegram-auth') ? json(200, { token: 'T', expiresAt: 9_000_000 }) : json(401, { error: { code: 'UNAUTHENTICATED' } })))
    expect(await kindOf(b.getCart())).toBe('auth:UNAUTHENTICATED')
    expect(calls.filter((c) => c.url.endsWith('/cart'))).toHaveLength(2)
  })

  it('outside Telegram (no initData) never calls the server and says so', async () => {
    const { b, calls } = mk(() => json(200, {}), { initData: () => '' })
    expect(await kindOf(b.getCart())).toBe('not_in_telegram:NOT_IN_TELEGRAM')
    expect(calls).toHaveLength(0)
  })

  it('maps failures to understandable kinds', async () => {
    const down = mk(() => {
      throw new TypeError('Failed to fetch')
    })
    expect(await kindOf(down.b.catalog())).toBe('offline:NETWORK')

    const slow = mk((_u, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))), { timeoutMs: 20 })
    expect(await kindOf(slow.b.catalog())).toBe('timeout:TIMEOUT')

    expect(await kindOf(mk(() => json(500, { error: { code: 'SERVER_ERROR' } })).b.catalog())).toBe('server:SERVER_ERROR')
    expect(await kindOf(mk(() => new Response('<html>bad gateway</html>', { status: 502 })).b.catalog())).toBe('server:HTTP_502')
    expect(await kindOf(mk(() => new Response('not json', { status: 200 })).b.catalog())).toBe('server:BAD_RESPONSE')
    expect(await kindOf(mk(() => json(500, { error: { code: 'SERVER_MISCONFIGURED' } })).b.catalog())).toBe('misconfigured:SERVER_MISCONFIGURED')
  })

  it('auth failures from telegram-auth are reported, not retried', async () => {
    const { b, calls } = mk(() => json(401, { error: { code: 'INVALID_INIT_DATA' } }))
    expect(await kindOf(b.getCart())).toBe('auth:INVALID_INIT_DATA')
    expect(calls).toHaveLength(1)
  })

  it('placeOrder returns structured error details (stock issues, contact fields)', async () => {
    const { b } = mk((url) => {
      if (url.endsWith('/telegram-auth')) return json(200, { token: 'T', expiresAt: 9_000_000 })
      return json(409, { error: { code: 'ITEMS_UNAVAILABLE', issues: [{ productId: 'P1', requested: 3, available: 1, reason: 'stock', name: 'X' }] } })
    })
    try {
      await b.placeOrder({ idempotencyKey: 'k', source: 'cart', contact: { name: '', phone: '', address: '', comment: '' }, items: [] })
      expect.unreachable()
    } catch (e) {
      const err = e as BackendError
      expect(err.kind).toBe('conflict')
      expect(err.code).toBe('ITEMS_UNAVAILABLE')
      expect((err.detail.issues as unknown[]).length).toBe(1)
    }
  })

  it('sends only what the endpoint needs and never the bot/service keys', async () => {
    const { b, calls } = mk((url) => (url.endsWith('/telegram-auth') ? json(200, { token: 'T', expiresAt: 9_000_000 }) : json(200, { duplicate: false, order: { id: 'x' } })))
    await b.placeOrder({ idempotencyKey: '11111111-1111-4111-8111-111111111111', source: 'cart', contact: { name: 'A', phone: 'B', address: 'C', comment: '' }, items: [{ productId: 'p', size: 'M', color: 'c', qty: 1 }] })
    const all = JSON.stringify(calls)
    expect(all).not.toMatch(/service_role|BOT_TOKEN|SESSION_SECRET/i)
    const order = calls.find((c) => c.url.endsWith('/place-order'))!
    expect(order.init.method).toBe('POST')
    expect((order.init.headers as Record<string, string>).apikey).toBe('anon-key-0123456789-abcdef')
  })
})
