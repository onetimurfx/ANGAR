import { lazy, Suspense, useCallback, useEffect } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Dock } from './components/Dock'
import { EmptyState, PageHeader, primaryBtn } from './components/ui'
import { Home } from './pages/Home'
import { Catalog } from './pages/Catalog'
import { Product } from './pages/Product'
import { Outfit } from './pages/Outfit'
import { QuickOrder } from './pages/QuickOrder'
import { Cart } from './pages/Cart'
import { Checkout } from './pages/Checkout'
import { OrderView } from './pages/OrderView'
import { PickupOrderView } from './pages/PickupOrderView'
import { Profile } from './pages/Profile'
import { useBackButton } from './lib/telegram'
import { CartProvider } from './lib/cart'
import { OrdersProvider } from './lib/ordersStore'
import { QuickProvider } from './lib/quick'
import { PickupProvider } from './lib/pickupStore'
import { ToastProvider } from './lib/toast'
import { Compass } from 'lucide-react'
import { t } from './i18n'

const AdminApp = lazy(() => import('./admin/AdminApp'))
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

  // The admin panel is its own bundle (loaded on demand) and does not use the shop's carts, dock or animation wrapper.
  if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) {
    return (
      <Suspense fallback={<div className="grid min-h-[var(--app-height)] place-items-center text-sm text-stone">…</div>}>
        <AdminApp />
      </Suspense>
    )
  }

  return (
    <CartProvider>
    <OrdersProvider>
    <QuickProvider>
    <PickupProvider>
    <ToastProvider>
    <Dock>
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
            <Route path="/tezkor-buyurtma/:id" element={<PickupOrderView />} />
            <Route path="/savatcha" element={<Cart />} />
            <Route path="/savatcha/buyurtma" element={<Checkout />} />
            <Route path="/buyurtma/:id" element={<OrderView />} />
            <Route path="/profil" element={<Profile />} />
            <Route path="/mahsulot/:id" element={<Product />} />
            <Route path="/komplekt/:id" element={<Outfit />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </motion.main>
      </AnimatePresence>
    </div>
    </Dock>
    </ToastProvider>
    </PickupProvider>
    </QuickProvider>
    </OrdersProvider>
    </CartProvider>
  )
}
