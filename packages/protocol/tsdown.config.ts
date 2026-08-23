import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/types.ts'], outDir: 'lib', format: ['esm'], platform: 'neutral',
  target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
