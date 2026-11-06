import { CloudOff } from 'lucide-react'
import { t } from '../i18n'

/** Always-visible honesty note: there is no server yet, so nothing is sent to the shop. */
export function NoBackendNotice() {
  return (
    <div data-testid="no-backend-notice" role="note" className="flex gap-3 rounded-2xl bg-[#fbeedd] px-3.5 py-3 text-[13px] font-medium leading-snug text-[#7a4a14]">
      <CloudOff className="mt-0.5 size-[18px] shrink-0" />
      <p>{t('notice.noBackend')}</p>
    </div>
  )
}

export function DraftBadge({ className = '' }: { className?: string }) {
  return (
    <span data-testid="draft-badge" className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#fbeedd] px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider text-[#8a5217] ${className}`}>
      <CloudOff className="size-3" />
      {t('order.draftBadge')}
    </span>
  )
}
