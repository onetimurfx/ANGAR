import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BottomNav } from './BottomNav'

/**
 * Fixed bottom stack: an optional action panel (product / cart screens) ABOVE the five-item tab bar.
 * The two are siblings in one column, so the panel can never cover the tab bar and the tab bar is
 * always visible. Screens put their panel into the slot with <DockPanel>.
 */
const SlotCtx = createContext<HTMLElement | null>(null)

export function Dock({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return (
    <SlotCtx.Provider value={slot}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center px-3"
        style={{ paddingBottom: 'max(12px, var(--safe-bottom))' }}
      >
        {/* the centre Quick Order button rises ~26px above the bar, so the panel keeps clear of it */}
        <div ref={setSlot} data-testid="dock-panel" className="pointer-events-auto mb-8 w-full max-w-[440px] empty:mb-0 empty:hidden" />
        <BottomNav />
      </div>
    </SlotCtx.Provider>
  )
}

export function DockPanel({ children }: { children: ReactNode }) {
  const slot = useContext(SlotCtx)
  return slot ? createPortal(children, slot) : null
}
