import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Phone, Search } from 'lucide-react'
import { BottomSheet } from '../../components/BottomSheet'
import { aGet, aPost } from '../api'
import { useAction, useDebounced } from '../hooks'
import { A, phoneFmt, uzs, when } from '../text'
import { NEXT_STATUS, ORDER_STATUSES, type OrderDetail, type OrderRow, type OrderStatus } from '../types'
import { Badge, Btn, Chips, Empty, ErrorBox, Field, Input, Loading, Notice, Pager, Row, Textarea } from '../ui'
import { adminError } from '../text'
import { PageTitle } from './common'

interface ListAnswer { orders: OrderRow[]; total: number; counts: Record<string, number> }
const PAGE = 30

export function Orders() {
  const [sp, setSp] = useSearchParams()
  const status = (ORDER_STATUSES as readonly string[]).includes(sp.get('status') ?? '') ? (sp.get('status') as OrderStatus) : ''
  const open = sp.get('open')
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const load = useCallback(async (offset: number) => {
    setLoading(true)
    try {
      const r = await aGet<ListAnswer>('orders', { status, q: dq, limit: PAGE, offset })
      setRows((prev) => (offset === 0 ? r.orders : [...prev, ...r.orders]))
      setTotal(r.total)
      setCounts(r.counts)
      setError(null)
    } catch (e) {
      setError(adminError(e))
    } finally {
      setLoading(false)
    }
  }, [status, dq])
  useEffect(() => { void load(0) }, [load, tick])

  const setStatus = (s: string) => setSp((p) => { const n = new URLSearchParams(p); if (s) n.set('status', s); else n.delete('status'); n.delete('open'); return n }, { replace: true })
  const closeSheet = useCallback(() => setSp((p) => { const n = new URLSearchParams(p); n.delete('open'); return n }, { replace: true }), [setSp])
  const sumAll = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div data-testid="admin-orders">
      <PageTitle title={A.nav.orders} />
      <p className="-mt-2 mb-3 text-[13px] text-stone">Savat orqali berilgan, yetkazib beriladigan buyurtmalar. Do'kondan olib ketish — «Pickup» bo'limida.</p>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-stone" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Raqam, ism yoki telefon" aria-label={A.search} className="pl-10" maxLength={100} />
      </div>
      <Chips label="Holat" value={status} onChange={setStatus}
        options={[{ id: '', label: A.all, count: sumAll }, ...ORDER_STATUSES.map((s) => ({ id: s as string, label: A.status[s], count: counts[s] ?? 0 }))]} />

      <div className="mt-3 space-y-2">
        {error && <ErrorBox message={error} onRetry={() => setTick((x) => x + 1)} />}
        {!error && loading && rows.length === 0 && <Loading />}
        {!error && !loading && rows.length === 0 && <Empty />}
        {rows.map((o) => (
          <button key={o.id} type="button" data-testid="order-row" data-status={o.status} onClick={() => setSp((p) => { const n = new URLSearchParams(p); n.set('open', o.id); return n }, { replace: true })}
            className="glass flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left active:scale-[0.99]">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-bold">{o.orderNumber}</p>
              <p className="truncate text-[13px] text-navy-soft">{o.contactName} · {o.itemCount} dona</p>
              <p className="text-[12px] text-stone">{when(o.createdAt)}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge tone={o.status}>{A.status[o.status]}</Badge>
              <span className="text-[13px] font-bold">{uzs(o.total)}</span>
              {o.deliveryPending && <span className="text-[11px] font-semibold text-coral">yetkazish narxi?</span>}
            </div>
          </button>
        ))}
        {!error && rows.length > 0 && <Pager shown={rows.length} total={total} loading={loading} onMore={() => void load(rows.length)} />}
      </div>

      <OrderSheet id={open} onClose={closeSheet} onChanged={() => setTick((x) => x + 1)} />
    </div>
  )
}

