/**
 * Browser side of the Supabase backend. Only PUBLIC values are used here:
 *   VITE_SUPABASE_URL       https://<project>.supabase.co
 *   VITE_SUPABASE_ANON_KEY  the public "anon"/publishable key (safe to ship; RLS limits it to reading the active catalog)
 * Everything private (customer data, orders) goes through Edge Functions with a server-verified session.
 * The Telegram signature (initData) is checked by the Edge Function, never here.
 */
import { getWebApp } from './telegram'

export interface BackendConfig {
  url: string
  anonKey: string
}

/** A browser must never hold a privileged key: refuse it even if someone puts it in the env by mistake. */
export function isPrivilegedKey(key: string): boolean {
  if (/^sb_secret_/.test(key)) return true
  const m = /^eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(key)
  if (!m) return false
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return (JSON.parse(json) as { role?: string }).role === 'service_role'
  } catch {
    return false
  }
}

export function readBackendConfig(env: Record<string, string | undefined>): BackendConfig | null {
  const url = (env.VITE_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const anonKey = (env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  if (!/^https?:\/\/[^\s/]+/.test(url) || anonKey.length < 20 || isPrivilegedKey(anonKey)) return null
  return { url, anonKey }
}

/** What went wrong, in terms the UI can explain (see i18n err.*). */
export type ErrorKind = 'offline' | 'timeout' | 'server' | 'auth' | 'not_in_telegram' | 'rate_limit' | 'invalid' | 'conflict' | 'format' | 'misconfigured' | 'unavailable'

export class BackendError extends Error {
  constructor(
    public kind: ErrorKind,
    public code: string,
    public detail: Record<string, unknown> = {},
    public status?: number,
  ) {
    super(`${kind}:${code}`)
  }
}

function kindFor(status: number, code: string): ErrorKind {
  if (code === 'SERVER_MISCONFIGURED') return 'misconfigured'
  // Supabase answers a function that is not deployed with 404 and NO {error:{code}} envelope (code falls back to HTTP_404);
  // our own functions always answer with the envelope, so this is "the service is not switched on yet", not "order not found"
  if (status === 404 && code.startsWith('HTTP_')) return 'unavailable'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 409) return 'conflict'
  if (status === 400 || status === 422) return 'invalid'
  return 'server'
}

export interface CartItem {
  productId: string
  size: string
  color: string
  qty: number
}

export interface PlaceOrderRequest {
  idempotencyKey: string
  /** the Cart only: Quick Order is store pickup now (see pickupPlace) */
  source: 'cart'
  contact: { name: string; phone: string; address: string; comment: string }
  items: CartItem[]
}

/** Quick Order = store pickup. No address, no delivery: name + phone (required) and an optional comment. */
export interface PickupPlaceRequest {
  idempotencyKey: string
  contact: { name: string; phone: string; comment: string }
  items: CartItem[]
}

export type AdminParams = Record<string, string | number | boolean | null | undefined>

function adminQuery(params: AdminParams): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  return qs.toString()
}

