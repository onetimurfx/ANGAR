import { useCallback, useEffect, useState } from 'react'
import { Phone } from 'lucide-react'
import { BottomSheet } from '../../components/BottomSheet'
import { useSearchParams } from 'react-router-dom'
import { pGet, pPost } from '../api'
import { useAction } from '../hooks'
import { A, adminError, phoneFmt, uzs, when } from '../text'
import { PICKUP_GROUPS, type PickupGroup, type PickupHistory, type PickupOrder } from '../types'
import { Badge, Btn, Chips, Empty, ErrorBox, Field, Input, Loading, Notice, Row, Textarea } from '../ui'
import { PageTitle } from './common'

interface ListAnswer { orders: PickupOrder[]; counts: { pending: number; preparing: number; ready: number } }
interface OneAnswer { order: PickupOrder; history: PickupHistory[] }
const GROUP_LABEL: Record<PickupGroup, string> = { active: 'Faol', pending: 'Kutilmoqda', preparing: "Yig'ilmoqda", ready: 'Tayyor', history: 'Tarix' }

export function Pickup() {
  const [sp, setSp] = useSearchParams()
  const group = (PICKUP_GROUPS as readonly string[]).includes(sp.get('g') ?? '') ? (sp.get('g') as PickupGroup) : 'active'
  const open = sp.get('open')
  const [data, setData] = useState<ListAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [healthy, setHealthy] = useState(true)
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    // monitoring: a stopped cron means expired orders are not cleaned up (see BACKEND_SETUP.md)
    pGet<{ healthy: boolean }>({ view: 'health' }).then((h) => setHealthy(h.healthy !== false), () => undefined)
    try { setData(await pGet<ListAnswer>({ group, limit: 100 })); setErr(null) } catch (e) { setErr(adminError(e)) } finally { setLoading(false) }
  }, [group])
  useEffect(() => { void load() }, [load, tick])
  // the queue changes while the admin watches: refresh every 30 s (not while a sheet is open)
  useEffect(() => {
    if (open) return
    const id = setInterval(() => setTick((x) => x + 1), 30_000)
    return () => clearInterval(id)
  }, [open])

  const set = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const c = data?.counts

  return (
    <div data-testid="admin-pickup">
      <PageTitle title="Pickup" />
      <p className="-mt-2 mb-3 text-[13px] text-stone">Tezkor buyurtmalar: mijoz do'kondan olib ketadi, to'lov do'konda. Savat buyurtmalari — «Buyurtmalar» bo'limida.</p>
      {!healthy && <div className="mb-3" data-testid="pk-unhealthy"><Notice>Avtomatik tozalash (muddati o'tgan buyurtmalarni bekor qilish) ishlamayapti. Cron'ni tekshiring.</Notice></div>}
      <Chips label="Guruh" value={group} onChange={(g) => set('g', g === 'active' ? null : g)}
        options={PICKUP_GROUPS.map((g) => ({ id: g, label: GROUP_LABEL[g], count: g === 'pending' ? c?.pending : g === 'preparing' ? c?.preparing : g === 'ready' ? c?.ready : g === 'active' && c ? c.pending + c.preparing + c.ready : undefined }))} />

      <div className="mt-3 space-y-2">
        {err && <ErrorBox message={err} onRetry={() => setTick((x) => x + 1)} />}
        {!err && loading && !data && <Loading />}
        {!err && data && data.orders.length === 0 && <Empty />}
        {data?.orders.map((o) => (
          <button key={o.id} type="button" data-testid="pickup-row" data-status={o.status} onClick={() => set('open', o.id)} className="glass flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left active:scale-[0.99]">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-bold">{o.orderNumber}</p>
              <p className="truncate text-[13px] text-navy-soft">{o.contact.name} · {o.items.reduce((a, i) => a + i.qty, 0)} dona</p>
              <p className="text-[12px] text-stone">{when(o.createdAt)}{o.status === 'pending' && o.pendingExpiresAt ? ` · ${when(o.pendingExpiresAt)} gacha` : ''}{o.status === 'ready_for_pickup' && o.readyExpiresAt ? ` · ${when(o.readyExpiresAt)} gacha` : ''}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1"><Badge tone={o.status}>{A.pickupStatus[o.status]}</Badge><span className="text-[13px] font-bold">{uzs(o.total)}</span></div>
          </button>
        ))}
      </div>
      <PickupSheet id={open} onClose={() => set('open', null)} onChanged={() => setTick((x) => x + 1)} />
    </div>
  )
}

