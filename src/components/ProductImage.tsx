import { useId, useState, type ReactNode } from 'react'

/**
 * Original vector illustrations used while the catalog is sample data.
 * They are NOT photos: real product photos arrive through Supabase Storage (Phase 5).
 */
const LINE = 'rgba(23,43,58,0.28)'

type Draw = (fill: string) => ReactNode
const stroke = { stroke: LINE, strokeWidth: 1.4, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }

const GARMENTS: Record<string, Draw> = {
  tshirts: (f) => (
    <>
      <path d="M38 20 52 14Q60 25 68 14L82 20 102 40 90 54 82 48V112H38V48L30 54 18 40Z" fill={f} {...stroke} />
      <path d="M52 14Q60 25 68 14" fill="none" {...stroke} />
    </>
  ),
  shirts: (f) => (
    <>
      <path d="M40 20 54 14 60 26 66 14 80 20 104 92 92 96 82 56V116H38V56L28 96 16 92Z" fill={f} {...stroke} />
      <path d="M54 14 60 26 66 14M60 26V116" fill="none" {...stroke} />
      <circle cx="60" cy="48" r="1.3" fill={LINE} />
      <circle cx="60" cy="68" r="1.3" fill={LINE} />
      <circle cx="60" cy="88" r="1.3" fill={LINE} />
    </>
  ),
  hoodies: (f) => (
    <>
      <path d="M40 24 52 20 60 30 68 20 80 24 104 92 92 96 82 58V114H38V58L28 96 16 92Z" fill={f} {...stroke} />
      <path d="M44 26Q42 6 60 5Q78 6 76 26Q60 38 44 26Z" fill={f} {...stroke} />
      <path d="M52 34 51 52M68 34 69 52" fill="none" {...stroke} />
      <path d="M46 84H74L78 100H42Z" fill="rgba(23,43,58,0.07)" {...stroke} />
    </>
  ),
  sweaters: (f) => (
    <>
      <path d="M40 20 54 15Q60 24 66 15L80 20 104 94 92 98 82 58V112H38V58L28 98 16 94Z" fill={f} {...stroke} />
      <path d="M38 104H82V114H38ZM16 94 28 98M104 94 92 98" fill="rgba(23,43,58,0.08)" {...stroke} />
      <path d="M54 15Q60 24 66 15" fill="none" {...stroke} />
    </>
  ),
  jackets: (f) => (
    <>
      <path d="M40 18 52 14 60 28 68 14 80 18 104 90 92 95 82 56V116H38V56L28 95 16 90Z" fill={f} {...stroke} />
      <path d="M52 14 60 28 68 14M60 28V116" fill="none" {...stroke} />
      <path d="M44 84H54M66 84H76" fill="none" {...stroke} />
    </>
  ),
  outerwear: (f) => (
    <>
      <path d="M40 16 52 12 60 30 68 12 80 16 106 100 94 106 82 58V132H38V58L26 106 14 100Z" fill={f} {...stroke} />
      <path d="M52 12 60 30 68 12M60 30V132M60 56 49 40M60 56 71 40" fill="none" {...stroke} />
      <circle cx="56" cy="70" r="1.5" fill={LINE} />
      <circle cx="56" cy="90" r="1.5" fill={LINE} />
    </>
  ),
  trousers: (f) => (
    <>
      <path d="M40 14H80L90 130H67L60 54 53 130H30Z" fill={f} {...stroke} />
      <path d="M40 14H80V22H40ZM60 22V54" fill="rgba(23,43,58,0.08)" {...stroke} />
    </>
  ),
  dresses: (f) => (
    <>
      <path d="M46 14H52L56 30H64L68 14H74L70 52 98 128Q60 138 22 128L50 52Z" fill={f} {...stroke} />
      <path d="M50 52H70" fill="none" {...stroke} />
    </>
  ),
  shoes: (f) => (
    <>
      <path d="M12 98V74Q12 66 22 64L44 58 52 68Q62 72 76 72L98 78Q110 82 110 92V98Z" fill={f} {...stroke} />
      <path d="M10 98H112V106Q112 112 104 112H18Q10 112 10 106Z" fill="#F4F2EE" {...stroke} />
      <path d="M50 68 56 62M58 71 64 65M66 73 72 67" fill="none" {...stroke} />
    </>
  ),
  bags: (f) => (
    <>
      <path d="M42 56Q42 24 60 24Q78 24 78 56" fill="none" stroke={f} strokeWidth="5" strokeLinecap="round" />
      <path d="M26 56H94L102 120H18Z" fill={f} {...stroke} />
      <path d="M26 56H94" fill="none" {...stroke} />
      <rect x="54" y="62" width="12" height="9" rx="2" fill="rgba(255,255,255,0.7)" {...stroke} />
    </>
  ),
  accessories: (f) => (
    <>
      <path d="M12 54H50Q56 54 56 62V72Q56 88 40 88H28Q12 88 12 72Z" fill={f} {...stroke} />
      <path d="M108 54H70Q64 54 64 62V72Q64 88 80 88H92Q108 88 108 72Z" fill={f} {...stroke} />
      <path d="M56 62Q60 57 64 62M12 54 6 50M108 54 114 50" fill="none" {...stroke} />
    </>
  ),
}

const BACKDROPS = [
  ['#F3ECE1', '#E8DCCB'],
  ['#FBE9EA', '#F2D3D6'],
  ['#E9ECEE', '#D8DEE2'],
  ['#F1EBDD', '#DCCFB8'],
]

const TRANSFORMS = [
  undefined,
  'translate(60 66) scale(1.12) translate(-60 -66)',
  'translate(60 66) scale(0.92) translate(-60 -66)',
  'translate(60 44) scale(1.75) translate(-60 -34)',
]

interface Props {
  categoryId: string
  color: string
  /** public URL of a real photo; the illustration is shown when absent or when it fails to load */
  src?: string | null
  /** 0-3: different backdrops/crops stand in for a photo gallery (3 = close-up detail) */
  view?: number
  className?: string
  label?: string
}

export function ProductImage({ categoryId, color, src, view = 0, className = '', label }: Props) {
  const id = useId()
  const [bad, setBad] = useState(false)
  if (src && !bad) return <img src={src} alt={label ?? ''} aria-hidden={label ? undefined : true} loading="lazy" onError={() => setBad(true)} className={`${className} object-cover`} />
  const [a, b] = BACKDROPS[view % BACKDROPS.length]
  return (
    <svg
      viewBox="0 0 120 140"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
      </defs>
      <rect width="120" height="140" fill={`url(#${id}-bg)`} />
      <ellipse cx="60" cy="130" rx="34" ry="3.5" fill="rgba(23,43,58,0.12)" />
      <g transform={TRANSFORMS[view % 4]}>
        {(GARMENTS[categoryId] ?? GARMENTS.tshirts)(color)}
      </g>
    </svg>
  )
}
