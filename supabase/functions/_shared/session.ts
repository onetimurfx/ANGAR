/**
 * Short-lived session token issued after initData verification:  base64url(payload) "." base64url(HMAC_SHA256).
 * The signing secret lives only in the Edge Function secrets. The token carries no admin flag: admin
 * rights are looked up in the database on every admin call, so removing an admin takes effect at once.
 */
import { safeEqual } from './telegram.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export interface SessionClaims {
  /** customer uuid */
  sub: string
  /** telegram user id */
  tg: number
  /** expiry, unix seconds */
  exp: number
}

async function sign(secret: string, data: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))))
}

export const SESSION_TTL_SEC = 3600

export async function issueSession(claims: Omit<SessionClaims, 'exp'>, secret: string, nowMs: number, ttlSec = SESSION_TTL_SEC) {
  const payload: SessionClaims = { ...claims, exp: Math.floor(nowMs / 1000) + ttlSec }
  const body = b64u(enc.encode(JSON.stringify(payload)))
  return { token: `${body}.${await sign(secret, body)}`, expiresAt: payload.exp * 1000 }
}

export async function verifySession(token: unknown, secret: string, nowMs: number): Promise<SessionClaims | null> {
  if (typeof token !== 'string' || token.length > 1024) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, mac] = parts
  if (!safeEqual(await sign(secret, body), mac)) return null
  try {
    const c = JSON.parse(dec.decode(unb64u(body)))
    if (typeof c.sub !== 'string' || !Number.isSafeInteger(c.tg) || !Number.isInteger(c.exp)) return null
    if (c.exp <= nowMs / 1000) return null
    return c as SessionClaims
  } catch {
    return null
  }
}
