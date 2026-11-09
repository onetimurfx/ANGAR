/** Bot messages for Quick Order (store pickup): Uzbek text, HTML-escaped, retried through pickup_outbox. */
import { esc, money } from './notify.ts'
import type { Deps } from './types.ts'

export interface StoreInfo {
  address?: string | null
  phone?: string | null
  hours?: string | null
  pendingMinutes?: number | null
}

/** dd.mm.yyyy HH:MM in the store's time zone (Uzbekistan has no daylight saving) */
export function whenUz(iso: unknown): string {
  const d = new Date(String(iso))
  if (Number.isNaN(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return `${g('day')}.${g('month')}.${g('year')} ${g('hour')}:${g('minute')}`
}

const lines = (o: any) => (o.items as any[]).map((i) => `• ${esc(i.name)} (${esc(i.color)}, ${esc(i.size)}) × ${Number(i.qty)} = ${money(i.unitPrice * i.qty)}`).join('\n')
const storeLines = (s: StoreInfo) =>
  [s.address ? `📍 Manzil: ${esc(s.address)}` : '', s.hours ? `🕘 Ish vaqti: ${esc(s.hours)}` : '', s.phone ? `📞 Telefon: ${esc(s.phone)}` : ''].filter(Boolean)
const clean = (a: string[]) => a.filter((l, i) => l !== '' || (a[i - 1] !== '' && i < a.length - 1)).join('\n')

/** Returns null when no message should be sent any more (the order moved on, e.g. the code would be stale). */
export function composePickupMessage(kind: string, event: string, o: any, store: StoreInfo = {}): string | null {
  const no = `<b>${esc(o.orderNumber)}</b>`
  if (kind === 'pickup_admin') {
    if (event === 'new')
      return clean([
        `🆕 <b>Yangi buyurtma (do'konda olib ketish) ${esc(o.orderNumber)}</b>`,
        `👤 ${esc(o.contact.name)}`,
        `📞 ${esc(o.contact.phone)}`,
        o.contact.comment ? `💬 ${esc(o.contact.comment)}` : '',
        '',
        lines(o),
        '',
        `<b>Jami: ${money(o.total)}</b> · to'lov do'konda`,
        `Admin panelda yig'ishni boshlang.`,
      ])
    if (event === 'cancelled') return `❌ Mijoz ${no} buyurtmasini bekor qildi.`
    return null
  }
  if (kind !== 'pickup_customer') return null
  switch (event) {
    case 'new':
      return clean([
        `🕒 <b>Buyurtmangiz qabul qilindi</b>`,
        `Raqam: ${no}`,
        '',
        lines(o),
        '',
        `<b>Jami: ${money(o.total)}</b> · to'lov faqat do'konda`,
        store.pendingMinutes ? `Do'kon xodimi ${store.pendingMinutes} daqiqa ichida yig'ishni boshlamasa, buyurtma avtomatik bekor bo'ladi.` : '',
      ])
    case 'preparing':
      return `👕 Buyurtma ${no} tayyorlanmoqda. Tayyor bo'lganda kodingizni yuboramiz.`
    case 'ready': {
      if (o.status !== 'ready_for_pickup' || !o.pickupCode) return null
      return clean([
        `✅ <b>Buyurtmangiz tayyor!</b>`,
        `Raqam: ${no}`,
        `Pickup kodi: <code>${esc(o.pickupCode)}</code>`,
        `Kodni do'konda xodimga ko'rsating. Kodni boshqalarga bermang.`,
        `Jami: <b>${money(o.total)}</b> · to'lov do'konda`,
        o.readyExpiresAt ? `Buyurtma ${whenUz(o.readyExpiresAt)} gacha saqlanadi.` : '',
        ...storeLines(store),
      ])
    }
    case 'completed':
      return `🎉 Buyurtma ${no} topshirildi. Xaridingiz uchun rahmat!`
    case 'cancelled':
      return clean([
        `❌ Buyurtma ${no} bekor qilindi.`,
        o.closedReason === 'admin_cancelled' && o.closeNote ? `Sabab: ${esc(o.closeNote)}` : '',
      ])
    case 'expired':
      return o.closedReason === 'pickup_timeout'
        ? `⌛ Buyurtma ${no} olib ketilmagani uchun bekor qilindi. Mahsulotlar yana sotuvga qaytdi.`
        : `⌛ Buyurtma ${no} do'kon tomonidan qabul qilinmagani uchun muddati tugadi. Xohlasangiz, qayta buyurtma bering.`
    default:
      return null
  }
}

export interface PickupDeliverResult {
  sent: number
  failed: number
  skipped: number
  reason?: 'NO_BOT_TOKEN'
}

/**
 * Claims due messages and sends them. claim_pickup_outbox() pushes next_attempt_at forward BEFORE sending (a lease), so
 * concurrent runs (cron + background) never pick the same row; a failure is retried later with backoff (max 6 attempts).
 * Messages to one chat go in order; different chats go in parallel, so the whole batch stays well inside the lease.
 * Never throws.
 */
export async function deliverPickupOutbox(deps: Deps, limit = 20): Promise<PickupDeliverResult> {
  const token = deps.env.BOT_TOKEN
  if (!token) {
    deps.log('BOT_TOKEN not set: pickup bot messages stay queued')
    return { sent: 0, failed: 0, skipped: 0, reason: 'NO_BOT_TOKEN' }
  }
  const scrub = (s: string) => s.split(token).join('***')
  const res: PickupDeliverResult = { sent: 0, failed: 0, skipped: 0 }
  const rows = await deps.sql`select * from public.claim_pickup_outbox(${limit}::int)`
  if (!rows.length) return res
  const [st] = await deps.sql`select store_address, store_phone, store_hours, pending_timeout_minutes from public.pickup_settings limit 1`
  const store: StoreInfo = { address: st?.store_address, phone: st?.store_phone, hours: st?.store_hours, pendingMinutes: st?.pending_timeout_minutes }

  const sendOne = async (row: any) => {
    let ok = false
    let error: string | null = null
    try {
      const view = row.kind === 'pickup_customer' ? 'customer' : 'admin'
      const [{ o }] = await deps.sql`select public.pickup_order_json(${row.pickup_order_id}::uuid, ${view}) as o`
      const text = o ? composePickupMessage(row.kind, row.event, o, store) : null
      if (text === null) {
        res.skipped++
        await deps.sql`select public.finish_pickup_outbox(${row.id}::bigint, true::boolean, null)`
        return
      }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      try {
        const r = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(row.chat_id), text, parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: ctrl.signal,
        })
        const body: any = await r.json().catch(() => ({}))
        ok = r.ok && body?.ok === true
        if (!ok) error = scrub(`Telegram ${r.status}: ${body?.description ?? 'unknown error'}`)
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      error = scrub(e instanceof Error ? e.message : String(e))
    }
    await deps.sql`select public.finish_pickup_outbox(${row.id}::bigint, ${ok}::boolean, ${error})`
    if (ok) res.sent++
    else {
      res.failed++
      // ids and kinds only: no message text, no pickup code, no token
      deps.log('pickup bot message failed', { id: String(row.id), kind: row.kind, event: row.event, error })
    }
  }

  const byChat = new Map<string, any[]>()
  for (const row of rows) byChat.set(String(row.chat_id), [...(byChat.get(String(row.chat_id)) ?? []), row])
  await Promise.all([...byChat.values()].map(async (group) => {
    for (const row of group) await sendOne(row)
  }))
  return res
}

/** Fire-and-forget delivery after a state change; the cron job is the safety net. */
export const deliverInBackground = (deps: Deps) =>
  deps.background(deliverPickupOutbox(deps).catch((e) => deps.log('deliverPickupOutbox failed', { message: String(e instanceof Error ? e.message : e) })))
