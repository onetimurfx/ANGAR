import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Grid2x2, House, ShoppingBag, UserRound, Zap, type LucideIcon } from 'lucide-react'
import { t } from '../i18n'
import { haptic } from '../lib/telegram'
import { useCart } from '../lib/cart'
import type { Key } from '../i18n/uz'

/** Exactly five items; the center one is Quick Order. */
const ITEMS: { to: string; key: Key; icon: LucideIcon; end?: boolean; center?: boolean }[] = [
  { to: '/', key: 'nav.home', icon: House, end: true },
  { to: '/katalog', key: 'nav.catalog', icon: Grid2x2 },
  { to: '/tezkor-buyurtma', key: 'nav.quick', icon: Zap, center: true },
  { to: '/savatcha', key: 'nav.cart', icon: ShoppingBag },
  { to: '/profil', key: 'nav.profile', icon: UserRound },
]

export function BottomNav() {
  const { count } = useCart()
  return (
    <nav
      aria-label={t('nav.label')}
      className="pointer-events-auto w-full max-w-[440px]"
    >
      <ul className="glass-nav relative grid w-full grid-cols-[1fr_1fr_1.18fr_1fr_1fr] items-end rounded-[30px] px-1 pb-1.5 pt-1.5">
        {ITEMS.map(({ to, key, icon: Icon, end, center }) => (
          <li key={to} className="flex justify-center">
            <NavLink
              to={to}
              end={end}
              onClick={haptic}
              aria-label={t(key)}
              className="relative flex w-full flex-col items-center gap-0.5 rounded-2xl pb-1 pt-1.5"
            >
              {({ isActive }) =>
                center ? (
                  <>
                    <motion.span
                      whileTap={{ scale: 0.92 }}
                      className="-mt-7 grid size-[58px] place-items-center rounded-full bg-coral text-white shadow-[0_12px_24px_-6px_rgba(217,75,89,0.7)] ring-4 ring-ivory/90"
                    >
                      <Zap className="size-[26px]" fill="currentColor" strokeWidth={1.5} />
                    </motion.span>
                    <span className="text-center text-[9.5px] font-extrabold uppercase leading-[1.05] tracking-wide text-coral max-[359px]:text-[8.5px] max-[359px]:tracking-normal">
                      {t(key)
                        .split(' ')
                        .map((w) => (
                          <span key={w} className="block">
                            {w}
                          </span>
                        ))}
                    </span>
                  </>
                ) : (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="nav-active"
                        className="absolute inset-x-1 inset-y-0 rounded-2xl bg-navy/[0.07]"
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    <span className="relative">
                      <Icon className={`size-[22px] ${isActive ? 'text-coral' : 'text-navy-soft'}`} strokeWidth={isActive ? 2.4 : 1.9} />
                      {to === '/savatcha' && count > 0 && (
                        <motion.span
                          key={count}
                          initial={{ scale: 1.5 }}
                          animate={{ scale: 1 }}
                          data-testid="nav-cart-badge"
                          aria-label={`${count}`}
                          className="absolute -right-2.5 -top-2 grid min-w-[17px] place-items-center rounded-full bg-coral px-1 text-[10px] font-extrabold leading-[17px] text-white"
                        >
                          {count}
                        </motion.span>
                      )}
                    </span>
                    <span
                      className={`relative text-[9.5px] font-bold uppercase leading-none tracking-wide max-[359px]:text-[8.5px] max-[359px]:tracking-normal ${isActive ? 'text-navy' : 'text-navy-soft'}`}
                    >
                      {t(key)}
                    </span>
                  </>
                )
              }
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
