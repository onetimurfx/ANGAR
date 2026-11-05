import { useEffect, useState } from 'react'

const KEY = 'aynimo:recent'
const MAX = 12

const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function pushRecent(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...read().filter((x) => x !== id)].slice(0, MAX)))
  } catch {
    /* storage unavailable: recently viewed simply stays empty */
  }
}

export function useRecent(): string[] {
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => setIds(read()), [])
  return ids
}
