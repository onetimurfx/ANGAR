import { Link } from 'react-router-dom'
import { ChevronRight, Headset, PackageOpen, UserRound } from 'lucide-react'
import { PageHeader, Section } from '../components/ui'
import { ProductRail } from '../components/ProductCard'
import { getProduct } from '../data/sample'
import { getTelegramUser, isInTelegram } from '../lib/telegram'
import { DraftBadge } from '../components/NoticeBanner'
import { useOrders } from '../lib/ordersStore'
import { formatUZS } from '../lib/format'
import { useRecent } from '../lib/recent'
import { t } from '../i18n'

export function Profile() {
  const user = getTelegramUser()
  const { orders } = useOrders()
  const recent = useRecent().map(getProduct).filter((p) => p !== undefined)
  const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'AYNIMO mijozi'

  return (
    <div className="pb-36">
      <PageHeader title={t('profile.title')} />
      <div className="px-4">
        <div className="glass flex items-center gap-4 rounded-[28px] p-4">
          {user?.photo_url ? (
            <img src={user.photo_url} alt="" className="size-16 rounded-full object-cover" />
          ) : (
            <div className="grid size-16 place-items-center rounded-full bg-coral-soft text-coral">
              <UserRound className="size-7" />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{name}</p>
            {user?.username && <p className="text-sm text-navy-soft">@{user.username}</p>}
          </div>
        </div>
        <p className="mt-2 px-1 text-[12px] text-stone">{isInTelegram() ? t('profile.tgNote') : t('profile.preview')}</p>

        <h2 className="mb-2 mt-7 text-xl">{t('profile.orders')}</h2>
        {orders.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-4 text-sm text-navy-soft">
            <PackageOpen className="size-5 text-coral" />
            {t('profile.ordersEmpty')}
          </div>
        ) : (
          <>
            <p className="mb-2 text-[12.5px] text-navy-soft">{t('profile.ordersHint')}</p>
            <ul className="space-y-2.5">
              {orders.map((o) => (
                <li key={o.id}>
                  <Link to={`/buyurtma/${o.id}`} data-testid="profile-order" className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3.5 shadow-[0_8px_22px_-16px_rgba(23,43,58,0.5)] active:scale-[0.99]">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-extrabold tracking-wide tabular-nums">{o.ref}</p>
                      <p className="mt-0.5 text-[12.5px] text-navy-soft">
                        {new Date(o.createdAt).toLocaleDateString('uz-UZ')} · {o.items.reduce((n, i) => n + i.qty, 0)} {t('cart.line')} · {formatUZS(o.total)}
                      </p>
                      <DraftBadge className="mt-1.5" />
                    </div>
                    <ChevronRight className="size-5 shrink-0 text-stone" />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        <h2 className="mb-2 mt-7 text-xl">{t('profile.support')}</h2>
        <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-4 text-sm text-navy-soft">
          <Headset className="size-5 text-coral" />
          {t('profile.supportEmpty')}
        </div>
      </div>
      {recent.length > 0 && (
        <Section title={t('home.recent')}>
          <ProductRail items={recent} />
        </Section>
      )}
    </div>
  )
}
