import { Link } from 'react-router-dom'
import { ShoppingBag, Trash2, Zap } from 'lucide-react'
import { PageHeader, EmptyState, primaryBtn } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { QtyStepper } from '../components/QtyStepper'
import { getProduct } from '../data/sample'
import { formatUZS } from '../lib/format'
import { lineKey, useCart } from '../lib/cart'
import { t } from '../i18n'

export function QuickOrder() {
  const { quick } = useCart()
  const product = quick ? getProduct(quick.productId) : undefined
  const hex = product?.colors.find((c) => c.name === quick?.color)?.hex ?? product?.colors[0].hex

  return (
    <div className="pb-36">
      <PageHeader title={t('quick.title')} />
      {!quick || !product || !hex ? (
        <EmptyState
          icon={<Zap className="size-7" fill="currentColor" />}
          title={t('quick.emptyTitle')}
          hint={t('quick.emptyHint')}
          action={
            <Link to="/katalog" className={primaryBtn}>
              {t('quick.toCatalog')}
            </Link>
          }
        />
      ) : (
        <div className="px-4">
          <h2 className="mb-3 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
            {t('quick.selected')}
          </h2>
          <div data-testid="quick-item" className="glass flex gap-4 rounded-[28px] p-3">
            <Link to={`/mahsulot/${product.id}`} className="size-28 shrink-0 overflow-hidden rounded-[20px]">
              <ProductImage categoryId={product.categoryId} color={hex} className="size-full" />
            </Link>
            <div className="min-w-0 flex-1 py-1">
              <p className="truncate text-[17px] font-semibold" style={{ fontFamily: 'var(--font-display)' }}>
                {product.name}
              </p>
              <p className="mt-1 text-[13px] text-navy-soft">
                {t('quick.color')}: <b>{quick.color}</b>
              </p>
              <p className="text-[13px] text-navy-soft">
                {t('quick.size')}: <b>{quick.size}</b>
              </p>
              <p className="text-[13px] text-navy-soft">
                {t('quick.qty')}: <b>{quick.qty}</b>
              </p>
              <p className="mt-2 text-[17px] font-extrabold tabular-nums">{formatUZS(product.price * quick.qty)}</p>
            </div>
          </div>
          <p className="mt-4 rounded-2xl bg-beige-soft px-3.5 py-3 text-[13px] font-medium text-navy-soft">{t('quick.formSoon')}</p>
          <Link to="/katalog" className="mt-5 inline-block text-[14px] font-bold text-coral">
            {t('quick.change')}
          </Link>
        </div>
      )}
    </div>
  )
}

export function Cart() {
  const { lines, count, subtotal, setQty, remove, qtyOf } = useCart()

  if (lines.length === 0) {
    return (
      <div className="pb-36">
        <PageHeader title={t('cart.title')} />
        <EmptyState
          icon={<ShoppingBag className="size-7" />}
          title={t('cart.empty')}
          hint={t('cart.emptyHint')}
          action={
            <Link to="/katalog" className={primaryBtn}>
              {t('cart.toCatalog')}
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="pb-40">
      <PageHeader title={t('cart.title')} />
      <ul className="space-y-3 px-4">
        {lines.map((l) => {
          const p = getProduct(l.productId)
          if (!p) return null
          const key = lineKey(l)
          const hex = p.colors.find((c) => c.name === l.color)?.hex ?? p.colors[0].hex
          const max = Math.max(1, p.stock - qtyOf(p.id, key))
          return (
            <li key={key} data-testid="cart-line" className="flex gap-3 rounded-[26px] bg-white p-3 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
              <Link to={`/mahsulot/${p.id}`} className="size-[88px] shrink-0 self-start overflow-hidden rounded-[18px]">
                <ProductImage categoryId={p.categoryId} color={hex} className="size-full" />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/mahsulot/${p.id}`} className="min-w-0 truncate text-[15.5px] font-semibold leading-tight">
                    {p.name}
                  </Link>
                  <button type="button" onClick={() => remove(key)} aria-label={`${t('cart.remove')}: ${p.name}`} className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-stone active:bg-navy/[0.06]">
                    <Trash2 className="size-[17px]" />
                  </button>
                </div>
                <p className="mt-0.5 text-[12px] text-navy-soft">
                  {l.color} · {t('common.size')} {l.size}
                </p>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-2">
                  <QtyStepper compact value={l.qty} max={max} onChange={(v) => setQty(key, v)} label={`${t('product.qty')}: ${p.name}`} />
                  <span data-testid="line-total" className="ml-auto whitespace-nowrap text-[15px] font-extrabold tabular-nums">
                    {formatUZS(p.price * l.qty)}
                  </span>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="mx-4 mt-5 rounded-[26px] bg-white p-4 shadow-[0_12px_28px_-18px_rgba(23,43,58,0.55)]">
        <div className="flex items-baseline justify-between text-[14px] text-navy-soft">
          <span>
            {t('cart.title')} ({count} {t('cart.itemsCount')})
          </span>
          <span data-testid="cart-subtotal" className="font-semibold tabular-nums">
            {formatUZS(subtotal)}
          </span>
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-navy/[0.07] pt-3">
          <span className="text-[13px] font-extrabold uppercase tracking-wider text-stone">{t('cart.subtotal')}</span>
          <span data-testid="cart-total" className="text-[22px] font-extrabold tabular-nums">
            {formatUZS(subtotal)}
          </span>
        </div>
      </div>
      <p className="mx-4 mt-3 rounded-2xl bg-beige-soft px-3.5 py-3 text-[12.5px] font-medium text-navy-soft">{t('cart.checkoutSoon')}</p>
      <Link to="/katalog" className="mx-4 mt-4 inline-block text-[14px] font-bold text-coral">
        {t('cart.toCatalog')}
      </Link>
    </div>
  )
}
