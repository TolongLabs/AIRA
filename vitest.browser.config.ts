import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/browser/**/*.browser.ts'],
    setupFiles: ['tests/support/no-live-calls.ts'],
    testTimeout: 60000
  }
})