export interface BackendOptions {
  url: string
  anonKey: string
  /** raw Telegram initData of this session ('' outside Telegram) */
  initData?: () => string
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export function createBackend(o: BackendOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = o.now ?? Date.now
  const timeoutMs = o.timeoutMs ?? 15000
  const initData = o.initData ?? (() => getWebApp()?.initData ?? '')
  let session: { token: string; expiresAt: number } | null = null
  /** UI HINT ONLY (shows the "Admin panel" link). The server decides on every admin call. */
  let adminHint = false
  let pendingLogin: Promise<string> | null = null

  async function request(path: string, init: RequestInit, extra: Record<string, string> = {}): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(`${o.url}${path}`, { ...init, signal: ctrl.signal, headers: { apikey: o.anonKey, authorization: `Bearer ${o.anonKey}`, 'content-type': 'application/json', ...extra } })
    } catch (e) {
      throw (e as { name?: string })?.name === 'AbortError' ? new BackendError('timeout', 'TIMEOUT') : new BackendError('offline', 'NETWORK')
    } finally {
      clearTimeout(timer)
    }
    let body: unknown
    let parsed = true
    try {
      body = await res.json()
    } catch {
      parsed = false
    }
    if (!res.ok) {
      const err = parsed && body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
      const { code, ...detail } = err && typeof err === 'object' ? (err as Record<string, unknown>) : ({} as Record<string, unknown>)
      const c = typeof code === 'string' ? code : `HTTP_${res.status}`
      throw new BackendError(kindFor(res.status, c), c, detail, res.status)
    }
    if (!parsed || body === null || typeof body !== 'object') throw new BackendError('server', 'BAD_RESPONSE', {}, res.status)
    return body
  }

  async function signIn(): Promise<string> {
    if (session && session.expiresAt - now() > 60_000) return session.token
    pendingLogin ??= (async () => {
      const data = initData()
      if (!data) throw new BackendError('not_in_telegram', 'NOT_IN_TELEGRAM')
      const r = (await request('/functions/v1/telegram-auth', { method: 'POST', body: JSON.stringify({ initData: data }) })) as { token?: unknown; expiresAt?: unknown; isAdmin?: unknown }
      if (typeof r.token !== 'string') throw new BackendError('server', 'BAD_RESPONSE')
      adminHint = r.isAdmin === true
      session = { token: r.token, expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : now() + 50 * 60_000 }
      return r.token
    })().finally(() => (pendingLogin = null))
    return pendingLogin
  }

  /** Calls an Edge Function with the session. One automatic re-login if the server refused the token. */
  async function call(name: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const token = await signIn()
      try {
        return (await request(`/functions/v1/${name}`, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) }, { 'x-aynimo-session': token })) as Record<string, unknown>
      } catch (e) {
        if (attempt === 0 && e instanceof BackendError && e.kind === 'auth') {
          session = null
          continue
        }
        throw e
      }
    }
  }

  return {
    /** public catalog (active products only, enforced by RLS) */
    catalog: () => request('/rest/v1/rpc/get_catalog', { method: 'POST', body: '{}' }),
    signIn: async () => {
      await signIn()
    },
    getCart: async (): Promise<CartItem[]> => {
      const r = await call('cart', 'GET')
      if (!Array.isArray(r.items)) throw new BackendError('server', 'BAD_RESPONSE')
      return r.items as CartItem[]
    },
    putCart: async (items: CartItem[]): Promise<void> => {
      await call('cart', 'PUT', { items })
    },
    myOrders: async (): Promise<unknown[]> => {
      const r = await call('my-orders', 'GET')
      if (!Array.isArray(r.orders)) throw new BackendError('server', 'BAD_RESPONSE')
      return r.orders
    },
    placeOrder: async (req: PlaceOrderRequest): Promise<{ duplicate: boolean; order: unknown }> => {
      const r = await call('place-order', 'POST', req)
      return { duplicate: r.duplicate === true, order: r.order }
    },
    // ---- Quick Order (store pickup). Identity always comes from the signed session, never from these arguments.
    pickupOrders: async (): Promise<unknown[]> => {
      const r = await call('pickup-order', 'GET')
      if (!Array.isArray(r.orders)) throw new BackendError('server', 'BAD_RESPONSE')
      return r.orders
    },
    pickupOrder: async (id: string): Promise<unknown> => {
      const r = await call(`pickup-order?id=${encodeURIComponent(id)}`, 'GET')
      if (!r.order || typeof r.order !== 'object') throw new BackendError('server', 'BAD_RESPONSE')
      return r.order
    },
    pickupPlace: async (req: PickupPlaceRequest): Promise<{ duplicate: boolean; order: unknown }> => {
      const r = await call('pickup-order', 'POST', { action: 'place', ...req })
      return { duplicate: r.duplicate === true, order: r.order }
    },
    pickupCancel: async (id: string): Promise<unknown> => {
      const r = await call('pickup-order', 'POST', { action: 'cancel', id })
      return r.order
    },
    // ---- Admin panel (stage E). Authority is the server (requireAdmin on every call); nothing here grants anything.
    isAdminHint: () => adminHint,
    /** GET admin-api?r=<resource>&...  (booleans become 1/0, empty values are dropped) */
    adminGet: (resource: string, params: AdminParams = {}): Promise<Record<string, unknown>> => call(`admin-api?${adminQuery({ ...params, r: resource })}`, 'GET'),
    /** POST admin-api { ...body, r: resource } (the resource can never be overridden by the body) */
    adminPost: (resource: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call('admin-api', 'POST', { ...body, r: resource }),
    /** the existing stage-D function: GET admin-pickup?group=...|id=...|view=health */
    adminPickupGet: (params: AdminParams = {}): Promise<Record<string, unknown>> => call(`admin-pickup${Object.keys(params).length ? `?${adminQuery(params)}` : ''}`, 'GET'),
    adminPickupPost: (body: Record<string, unknown>): Promise<Record<string, unknown>> => call('admin-pickup', 'POST', body),
    /**
     * Uploads a photo to the SIGNED Storage URL that admin-api issued. It is a plain PUT with FormData (what supabase-js
     * uploadToSignedUrl does): no apikey, no session header, so nothing secret goes to Storage.
     */
    adminUpload: async (uploadUrl: string, file: Blob): Promise<void> => {
      if (!/^https?:\/\/[^\s/]+\/storage\/v1\/object\/upload\/sign\/product-images\//.test(uploadUrl)) throw new BackendError('invalid', 'BAD_UPLOAD_URL')
      const fd = new FormData()
      fd.append('cacheControl', '3600')
      fd.append('', file)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 60_000)
      let res: Response
      try {
        res = await doFetch(uploadUrl, { method: 'PUT', body: fd, signal: ctrl.signal })
      } catch (e) {
        throw (e as { name?: string })?.name === 'AbortError' ? new BackendError('timeout', 'TIMEOUT') : new BackendError('offline', 'NETWORK')
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new BackendError(res.status === 413 || res.status === 415 ? 'invalid' : 'server', 'UPLOAD_FAILED', {}, res.status)
    },
  }
}

export type Backend = ReturnType<typeof createBackend>

const cfg = readBackendConfig(import.meta.env as Record<string, string | undefined>)
/** null = no backend configured (demo mode) */
export const backend: Backend | null = cfg ? createBackend(cfg) : null

/** Public URL of a product photo in the "product-images" Storage bucket (null when there is no backend). */
export function imageUrl(path: string): string | null {
  if (!cfg || !path || path.includes('..')) return null
  return `${cfg.url}/storage/v1/object/public/product-images/${path.split('/').map(encodeURIComponent).join('/')}`
}
