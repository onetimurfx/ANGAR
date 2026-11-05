import { BellOff } from 'lucide-react'
import { t } from '../i18n'
import { BottomSheet } from './BottomSheet'

export function NotificationsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={t('home.notifications')}>
      <div className="flex flex-col items-center py-10 text-center">
        <div className="mb-3 grid size-14 place-items-center rounded-full bg-coral-soft text-coral">
          <BellOff className="size-6" />
        </div>
        <p className="text-sm text-navy-soft">{t('home.notifications.empty')}</p>
      </div>
    </BottomSheet>
  )
}
