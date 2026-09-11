import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  dts: { sourcemap: true },
  clean: true,
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  // The committed `lib/` is what the release workflow packs, so the build must
  // reproduce the whole artifact set — including the sourcemaps that were
  // previously shipped without a config that generated them.
  sourcemap: true,
  format: ['esm'],
})
