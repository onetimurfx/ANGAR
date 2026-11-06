import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { CircleAlert, Check } from 'lucide-react'

interface ToastData {
  id: number
  message: string
  tone: 'ok' | 'warn'
  action?: { label: string; to: string }
}
interface Ctx {
  show: (message: string, opts?: { tone?: 'ok' | 'warn'; action?: { label: string; to: string } }) => void
}

const ToastCtx = createContext<Ctx | null>(null)

export function useToast(): Ctx {
  const c = useContext(ToastCtx)
  if (!c) throw new Error('useToast outside ToastProvider')
  return c
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastData | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const seq = useRef(0)

  const show = useCallback<Ctx['show']>((message, opts) => {
    window.clearTimeout(timer.current)
    setToast({ id: ++seq.current, message, tone: opts?.tone ?? 'ok', action: opts?.action })
    timer.current = window.setTimeout(() => setToast(null), 3600)
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 z-[80] flex justify-center px-4" style={{ top: 'calc(var(--safe-top) + 66px)' }}>
        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.id}
              role="status"
              aria-live="polite"
              data-testid="toast"
              initial={{ y: -14, opacity: 0, scale: 0.96 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ opacity: 0, y: -8 }}
              className="glass-nav pointer-events-auto flex max-w-[420px] items-center gap-2.5 rounded-full py-2 pl-3 pr-3.5 text-[13px] font-semibold text-navy"
            >
              <span className={`grid size-6 shrink-0 place-items-center rounded-full text-white ${toast.tone === 'ok' ? 'bg-[#4f6a3c]' : 'bg-coral'}`}>
                {toast.tone === 'ok' ? <Check className="size-3.5" strokeWidth={3} /> : <CircleAlert className="size-3.5" strokeWidth={2.6} />}
              </span>
              <span>{toast.message}</span>
              {toast.action && (
                <Link to={toast.action.to} onClick={() => setToast(null)} className="ml-1 whitespace-nowrap font-bold text-coral">
                  {toast.action.label}
                </Link>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}
