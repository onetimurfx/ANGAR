/**
 * Telegram Mini App initData verification (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * hash = HMAC_SHA256(key = HMAC_SHA256("WebAppData", bot_token), data_check_string)
 * Runs on Web Crypto, so it works in Deno (Edge Functions) and Node (tests).
 */
const enc = new TextEncoder()

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export interface TelegramUser {
  id: number
  firstName: string
  lastName?: string
  username?: string
  photoUrl?: string
  languageCode?: string
}

export type InitDataResult =
  | { ok: true; user: TelegramUser; authDate: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'no_user' }

export async function verifyInitData(initData: unknown, botToken: string, nowMs: number, maxAgeSec = 86400): Promise<InitDataResult> {
  if (typeof initData !== 'string' || initData.length < 10 || initData.length > 4096) return { ok: false, reason: 'malformed' }
  let params: URLSearchParams
  try {
    params = new URLSearchParams(initData)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'malformed' }
  params.delete('hash')
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = await hmac(enc.encode('WebAppData'), botToken)
  const expected = toHex(await hmac(secret, dataCheck))
  if (!safeEqual(expected, hash)) return { ok: false, reason: 'bad_signature' }

  // The signature is valid, so the fields below were really issued by Telegram.
  const authDate = Number(params.get('auth_date'))
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: 'malformed' }
  const ageSec = nowMs / 1000 - authDate
  if (ageSec > maxAgeSec || ageSec < -60) return { ok: false, reason: 'expired' }
  let raw: any
  try {
    raw = JSON.parse(params.get('user') ?? '')
  } catch {
    return { ok: false, reason: 'no_user' }
  }
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0 || typeof raw.first_name !== 'string') return { ok: false, reason: 'no_user' }
  return {
    ok: true,
    authDate,
    user: {
      id: raw.id,
      firstName: raw.first_name,
      lastName: typeof raw.last_name === 'string' ? raw.last_name : undefined,
      username: typeof raw.username === 'string' ? raw.username : undefined,
      photoUrl: typeof raw.photo_url === 'string' ? raw.photo_url : undefined,
      languageCode: typeof raw.language_code === 'string' ? raw.language_code : undefined,
    },
  }
}
