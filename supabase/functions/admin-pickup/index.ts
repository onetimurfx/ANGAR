import { makeDeps } from '../_shared/runtime.ts'
import { handler } from './handler.ts'

// @ts-ignore Deno global (Supabase Edge Runtime)
Deno.serve(handler(makeDeps()))
