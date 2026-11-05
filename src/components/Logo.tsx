/** The supplied AYNIMO logo, cropped to its content with the white background removed. */
export function Logo({ className = 'h-9' }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}logo.png`} alt="AYNIMO" className={`${className} w-auto object-contain`} draggable={false} />
}
