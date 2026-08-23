import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.DSH_FACTORY_E2E_URL ?? 'http://127.0.0.1:4179',
    viewport: { width: 1440, height: 960 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
})
