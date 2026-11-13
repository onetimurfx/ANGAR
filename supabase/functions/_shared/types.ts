/** Minimal shape of a postgres.js client: only the tagged-template call is used, so any compatible client works. */
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<any[]>

export interface Env {
  /** Telegram bot token. Secret. Used to verify initData and to call the Bot API. */
  BOT_TOKEN?: string
  /** >= 32 random chars. Secret. Signs the short-lived session token. */
  SESSION_SECRET?: string
  /** Comma-separated list of allowed browser origins (the Mini App's HTTPS origin). */
  ALLOWED_ORIGINS?: string
  /** Shared secret for the notify-outbox retry endpoint (called by a scheduler). */
  CRON_SECRET?: string
  /** Injected by Supabase. With the service-role key it is used ONLY by the server to sign Storage uploads. */
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export interface Deps {
  sql: Sql
  env: Env
  fetch: typeof fetch
  /** current time in ms (injectable for tests) */
  now: () => number
  /** run best-effort background work (EdgeRuntime.waitUntil in production) */
  background: (work: Promise<unknown>) => void
  log: (msg: string, extra?: Record<string, unknown>) => void
}
