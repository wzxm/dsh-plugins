import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  dts: true,
  clean: true,
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  format: ['esm'],
})
