import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const harness = (path: string): string => fileURLToPath(new URL(`../deepseek-harness/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    // Sibling Harness sources import React from their own checkout unless Vite
    // pins framework identity to this test workspace. Duplicate React copies
    // make every linked primitive hook fail on a clean CI runner.
    dedupe: ['react', 'react-dom', 'lucide-react'],
    alias: {
      '@monotykamary/dsh-client-ui-primitives': harness('packages/client/ui-primitives/src/index.ts'),
      '@monotykamary/dsh-client-ui-attachment/client': harness('packages/client/ui-attachment/src/client/index.ts'),
      '@monotykamary/dsh-client-ui-deliverables/client': harness('packages/client/ui-deliverables/src/client/ProducedFiles.tsx'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.{ts,tsx}'],
  },
})
