import { Link } from 'react-router-dom'
import { aGet } from '../api'
import { useRes } from '../hooks'
import { A, uzs, when } from '../text'
import type { DashboardData } from '../types'
import { Badge, ErrorBox, Loading, card } from '../ui'
import { PageTitle } from './common'

function Stat({ to, label, value, tone, sub }: { to: string; label: string; value: number | string; tone?: 'hot'; sub?: string }) {
  return (
    <Link to={to} className={`${card} block active:scale-[0.99]`}>
      <p className="text-[12px] font-semibold text-navy-soft">{label}</p>
      <p className={`mt-1 font-serif text-[28px] leading-none ${tone === 'hot' && Number(value) > 0 ? 'text-coral' : ''}`} data-testid={`stat-${label}`}>{value}</p>
      {sub && <p className="mt-1.5 text-[12px] text-stone">{sub}</p>}
    </Link>
  )
}

export function Dashboard() {
  const r = useRes(() => aGet<DashboardData>('dashboard'), [])
  if (r.loading && !r.data) return <Loading />
  if (r.error || !r.data) return <ErrorBox message={r.error ?? A.empty} onRetry={r.reload} />
  const d = r.data
  return (
    <div data-testid="admin-dashboard">
      <PageTitle title={A.nav.dashboard} />

      <h2 className="mb-2 mt-1 text-[17px]">Savat buyurtmalari (yetkazib berish)</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat to="/admin/orders?status=new" label="Yangi" value={d.cart.new} tone="hot" />
        <Stat to="/admin/orders?status=confirmed" label="Tasdiqlangan" value={d.cart.confirmed} />
        <Stat to="/admin/orders?status=preparing" label="Tayyorlanmoqda" value={d.cart.preparing} />
        <Stat to="/admin/orders?status=shipped" label="Yo'lda" value={d.cart.shipped} />
        <Stat to="/admin/orders" label="Bugun" value={d.cart.today} sub={uzs(d.cart.todayTotal)} />
        <Stat to="/admin/orders" label="Yetkazish narxi kutilmoqda" value={d.cart.deliveryPending} tone="hot" />
      </div>

      <h2 className="mb-2 mt-6 text-[17px]">Tezkor buyurtmalar (do'kondan olib ketish)</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat to="/admin/pickup" label="Kutilmoqda" value={d.pickup.pending} tone="hot" />
        <Stat to="/admin/pickup" label="Yig'ilmoqda" value={d.pickup.preparing} />
        <Stat to="/admin/pickup" label="Tayyor" value={d.pickup.ready} />
        <Stat to="/admin/pickup" label="Bugun topshirildi" value={d.pickup.completedToday} sub={uzs(d.pickup.completedTodayTotal)} />
      </div>

      <h2 className="mb-2 mt-6 text-[17px]">Ombor va katalog</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat to="/admin/inventory" label="Tugagan" value={d.stock.out} tone="hot" />
        <Stat to="/admin/inventory" label={`Kam (≤ ${d.stock.threshold})`} value={d.stock.low} tone="hot" />
        <Stat to="/admin/products" label="Faol mahsulotlar" value={d.catalog.active} sub={`${d.catalog.inactive} ta yashirin`} />
        <Stat to="/admin/customers" label="Mijozlar" value={d.customers.total} sub={`bugun +${d.customers.newToday}`} />
      </div>
      {d.catalog.samples > 0 && <p className="mt-3 rounded-2xl bg-beige-soft px-3.5 py-2 text-[12px] font-medium text-navy-soft">Faol namuna (sample) mahsulotlar: {d.catalog.samples}. Ular haqiqiy sotuvga chiqmasligi kerak.</p>}

      <h2 className="mb-2 mt-6 text-[17px]">So'nggi Savat buyurtmalari</h2>
      <div className="space-y-2">
        {d.recentOrders.length === 0 && <p className="py-6 text-center text-[14px] text-stone">{A.empty}</p>}
        {d.recentOrders.map((o) => (
          <Link key={o.id} to={`/admin/orders?open=${o.id}`} className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-bold">{o.orderNumber} · {o.contactName}</p>
              <p className="text-[12px] text-stone">{when(o.createdAt)} · {uzs(o.total)}</p>
            </div>
            <Badge tone={o.status}>{A.status[o.status]}</Badge>
          </Link>
        ))}
      </div>
    </div>
  )
}
