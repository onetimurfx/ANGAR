import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getDeliveryConfig } from './delivery'
import { clearAttemptId, getAttemptId, useContactDraft } from './drafts'
import type { OrderLineInput } from './orders'
import { useOrders, type PlaceOutcome } from './ordersStore'
import { getTelegramUser } from './telegram'
import { validateContact, validateField, type ContactErrors, type ContactField, type ContactInput } from './validation'

export type Scope = 'quick' | 'cart'

/**
 * Shared by Quick Order and the cart checkout.
 * - one submit at a time (`lock` is a ref, so even two taps in the same frame cannot both pass)
 * - one idempotency key per attempt (see drafts.getAttemptId), cleared only after a successful save
 * - on success the screen is REPLACED by the confirmation, so "Back" can never re-open a submitted form
 */
export function useOrderForm(scope: Scope) {
  const tg = getTelegramUser()
  const tgName = tg ? [tg.first_name, tg.last_name].filter(Boolean).join(' ') : ''
  const draft = useContactDraft(scope, { name: tgName })
  const { place } = useOrders()
  const navigate = useNavigate()
  const [errors, setErrors] = useState<ContactErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const lock = useRef(false)

  const setFieldError = (f: ContactField, e: ContactErrors[ContactField] | null) =>
    setErrors((cur) => {
      const next = { ...cur }
      if (e) next[f] = e
      else delete next[f]
      return next
    })

  const onChange = useCallback(
    (patch: Partial<ContactInput>) => {
      draft.update(patch)
      // a shown error disappears as soon as the field becomes valid
      setErrors((cur) => {
        let next = cur
        for (const f of Object.keys(patch) as ContactField[]) {
          if (cur[f] && !validateField(f, patch[f] ?? '')) {
            if (next === cur) next = { ...cur }
            delete next[f]
          }
        }
        return next
      })
    },
    [draft],
  )

  const onBlurField = (f: ContactField) => {
    const v = draft.value[f]
    // do not nag about an untouched empty required field; submit shows everything
    if (!v.trim() && f !== 'comment') return
    setFieldError(f, validateField(f, v))
  }

  /** Validates the contact fields; returns true when all are fine (errors are shown otherwise). */
  const checkContact = () => {
    const res = validateContact(draft.value)
    setErrors(res.errors)
    return Object.keys(res.errors).length === 0
  }

  /** Saves the draft order. Returns the outcome so the screen can explain failures; navigates itself on success. */
  const submit = async (source: Scope, lines: OrderLineInput[], afterSave?: () => void): Promise<PlaceOutcome | null> => {
    if (lock.current) return null
    lock.current = true
    setSubmitting(true)
    let out: PlaceOutcome
    try {
      out = await place({ attemptId: getAttemptId(scope), source, contact: draft.value, lines, delivery: getDeliveryConfig(), telegramUserId: tg?.id })
    } catch {
      out = { ok: false, reason: 'error', kind: 'server', code: 'UNKNOWN' }
    }
    if (!out.ok) {
      if (out.reason === 'contact') setErrors(out.errors)
      lock.current = false
      setSubmitting(false)
      return out
    }
    // success: keep the lock (the screen is replaced), forget the typed data and the attempt key.
    // (a FAILED attempt keeps its key: retrying the same form can never create two orders)
    draft.clear()
    clearAttemptId(scope)
    afterSave?.()
    navigate(`/buyurtma/${out.order.id}`, { replace: true })
    return out
  }

  return { draft, errors, setErrors, submitting, onChange, onBlurField, checkContact, submit, nameFromTelegram: Boolean(tgName) && draft.value.name === tgName }
}

/** Scrolls to and focuses the first field/section marked invalid. */
export function focusFirstInvalid(root: HTMLElement | null) {
  requestAnimationFrame(() => {
    const el = root?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]')
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (typeof el.focus === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.focus({ preventScroll: true })
  })
}