function PickupSheet({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<OneAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<'cancel' | 'complete' | null>(null)
  const [reason, setReason] = useState('')
  const [code, setCode] = useState('')
  const [paid, setPaid] = useState(false)
  const act = useAction()

  useEffect(() => {
    setD(null); setErr(null); setMode(null); setReason(''); setCode(''); setPaid(false)
    if (!id) return
    let live = true
    pGet<OneAnswer>({ id }).then((r) => { if (live) setD(r) }, (e) => { if (live) setErr(adminError(e)) })
    return () => { live = false }
  }, [id])

  const reload = async () => { if (id) setD(await pGet<OneAnswer>({ id })); onChanged() }
  const simple = (action: 'start_preparing' | 'mark_ready') => act.run(async () => { await pPost({ action, id }); await reload() })
  const cancel = () => act.run(async () => { await pPost({ action: 'cancel', id, reason: reason.trim() }); setMode(null); await reload() })
  const complete = () => act.run(async () => { await pPost({ action: 'complete', id, code: code.trim(), paymentConfirmed: true, amount: d?.order.total }); setMode(null); await reload() })

  const o = d?.order
  const canCancel = o && ['pending', 'preparing', 'ready_for_pickup'].includes(o.status)
  return (
    <BottomSheet open={!!id} onClose={onClose} title={o?.orderNumber ?? 'Pickup'}
      footer={o && !mode && ['pending', 'preparing', 'ready_for_pickup'].includes(o.status) ? (
        <div className="flex flex-wrap gap-2">
          {o.status === 'pending' && <Btn busy={act.busy} onClick={() => void simple('start_preparing')} className="flex-1" data-testid="pk-start">Yig'ishni boshlash</Btn>}
          {o.status === 'preparing' && <Btn busy={act.busy} onClick={() => void simple('mark_ready')} className="flex-1" data-testid="pk-ready">Tayyor (kod yuboriladi)</Btn>}
          {o.status === 'ready_for_pickup' && <Btn onClick={() => setMode('complete')} className="flex-1" data-testid="pk-complete">Topshirish</Btn>}
          {canCancel && <Btn kind="danger" onClick={() => setMode('cancel')} data-testid="pk-cancel">Bekor qilish</Btn>}
        </div>
      ) : undefined}>
      {err && <ErrorBox message={err} />}
      {!err && !d && <Loading />}
      {o && d && (
        <div className="space-y-4 pb-2" data-testid="pickup-sheet" data-status={o.status}>
          <div className="flex items-center justify-between"><Badge tone={o.status}>{A.pickupStatus[o.status]}</Badge><span className="text-[12px] text-stone">{when(o.createdAt)}</span></div>
          {act.error && <Notice>{act.error}</Notice>}
          <section className="rounded-2xl bg-white p-3.5">
            <Row k="Ism">{o.contact.name}</Row>
            <Row k="Telefon"><a href={`tel:${o.contact.phone}`} className="inline-flex items-center gap-1 text-coral"><Phone className="size-3.5" />{phoneFmt(o.contact.phone)}</a></Row>
            {o.contact.comment && <Row k="Izoh">{o.contact.comment}</Row>}
            {o.status === 'pending' && <Row k="Qabul muddati">{when(o.pendingExpiresAt)}</Row>}
            {o.status === 'ready_for_pickup' && <Row k="Saqlanadi">{when(o.readyExpiresAt)} gacha</Row>}
            {o.closeNote && <Row k="Sabab">{o.closeNote}</Row>}
          </section>
          <section className="rounded-2xl bg-white p-3.5">
            {o.items.map((i, n) => (
              <div key={n} className="flex items-center gap-3 py-1.5 text-[14px]">
                <span className="size-3.5 shrink-0 rounded-full ring-1 ring-navy/15" style={{ background: i.colorHex }} />
                <span className="min-w-0 flex-1"><span className="font-semibold">{i.name}</span><span className="block text-[12px] text-stone">{i.color}, {i.size}</span></span>
                <span className="shrink-0 text-[13px]">{i.qty} × {uzs(i.unitPrice)}</span>
              </div>
            ))}
            <div className="mt-2 border-t border-navy/10 pt-2"><Row k="Jami (do'konda to'lanadi)"><span className="text-[16px]">{uzs(o.total)}</span></Row></div>
          </section>

          {mode === 'cancel' && (
            <section className="space-y-2 rounded-2xl bg-coral-soft p-3.5">
              <Field label="Bekor qilish sababi (mijozga yuboriladi)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="pk-reason" /></Field>
              <div className="flex gap-2"><Btn kind="ghost" onClick={() => setMode(null)} className="flex-1">{A.cancel}</Btn><Btn busy={act.busy} disabled={reason.trim().length < 3} onClick={() => void cancel()} className="flex-1" data-testid="pk-cancel-confirm">{A.confirm}</Btn></div>
            </section>
          )}
          {mode === 'complete' && (
            <section className="space-y-3 rounded-2xl bg-beige-soft p-3.5">
              <Field label="Mijoz ko'rsatgan pickup kodi" hint="Kod mijozning telefonida. U sizga ko'rsatilmaydi.">
                <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} autoComplete="off" autoCapitalize="characters" data-testid="pk-code" />
              </Field>
              <label className="flex items-start gap-3 text-[14px]"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="mt-0.5 size-5 accent-[#d94b59]" data-testid="pk-paid" /><span>{uzs(o.total)} to'lov qabul qilindi</span></label>
              <div className="flex gap-2"><Btn kind="ghost" onClick={() => setMode(null)} className="flex-1">{A.cancel}</Btn><Btn busy={act.busy} disabled={!paid || code.trim().length < 3} onClick={() => void complete()} className="flex-1" data-testid="pk-complete-confirm">Topshirildi</Btn></div>
            </section>
          )}

          <section>
            <h3 className="mb-1 text-[14px] font-bold text-navy-soft">Tarix</h3>
            <ol className="space-y-1 text-[13px]">
              {d.history.map((h, n) => (
                <li key={n} className="flex justify-between gap-3"><span><b>{h.kind === 'payment' ? "To'lov" : (A.pickupStatus as Record<string, string>)[h.status] ?? h.status}</b>{h.note ? ` — ${h.note}` : ''}</span><span className="shrink-0 text-stone">{when(h.at)}</span></li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </BottomSheet>
  )
}
