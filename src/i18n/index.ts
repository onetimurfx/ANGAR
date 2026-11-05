import { uz, type Key } from './uz'

export type Locale = 'uz' | 'ru' | 'en'
const dictionaries: Record<Locale, Partial<Record<Key, string>>> = { uz, ru: {}, en: {} }

let locale: Locale = 'uz'
export const setLocale = (l: Locale) => {
  locale = l
}

/** Falls back to Uzbek when a key is not translated yet. `{n}`-style placeholders are filled from `vars`. */
export const t = (key: Key, vars?: Record<string, string | number>): string => {
  const raw: string = dictionaries[locale][key] ?? uz[key]
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : raw
}
