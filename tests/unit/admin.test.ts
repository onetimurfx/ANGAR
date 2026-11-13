import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BackendError } from '../../src/lib/backend'
import { A, adminError, phoneFmt, uzs, when } from '../../src/admin/text'
import { NEXT_STATUS, ORDER_STATUSES } from '../../src/admin/types'

describe('admin texts and formatting', () => {
  it('maps server codes to Uzbek messages and never leaks technical detail', () => {
    expect(adminError(new BackendError('conflict', 'INVALID_TRANSITION', {}, 409))).toMatch(/holati o'zgargan/)
    expect(adminError(new BackendError('invalid', 'INVALID_REASON', {}, 422))).toMatch(/Sabab/)
    expect(adminError(new BackendError('conflict', 'STOCK_BELOW_RESERVED', { reserved: 4 }, 409))).toContain('4')
    expect(adminError(new BackendError('invalid', 'INVALID_REQUEST', { field: 'price' }, 400))).toMatch(/Narx/)
    expect(adminError(new BackendError('auth', 'FORBIDDEN', {}, 403))).toMatch(/ruxsat/i)
    expect(adminError(new BackendError('offline', 'NETWORK'))).toMatch(/Internet/)
    expect(adminError(new BackendError('unavailable', 'HTTP_404', {}, 404))).toMatch(/deploy/)
    expect(adminError(new Error('relation x does not exist'))).toBe('Kutilmagan xato.')
    expect(adminError(new Error('type'))).toMatch(/JPG/)
  })
  it('formats money, phone and Tashkent time', () => {
    expect(uzs(1234567)).toBe("1 234 567 so'm")
    expect(uzs(null)).toBe('—')
    expect(phoneFmt('+998901234567')).toBe('+998 90 123 45 67')
    expect(phoneFmt(null)).toBe('—')
    expect(when('2026-11-10T19:30:00Z')).toBe('11.11 00:30') // UTC+5
    expect(when('garbage')).toBe('—')
  })
  it('has a label and an action text for every order status', () => {
    for (const s of ORDER_STATUSES) { expect(A.status[s]).toBeTruthy(); if (s !== 'new') expect(A.action[s]).toBeTruthy() }
  })
  it('status moves mirror the database rules (admin_set_order_status)', () => {
    expect(NEXT_STATUS).toEqual({ new: ['confirmed', 'cancelled'], confirmed: ['preparing', 'cancelled'], preparing: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] })
    const sql = readFileSync('supabase/migrations/20261111000001_admin_panel.sql', 'utf8')
    expect(sql).toContain("o.status = 'shipped' and v_new = 'delivered'")
    expect(sql).toContain("o.status = 'new' and v_new in ('confirmed', 'cancelled')")
  })
})

describe('admin bundle: no secrets, no privilege grants in the browser code', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
  const files = walk('src').filter((f) => /\.(ts|tsx)$/.test(f))
  it('never mentions the service role key or the administrators table', () => {
    // lib/backend.ts is the one place that names it, to REFUSE a service-role key given as the public key
    for (const f of files.filter((x) => x !== join('src', 'lib', 'backend.ts'))) {
      const t = readFileSync(f, 'utf8')
      expect(/service_role|SERVICE_ROLE/i.test(t), f).toBe(false)
      expect(/administrators/.test(t.replace(/Administratorlar|administrators\b.*(?:Supabase|bazasida)/g, '')) && !/src\/admin\/pages\/Settings/.test(f), f).toBe(false)
    }
  })
  it('the admin panel only calls admin-api / admin-pickup and never writes the administrators table or sends an admin id', () => {
    for (const f of files.filter((x) => x.startsWith(join('src', 'admin')))) {
      const t = readFileSync(f, 'utf8')
      expect(/telegramId\s*:\s*[^,}]*\badmin|role\s*:\s*['"]owner['"]/.test(t), f).toBe(false)
      expect(/fetch\(/.test(t), f).toBe(false) // all network goes through lib/backend
    }
  })
})
