/** The ANGAR wordmark: the lowercase word "angar" in yellow, outlined from a bold rounded typeface (SVG, crisp at any size). Text only, no icon. */
export function Logo({ className = 'h-9' }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="ANGAR" className={`${className} w-auto object-contain`} draggable={false} />
}
