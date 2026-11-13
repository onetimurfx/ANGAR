import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { A } from './text'

export const card = 'glass rounded-3xl p-4'
export const inputCls = 'w-full rounded-2xl border border-navy/10 bg-white px-3.5 py-3 text-[16px] text-navy outline-none placeholder:text-stone focus:border-coral'
export const btn = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-bold transition-transform active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100'
export const btnPrimary = `${btn} bg-coral text-white shadow-[0_10px_22px_-8px_rgba(217,75,89,0.65)]`
export const btnGhost = `${btn} bg-navy/[0.06] text-navy`
export const btnDanger = `${btn} bg-white text-coral ring-1 ring-coral/40`

export const Spinner = () => <Loader2 className="size-5 animate-spin text-coral" aria-label={A.loading} />

export function Loading() {
  return <div className="grid place-items-center py-16" role="status"><Spinner /></div>
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-auto my-6 flex max-w-sm flex-col items-center gap-3 rounded-3xl bg-white p-6 text-center">
      <AlertTriangle className="size-7 text-coral" />
      <p className="text-[14px] text-navy-soft">{message}</p>
      {onRetry && <button type="button" onClick={onRetry} className={btnPrimary}>{A.retry}</button>}
    </div>
  )
}

export function Empty({ text = A.empty }: { text?: string }) {
  return <p className="py-10 text-center text-[14px] text-stone">{text}</p>
}

export function Notice({ kind = 'error', children }: { kind?: 'error' | 'ok'; children: ReactNode }) {
  return <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-2xl px-3.5 py-2.5 text-[13px] font-medium ${kind === 'error' ? 'bg-coral-soft text-coral-deep' : 'bg-emerald-50 text-emerald-800'}`}>{children}</p>
}

const TONES: Record<string, string> = {
  new: 'bg-coral-soft text-coral-deep', confirmed: 'bg-sky-100 text-sky-800', preparing: 'bg-amber-100 text-amber-800', shipped: 'bg-indigo-100 text-indigo-800',
  delivered: 'bg-emerald-100 text-emerald-800', cancelled: 'bg-mist text-navy-soft',
  pending: 'bg-coral-soft text-coral-deep', ready_for_pickup: 'bg-emerald-100 text-emerald-800', completed: 'bg-emerald-100 text-emerald-800', expired: 'bg-mist text-navy-soft',
  on: 'bg-emerald-100 text-emerald-800', off: 'bg-mist text-navy-soft', low: 'bg-amber-100 text-amber-800', out: 'bg-coral-soft text-coral-deep',
}
export const Badge = ({ tone, children }: { tone: string; children: ReactNode }) => (
  <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[12px] font-bold ${TONES[tone] ?? 'bg-mist text-navy-soft'}`}>{children}</span>
)

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-semibold text-navy-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-stone">{hint}</span>}
    </label>
  )
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${inputCls} ${p.className ?? ''}`} />
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${inputCls} min-h-24 ${p.className ?? ''}`} />
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${inputCls} ${p.className ?? ''}`} />
export const Btn = ({ kind = 'primary', busy, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger'; busy?: boolean }) => (
  <button type="button" {...p} disabled={p.disabled || busy} className={`${kind === 'primary' ? btnPrimary : kind === 'ghost' ? btnGhost : btnDanger} ${p.className ?? ''}`}>
    {busy && <Loader2 className="size-4 animate-spin" />}
    {children}
  </button>
)

export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}
          className={`min-h-10 shrink-0 rounded-full px-4 text-[13px] font-semibold transition-colors ${value === o.id ? 'bg-navy text-white' : 'glass-chip text-navy'}`}>
          {o.label}{o.count !== undefined && <span className="ml-1.5 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Pager({ shown, total, loading, onMore }: { shown: number; total: number; loading: boolean; onMore: () => void }) {
  if (shown >= total) return total > 0 ? <p className="py-3 text-center text-[12px] text-stone">{total} ta</p> : null
  return <div className="flex justify-center py-3"><Btn kind="ghost" busy={loading} onClick={onMore}>{A.more} ({shown}/{total})</Btn></div>
}

/** A labelled row inside a detail sheet */
export const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex items-start justify-between gap-4 py-2 text-[14px]"><span className="shrink-0 text-navy-soft">{k}</span><span className="min-w-0 break-words text-right font-semibold">{children}</span></div>
)
