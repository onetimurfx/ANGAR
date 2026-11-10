import { Check } from 'lucide-react'
import { STATUS_LABEL, STEPS, type PickupStatus } from '../lib/pickup'
import { t } from '../i18n'

const TONE: Record<PickupStatus, string> = {
  pending: 'bg-[#fbeedd] text-[#8a5217]',
  preparing: 'bg-[#e3ecf4] text-[#1f3f5a]',
  ready_for_pickup: 'bg-[#e8f1df] text-[#2f4a1f]',
  completed: 'bg-navy/[0.07] text-navy',
  cancelled: 'bg-coral-soft text-coral-deep',
  expired: 'bg-coral-soft text-coral-deep',
}

export function StatusChip({ status, className = '' }: { status: PickupStatus; className?: string }) {
  return (
    <span data-testid="pickup-status-chip" data-status={status} className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider ${TONE[status]} ${className}`}>
      {t(STATUS_LABEL[status])}
    </span>
  )
}

/** The happy path as a line of four steps. Closed-without-pickup orders show no progress. */
export function ProgressSteps({ status }: { status: PickupStatus }) {
  const at = (STEPS as readonly PickupStatus[]).indexOf(status)
  if (at < 0) return null
  return (
    <ol aria-label={t('pickup.progress')} data-testid="pickup-steps" className="flex items-start">
      {STEPS.map((s, i) => {
        const done = i < at || status === 'completed'
        const now = i === at && status !== 'completed'
        return (
          <li key={s} data-step={s} data-state={done ? 'done' : now ? 'now' : 'todo'} className="relative flex-1 text-center">
            {i > 0 && <span aria-hidden className={`absolute right-1/2 top-[13px] h-0.5 w-full ${i <= at ? 'bg-coral' : 'bg-navy/10'}`} />}
            <span className={`relative mx-auto grid size-7 place-items-center rounded-full text-[12px] font-extrabold ${done ? 'bg-coral text-white' : now ? 'bg-white text-coral ring-2 ring-coral' : 'bg-white text-stone ring-1 ring-navy/10'}`}>
              {done ? <Check className="size-4" /> : i + 1}
            </span>
            <span className={`mt-1.5 block text-[11px] font-semibold leading-tight ${now ? 'text-navy' : 'text-stone'}`}>{t(`pickup.step.${s}` as const)}</span>
          </li>
        )
      })}
    </ol>
  )
}
