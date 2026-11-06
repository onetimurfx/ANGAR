import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type postgres from 'postgres'
import { asRole } from './pg'
import { newTestDb, seed, type Fixture } from './fixtures'

let sql: postgres.Sql
let fx: Fixture
beforeAll(async () => {
  ;({ sql } = await newTestDb('rls'))
  fx = await seed(sql)
})
afterAll(() => sql.end())

const denied = async (role: 'anon' | 'authenticated', query: string) => {
  try {
    await asRole(sql, role, (tx) => tx.unsafe(query))
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'allowed'
}
const PRIVATE = ['customers', 'cart_items', 'orders', 'order_items', 'order_status_history', 'notification_outbox', 'administrators']
const CATALOG = ['categories', 'brands', 'products', 'product_images', 'product_variants', 'inventory', 'collections', 'collection_items', 'promotions', 'settings']

describe('RLS is on everywhere', () => {
  it('every table in public has row level security enabled', async () => {
    const rows = await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`
    expect(rows.map((r) => r.relname)).toEqual([])
  })
})

describe.each(['anon', 'authenticated'] as const)('%s role', (role) => {
  it.each(PRIVATE)('cannot read %s', async (table) => {
    expect(await denied(role, `select * from public.${table} limit 1`)).toBe('42501')
  })
  it.each(PRIVATE)('cannot write %s', async (table) => {
    expect(await denied(role, `delete from public.${table}`)).toBe('42501')
    expect(await denied(role, `insert into public.${table} default values`)).toBe('42501')
  })
  it.each(CATALOG)('cannot write catalog table %s', async (table) => {
    expect(await denied(role, `delete from public.${table}`)).toBe('42501')
  })
  it('cannot change prices, stock or settings', async () => {
    expect(await denied(role, `update public.products set price = 1`)).toBe('42501')
    expect(await denied(role, `update public.inventory set quantity = 999`)).toBe('42501')
    expect(await denied(role, `update public.settings set delivery_fee = 0, allow_sample_orders = true`)).toBe('42501')
    expect(await denied(role, `insert into public.administrators (telegram_id) values (1)`)).toBe('42501')
  })
  it.each([
    `select public.place_order('${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}', '${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}', 'quick', 'a', 'b', 'c', null, '[]'::jsonb)`,
    `select public.set_cart('${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}', '[]'::jsonb)`,
    `select public.get_cart('${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}')`,
    `select public.my_orders('${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}')`,
    `select public.is_admin(900001)`,
    `select public.upsert_customer(1, 'x', null, null, null, null)`,
    `select * from public.claim_outbox(5)`,
    `select public.finish_outbox(1, true)`,
  ])('cannot execute server-only function: %s', async (q) => {
    expect(await denied(role, q)).toBe('42501')
  })
  it('can read the active catalog but not inactive items', async () => {
    const ids = await asRole(sql, role, async (tx) => (await tx`select id from products order by id`).map((r) => r.id))
    expect(ids).toEqual(['P1', 'P2', 'P3', 'SAMPLE'])
    const variants = await asRole(sql, role, async (tx) => (await tx`select size from product_variants where product_id = 'INACTIVE'`).length)
    expect(variants).toBe(0)
    const inv = await asRole(sql, role, async (tx) => (await tx`select count(*)::int as n from inventory`)[0].n)
    expect(inv).toBe(5) // P1 M, P1 L, P2, P3, SAMPLE (inactive product + inactive variant hidden)
  })
})

describe('get_catalog (the only function the browser calls)', () => {
  it('returns only public, active data and the delivery setting as "not configured"', async () => {
    const cat = await asRole(sql, 'anon', async (tx) => (await tx`select get_catalog() as c`)[0].c)
    const ids = cat.products.map((p: any) => p.id).sort()
    expect(ids).toEqual(['P1', 'P2', 'P3', 'SAMPLE'])
    const p1 = cat.products.find((p: any) => p.id === 'P1')
    expect(p1.variants.map((v: any) => `${v.size}/${v.color}/${v.qty}`)).toEqual(['L/Qora/2', 'M/Qora/5'])
    expect(cat.products.find((p: any) => p.id === 'SAMPLE').sample).toBe(true)
    expect(cat.products.find((p: any) => p.id === 'P1').sample).toBe(false)
    expect(cat.settings.deliveryConfigured).toBe(false)
    expect(cat.settings.deliveryFee).toBeNull()
    // no private keys leak
    expect(JSON.stringify(cat)).not.toMatch(/telegram|customer|phone|administrator/i)
  })
  it('hides expired promotions and inactive collections', async () => {
    await sql`insert into promotions (title, ends_at) values ('Eski', now() - interval '1 day'), ('Joriy', now() + interval '1 day')`
    await sql`insert into collections (id, title, active) values ('off', 'Yashirin', false), ('on', 'Ochiq', true)`
    const cat = await asRole(sql, 'anon', async (tx) => (await tx`select get_catalog() as c`)[0].c)
    expect(cat.banners.map((b: any) => b.title)).toEqual(['Joriy'])
    expect(cat.outfits.map((o: any) => o.id)).toEqual(['on'])
  })
  it('reflects stock changes and deactivation immediately', async () => {
    await sql`update products set active = false where id = 'P3'`
    const cat = await asRole(sql, 'anon', async (tx) => (await tx`select get_catalog() as c`)[0].c)
    expect(cat.products.map((p: any) => p.id)).not.toContain('P3')
    await sql`update products set active = true where id = 'P3'`
  })
})

describe('service_role (Edge Functions only)', () => {
  it('bypasses RLS and may execute the server functions', async () => {
    const n = await asRole(sql, 'service_role', async (tx) => (await tx`select count(*)::int as n from administrators`)[0].n)
    expect(n).toBe(1)
    const ok = await asRole(sql, 'service_role', async (tx) => (await tx`select is_admin(${fx.adminTg}) as a`)[0].a)
    expect(ok).toBe(true)
  })
})
