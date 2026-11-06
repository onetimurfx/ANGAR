/**
 * Secret hygiene: nothing privileged may be reachable from the browser bundle or the frontend source.
 * Scans src/ always and every built bundle that exists (dist/, dist-live/).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPrivilegedKey, readBackendConfig } from '../../src/lib/backend'

const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] }) : []
const text = (f: string) => (/\.(js|css|html|ts|tsx|json|svg|map|webmanifest)$/.test(f) ? readFileSync(f, 'utf8') : '')

const BOT_TOKEN = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/
// (the words 'service_role' / 'sb_secret_' appear in the browser GUARD that refuses such keys; real keys are caught by the JWT check below)
const FORBIDDEN = [/SERVICE_ROLE_KEY/i, /SESSION_SECRET/, /SUPABASE_DB_URL/, /CRON_SECRET/, /BOT_TOKEN/, /postgres(ql)?:\/\/[^\s'"]*@/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
const jwtRole = (s: string) => {
  const out: string[] = []
  for (const m of s.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    try { out.push(JSON.parse(Buffer.from(m[1], 'base64url').toString()).role) } catch { /* not a JWT */ }
  }
  return out
}

const targets: [string, string[]][] = [['src', walk(resolve('src'))], ['dist', walk(resolve('dist'))], ['dist-live', walk(resolve('dist-live'))]]

describe.each(targets.filter(([, files]) => files.length > 0))('%s has no secrets', (_name, files) => {
  it('contains no bot token, service-role key, DB URL or private key', () => {
    for (const f of files) {
      const s = text(f)
      expect(BOT_TOKEN.test(s), `bot token pattern in ${f}`).toBe(false)
      for (const re of FORBIDDEN) expect(re.test(s), `${re} found in ${f}`).toBe(false)
      expect(/sb_secret_[A-Za-z0-9_-]{20,}/.test(s), `secret key in ${f}`).toBe(false)
      expect(jwtRole(s).filter((r) => r === 'service_role'), `service_role JWT in ${f}`).toEqual([])
    }
  })
})

describe('frontend never reaches into server code', () => {
  it('does not import from supabase/ (Edge Functions are server-only)', () => {
    for (const f of walk(resolve('src')).filter((x) => /\.(ts|tsx)$/.test(x))) expect(/from ['"][./]*supabase\//.test(readFileSync(f, 'utf8')), f).toBe(false)
  })
  it('only VITE_ variables that are public are read', () => {
    const used = new Set<string>()
    for (const f of walk(resolve('src')).filter((x) => /\.(ts|tsx)$/.test(x))) for (const m of readFileSync(f, 'utf8').matchAll(/VITE_[A-Z_]+/g)) used.add(m[0])
    expect([...used].sort()).toEqual(['VITE_DELIVERY_FEE', 'VITE_DELIVERY_FREE_FROM', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL'])
  })
})

describe('privileged keys are refused in the browser', () => {
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signaturesignaturesig`
  it('detects service_role JWTs and sb_secret keys', () => {
    expect(isPrivilegedKey(jwt('service_role'))).toBe(true)
    expect(isPrivilegedKey(jwt('anon'))).toBe(false)
    expect(isPrivilegedKey('sb_secret_abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(isPrivilegedKey('sb_publishable_abcdefghijklmnopqrstuvwxyz')).toBe(false)
  })
  it('readBackendConfig does not use a service-role key', () => {
    expect(readBackendConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: jwt('service_role') })).toBeNull()
    expect(readBackendConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: jwt('anon') })).not.toBeNull()
  })
})

describe('repository', () => {
  it('ignores local env files', () => {
    const gi = readFileSync('.gitignore', 'utf8')
    expect(/^\.env/m.test(gi)).toBe(true)
  })
})
