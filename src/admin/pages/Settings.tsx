import { useEffect, useState } from 'react'
import { aGet, aPost } from '../api'
import { useMe } from '../AdminApp'
import { useAction, useRes } from '../hooks'
import { A } from '../text'
import type { SettingsData } from '../types'
import { Badge, Btn, ErrorBox, Field, Input, Loading, Notice, Row, card } from '../ui'
import { PageTitle } from './common'

const digits = (s: string) => s.replace(/\D/g, '')

export function SettingsPage() {
  const me = useMe()
  const r = useRes(() => aGet<SettingsData>('settings'), [])
  if (r.loading && !r.data) return <Loading />
  if (r.error || !r.data) return <ErrorBox message={r.error ?? A.empty} onRetry={r.reload} />
  const owner = me.role === 'owner'
  return (
    <div data-testid="admin-settings" className="space-y-4">
      <PageTitle title={A.nav.settings} />
      {!owner && <Notice>Sozlamalarni faqat loyiha egasi o'zgartira oladi. Siz ularni ko'ra olasiz.</Notice>}
      <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
        <ShopForm data={r.data} owner={owner} onSaved={(d) => r.setData(d)} />
        <PickupForm data={r.data} owner={owner} onSaved={(d) => r.setData(d)} />
      </div>
      {r.data.admins && (
        <section className={`${card}`}>
          <h2 className="mb-1 text-[17px]">Administratorlar</h2>
          <p className="mb-2 text-[12px] text-stone">Faqat ko'rish. Administrator qo'shish yoki olib tashlash panel orqali mumkin emas: bu faqat Supabase bazasida loyiha egasi tomonidan qilinadi.</p>
          {r.data.admins.map((a) => <Row key={a.telegramId} k={`${a.name} · ${a.telegramId}`}><Badge tone={a.active ? 'on' : 'off'}>{A.role[a.role]}{a.active ? '' : ' (o‘chirilgan)'}</Badge></Row>)}
        </section>
      )}
    </div>
  )
}

function ShopForm({ data, owner, onSaved }: { data: SettingsData; owner: boolean; onSaved: (d: SettingsData) => void }) {
  const s = data.settings
  const [fee, setFee] = useState(s.deliveryFee === null ? '' : String(s.deliveryFee))
  const [free, setFree] = useState(s.deliveryFreeFrom === null ? '' : String(s.deliveryFreeFrom))
  const [sample, setSample] = useState(s.allowSampleOrders)
  const [contact, setContact] = useState(s.supportContact ?? '')
  const [ok, setOk] = useState(false)
  const act = useAction()
  useEffect(() => { setOk(false) }, [fee, free, sample, contact])
  const valid = (fee === '' || /^\d{1,9}$/.test(fee)) && (free === '' || (/^\d{1,9}$/.test(free) && Number(free) > 0))
  const save = () => act.run(async () => {
    const r = await aPost<SettingsData>('settings', { action: 'update', settings: { deliveryFee: fee === '' ? null : Number(fee), deliveryFreeFrom: free === '' ? null : Number(free), allowSampleOrders: sample, supportContact: contact.trim() || null } })
    onSaved({ ...data, ...r }); setOk(true)
  })
  return (
    <section className={`${card} space-y-3`}>
      <h2 className="text-[17px]">Do'kon va yetkazib berish</h2>
      {act.error && <Notice>{act.error}</Notice>}
      <Field label="Yetkazish narxi (so'm)" hint="Bo'sh = belgilanmagan: har bir Savat buyurtmasiga narxni siz qo'yasiz."><Input inputMode="numeric" disabled={!owner} value={fee} onChange={(e) => setFee(digits(e.target.value))} data-testid="s-fee" /></Field>
      <Field label="Shu summadan bepul yetkazish" hint="Bo'sh = bepul yetkazish yo'q."><Input inputMode="numeric" disabled={!owner} value={free} onChange={(e) => setFree(digits(e.target.value))} /></Field>
      <Field label="Aloqa (Telegram yoki telefon)"><Input disabled={!owner} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} /></Field>
      <label className="flex min-h-11 items-start gap-3 text-[14px]"><input type="checkbox" disabled={!owner} checked={sample} onChange={(e) => setSample(e.target.checked)} className="mt-0.5 size-5 accent-[#d94b59]" /><span>Namuna (sample) mahsulotlarni sotishga ruxsat<span className="block text-[12px] text-stone">Faqat sinov uchun. Haqiqiy sotuvda o'chiq tursin.</span></span></label>
      {owner && <>{ok && <Notice kind="ok">{A.saved}</Notice>}<Btn busy={act.busy} disabled={!valid} onClick={() => void save()} className="w-full" data-testid="s-save">{A.save}</Btn></>}
    </section>
  )
}

