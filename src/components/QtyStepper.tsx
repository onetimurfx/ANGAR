import { Minus, Plus } from 'lucide-react'
import { t } from '../i18n'

interface Props {
  value: number
  min?: number
  max: number
  onChange: (v: number) => void
  compact?: boolean
  label?: string
}

export function QtyStepper({ value, min = 1, max, onChange, compact = false, label }: Props) {
  const size = compact ? 'size-8' : 'size-10'
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-white p-1 shadow-[0_6px_18px_-12px_rgba(23,43,58,0.6)]" role="group" aria-label={label ?? t('product.qty')}>
      <button
        type="button"
        aria-label={t('qty.down')}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={`${size} grid place-items-center rounded-full bg-navy/[0.06] transition active:scale-90 disabled:opacity-35`}
      >
        <Minus className="size-4" />
      </button>
      <output aria-live="polite" className={`${compact ? 'w-7 text-[14px]' : 'w-9 text-[16px]'} text-center font-extrabold tabular-nums`}>
        {value}
      </output>
      <button
        type="button"
        aria-label={t('qty.up')}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={`${size} grid place-items-center rounded-full bg-navy text-white transition active:scale-90 disabled:opacity-35`}
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}
