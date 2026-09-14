/**
 * Build: the host-half plugin.
 *
 * Everything the harness also composes stays external. The harness supplies its
 * own Cordis, Schemastery, credentials, and Agent-stack instances; bundling a
 * private copy would give this row a *different* service registry and module
 * identity than the rest of the profile, so a resolution or `instanceof` check
 * could silently disagree. Before this file existed, adding the `Config` schema
 * pulled Schemastery into the bundle and grew the artifact from ~5 kB to ~57 kB.
 *
 * The Agent-stack packages matter for the same reason and are worse when broken:
 * this plugin both reads the `agents` service and would carry the only copy of
 * its module identity, so a bundled duplicate could create Agents the rest of the
 * profile cannot see.
 *
 * `sourcemap` is on because the committed `lib/` is what the release workflow
 * packs, and CI proves it matches source with `git diff --exit-code -- lib`.
 *
 * @module dsh-im/tsdown.config
 */

import { defineConfig } from 'tsdown'

/** Platform modules the harness provides; never inline these. */
const EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-workspace',
]

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: { sourcemap: true },
  sourcemap: true,
  fixedExtension: false,
  deps: { neverBundle: EXTERNALS },
})
