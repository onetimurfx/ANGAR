/** Typed access to the admin Edge Functions. Authority is the server: every call is checked there. */
import { backend, BackendError, type AdminParams } from '../lib/backend'

const b = () => {
  if (!backend) throw new BackendError('misconfigured', 'NO_BACKEND')
  return backend
}
export const aGet = <T>(resource: string, params?: AdminParams) => b().adminGet(resource, params) as unknown as Promise<T>
export const aPost = <T = Record<string, unknown>>(resource: string, body?: Record<string, unknown>) => b().adminPost(resource, body) as unknown as Promise<T>
export const pGet = <T>(params?: AdminParams) => b().adminPickupGet(params) as unknown as Promise<T>
export const pPost = <T>(body: Record<string, unknown>) => b().adminPickupPost(body) as unknown as Promise<T>
export const uploadPhoto = (uploadUrl: string, file: Blob) => b().adminUpload(uploadUrl, file)
export const hasBackend = () => backend !== null
