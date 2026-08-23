import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const harness = (path: string): string => fileURLToPath(new URL(`../deepseek-harness/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@monotykamary/dsh-client-ui-attachment/client': harness('packages/client/ui-attachment/src/client/index.ts'),
      '@monotykamary/dsh-client-ui-deliverables/client': harness('packages/client/ui-deliverables/src/client/ProducedFiles.tsx'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.{ts,tsx}'],
  },
})
