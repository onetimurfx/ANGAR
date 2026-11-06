import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { banners } from '../data/catalog'
import type { Banner } from '../data/types'

const TONES: Record<Banner['tone'], string> = {
  coral: 'from-coral to-[#b93a48] text-white',
  navy: 'from-navy to-[#0f1f2b] text-white',
  beige: 'from-beige to-[#c4a583] text-navy',
}

export function BannerCarousel() {
  const ref = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const paused = useRef(false)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const id = window.setInterval(() => {
      const el = ref.current
      if (!el || paused.current) return
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % banners.length
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' })
    }, 4500)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div>
      <div
        ref={ref}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto"
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
        onTouchStart={() => (paused.current = true)}
        onTouchEnd={() => window.setTimeout(() => (paused.current = false), 6000)}
        aria-roledescription="carousel"
        aria-label="Aksiyalar"
      >
        {banners.map((b) => (
          <div key={b.id} className="w-full flex-none snap-center px-4">
            <Link
              to={b.to}
              className={`relative flex h-[168px] flex-col justify-end overflow-hidden rounded-[28px] bg-gradient-to-br p-5 shadow-[0_18px_34px_-20px_rgba(23,43,58,0.7)] ${TONES[b.tone]}`}
            >
              <span aria-hidden className="absolute -right-10 -top-12 size-44 rounded-full bg-white/15" />
              <span aria-hidden className="absolute -bottom-16 right-10 size-36 rounded-full bg-white/10" />
              <h2 className="relative max-w-[14ch] text-[27px]">{b.title}</h2>
              <p className="relative mt-1 text-[13px] opacity-85">{b.subtitle}</p>
              <span className="glass-chip absolute right-4 top-4 grid size-9 place-items-center rounded-full text-navy">
                <ArrowUpRight className="size-[18px]" />
              </span>
            </Link>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-center gap-1.5" aria-hidden>
        {banners.map((b, i) => (
          <span key={b.id} className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-coral' : 'w-1.5 bg-navy/20'}`} />
        ))}
      </div>
    </div>
  )
}