function PickupForm({ data, owner, onSaved }: { data: SettingsData; owner: boolean; onSaved: (d: SettingsData) => void }) {
  const p = data.pickup
  const [f, setF] = useState({ storeAddress: p.storeAddress ?? '', storePhone: p.storePhone ?? '', storeHours: p.storeHours ?? '', pendingTimeoutMinutes: String(p.pendingTimeoutMinutes), readyHoldHours: String(p.readyHoldHours), maxActivePerCustomer: String(p.maxActivePerCustomer), maxLines: String(p.maxLines) })
  const [ok, setOk] = useState(false)
  const act = useAction()
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setOk(false) }
  const n = (s: string, lo: number, hi: number) => /^\d{1,5}$/.test(s) && Number(s) >= lo && Number(s) <= hi
  const valid = n(f.pendingTimeoutMinutes, 1, 1440) && n(f.readyHoldHours, 1, 720) && n(f.maxActivePerCustomer, 1, 20) && n(f.maxLines, 1, 50)
  const save = () => act.run(async () => {
    const r = await aPost<SettingsData>('settings', { action: 'update_pickup', pickup: {
      storeAddress: f.storeAddress.trim() || null, storePhone: f.storePhone.trim() || null, storeHours: f.storeHours.trim() || null,
      pendingTimeoutMinutes: Number(f.pendingTimeoutMinutes), readyHoldHours: Number(f.readyHoldHours), maxActivePerCustomer: Number(f.maxActivePerCustomer), maxLines: Number(f.maxLines) } })
    onSaved({ ...data, ...r }); setOk(true)
  })
  return (
    <section className={`${card} space-y-3`}>
      <h2 className="text-[17px]">Pickup (do'kondan olib ketish)</h2>
      {act.error && <Notice>{act.error}</Notice>}
      <Field label="Do'kon manzili"><Input disabled={!owner} value={f.storeAddress} onChange={(e) => set('storeAddress', e.target.value)} maxLength={300} data-testid="s-address" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Telefon"><Input disabled={!owner} value={f.storePhone} onChange={(e) => set('storePhone', e.target.value)} maxLength={40} /></Field>
        <Field label="Ish vaqti"><Input disabled={!owner} value={f.storeHours} onChange={(e) => set('storeHours', e.target.value)} maxLength={300} placeholder="10:00–20:00" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Qabul muddati (daqiqa)" hint="Shu vaqtda yig'ilmasa, avto bekor"><Input inputMode="numeric" disabled={!owner} value={f.pendingTimeoutMinutes} onChange={(e) => set('pendingTimeoutMinutes', digits(e.target.value))} /></Field>
        <Field label="Tayyor buyurtma saqlanishi (soat)"><Input inputMode="numeric" disabled={!owner} value={f.readyHoldHours} onChange={(e) => set('readyHoldHours', digits(e.target.value))} /></Field>
        <Field label="Mijozga faol buyurtmalar"><Input inputMode="numeric" disabled={!owner} value={f.maxActivePerCustomer} onChange={(e) => set('maxActivePerCustomer', digits(e.target.value))} /></Field>
        <Field label="Buyurtmadagi qatorlar"><Input inputMode="numeric" disabled={!owner} value={f.maxLines} onChange={(e) => set('maxLines', digits(e.target.value))} /></Field>
      </div>
      {owner && <>{ok && <Notice kind="ok">{A.saved}</Notice>}<Btn busy={act.busy} disabled={!valid} onClick={() => void save()} className="w-full" data-testid="s-pickup-save">{A.save}</Btn></>}
    </section>
  )
}
