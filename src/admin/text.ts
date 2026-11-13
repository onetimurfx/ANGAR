/** Uzbek (Latin) texts and formatting of the admin panel. Kept apart from the shop's typed i18n: the panel is a separate bundle. */
import { BackendError } from '../lib/backend'
import type { OrderStatus, PickupStatus } from './types'

export const A = {
  title: 'Admin panel',
  back: "Do'konga qaytish",
  nav: { dashboard: 'Dashboard', orders: 'Buyurtmalar', pickup: 'Pickup', products: 'Mahsulotlar', categories: 'Kategoriyalar', inventory: 'Ombor', customers: 'Mijozlar', settings: 'Sozlamalar' },
  loading: 'Yuklanmoqda…',
  retry: 'Qayta urinish',
  save: 'Saqlash',
  saving: 'Saqlanmoqda…',
  cancel: 'Bekor qilish',
  close: 'Yopish',
  search: 'Qidirish',
  all: 'Hammasi',
  more: "Ko'proq yuklash",
  empty: "Hech narsa topilmadi",
  saved: 'Saqlandi',
  confirm: 'Tasdiqlash',
  gate: {
    demo: { title: 'Server ulanmagan', hint: "Admin panel faqat server (Supabase) ulangan holatda ishlaydi. Hozir demo rejim." },
    tg: { title: 'Telegram ichida oching', hint: "Admin paneliga faqat Telegram Mini App orqali, administrator hisobingiz bilan kirish mumkin." },
    forbidden: { title: "Ruxsat yo'q", hint: "Bu hisob administrator emas. Ruxsatni faqat loyiha egasi bazada beradi." },
    failed: { title: 'Kirib bo‘lmadi', hint: "Serverga ulanib bo'lmadi. Internetni tekshirib, qayta urinib ko'ring." },
  },
  role: { owner: 'Egasi', manager: 'Menejer' },
  status: {
    new: 'Yangi', confirmed: 'Tasdiqlandi', preparing: 'Tayyorlanmoqda', shipped: "Yo'lda", delivered: 'Yetkazildi', cancelled: 'Bekor qilindi',
  } as Record<OrderStatus, string>,
  pickupStatus: {
    pending: 'Kutilmoqda', preparing: 'Yig‘ilmoqda', ready_for_pickup: 'Tayyor', completed: 'Topshirildi', cancelled: 'Bekor qilindi', expired: 'Muddati tugadi',
  } as Record<PickupStatus, string>,
  action: { confirmed: 'Tasdiqlash', preparing: 'Tayyorlashni boshlash', shipped: "Yo'lga chiqarish", delivered: 'Yetkazildi', cancelled: 'Bekor qilish' } as Record<OrderStatus, string>,
}

const ERR: Record<string, string> = {
  FORBIDDEN: "Bu amal uchun ruxsatingiz yo'q.",
  NOT_FOUND: 'Topilmadi (o‘chirilgan bo‘lishi mumkin).',
  INVALID_TRANSITION: "Buyurtma holati o'zgargan. Ro'yxatni yangilab ko'ring.",
  INVALID_REASON: "Sababni yozing (kamida 3 belgi).",
  IN_USE: "Bu elementga mahsulotlar bog'langan, avval ularni o'zgartiring.",
  DUPLICATE_VARIANT: "Bunday o'lcham va rang allaqachon bor.",
  STOCK_BELOW_RESERVED: "Ombor miqdori band qilingan (pickup) miqdordan kam bo'lishi mumkin emas.",
  FILE_MISSING: "Rasm yuklanmagan. Qayta urinib ko'ring.",
  TOO_MANY_IMAGES: "Rasmlar soni chegaradan oshdi (12 ta).",
  UNSUPPORTED_TYPE: 'Faqat JPG, PNG yoki WebP rasm mumkin.',
  STORAGE_UNAVAILABLE: 'Rasm saqlash xizmati hozir ishlamayapti.',
  INVALID_CODE: "Kod noto'g'ri.",
  RATE_LIMITED: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.",
  PAYMENT_REQUIRED: "To'lov qabul qilinganini tasdiqlang.",
  AMOUNT_MISMATCH: "Summa buyurtma jamiga teng emas.",
  NOT_READY: 'Buyurtma hali tayyor emas.',
  EXPIRED: 'Buyurtma muddati tugagan.',
  NOT_CANCELLABLE: 'Bu buyurtmani bekor qilib bo‘lmaydi.',
}
const FIELDS: Record<string, string> = { name: 'Nomi', price: 'Narx', oldPrice: 'Eski narx', brandId: 'Brend', categoryId: 'Kategoriya', description: 'Tavsif', variants: 'Variantlar', fee: 'Yetkazish narxi', deliveryFee: 'Yetkazish narxi', deliveryFreeFrom: 'Bepul yetkazish chegarasi', supportContact: 'Aloqa', storeAddress: 'Manzil', storePhone: 'Telefon', storeHours: 'Ish vaqti', pendingTimeoutMinutes: 'Kutish vaqti', readyHoldHours: 'Saqlash vaqti', maxActivePerCustomer: 'Faol buyurtmalar', maxLines: 'Qatorlar soni', path: 'Rasm' }

/** User-facing message for any failure. Never shows technical details. */
export function adminError(e: unknown): string {
  if (e instanceof Error && e.message === 'type') return ERR.UNSUPPORTED_TYPE
  if (e instanceof Error && e.message === 'size') return 'Rasm 5 MB dan katta.'
  if (!(e instanceof BackendError)) return 'Kutilmagan xato.'
  if (e.code === 'STOCK_BELOW_RESERVED' && typeof e.detail.reserved === 'number') return `Ombor ${e.detail.reserved} tadan kam bo'lishi mumkin emas (band qilingan).`
  if (ERR[e.code]) return ERR[e.code]
  if (e.code === 'INVALID_REQUEST' && typeof e.detail.field === 'string') return `${FIELDS[e.detail.field] ?? e.detail.field}: noto'g'ri qiymat.`
  switch (e.kind) {
    case 'offline': return "Internet yo'q."
    case 'timeout': return "Server javob bermadi. Qayta urinib ko'ring."
    case 'auth': return 'Sessiya tugadi yoki ruxsat yo‘q.'
    case 'unavailable': return "Admin xizmati hali yoqilmagan (deploy qilinmagan)."
    case 'rate_limit': return "Juda ko'p so'rov. Biroz kuting."
    case 'conflict': return "Ma'lumot o'zgargan. Yangilab qayta urinib ko'ring."
    case 'invalid': return "Kiritilgan ma'lumot noto'g'ri."
    default: return 'Server xatosi. Keyinroq urinib ko‘ring.'
  }
}

export const uzs = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so'm`)
export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return `${g('day')}.${g('month')} ${g('hour')}:${g('minute')}`
}
/** "+998901234567" -> "+998 90 123 45 67" (display only) */
export const phoneFmt = (p: string | null | undefined) => {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(p ?? '')
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : (p ?? '—')
}
