/** Sends the queued bot messages (admin alert, customer confirmation) through the Telegram Bot API. */
import type { Deps } from './types.ts'

export const money = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const STATUS_UZ: Record<string, string> = {
  new: 'Yangi', confirmed: 'Tasdiqlandi', preparing: 'Tayyorlanmoqda', shipped: "Yo'lga chiqdi", delivered: 'Yetkazildi', cancelled: 'Bekor qilindi',
}

function itemLines(o: any) {
  return (o.items as any[]).map((i) => `• ${esc(i.name)} (${esc(i.color)}, ${esc(i.size)}) × ${i.qty} = ${money(i.unitPrice * i.qty)}`).join('\n')
}
const deliveryLine = (o: any) => (o.deliveryPending ? 'Yetkazib berish: hali belgilanmagan' : `Yetkazib berish: ${o.deliveryFee === 0 ? 'bepul' : money(o.deliveryFee)}`)

export function composeMessage(kind: string, o: any): string {
  if (kind === 'order_admin')
    return [
      `🆕 <b>Yangi buyurtma ${esc(o.orderNumber)}</b>`,
      `👤 ${esc(o.contact.name)}`,
      `📞 ${esc(o.contact.phone)}`,
      `📍 ${esc(o.contact.address)}`,
      o.contact.comment ? `💬 ${esc(o.contact.comment)}` : '',
      '',
      itemLines(o),
      '',
      `Mahsulotlar: ${money(o.subtotal)}`,
      deliveryLine(o),
      `<b>Jami${o.deliveryPending ? ' (yetkazib berishsiz)' : ''}: ${money(o.total)}</b>`,
      `Manba: ${o.source === 'cart' ? 'Savatcha' : 'Tezkor buyurtma'}`,
    ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i < a.length - 1)).join('\n')
  if (kind === 'status_customer') return `📦 Buyurtma <b>${esc(o.orderNumber)}</b>: ${esc(STATUS_UZ[o.status] ?? o.status)}`
  return [`✅ <b>Buyurtmangiz qabul qilindi</b>`, `Raqam: <b>${esc(o.orderNumber)}</b>`, `Jami${o.deliveryPending ? ' (yetkazib berishsiz)' : ''}: ${money(o.total)}`].join('\n')
}

export interface DeliverResult {
  sent: number
  failed: number
  reason?: 'NO_BOT_TOKEN'
}

/** Claims due messages and sends them. Failures are recorded and retried later with backoff. Never throws. */
export async function deliverOutbox(deps: Deps, limit = 20): Promise<DeliverResult> {
  const token = deps.env.BOT_TOKEN
  if (!token) {
    deps.log('BOT_TOKEN not set: bot messages stay queued')
    return { sent: 0, failed: 0, reason: 'NO_BOT_TOKEN' }
  }
  const scrub = (s: string) => s.split(token).join('***')
  let sent = 0
  let failed = 0
  const rows = await deps.sql`select * from public.claim_outbox(${limit}::int)`
  for (const row of rows) {
    let ok = false
    let error: string | null = null
    try {
      const [{ o }] = await deps.sql`select public.order_to_json(${row.order_id}::uuid) -> 'order' as o`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 6000)
      try {
        const res = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(row.chat_id), text: composeMessage(row.kind, o), parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: ctrl.signal,
        })
        const body: any = await res.json().catch(() => ({}))
        ok = res.ok && body?.ok === true
        if (!ok) error = scrub(`Telegram ${res.status}: ${body?.description ?? 'unknown error'}`)
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      error = scrub(e instanceof Error ? e.message : String(e))
    }
    await deps.sql`select public.finish_outbox(${row.id}::bigint, ${ok}::boolean, ${error})`
    if (ok) sent++
    else {
      failed++
      deps.log('bot message failed', { id: String(row.id), kind: row.kind, error })
    }
  }
  return { sent, failed }
}
