import { createContext, useContext, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Boxes, ClipboardList, LayoutDashboard, Package, Settings, ShieldAlert, Store, Tags, Users, WifiOff, Smartphone, ArrowLeft } from 'lucide-react'
import { Logo } from '../components/Logo'
import { useBackend } from '../lib/backendContext'
import { aGet, hasBackend } from './api'
import { useRes } from './hooks'
import { A } from './text'
import type { Me } from './types'
import { Badge, Btn, ErrorBox, Loading } from './ui'
import { Dashboard } from './pages/Dashboard'
import { Orders } from './pages/Orders'
import { Pickup } from './pages/Pickup'
import { Products } from './pages/Products'
import { ProductEdit } from './pages/ProductEdit'
import { Categories } from './pages/Categories'
import { Inventory } from './pages/Inventory'
import { Customers } from './pages/Customers'
import { SettingsPage } from './pages/Settings'

const AdminCtx = createContext<Me | null>(null)
/** The signed-in administrator, as the SERVER reported it. Only used to hide controls: the server re-checks every call. */
export const useMe = () => {
  const m = useContext(AdminCtx)
  if (!m) throw new Error('useMe outside the admin shell')
  return m
}

function Screen({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[var(--app-height)] max-w-[520px] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 grid size-16 place-items-center rounded-full bg-coral-soft text-coral">{icon}</div>
      <h1 className="text-2xl">{title}</h1>
      <p className="mt-2 max-w-[32ch] text-sm text-navy-soft">{hint}</p>
      <div className="mt-6 flex flex-col gap-3">
        {children}
        <Link to="/" className="text-[13px] font-semibold text-coral">{A.back}</Link>
      </div>
    </div>
  )
}

const NAV = [
  { to: '/admin', end: true, label: A.nav.dashboard, icon: LayoutDashboard },
  { to: '/admin/orders', label: A.nav.orders, icon: ClipboardList },
  { to: '/admin/pickup', label: A.nav.pickup, icon: Store },
  { to: '/admin/products', label: A.nav.products, icon: Package },
  { to: '/admin/categories', label: A.nav.categories, icon: Tags },
  { to: '/admin/inventory', label: A.nav.inventory, icon: Boxes },
  { to: '/admin/customers', label: A.nav.customers, icon: Users },
  { to: '/admin/settings', label: A.nav.settings, icon: Settings },
]

function Shell({ me }: { me: Me }) {
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition-colors lg:rounded-2xl lg:px-3.5 ${isActive ? 'bg-navy text-white' : 'glass-chip text-navy lg:bg-transparent'}`
  return (
    <AdminCtx.Provider value={me}>
      <div className="mx-auto min-h-[var(--app-height)] max-w-[1180px] lg:flex lg:gap-6 lg:px-6">
        <aside className="lg:sticky lg:top-0 lg:h-[var(--app-height)] lg:w-56 lg:shrink-0 lg:py-6">
          <header className="sticky top-0 z-30 bg-ivory/85 px-4 pb-2 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:backdrop-blur-none" style={{ paddingTop: 'calc(var(--safe-top) + 10px)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Logo className="h-9" />
                <span className="text-[12px] font-bold uppercase tracking-wider text-stone">admin</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={me.role === 'owner' ? 'new' : 'confirmed'}>{A.role[me.role]}</Badge>
                <Link to="/" aria-label={A.back} className="glass grid size-10 place-items-center rounded-full lg:hidden"><ArrowLeft className="size-[18px]" /></Link>
              </div>
            </div>
            <nav aria-label="Admin" className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={link}>
                  <n.icon className="size-[17px]" />
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <Link to="/" className="mt-4 hidden items-center gap-2 px-3.5 text-[13px] font-semibold text-coral lg:flex"><ArrowLeft className="size-4" />{A.back}</Link>
          </header>
        </aside>
        <main className="min-w-0 flex-1 px-4 pb-16 pt-3 lg:px-0 lg:pt-6" style={{ paddingBottom: 'calc(var(--safe-bottom) + 64px)' }}>
          <Routes>
            <Route path="/admin" element={<Dashboard />} />
            <Route path="/admin/orders" element={<Orders />} />
            <Route path="/admin/pickup" element={<Pickup />} />
            <Route path="/admin/products" element={<Products />} />
            <Route path="/admin/products/:id" element={<ProductEdit />} />
            <Route path="/admin/categories" element={<Categories />} />
            <Route path="/admin/inventory" element={<Inventory />} />
            <Route path="/admin/customers" element={<Customers />} />
            <Route path="/admin/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
    </AdminCtx.Provider>
  )
}

/** Gate: the panel renders only after the SERVER confirmed (GET me) that this Telegram account is an active administrator. */
export default function AdminApp() {
  const { auth, signIn } = useBackend()
  const demo = !hasBackend()
  const me = useRes(() => (auth === 'ok' ? aGet<Me>('me') : Promise.reject(new Error('wait'))), [auth])

  if (demo) return <Screen icon={<WifiOff className="size-7" />} title={A.gate.demo.title} hint={A.gate.demo.hint} />
  if (auth === 'not_in_telegram') return <Screen icon={<Smartphone className="size-7" />} title={A.gate.tg.title} hint={A.gate.tg.hint} />
  if (auth === 'failed') return <Screen icon={<WifiOff className="size-7" />} title={A.gate.failed.title} hint={A.gate.failed.hint}><Btn onClick={() => void signIn()}>{A.retry}</Btn></Screen>
  if (auth !== 'ok' || me.loading) return <div className="grid min-h-[var(--app-height)] place-items-center"><Loading /></div>
  if (me.error || !me.data || typeof me.data.telegramId !== 'number') {
    // 401/403 both mean "not an administrator for this session"; anything else is a connection problem
    if (me.kind === 'auth') return <Screen icon={<ShieldAlert className="size-7" />} title={A.gate.forbidden.title} hint={A.gate.forbidden.hint} />
    return <div className="mx-auto max-w-[520px] px-4 pt-16"><ErrorBox message={me.error ?? A.gate.failed.hint} onRetry={me.reload} /></div>
  }
  return <Shell me={me.data} />
}
