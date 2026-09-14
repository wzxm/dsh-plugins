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
  // Everything the host also composes stays external: the harness supplies its
  // own Cordis and Schemastery instances, and a plugin-private copy would give
  // this row a different service registry than the rest of the profile.
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-user-approval',
    ],
  },
})
