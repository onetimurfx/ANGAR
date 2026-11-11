/**
 * Delivery pricing. The real fee is business information ANGAR has not given us, so by default it is
 * "not configured": the UI says the fee is not set yet and the total excludes delivery.
 *
 * Until the admin panel exists (Phase 6 will store this in the database) the values come from build-time
 * environment variables, so the shop can set them without touching code:
 *   VITE_DELIVERY_FEE        integer UZS, 0 = free delivery
 *   VITE_DELIVERY_FREE_FROM  optional integer UZS: subtotal from which delivery is free
 */
import * as catalog from '../data/catalog'

export interface DeliveryConfig {
  configured: boolean
  /** UZS, only meaningful when configured */
  fee: number
  /** subtotal (UZS) from which delivery is free; null = never free */
  freeFrom: number | null
}

const asMoney = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/^\d{1,9}$/.test(v.trim())) return null
  return Number(v.trim())
}

export function readDeliveryConfig(env: { VITE_DELIVERY_FEE?: string; VITE_DELIVERY_FREE_FROM?: string }): DeliveryConfig {
  const fee = asMoney(env.VITE_DELIVERY_FEE)
  if (fee === null) return { configured: false, fee: 0, freeFrom: null }
  const freeFrom = asMoney(env.VITE_DELIVERY_FREE_FROM)
  return { configured: true, fee, freeFrom: freeFrom !== null && freeFrom > 0 ? freeFrom : null }
}

const envConfig: DeliveryConfig = readDeliveryConfig(import.meta.env as Record<string, string | undefined>)

/** With a backend the fee is whatever the shop saved in the database (never a default). Without one, the build-time env values. */
export function getDeliveryConfig(): DeliveryConfig {
  if (catalog.source !== 'server') return envConfig
  const s = catalog.settings
  if (!s.deliveryConfigured || s.deliveryFee === null) return { configured: false, fee: 0, freeFrom: null }
  return { configured: true, fee: s.deliveryFee, freeFrom: s.deliveryFreeFrom }
}

export interface Totals {
  subtotal: number
  /** null while the fee is not configured */
  deliveryFee: number | null
  deliveryFree: boolean
  deliveryPending: boolean
  total: number
}

export function computeTotals(subtotal: number, cfg: DeliveryConfig = getDeliveryConfig()): Totals {
  if (!cfg.configured) return { subtotal, deliveryFee: null, deliveryFree: false, deliveryPending: true, total: subtotal }
  if (subtotal <= 0) return { subtotal, deliveryFee: 0, deliveryFree: false, deliveryPending: false, total: subtotal }
  const free = cfg.freeFrom !== null && subtotal >= cfg.freeFrom
  const fee = free ? 0 : cfg.fee
  return { subtotal, deliveryFee: fee, deliveryFree: free, deliveryPending: false, total: subtotal + fee }
}
