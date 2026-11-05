import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { t } from '../i18n'

const TAB_ROOTS = new Set(['/katalog', '/tezkor-buyurtma', '/savatcha', '/profil'])

export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  const navigate = useNavigate()
  const isTab = TAB_ROOTS.has(useLocation().pathname) // main tabs are reached from the bottom bar: no back arrow
  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-2 bg-ivory/85 px-4 pb-3 backdrop-blur-xl"
      style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}
    >
      {!isTab && (
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
          aria-label={t('common.back')}
          className="glass grid size-10 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5" />
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-xl">{title}</h1>
      {right}
    </header>
  )
}

export function Section({ title, sub, to, children }: { title: string; sub?: string; to?: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-end justify-between px-4">
        <div>
          <h2 className="text-[21px]">{title}</h2>
          {sub && <p className="mt-0.5 text-[13px] text-navy-soft">{sub}</p>}
        </div>
        {to && (
          <Link to={to} className="flex items-center gap-0.5 text-[13px] font-semibold text-coral">
            {t('common.all')}
            <ChevronRight className="size-4" />
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mx-4 mt-10 flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-[0_8px_30px_-18px_rgba(23,43,58,0.35)]">
      <div className="mb-4 grid size-16 place-items-center rounded-full bg-coral-soft text-coral">{icon}</div>
      <h2 className="text-xl">{title}</h2>
      {hint && <p className="mt-2 max-w-[28ch] text-sm text-navy-soft">{hint}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-full bg-coral px-6 py-3 text-sm font-bold text-white shadow-[0_10px_22px_-8px_rgba(217,75,89,0.65)] active:scale-[0.97] transition-transform'
