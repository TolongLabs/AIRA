import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./site/src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'site/src/**/*.test.ts'],
    // Zero Live Calls: a request to any host but this machine fails the test that made it.
    setupFiles: ['tests/support/no-live-calls.ts']
  }
})
