import { errorMessage } from './backendContext'
import type { PlaceOutcome } from './ordersStore'
import { t } from '../i18n'

export interface Problem {
  title: string
  lines: string[]
}

/** Turns a failed placement into the box shown above the submit button. `null` = field errors, shown by the fields themselves. */
export function describeFailure(out: PlaceOutcome): Problem | null {
  if (out.ok) return null
  switch (out.reason) {
    case 'contact':
      return null
    case 'empty':
    case 'variant':
      return { title: t('err.conflict'), lines: [t('checkout.variantProblem')] }
    case 'stock':
      return {
        title: t('checkout.stockProblem'),
        lines: out.issues.map((i) => {
          const v = i.size && i.color ? ` (${i.color}, ${i.size})` : ''
          return t('checkout.stockLine', { name: `${i.name}${v}`, r: i.requested, a: i.available })
        }),
      }
    case 'sample':
      return { title: t('err.conflict'), lines: [t('err.samplesBlocked', { name: out.name })] }
    case 'error':
      return { title: errorMessage(out.kind), lines: [t('err.notSentHint')] }
  }
}
