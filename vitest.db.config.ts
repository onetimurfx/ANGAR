import { defineConfig } from 'vitest/config'

// Database + Edge Function tests against a real PostgreSQL. Run: npm run test:db
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/db/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
