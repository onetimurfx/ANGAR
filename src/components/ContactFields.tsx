import { useId, type ReactNode } from 'react'
import { t } from '../i18n'
import { formatPhoneInput, type ContactErrors, type ContactField, type ContactInput } from '../lib/validation'

interface Props {
  value: ContactInput
  errors: ContactErrors
  onChange: (patch: Partial<ContactInput>) => void
  onBlurField: (field: ContactField) => void
  /** shown under the name when it was prefilled from Telegram */
  nameFromTelegram?: boolean
  /** store pickup has no delivery address */
  hideAddress?: boolean
}

const base = 'w-full rounded-2xl bg-white px-4 py-3.5 text-[16px] outline-none shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)] transition placeholder:text-stone/80 focus:ring-2'

function Field({ id, label, optional, error, hint, children }: { id: string; label: string; optional?: boolean; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-[13px] font-extrabold uppercase tracking-wider text-stone">
        <span>
          {label}
          {!optional && (
            <span className="ml-1 text-coral" aria-hidden>
              *
            </span>
          )}
        </span>
        {!optional && <span className="sr-only">{t('form.required')}</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-err`} role="alert" data-testid={`${id}-error`} className="mt-1.5 text-[13px] font-semibold text-coral">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-[12px] text-navy-soft">{hint}</p>
      )}
    </div>
  )
}

export function ContactFields({ value, errors, onChange, onBlurField, nameFromTelegram, hideAddress }: Props) {
  const uid = useId().replace(/:/g, '')
  const id = (f: ContactField) => `${uid}-${f}`
  const cls = (f: ContactField) => `${base} ${errors[f] ? 'ring-2 ring-coral focus:ring-coral' : 'focus:ring-coral/60'}`
  const err = (f: ContactField) => (errors[f] ? t(errors[f] as Parameters<typeof t>[0]) : undefined)
  const aria = (f: ContactField) => ({ 'aria-invalid': errors[f] ? true : undefined, 'aria-describedby': errors[f] ? `${id(f)}-err` : undefined }) as const

  return (
    <div className="space-y-4">
      <Field id={id('name')} label={t('form.name')} error={err('name')} hint={nameFromTelegram && value.name ? t('form.fromTelegram') : undefined}>
        <input
          id={id('name')}
          name="name"
          data-testid="f-name"
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={() => onBlurField('name')}
          autoComplete="name"
          enterKeyHint="next"
          maxLength={80}
          placeholder={t('form.namePh')}
          className={cls('name')}
          {...aria('name')}
        />
      </Field>
      <Field id={id('phone')} label={t('form.phone')} error={err('phone')}>
        <input
          id={id('phone')}
          name="phone"
          data-testid="f-phone"
          type="tel"
          inputMode="tel"
          value={value.phone}
          onChange={(e) => onChange({ phone: formatPhoneInput(e.target.value) })}
          onBlur={() => onBlurField('phone')}
          autoComplete="tel"
          enterKeyHint="next"
          placeholder={t('form.phonePh')}
          className={cls('phone')}
          {...aria('phone')}
        />
      </Field>
      {!hideAddress && (
      <Field id={id('address')} label={t('form.address')} error={err('address')}>
        <textarea
          id={id('address')}
          name="address"
          data-testid="f-address"
          rows={2}
          value={value.address}
          onChange={(e) => onChange({ address: e.target.value })}
          onBlur={() => onBlurField('address')}
          autoComplete="street-address"
          maxLength={260}
          placeholder={t('form.addressPh')}
          className={`${cls('address')} resize-none`}
          {...aria('address')}
        />
      </Field>
      )}
      <Field
        id={id('comment')}
        label={t('form.comment')}
        optional
        error={err('comment')}
        hint={<span className="tabular-nums">{t('form.commentCount', { n: value.comment.trim().length })}</span>}
      >
        <textarea
          id={id('comment')}
          name="comment"
          data-testid="f-comment"
          rows={2}
          value={value.comment}
          onChange={(e) => onChange({ comment: e.target.value })}
          onBlur={() => onBlurField('comment')}
          maxLength={400}
          placeholder={t('form.commentPh')}
          className={`${cls('comment')} resize-none`}
          {...aria('comment')}
        />
      </Field>
    </div>
  )
}
