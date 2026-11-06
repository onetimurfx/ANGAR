import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Expand, X } from 'lucide-react'
import { imageUrl } from '../lib/backend'
import { t } from '../i18n'
import { ProductImage } from './ProductImage'

const SAMPLE_VIEWS = 4

interface Props {
  categoryId: string
  color: string
  name: string
  /** storage paths of real photos; none = illustrations (sample catalog) */
  images?: string[]
  /** shows the NAMUNA chip */
  sample?: boolean
}

/** Swipeable gallery (scroll-snap) + synced thumbnails + full-screen viewer with arrows, keys and swipe. */
export function Gallery({ categoryId, color, name, images, sample = true }: Props) {
  const COUNT = images && images.length > 0 ? images.length : SAMPLE_VIEWS
  const srcOf = (i: number) => (images && images.length > 0 ? imageUrl(images[i]) : null)
  const scroller = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(false)

  const goTo = useCallback((i: number) => {
    const el = scroller.current
    setIndex(i)
    el?.scrollTo({ left: i * el.clientWidth, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [])

  return (
    <div>
      <div className="relative">
        <div
          ref={scroller}
          data-testid="gallery-scroller"
          className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto rounded-[30px] shadow-[0_18px_40px_-22px_rgba(23,43,58,0.6)]"
          onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
        >
          {Array.from({ length: COUNT }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setZoom(true)}
              aria-label={`${t('gallery.open')} (${i + 1}/${COUNT})`}
              className="relative aspect-square w-full flex-none snap-center overflow-hidden bg-white"
            >
              <ProductImage categoryId={categoryId} color={color} src={srcOf(i)} view={i} className="size-full" label={`${name}, ${i + 1}/${COUNT}`} />
            </button>
          ))}
        </div>
        {sample && <span className="glass-chip pointer-events-none absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wider text-navy-soft">{t('common.sample')}</span>}
        <span data-testid="gallery-counter" className="glass-chip pointer-events-none absolute bottom-3 right-3 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums">
          <Expand className="size-3" aria-hidden />
          {index + 1}/{COUNT}
        </span>
      </div>

      <div className="mt-3 flex gap-2" role="tablist" aria-label={name}>
        {Array.from({ length: COUNT }, (_, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={index === i}
            aria-current={index === i ? 'true' : undefined}
            aria-label={`${i + 1}/${COUNT}`}
            onClick={() => goTo(i)}
            className={`size-[62px] overflow-hidden rounded-2xl transition ${index === i ? 'ring-2 ring-coral ring-offset-2 ring-offset-ivory' : 'opacity-70'}`}
          >
            <ProductImage categoryId={categoryId} color={color} src={srcOf(i)} view={i} className="size-full" />
          </button>
        ))}
      </div>

      <Lightbox open={zoom} onClose={() => setZoom(false)} index={index} setIndex={(i) => goTo(i)} count={COUNT} src={srcOf(index)} categoryId={categoryId} color={color} name={name} />
    </div>
  )
}

function Lightbox({ open, onClose, index, setIndex, count: COUNT, src, categoryId, color, name }: Props & { open: boolean; onClose: () => void; index: number; setIndex: (i: number) => void; count: number; src: string | null }) {
  const touchX = useRef<number | null>(null)
  const prev = () => setIndex((index + COUNT - 1) % COUNT)
  const next = () => setIndex((index + 1) % COUNT)
  const nextRef = useRef(next)
  const prevRef = useRef(prev)
  nextRef.current = next
  prevRef.current = prev

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') nextRef.current()
      if (e.key === 'ArrowLeft') prevRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={name}
          className="fixed inset-0 z-[70] flex flex-col bg-navy/95 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (touchX.current === null) return
            const dx = e.changedTouches[0].clientX - touchX.current
            touchX.current = null
            if (Math.abs(dx) > 50) (dx < 0 ? next : prev)()
          }}
        >
          <div className="flex items-center justify-between px-4 pb-2 text-white" style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}>
            <span data-testid="lightbox-counter" className="text-sm font-bold tabular-nums">
              {index + 1}/{COUNT}
            </span>
            <button type="button" onClick={onClose} aria-label={t('gallery.close')} className="grid size-10 place-items-center rounded-full bg-white/15">
              <X className="size-5" />
            </button>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-8">
            <div className="aspect-[6/7] max-h-full w-full max-w-[520px] overflow-hidden rounded-[28px]">
              <ProductImage categoryId={categoryId} color={color} src={src} view={index} className="size-full" label={`${name}, ${index + 1}/${COUNT}`} />
            </div>
            <button type="button" onClick={prev} aria-label={t('gallery.prev')} className="absolute left-4 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-navy shadow-lg">
              <ChevronLeft className="size-5" />
            </button>
            <button type="button" onClick={next} aria-label={t('gallery.next')} className="absolute right-4 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-navy shadow-lg">
              <ChevronRight className="size-5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
