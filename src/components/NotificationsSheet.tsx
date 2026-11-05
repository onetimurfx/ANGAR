import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BellOff, X } from 'lucide-react'
import { t } from '../i18n'

export function NotificationsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.button
            type="button"
            aria-label={t('common.close')}
            className="absolute inset-0 bg-navy/35"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t('home.notifications')}
            className="glass-nav absolute inset-x-0 bottom-0 mx-auto max-w-[480px] rounded-t-[32px] px-6 pb-10 pt-4"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 36 }}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-navy/20" />
            <div className="flex items-center justify-between">
              <h2 className="text-xl">{t('home.notifications')}</h2>
              <button type="button" onClick={onClose} aria-label={t('common.close')} className="grid size-9 place-items-center rounded-full bg-navy/[0.06]">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col items-center py-10 text-center">
              <div className="mb-3 grid size-14 place-items-center rounded-full bg-coral-soft text-coral">
                <BellOff className="size-6" />
              </div>
              <p className="text-sm text-navy-soft">{t('home.notifications.empty')}</p>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
