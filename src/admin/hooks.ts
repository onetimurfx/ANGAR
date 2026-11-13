import { useCallback, useEffect, useRef, useState } from 'react'
import { BackendError, type ErrorKind } from '../lib/backend'
import { adminError } from './text'

export interface Res<T> { data: T | null; error: string | null; kind: ErrorKind | null; loading: boolean; reload: () => void; setData: (d: T) => void }

/** Loads `fn()` whenever `deps` change; a stale answer never overwrites a newer one. */
export function useRes<T>(fn: () => Promise<T>, deps: unknown[]): Res<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<ErrorKind | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const [tick, setTick] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  useEffect(() => {
    const n = ++seq.current
    setLoading(true)
    run().then(
      (d) => { if (n === seq.current) { setData(d); setError(null); setKind(null); setLoading(false) } },
      (e) => { if (n === seq.current) { setError(adminError(e)); setKind(e instanceof BackendError ? e.kind : null); setLoading(false) } },
    )
  }, [run, tick])
  return { data, error, kind, loading, reload: useCallback(() => setTick((x) => x + 1), []), setData }
}

/** Debounced copy of a value (search boxes). */
export function useDebounced<T>(v: T, ms = 350): T {
  const [x, setX] = useState(v)
  useEffect(() => {
    const id = setTimeout(() => setX(v), ms)
    return () => clearTimeout(id)
  }, [v, ms])
  return x
}

/** Runs one action at a time; exposes busy + the error message. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(adminError(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run, setError }
}
