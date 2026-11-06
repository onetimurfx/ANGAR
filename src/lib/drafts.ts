import { useCallback, useState } from 'react'
import { newAttemptId } from './orders'
import type { ContactInput } from './validation'

/** Unsent form text survives a refresh (sessionStorage only: it is personal data and is wiped with the tab). */
const EMPTY: ContactInput = { name: '', phone: '', address: '', comment: '' }

const key = (scope: string) => `aynimo:draft:${scope}`

function read(scope: string): ContactInput | null {
  try {
    const raw = window.sessionStorage.getItem(key(scope))
    if (!raw) return null
    const v = JSON.parse(raw) as Record<string, unknown>
    const pick = (k: keyof ContactInput) => (typeof v[k] === 'string' ? (v[k] as string).slice(0, 400) : '')
    return { name: pick('name'), phone: pick('phone'), address: pick('address'), comment: pick('comment') }
  } catch {
    return null
  }
}

export function useContactDraft(scope: string, prefill: Partial<ContactInput> = {}) {
  const [value, setValue] = useState<ContactInput>(() => read(scope) ?? { ...EMPTY, ...prefill })

  const update = useCallback(
    (patch: Partial<ContactInput>) => {
      setValue((cur) => {
        const next = { ...cur, ...patch }
        try {
          window.sessionStorage.setItem(key(scope), JSON.stringify(next))
        } catch {
          /* storage unavailable: the text just is not kept across a refresh */
        }
        return next
      })
    },
    [scope],
  )

  const clear = useCallback(() => {
    try {
      window.sessionStorage.removeItem(key(scope))
    } catch {
      /* ignore */
    }
  }, [scope])

  return { value, update, clear }
}

/**
 * One idempotency key per submit attempt, kept for the tab session. A retry (double tap, slow network,
 * refresh after submit) reuses it, so the order store returns the saved order instead of a second one.
 * It is cleared only after a successful save.
 */
export function getAttemptId(scope: string): string {
  const k = `aynimo:attempt:${scope}`
  try {
    const cur = window.sessionStorage.getItem(k)
    if (cur) return cur
    const id = newAttemptId()
    window.sessionStorage.setItem(k, id)
    return id
  } catch {
    return memoryAttempts[scope] ?? (memoryAttempts[scope] = newAttemptId())
  }
}
const memoryAttempts: Record<string, string> = {}

export function clearAttemptId(scope: string) {
  delete memoryAttempts[scope]
  try {
    window.sessionStorage.removeItem(`aynimo:attempt:${scope}`)
  } catch {
    /* ignore */
  }
}
