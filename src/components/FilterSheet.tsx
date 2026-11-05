import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { brands, categories } from '../data/sample'
import { formatUZS } from '../lib/format'
import { EMPTY, TAGS, facets, type FilterState } from '../lib/filters'
import type { Key } from '../i18n/uz'
import { t } from '../i18n'
import { BottomSheet } from './BottomSheet'
import { primaryBtn } from './ui'

interface Props {
  open: boolean
  onClose: () => void
  draft: FilterState
  setDraft: (f: FilterState) => void
  onApply: () => void
  resultCount: number
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="mt-5 min-w-0 border-0 p-0">
      <legend className="mb-2.5 text-[12px] font-extrabold uppercase tracking-wider text-stone">{title}</legend>
      {children}
    </fieldset>
  )
}

const chip = (on: boolean) =>
  `rounded-full px-3.5 py-2 text-[13px] font-semibold transition active:scale-95 ${on ? 'bg-navy text-white' : 'bg-white text-navy shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]'}`

export function FilterSheet({ open, onClose, draft, setDraft, onApply, resultCount }: Props) {
  const fx = facets()
  const { bounds } = fx
  const lo = draft.min ?? bounds.min
  const hi = draft.max ?? bounds.max
  const setPrice = (nextLo: number, nextHi: number) =>
    setDraft({ ...draft, min: nextLo <= bounds.min ? null : nextLo, max: nextHi >= bounds.max ? null : nextHi })

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t('filter.title')}
      headerAction={
        <button type="button" onClick={() => setDraft({ ...EMPTY, sort: draft.sort, q: draft.q })} className="px-2 text-[13px] font-bold text-coral">
          {t('filter.clear')}
        </button>
      }
      footer={
        <button type="button" onClick={onApply} className={`${primaryBtn} w-full py-3.5 text-[15px]`}>
          {t('filter.apply')} ({resultCount})
        </button>
      }
    >
      <Group title={t('filter.category')}>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button key={c.id} type="button" aria-pressed={draft.cat === c.id} onClick={() => setDraft({ ...draft, cat: c.id })} className={chip(draft.cat === c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      </Group>

      <Group title={t('filter.type')}>
        <div className="flex flex-wrap gap-2">
          {TAGS.map((tag) => (
            <button key={tag} type="button" aria-pressed={draft.tag === tag} onClick={() => setDraft({ ...draft, tag: draft.tag === tag ? '' : tag })} className={chip(draft.tag === tag)}>
              {t(`tag.${tag}` as Key)}
            </button>
          ))}
        </div>
      </Group>

      <Group title={t('filter.brand')}>
        <div className="flex flex-wrap gap-2">
          {brands.map((b) => (
            <button key={b.id} type="button" aria-pressed={draft.brands.includes(b.id)} onClick={() => setDraft({ ...draft, brands: toggle(draft.brands, b.id) })} className={chip(draft.brands.includes(b.id))}>
              {b.name}
            </button>
          ))}
        </div>
      </Group>

      <Group title={t('filter.size')}>
        <div className="flex flex-wrap gap-2">
          {fx.sizes.map((s) => (
            <button key={s} type="button" aria-pressed={draft.sizes.includes(s)} onClick={() => setDraft({ ...draft, sizes: toggle(draft.sizes, s) })} className={`${chip(draft.sizes.includes(s))} min-w-12`}>
              {s}
            </button>
          ))}
        </div>
      </Group>

      <Group title={t('filter.color')}>
        <div className="flex flex-wrap gap-3">
          {fx.colors.map((c) => {
            const on = draft.colors.includes(c.name)
            return (
              <button
                key={c.name}
                type="button"
                aria-label={c.name}
                aria-pressed={on}
                title={c.name}
                onClick={() => setDraft({ ...draft, colors: toggle(draft.colors, c.name) })}
                className={`grid size-10 place-items-center rounded-full border border-navy/15 transition active:scale-90 ${on ? 'ring-2 ring-coral ring-offset-2 ring-offset-[#fbfaf7]' : ''}`}
                style={{ background: c.hex }}
              >
                {on && <Check className="size-4" strokeWidth={3} style={{ color: isLight(c.hex) ? '#172B3A' : '#fff' }} />}
              </button>
            )
          })}
        </div>
      </Group>

      <Group title={t('filter.price')}>
        <div className="mb-3 flex items-center justify-between text-[14px] font-extrabold tabular-nums">
          <span>{formatUZS(lo)}</span>
          <span className="text-stone">-</span>
          <span>{formatUZS(hi)}</span>
        </div>
        <label className="block text-[12px] font-semibold text-navy-soft">
          {t('filter.from')}
          <input
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            value={lo}
            onChange={(e) => setPrice(Math.min(Number(e.target.value), hi), hi)}
            aria-label={`${t('filter.price')}: ${t('filter.from')}`}
            className="mt-1 block h-8 w-full accent-[#D94B59]"
          />
        </label>
        <label className="mt-1 block text-[12px] font-semibold text-navy-soft">
          {t('filter.to')}
          <input
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            value={hi}
            onChange={(e) => setPrice(lo, Math.max(Number(e.target.value), lo))}
            aria-label={`${t('filter.price')}: ${t('filter.to')}`}
            className="mt-1 block h-8 w-full accent-[#D94B59]"
          />
        </label>
      </Group>

      <Group title={t('filter.avail')}>
        <button
          type="button"
          role="switch"
          aria-checked={draft.avail}
          onClick={() => setDraft({ ...draft, avail: !draft.avail })}
          className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-3 text-left text-[14px] font-semibold shadow-[0_4px_14px_-10px_rgba(23,43,58,0.6)]"
        >
          {t('filter.availOnly')}
          <span className={`relative h-7 w-12 rounded-full transition ${draft.avail ? 'bg-coral' : 'bg-navy/20'}`}>
            <span className={`absolute top-0.5 size-6 rounded-full bg-white shadow transition-all ${draft.avail ? 'left-[22px]' : 'left-0.5'}`} />
          </span>
        </button>
      </Group>
    </BottomSheet>
  )
}

function isLight(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return r * 0.299 + g * 0.587 + b * 0.114 > 170
}
