import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShoppingBag, SlidersHorizontal, Trash2 } from 'lucide-react'
import { PageHeader, EmptyState, primaryBtn } from '../components/ui'
import { ProductImage } from '../components/ProductImage'
import { QtyStepper } from '../components/QtyStepper'
import { BottomSheet } from '../components/BottomSheet'
import { DockPanel } from '../components/Dock'
import { Totals } from '../components/Totals'
import { getProduct } from '../data/catalog'
import { computeTotals } from '../lib/delivery'
import { formatUZS } from '../lib/format'
import { lineKey, useCart } from '../lib/cart'
import { variantQty } from '../data/catalog'
import { useCatalogVersion } from '../lib/backendContext'
import { t } from '../i18n'

export function Cart() {
  useCatalogVersion()
  const { lines, count, subtotal, setQty, remove, qtyOf, changeVariant } = useCart()
  const navigate = useNavigate()
  const [editKey, setEditKey] = useState<string | null>(null)
  const [size, setSize] = useState('')
  const [color, setColor] = useState('')

  const editLine = editKey ? lines.find((l) => lineKey(l) === editKey) : undefined
  const editProduct = editLine ? getProduct(editLine.productId) : undefined

  const openEdit = (key: string) => {
    const l = lines.find((x) => lineKey(x) === key)
    if (!l) return
    setSize(l.size)
    setColor(l.color)
    setEditKey(key)
  }

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

  const total = computeTotals(subtotal)

  return (
    <div className="pb-56">
      <PageHeader title={t('cart.title')} />
      <ul className="space-y-3 px-4">
        {lines.map((l) => {
          const p = getProduct(l.productId)
          if (!p) return null
          const key = lineKey(l)
          const hex = p.colors.find((c) => c.name === l.color)?.hex ?? p.colors[0].hex
          const max = Math.max(1, Math.min(variantQty(p, l.size, l.color), p.stock - qtyOf(p.id, key)))
          const canChange = p.sizes.length > 1 || p.colors.length > 1
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
                  <button type="button" data-testid="remove-line" onClick={() => remove(key)} aria-label={`${t('cart.remove')}: ${p.name}`} className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-stone active:bg-navy/[0.06]">
                    <Trash2 className="size-[17px]" />
                  </button>
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-navy-soft">
                  <span data-testid="line-variant">
                    {l.color} · {t('common.size')} {l.size}
                  </span>
                  {canChange && (
                    <button type="button" data-testid="change-variant" onClick={() => openEdit(key)} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] px-2 py-0.5 text-[11.5px] font-bold text-navy">
                      <SlidersHorizontal className="size-3" />
                      {t('cart.change')}
                    </button>
                  )}
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

      <div className="mx-4 mt-5">
        <Totals subtotal={subtotal} count={count} />
      </div>
      <Link to="/katalog" className="mx-4 mt-4 inline-block text-[14px] font-bold text-coral">
        {t('cart.toCatalog')}
      </Link>

      <DockPanel>
        <div className="glass-nav flex items-center gap-3 rounded-[28px] p-2.5 pl-4">
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[10.5px] font-bold uppercase tracking-wider text-stone">{total.deliveryPending ? t('totals.totalNoDelivery') : t('totals.total')}</p>
            <p data-testid="panel-total" className="truncate text-[17px] font-extrabold tabular-nums">
              {formatUZS(total.total)}
            </p>
          </div>
          <button
            type="button"
            data-testid="checkout"
            onClick={() => navigate('/savatcha/buyurtma')}
            className="shrink-0 whitespace-nowrap rounded-full bg-coral px-5 py-3.5 text-[13.5px] font-bold text-white shadow-[0_10px_22px_-8px_rgba(217,75,89,0.7)] transition active:scale-[0.97]"
          >
            {t('cart.checkout')}
          </button>
        </div>
      </DockPanel>

      <BottomSheet
        open={Boolean(editLine && editProduct)}
        onClose={() => setEditKey(null)}
        title={t('cart.changeTitle')}
        footer={
          <button
            type="button"
            data-testid="apply-variant"
            onClick={() => {
              if (editKey) changeVariant(editKey, size, color)
              setEditKey(null)
            }}
            className="w-full rounded-full bg-coral py-3.5 text-[15px] font-bold text-white"
          >
            {t('cart.apply')}
          </button>
        }
      >
        {editProduct && (
          <div className="pb-2">
            <p className="text-[15px] font-semibold">{editProduct.name}</p>
            <h3 className="mt-4 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('common.color')}: <span className="normal-case tracking-normal text-navy">{color}</span>
            </h3>
            <div className="mt-2.5 flex flex-wrap gap-3">
              {editProduct.colors.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  aria-label={c.name}
                  aria-pressed={color === c.name}
                  onClick={() => setColor(c.name)}
                  className={`size-10 rounded-full border border-navy/15 ${color === c.name ? 'ring-2 ring-coral ring-offset-2 ring-offset-white' : ''}`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
            <h3 className="mt-5 text-[13px] font-extrabold uppercase tracking-wider text-stone" style={{ fontFamily: 'var(--font-sans)' }}>
              {t('common.size')}
            </h3>
            <div role="radiogroup" aria-label={t('common.size')} className="mt-2.5 flex flex-wrap gap-2">
              {editProduct.sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={size === s}
                  disabled={Boolean(editLine) && variantQty(editProduct, s, color) < (editLine?.qty ?? 1) && !(s === editLine?.size && color === editLine?.color)}
                  onClick={() => setSize(s)}
                  className={`min-w-12 rounded-2xl px-4 py-2.5 text-sm font-bold disabled:line-through disabled:opacity-35 ${size === s ? 'bg-navy text-white' : 'bg-white shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  )
}
