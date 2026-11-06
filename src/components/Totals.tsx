import { computeTotals, deliveryConfig, type DeliveryConfig } from '../lib/delivery'
import { formatUZS } from '../lib/format'
import { t } from '../i18n'

/** Subtotal, delivery and final total. While the fee is not configured it says so instead of guessing a number. */
export function Totals({ subtotal, count, config = deliveryConfig }: { subtotal: number; count?: number; config?: DeliveryConfig }) {
  const tot = computeTotals(subtotal, config)
  return (
    <div data-testid="totals" className="rounded-[26px] bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
      <div className="flex items-baseline justify-between text-[14px] text-navy-soft">
        <span>
          {t('totals.goods')}
          {count !== undefined && ` (${count} ${t('cart.itemsCount')})`}
        </span>
        <span data-testid="cart-subtotal" className="font-semibold tabular-nums">
          {formatUZS(tot.subtotal)}
        </span>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-[14px] text-navy-soft">
        <span>{t('totals.delivery')}</span>
        <span data-testid="delivery-fee" className={`text-right font-semibold ${tot.deliveryPending ? 'text-[#b5651d]' : tot.deliveryFree ? 'text-[#4f6a3c]' : ''} tabular-nums`}>
          {tot.deliveryPending ? t('totals.deliveryPending') : tot.deliveryFree ? t('totals.deliveryFree') : formatUZS(tot.deliveryFee ?? 0)}
        </span>
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-navy/[0.07] pt-3">
        <span className="min-w-0 text-[12px] font-extrabold uppercase leading-tight tracking-wider text-stone">{tot.deliveryPending ? t('totals.totalNoDelivery') : t('totals.total')}</span>
        <span data-testid="cart-total" className="whitespace-nowrap text-[21px] font-extrabold tabular-nums">
          {formatUZS(tot.total)}
        </span>
      </div>
      {tot.deliveryPending && <p className="mt-2 text-[12px] leading-snug text-navy-soft">{t('totals.deliveryNote')}</p>}
    </div>
  )
}
