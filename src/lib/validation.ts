import type { Key } from '../i18n/uz'

export interface ContactInput {
  name: string
  phone: string
  address: string
  comment: string
}
export interface Contact {
  name: string
  /** normalised: +998XXXXXXXXX */
  phone: string
  address: string
  comment: string
}
export type ContactField = keyof ContactInput
export type ContactErrors = Partial<Record<ContactField, Key>>

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Returns +998XXXXXXXXX or null. Accepts "+998 90 123 45 67", "998901234567", "901234567". */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  let national: string
  if (digits.length === 12 && digits.startsWith('998')) national = digits.slice(3)
  else if (digits.length === 9) national = digits
  else return null
  if (national[0] === '0') return null // operator codes never start with 0
  return `+998${national}`
}

/** Progressive mask for the phone field: "+998 90 123 45 67". Empty input stays empty. */
export function formatPhoneInput(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const hasPrefix = digits.startsWith('998') && (raw.includes('+') || digits.length > 9)
  const national = (hasPrefix ? digits.slice(3) : digits).slice(0, 9)
  if (!national) return ''
  const parts = [national.slice(0, 2), national.slice(2, 5), national.slice(5, 7), national.slice(7, 9)].filter(Boolean)
  return `+998 ${parts.join(' ')}`
}

export function validateName(raw: string): Key | null {
  const v = collapse(raw)
  if (!v) return 'err.nameRequired'
  if (v.length < 2) return 'err.nameShort'
  if (v.length > 60) return 'err.nameLong'
  if (!/\p{L}/u.test(v) || /[<>]/.test(v)) return 'err.nameInvalid'
  return null
}

export function validatePhone(raw: string): Key | null {
  if (!raw.trim()) return 'err.phoneRequired'
  return normalizePhone(raw) ? null : 'err.phoneInvalid'
}

export function validateAddress(raw: string): Key | null {
  const v = collapse(raw)
  if (!v) return 'err.addressRequired'
  if (v.length < 8) return 'err.addressShort'
  if (v.length > 200) return 'err.addressLong'
  return null
}

export function validateComment(raw: string): Key | null {
  return raw.trim().length > 300 ? 'err.commentLong' : null
}

const VALIDATORS: Record<ContactField, (v: string) => Key | null> = {
  name: validateName,
  phone: validatePhone,
  address: validateAddress,
  comment: validateComment,
}
export const validateField = (field: ContactField, value: string) => VALIDATORS[field](value)

export const CONTACT_FIELDS: ContactField[] = ['name', 'phone', 'address', 'comment']

export function validateContact(input: ContactInput): { errors: ContactErrors; value: Contact | null } {
  const errors: ContactErrors = {}
  for (const f of CONTACT_FIELDS) {
    const e = VALIDATORS[f](input[f] ?? '')
    if (e) errors[f] = e
  }
  if (Object.keys(errors).length) return { errors, value: null }
  return {
    errors,
    value: {
      name: collapse(input.name),
      phone: normalizePhone(input.phone) as string,
      address: collapse(input.address),
      comment: input.comment.trim(),
    },
  }
}