function OrderSheet({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<OrderDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)
  const [fee, setFee] = useState('')
  const act = useAction()

  useEffect(() => {
    setD(null); setErr(null); setReason(''); setAsking(false)
    if (!id) return
    let live = true
    aGet<OrderDetail>('order', { id }).then((r) => { if (live) { setD(r); setFee(r.order.deliveryFee === null ? '' : String(r.order.deliveryFee)) } }, (e) => { if (live) setErr(adminError(e)) })
    return () => { live = false }
  }, [id])

  const refresh = async () => { if (id) { const r = await aGet<OrderDetail>('order', { id }); setD(r); setFee(r.order.deliveryFee === null ? '' : String(r.order.deliveryFee)) } onChanged() }
  const move = (s: OrderStatus, note?: string) => act.run(async () => { await aPost('order', { action: 'set_status', id, status: s, note }); setAsking(false); setReason(''); await refresh() })
  const saveFee = () => act.run(async () => { await aPost('order', { action: 'set_delivery', id, fee: Number(fee) }); await refresh() })

  const o = d?.order
  const next = o ? NEXT_STATUS[o.status] : []
  const feeOk = /^\d{1,9}$/.test(fee)
  const canFee = o && ['new', 'confirmed', 'preparing'].includes(o.status)

  return (
    <BottomSheet open={!!id} onClose={onClose} title={o?.orderNumber ?? A.nav.orders}
      footer={o && next.length > 0 && !asking ? (
        <div className="flex flex-wrap gap-2">
          {next.filter((s) => s !== 'cancelled').map((s) => <Btn key={s} busy={act.busy} data-testid={`to-${s}`} onClick={() => void move(s)} className="flex-1">{A.action[s]}</Btn>)}
          {next.includes('cancelled') && <Btn kind="danger" data-testid="to-cancelled" onClick={() => setAsking(true)}>{A.action.cancelled}</Btn>}
        </div>
      ) : undefined}>
      {err && <ErrorBox message={err} />}
      {!err && !d && <Loading />}
      {o && d && (
        <div className="space-y-4 pb-2" data-testid="order-sheet" data-status={o.status}>
          <div className="flex items-center justify-between"><Badge tone={o.status}>{A.status[o.status]}</Badge><span className="text-[12px] text-stone">{when(o.createdAt)}</span></div>
          {act.error && <Notice>{act.error}</Notice>}

          <section className="rounded-2xl bg-white p-3.5">
            <Row k="Ism">{o.contact.name}</Row>
            <Row k="Telefon"><a href={`tel:${o.contact.phone}`} className="inline-flex items-center gap-1 text-coral"><Phone className="size-3.5" />{phoneFmt(o.contact.phone)}</a></Row>
            <Row k="Manzil">{o.contact.address}</Row>
            {o.contact.comment && <Row k="Izoh">{o.contact.comment}</Row>}
            <Row k="Telegram">{d.customer.username ? `@${d.customer.username}` : d.customer.name}</Row>
          </section>

          <section className="rounded-2xl bg-white p-3.5">
            {o.items.map((i, n) => (
              <div key={n} className="flex items-center gap-3 py-1.5 text-[14px]">
                <span className="size-3.5 shrink-0 rounded-full ring-1 ring-navy/15" style={{ background: i.colorHex }} />
                <span className="min-w-0 flex-1"><span className="font-semibold">{i.name}</span><span className="block text-[12px] text-stone">{i.brand} · {i.color}, {i.size}</span></span>
                <span className="shrink-0 text-right text-[13px]">{i.qty} × {uzs(i.unitPrice)}</span>
              </div>
            ))}
            <div className="mt-2 border-t border-navy/10 pt-2">
              <Row k="Mahsulotlar">{uzs(o.subtotal)}</Row>
              <Row k="Yetkazish">{o.deliveryPending ? <span className="text-coral">belgilanmagan</span> : uzs(o.deliveryFee)}</Row>
              <Row k="Jami"><span className="text-[16px]" data-testid="order-total">{uzs(o.total)}</span></Row>
            </div>
          </section>

          {canFee && (
            <section className="rounded-2xl bg-white p-3.5">
              <Field label="Yetkazish narxi (so'm)" hint={o.deliveryPending ? "Mijoz narx belgilanmaguncha jami summani ko'rmaydi." : undefined}>
                <div className="flex gap-2">
                  <Input inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value.replace(/\D/g, ''))} data-testid="fee-input" />
                  <Btn kind="ghost" disabled={!feeOk} busy={act.busy} onClick={() => void saveFee()} data-testid="fee-save">{A.save}</Btn>
                </div>
              </Field>
            </section>
          )}

          {asking && (
            <section className="space-y-2 rounded-2xl bg-coral-soft p-3.5">
              <Field label="Bekor qilish sababi (mijozga ko'rsatiladi)">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="cancel-reason" />
              </Field>
              <p className="text-[12px] text-navy-soft">Mahsulotlar omborga qaytariladi.</p>
              <div className="flex gap-2">
                <Btn kind="ghost" onClick={() => setAsking(false)} className="flex-1">{A.cancel}</Btn>
                <Btn busy={act.busy} disabled={reason.trim().length < 3} onClick={() => void move('cancelled', reason.trim())} className="flex-1" data-testid="cancel-confirm">{A.confirm}</Btn>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-1 text-[14px] font-bold text-navy-soft">Tarix</h3>
            <ol className="space-y-1 text-[13px]">
              {d.history.map((h, n) => (
                <li key={n} className="flex justify-between gap-3"><span><b>{A.status[h.status]}</b>{h.note ? ` — ${h.note}` : ''}</span><span className="shrink-0 text-stone">{when(h.at)}</span></li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </BottomSheet>
  )
}
