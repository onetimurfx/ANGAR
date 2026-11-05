import { useEffect } from 'react'

/** Minimal typing of the official Telegram.WebApp object (only what AYNIMO uses). */
interface TgButton {
  show(): void
  hide(): void
  onClick(cb: () => void): void
  offClick(cb: () => void): void
}
export interface TgUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  photo_url?: string
  language_code?: string
}
interface TgWebApp {
  initData: string
  initDataUnsafe: { user?: TgUser }
  platform: string
  colorScheme: 'light' | 'dark'
  viewportStableHeight: number
  BackButton: TgButton
  HapticFeedback?: { selectionChanged(): void; impactOccurred(s: 'light' | 'medium'): void }
  ready(): void
  expand(): void
  setHeaderColor(c: string): void
  setBackgroundColor(c: string): void
  disableVerticalSwipes?(): void
  isVersionAtLeast(v: string): boolean
  onEvent(e: string, cb: () => void): void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp }
  }
}

export const getWebApp = (): TgWebApp | undefined => window.Telegram?.WebApp

/** True only when opened from inside Telegram (initData is non-empty there). */
export const isInTelegram = () => Boolean(getWebApp()?.initData)

const BRAND_BG = '#F7F5F0'

export function initTelegram() {
  const tg = getWebApp()
  if (!tg) return
  try {
    tg.ready()
    tg.expand()
    if (tg.isVersionAtLeast('6.1')) {
      tg.setHeaderColor(BRAND_BG)
      tg.setBackgroundColor(BRAND_BG)
    }
    if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes?.()
    document.documentElement.dataset.tgScheme = tg.colorScheme
    const syncViewport = () =>
      document.documentElement.style.setProperty('--tg-viewport-stable-height', `${tg.viewportStableHeight}px`)
    syncViewport()
    tg.onEvent('viewportChanged', syncViewport)
  } catch {
    /* an old client without some of these calls must not break the app */
  }
}

/** Telegram user for DISPLAY only. It is unverified until the backend checks initData (Phase 5). */
export const getTelegramUser = (): TgUser | undefined => getWebApp()?.initDataUnsafe?.user

export const haptic = () => {
  try {
    getWebApp()?.HapticFeedback?.selectionChanged()
  } catch {
    /* ignore */
  }
}

/** Shows Telegram's native BackButton while `enabled`. */
export function useBackButton(enabled: boolean, onBack: () => void) {
  useEffect(() => {
    const bb = getWebApp()?.BackButton
    if (!bb) return
    if (!enabled) {
      bb.hide()
      return
    }
    bb.show()
    bb.onClick(onBack)
    return () => bb.offClick(onBack)
  }, [enabled, onBack])
}
