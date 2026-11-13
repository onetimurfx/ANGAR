/**
 * Supabase Storage access for product images. SERVER ONLY: it needs the service-role key, which exists only in the
 * Edge Function environment (injected by Supabase) and is never returned to a client.
 * The browser only ever receives a one-time signed upload URL for ONE object path.
 */
import type { Deps } from './types.ts'

export const BUCKET = 'product-images'
export const IMAGE_TYPES: Record<string, 'jpg' | 'png' | 'webp'> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const base = (deps: Deps) => (deps.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const authHeaders = (deps: Deps) => ({ authorization: `Bearer ${deps.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: deps.env.SUPABASE_SERVICE_ROLE_KEY ?? '' })
export const storageConfigured = (deps: Deps) => !!(deps.env.SUPABASE_URL && deps.env.SUPABASE_SERVICE_ROLE_KEY)

/** Asks Storage for a signed upload URL for `path`. Returns null when Storage refuses or is unreachable. */
export async function signedUploadUrl(deps: Deps, path: string): Promise<string | null> {
  if (!storageConfigured(deps)) return null
  try {
    const r = await deps.fetch(`${base(deps)}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...authHeaders(deps), 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) {
      deps.log('storage sign failed', { status: r.status })
      return null
    }
    const b: any = await r.json().catch(() => null)
    if (typeof b?.url !== 'string' || !b.url.includes('token=')) return null
    return b.url.startsWith('http') ? b.url : `${base(deps)}/storage/v1${b.url.startsWith('/') ? '' : '/'}${b.url}`
  } catch (e) {
    deps.log('storage sign error', { message: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/** Best-effort removal of an object. A leftover file is harmless; a failure is only logged. */
export async function removeObject(deps: Deps, path: string): Promise<void> {
  if (!storageConfigured(deps)) return
  try {
    const r = await deps.fetch(`${base(deps)}/storage/v1/object/${BUCKET}/${path}`, { method: 'DELETE', headers: authHeaders(deps), signal: AbortSignal.timeout(8000) })
    if (!r.ok) deps.log('storage remove failed', { status: r.status })
  } catch (e) {
    deps.log('storage remove error', { message: e instanceof Error ? e.message : String(e) })
  }
}
