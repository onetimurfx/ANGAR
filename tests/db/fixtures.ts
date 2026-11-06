import { randomUUID } from 'node:crypto'
import { inject } from 'vitest'
import postgres from 'postgres'
import { createDb } from './pg'

let n = 0
export async function newTestDb(prefix: string) {
  const dbUrl = await createDb(inject('pgPort'), `${prefix}_${process.pid}_${n++}`)
  const sql = postgres(dbUrl, { max: 12, onnotice: () => {} })
  return { sql, url: dbUrl }
}

export interface Fixture {
  P1: string // 100 000, M/Qora x5, L/Qora x2, XL/Qora inactive variant x9
  P2: string // 250 000, Yagona/Oq x3
  P3: string // 40 000, S/Oq x4 (to test multi-line orders)
  INACTIVE: string // inactive product
  SAMPLE: string // sample product
  adminTg: number
  customerTg: number
  customer: string
}

/** Real-looking (NOT sample) test products, one inactive, one sample, one admin and one customer. */
export async function seed(sql: postgres.Sql): Promise<Fixture> {
  await sql`insert into brands (id, name, type) values ('b1', 'Brend', 'original')`
  await sql`insert into categories (id, name) values ('c1', 'Kategoriya')`
  const prod = async (id: string, price: number, extra: { active?: boolean; sample?: boolean; old?: number } = {}) =>
    sql`insert into products (id, name, brand_id, category_id, price, old_price, type, active, is_sample)
        values (${id}, ${'Mahsulot ' + id}, 'b1', 'c1', ${price}, ${extra.old ?? null}, 'original', ${extra.active ?? true}, ${extra.sample ?? false})`
  const variant = async (pid: string, size: string, color: string, qty: number, active = true) => {
    const [v] = await sql`insert into product_variants (product_id, size, color_name, color_hex, active)
                          values (${pid}, ${size}, ${color}, '#222222', ${active}) returning id`
    await sql`insert into inventory (variant_id, quantity) values (${v.id}, ${qty})`
  }
  await prod('P1', 100000, { old: 120000 })
  await variant('P1', 'M', 'Qora', 5)
  await variant('P1', 'L', 'Qora', 2)
  await variant('P1', 'XL', 'Qora', 9, false)
  await prod('P2', 250000)
  await variant('P2', 'Yagona', 'Oq', 3)
  await prod('P3', 40000)
  await variant('P3', 'S', 'Oq', 4)
  await prod('INACTIVE', 10000, { active: false })
  await variant('INACTIVE', 'M', 'Qora', 5)
  await prod('SAMPLE', 10000, { sample: true })
  await variant('SAMPLE', 'M', 'Qora', 5)
  const adminTg = 900001
  const customerTg = 700001
  await sql`insert into administrators (telegram_id, name, role) values (${adminTg}, 'Admin', 'owner')`
  const [c] = await sql`select upsert_customer(${customerTg}, 'Ali', 'Valiyev', 'ali', null, 'uz') as id`
  return { P1: 'P1', P2: 'P2', P3: 'P3', INACTIVE: 'INACTIVE', SAMPLE: 'SAMPLE', adminTg, customerTg, customer: c.id }
}

export const CONTACT = { name: 'Ali Valiyev', phone: '+998 90 123 45 67', address: "Toshkent sh., Chilonzor 9-kvartal, 12-uy", comment: 'Ertalab' }

export interface Line { productId: string; size: string; color: string; qty: number }
export const line = (productId: string, size: string, color: string, qty: number): Line => ({ productId, size, color, qty })

export async function placeOrder(
  sql: postgres.Sql,
  customer: string,
  items: unknown,
  opts: { key?: string; source?: 'quick' | 'cart'; contact?: Partial<typeof CONTACT> } = {},
) {
  const c = { ...CONTACT, ...opts.contact }
  const [r] = await sql`select place_order(${customer}::uuid, ${opts.key ?? randomUUID()}::uuid, ${opts.source ?? 'quick'},
     ${c.name}, ${c.phone}, ${c.address}, ${c.comment}, ${sql.json(items as never)}) as r`
  return r.r as { duplicate: boolean; order: Record<string, any> }
}

/** Runs a place_order call that must fail; returns the machine code and parsed detail. */
export async function placeFails(sql: postgres.Sql, customer: string, items: unknown, opts: Parameters<typeof placeOrder>[3] = {}) {
  try {
    await placeOrder(sql, customer, items, opts)
  } catch (e) {
    const err = e as { message: string; detail?: string }
    return { code: err.message, detail: err.detail ? JSON.parse(err.detail) : undefined }
  }
  throw new Error('expected place_order to fail')
}
