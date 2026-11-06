import { describe, expect, inject, it } from 'vitest'
import postgres from 'postgres'
import { createDb } from './pg'

describe('harness', () => {
  it('migrations apply on a real Postgres', async () => {
    const sql = postgres(await createDb(inject('pgPort'), 'smoke'), { max: 1 })
    const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`
    expect(n).toBeGreaterThanOrEqual(17)
    const cat = await sql`select public.get_catalog() as c`
    expect(Object.keys(cat[0].c)).toContain('products')
    await sql.end()
  })
})
