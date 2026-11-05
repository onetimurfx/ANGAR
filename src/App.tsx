import { useCallback, useEffect } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { BottomNav } from './components/BottomNav'
import { EmptyState, PageHeader, primaryBtn } from './components/ui'
import { Home } from './pages/Home'
import { Catalog } from './pages/Catalog'
import { Product } from './pages/Product'
import { Outfit } from './pages/Outfit'
import { Cart, QuickOrder } from './pages/Soon'
import { Profile } from './pages/Profile'
import { useBackButton } from './lib/telegram'
import { CartProvider } from './lib/cart'
import { ToastProvider } from './lib/toast'
import { Compass } from 'lucide-react'
import { t } from './i18n'

const ROOTS = new Set(['/', '/katalog', '/tezkor-buyurtma', '/savatcha', '/profil'])

function NotFound() {
  return (
    <div className="pb-36">
      <PageHeader title={t('notfound.title')} />
      <EmptyState
        icon={<Compass className="size-7" />}
        title={t('notfound.title')}
        action={
          <Link to="/" className={primaryBtn}>
            {t('notfound.home')}
          </Link>
        }
      />
    </div>
  )
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()

  // Telegram's native BackButton on every screen that is not one of the five main tabs.
  const goBack = useCallback(() => (window.history.length > 1 ? navigate(-1) : navigate('/')), [navigate])
  useBackButton(!ROOTS.has(location.pathname), goBack)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  // the product screen swaps the tab bar for its own purchase bar (price + add to cart + quick order)
  const showNav = !location.pathname.startsWith('/mahsulot/')

  return (
    <CartProvider>
    <ToastProvider>
    <div className="mx-auto min-h-[var(--app-height)] max-w-[520px]">
      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={location.pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <Routes location={location}>
            <Route path="/" element={<Home />} />
            <Route path="/katalog" element={<Catalog />} />
            <Route path="/tezkor-buyurtma" element={<QuickOrder />} />
            <Route path="/savatcha" element={<Cart />} />
            <Route path="/profil" element={<Profile />} />
            <Route path="/mahsulot/:id" element={<Product />} />
            <Route path="/komplekt/:id" element={<Outfit />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </motion.main>
      </AnimatePresence>
      {showNav && <BottomNav />}
    </div>
    </ToastProvider>
    </CartProvider>
  )
}
