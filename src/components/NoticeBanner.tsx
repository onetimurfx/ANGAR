import { CloudOff } from 'lucide-react'
import { useBackend } from '../lib/backendContext'
import { t } from '../i18n'

/**
 * Honesty note above the order form.
 *  - no backend configured (demo): nothing is sent to the shop, it is only a device draft
 *  - backend configured but this session is not signed in: say exactly why ordering is not possible right now
 */
export function NoBackendNotice() {
  const { mode, auth, signIn } = useBackend()
  if (mode === 'server') {
    if (auth === 'not_in_telegram' || auth === 'failed') {
      return (
        <div data-testid="auth-notice" role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl bg-coral-soft px-3.5 py-3 text-[13px] font-semibold leading-snug text-coral-deep">
          <p className="min-w-0 flex-1">{auth === 'not_in_telegram' ? t('err.not_in_telegram') : t('err.auth')}</p>
          {auth === 'failed' && (
            <button type="button" onClick={() => void signIn()} className="rounded-full bg-coral px-4 py-2 text-[13px] font-bold text-white">
              {t('boot.retry')}
            </button>
          )}
        </div>
      )
    }
    return null
  }
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
