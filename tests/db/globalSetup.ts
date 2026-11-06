import { buildTemplate, startServer, stopServer, type PgServer } from './pg'

let server: PgServer | undefined

export async function setup({ provide }: { provide: (k: string, v: unknown) => void }) {
  server = startServer()
  await buildTemplate(server.port)
  provide('pgPort', server.port)
}
export async function teardown() {
  if (server) stopServer(server)
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number
  }
}
