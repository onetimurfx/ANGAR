/**
 * Starts a REAL PostgreSQL (embedded-postgres binaries) for the database and Edge Function tests.
 * Postgres refuses to run as root, so when the tests run as root (cloud sandbox) the server runs as the
 * unprivileged user `pgtest`. In CI (non-root) it simply runs as the current user.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import postgres from 'postgres'

const NATIVE = resolve('node_modules/@embedded-postgres/linux-x64/native')
const BIN = join(NATIVE, 'bin')
const MIGRATIONS = resolve('supabase/migrations')

export interface PgServer {
  port: number
  dataDir: string
  runAs: { uid: number; gid: number } | undefined
}

function runAsUser(): { uid: number; gid: number } | undefined {
  if (process.getuid?.() !== 0) return undefined
  try {
    execFileSync('id', ['pgtest'])
  } catch {
    execFileSync('useradd', ['-m', 'pgtest'])
  }
  return { uid: Number(execFileSync('id', ['-u', 'pgtest']).toString()), gid: Number(execFileSync('id', ['-g', 'pgtest']).toString()) }
}

export function startServer(): PgServer {
  const runAs = runAsUser()
  const dataDir = mkdtempSync(join(tmpdir(), 'aynimo-pg-'))
  if (runAs) chmodSync(dataDir, 0o700) // owned by root until chown below
  if (runAs) execFileSync('chown', ['-R', `${runAs.uid}:${runAs.gid}`, dataDir])
  const port = 54000 + Math.floor(Math.random() * 900)
  const opts = { uid: runAs?.uid, gid: runAs?.gid, encoding: 'utf8' as const, env: { ...process.env, LC_ALL: 'C.UTF-8' } }
  const init = spawnSync(join(BIN, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], opts)
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`)
  const start = spawnSync(
    join(BIN, 'pg_ctl'),
    ['-D', dataDir, '-w', '-l', join(dataDir, 'server.log'), '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`, 'start'],
    opts,
  )
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr}${start.stdout}`)
  return { port, dataDir, runAs }
}

export function stopServer(s: PgServer) {
  spawnSync(join(BIN, 'pg_ctl'), ['-D', s.dataDir, '-m', 'immediate', 'stop'], { uid: s.runAs?.uid, gid: s.runAs?.gid })
  rmSync(s.dataDir, { recursive: true, force: true })
}

export const url = (port: number, db: string) => `postgres://postgres@127.0.0.1:${port}/${db}`

/** Roles that Supabase provides out of the box. */
const ROLES_SQL = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
`

export async function buildTemplate(port: number, name = 'aynimo_template') {
  const admin = postgres(url(port, 'postgres'), { max: 1, onnotice: () => {} })
  await admin.unsafe(ROLES_SQL)
  await admin.unsafe(`create database ${name}`)
  await admin.end()
  const db = postgres(url(port, name), { max: 1, onnotice: () => {} })
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await db.unsafe(readFileSync(join(MIGRATIONS, f), 'utf8'))
  }
  await db.end()
}

export async function createDb(port: number, name: string, template = 'aynimo_template') {
  const admin = postgres(url(port, 'postgres'), { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database ${name} template ${template}`)
  await admin.end()
  return url(port, name)
}

/** Runs `fn` inside a transaction as the given Supabase role (RLS applies to anon/authenticated). */
export async function asRole<T>(sql: postgres.Sql, role: 'anon' | 'authenticated' | 'service_role', fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  let out!: T
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`)
      out = await fn(tx as unknown as postgres.Sql)
      throw new RollbackSignal()
    })
  } catch (e) {
    if (!(e instanceof RollbackSignal)) throw e
  }
  return out
}
class RollbackSignal extends Error {}
