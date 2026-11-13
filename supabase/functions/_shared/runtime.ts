// Production wiring (Deno / Supabase Edge Runtime only; the tests build their own Deps).
// deno-lint-ignore-file no-explicit-any
import postgres from 'npm:postgres@3.4.5'
import type { Deps } from './types.ts'

declare const Deno: { env: { get(k: string): string | undefined } }
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

let sql: ReturnType<typeof postgres> | undefined

export function makeDeps(): Deps {
  // SUPABASE_DB_URL is injected by Supabase. Edge Functions use the pooled, server-side connection: the service
  // role / DB password never leave the server.
  sql ??= postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 3, prepare: false, idle_timeout: 20 })
  return {
    sql: sql as any,
    env: {
      BOT_TOKEN: Deno.env.get('BOT_TOKEN'),
      SESSION_SECRET: Deno.env.get('SESSION_SECRET'),
      ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS'),
      CRON_SECRET: Deno.env.get('CRON_SECRET'),
      SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    },
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
    background: (p) => (typeof EdgeRuntime !== 'undefined' ? EdgeRuntime.waitUntil(p) : void p),
    // never log secrets, tokens or personal data: codes and ids only
    log: (msg, extra) => console.error(JSON.stringify({ msg, ...extra })),
  }
}
