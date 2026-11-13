import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { setCatalog } from '../data/catalog'
import { CatalogFormatError, mapCatalog } from '../data/serverCatalog'
import { backend, BackendError, type ErrorKind } from './backend'
import { t } from '../i18n'

export type AuthState = 'none' | 'pending' | 'ok' | 'not_in_telegram' | 'failed'

interface Ctx {
  /** 'demo' = no backend configured (sample catalog, drafts stay on the device) */
  mode: 'demo' | 'server'
  auth: AuthState
  /** bumps whenever the catalog was replaced, so screens re-read the live catalog */
  version: number
  /** re-fetches the catalog (fresh stock). Never throws; keeps the previous catalog if the server is unreachable. */
  reload: () => Promise<void>
  /** tries to sign in again (e.g. after a network error) */
  signIn: () => Promise<boolean>
  /** UI hint only (the Profile link to the admin panel). The server re-checks admin rights on every admin call. */
  isAdmin: boolean
}

const BackendCtx = createContext<Ctx>({ mode: 'demo', auth: 'none', version: 0, reload: async () => {}, signIn: async () => false, isAdmin: false })
export const useBackend = () => useContext(BackendCtx)
/** Call in a screen that must re-render when the catalog is refreshed. */
export const useCatalogVersion = () => useContext(BackendCtx).version

export function errorKind(e: unknown): ErrorKind {
  if (e instanceof BackendError) return e.kind
  if (e instanceof CatalogFormatError) return 'format'
  return 'server'
}

/** User-facing Uzbek message for an error kind. Never shows technical details. */
export function errorMessage(kind: ErrorKind): string {
  return t(`err.${kind}`)
}

async function fetchCatalog() {
  if (!backend) return
  try {
    setCatalog(mapCatalog(await backend.catalog()), 'server')
  } catch (e) {
    if (e instanceof CatalogFormatError) throw new BackendError('format', 'BAD_CATALOG')
    throw e
  }
}

const STALE_MS = 60_000

export function BackendProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(backend ? 'loading' : 'ready')
  const [error, setError] = useState<ErrorKind>('server')
  const [auth, setAuth] = useState<AuthState>('none')
  const [version, setVersion] = useState(0)
  const loadedAt = useRef(0)
  const alive = useRef(true)

  const signIn = useCallback(async () => {
    if (!backend) return false
    setAuth('pending')
    try {
      await backend.signIn()
      if (alive.current) setAuth('ok')
      return true
    } catch (e) {
      if (alive.current) setAuth(errorKind(e) === 'not_in_telegram' ? 'not_in_telegram' : 'failed')
      return false
    }
  }, [])

  const load = useCallback(async () => {
    setState('loading')
    try {
      await fetchCatalog()
      loadedAt.current = Date.now()
      if (!alive.current) return
      setVersion((v) => v + 1)
      setState('ready')
      void signIn()
    } catch (e) {
      if (!alive.current) return
      setError(errorKind(e))
      setState('error')
    }
  }, [signIn])

  const reload = useCallback(async () => {
    try {
      await fetchCatalog()
      loadedAt.current = Date.now()
      if (alive.current) setVersion((v) => v + 1)
    } catch {
      /* keep showing the previous catalog */
    }
  }, [])

  useEffect(() => {
    alive.current = true
    if (backend) void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // fresh stock when the customer comes back to the app after a while
  useEffect(() => {
    if (!backend) return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > STALE_MS) void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])

  const value = useMemo<Ctx>(() => ({ mode: backend ? 'server' : 'demo', auth, version, reload, signIn, isAdmin: auth === 'ok' && backend?.isAdminHint() === true }), [auth, version, reload, signIn])

  if (state === 'loading') {
    return (
      <div data-testid="boot-loading" role="status" className="grid min-h-[100dvh] place-items-center px-6 text-center">
        <div>
          <div className="mx-auto size-10 animate-spin rounded-full border-[3px] border-coral/25 border-t-coral" />
          <p className="mt-4 text-[14px] font-semibold text-navy-soft">{t('boot.loading')}</p>
        </div>
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div data-testid="boot-error" role="alert" className="grid min-h-[100dvh] place-items-center px-6 text-center">
        <div className="max-w-[320px]">
          <span className="mx-auto grid size-14 place-items-center rounded-full bg-coral-soft text-coral">
            <CloudOff className="size-6" />
          </span>
          <h1 className="mt-4 text-[22px]">{t('boot.errorTitle')}</h1>
          <p className="mt-2 text-[14px] leading-snug text-navy-soft">{errorMessage(error)}</p>
          <button type="button" data-testid="boot-retry" onClick={() => void load()} className="mt-5 inline-flex items-center gap-2 rounded-full bg-coral px-6 py-3.5 text-[14px] font-bold text-white">
            <RefreshCw className="size-4" />
            {t('boot.retry')}
          </button>
        </div>
      </div>
    )
  }
  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}
