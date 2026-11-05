import { useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { t } from '../i18n'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  /** shown at the right of the title row, before the close button */
  headerAction?: ReactNode
}

/** Frosted-glass modal sheet: Esc / backdrop closes, page scroll is locked, focus moves into the dialog. */
export function BottomSheet({ open, onClose, title, children, footer, headerAction }: Props) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const prevFocus = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      prevFocus?.focus?.()
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]">
          <motion.button
            type="button"
            tabIndex={-1}
            aria-label={t('common.close')}
            className="absolute inset-0 bg-navy/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="glass-nav absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] max-w-[520px] flex-col rounded-t-[32px] outline-none"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          >
            <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-navy/20" />
            <div className="flex shrink-0 items-center justify-between gap-2 px-5 pb-2 pt-3">
              <h2 className="text-xl">{title}</h2>
              <div className="flex items-center gap-2">
                {headerAction}
                <button type="button" onClick={onClose} aria-label={t('common.close')} className="grid size-9 place-items-center rounded-full bg-navy/[0.06]">
                  <X className="size-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
            {footer && <div className="shrink-0 border-t border-navy/[0.07] px-5 pb-4 pt-3">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
