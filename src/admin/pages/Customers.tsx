import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { BottomSheet } from '../../components/BottomSheet'
import { aGet } from '../api'
import { useDebounced } from '../hooks'
import { A, adminError, phoneFmt, uzs, when } from '../text'
import type { CustomerDetail, CustomerRow, OrderStatus, PickupStatus } from '../types'
import { Badge, Empty, ErrorBox, Input, Loading, Pager, Row } from '../ui'
import { PageTitle } from './common'

interface ListAnswer { customers: CustomerRow[]; total: number }
const PAGE = 30

export function Customers() {
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const load = useCallback(async (offset: number) => {
    setLoading(true)
    try { const r = await aGet<ListAnswer>('customers', { q: dq, limit: PAGE, offset }); setRows((p) => (offset === 0 ? r.customers : [...p, ...r.customers])); setTotal(r.total); setError(null) }
    catch (e) { setError(adminError(e)) } finally { setLoading(false) }
  }, [dq])
  useEffect(() => { void load(0) }, [load, tick])
  return (
    <div data-testid="admin-customers">
      <PageTitle title={A.nav.customers} />
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-stone" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ism, @username, telefon yoki Telegram ID" aria-label={A.search} className="pl-10" maxLength={100} />
      </div>
      <div className="space-y-2">
        {error && <ErrorBox message={error} onRetry={() => setTick((x) => x + 1)} />}
        {!error && loading && rows.length === 0 && <Loading />}
        {!error && !loading && rows.length === 0 && <Empty />}
        {rows.map((c) => (
          <button key={c.id} type="button" data-testid="customer-row" onClick={() => setOpen(c.id)} className="glass flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left active:scale-[0.99]">
            <div className="min-w-0 flex-1"><p className="truncate text-[14px] font-bold">{c.name || '—'}{c.username ? <span className="ml-1.5 font-normal text-stone">@{c.username}</span> : null}</p><p className="text-[12px] text-stone">{phoneFmt(c.phone)} · {c.cartOrders} Savat · {c.pickupOrders} pickup</p></div>
            <span className="shrink-0 text-[13px] font-bold">{uzs(c.cartSpent + c.pickupSpent)}</span>
          </button>
        ))}
        {!error && rows.length > 0 && <Pager shown={rows.length} total={total} loading={loading} onMore={() => void load(rows.length)} />}
      </div>
      <CustomerSheet id={open} onClose={() => setOpen(null)} />
    </div>
  )
}

function CustomerSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [d, setD] = useState<CustomerDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setD(null); setErr(null)
    if (!id) return
    let live = true
    aGet<CustomerDetail>('customer', { id }).then((r) => { if (live) setD(r) }, (e) => { if (live) setErr(adminError(e)) })
    return () => { live = false }
  }, [id])
  const c = d?.customer
  return (
    <BottomSheet open={!!id} onClose={onClose} title={c?.name || A.nav.customers}>
      {err && <ErrorBox message={err} />}
      {!err && !d && <Loading />}
      {c && d && (
        <div className="space-y-4 pb-2" data-testid="customer-sheet">
          <section className="rounded-2xl bg-white p-3.5">
            <Row k="Telegram">{c.username ? `@${c.username}` : '—'}</Row><Row k="Telegram ID">{c.telegramId}</Row><Row k="Telefon">{phoneFmt(c.phone)}</Row>
            <Row k="Ro'yxatdan o'tgan">{when(c.createdAt)}</Row><Row k="Oxirgi faollik">{when(c.lastSeenAt)}</Row>
          </section>
          <section><h3 className="mb-1.5 text-[14px] font-bold text-navy-soft">Savat buyurtmalari</h3>
            {d.orders.length === 0 && <p className="text-[13px] text-stone">Yo'q</p>}
            <div className="space-y-1.5">{d.orders.map((o) => (
              <Link key={o.id} to={`/admin/orders?open=${o.id}`} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2.5 text-[13px]"><span className="min-w-0 flex-1 truncate font-semibold">{o.orderNumber}<span className="ml-2 font-normal text-stone">{when(o.createdAt)}</span></span><Badge tone={o.status}>{A.status[o.status as OrderStatus] ?? o.status}</Badge><span className="font-bold">{uzs(o.total)}</span></Link>
            ))}</div></section>
          <section><h3 className="mb-1.5 text-[14px] font-bold text-navy-soft">Tezkor (pickup) buyurtmalari</h3>
            {d.pickupOrders.length === 0 && <p className="text-[13px] text-stone">Yo'q</p>}
            <div className="space-y-1.5">{d.pickupOrders.map((o) => (
              <Link key={o.id} to={`/admin/pickup?g=history&open=${o.id}`} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2.5 text-[13px]"><span className="min-w-0 flex-1 truncate font-semibold">{o.orderNumber}<span className="ml-2 font-normal text-stone">{when(o.createdAt)}</span></span><Badge tone={o.status}>{A.pickupStatus[o.status as PickupStatus] ?? o.status}</Badge><span className="font-bold">{uzs(o.total)}</span></Link>
            ))}</div></section>
        </div>
      )}
    </BottomSheet>
  )
}
