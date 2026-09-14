/**
 * Build: the node-half plugin plus the browser-half settings card.
 *
 * The client artifact speaks the harness module-loader protocol
 * (`window.__ModuleLoader__.load({id, factory})`) and resolves the platform
 * modules through the injected `require`. Everything else is bundled in, so
 * the card must not import another plugin's value exports — cross-plugin
 * collaboration goes through cordis services (`ctx.settingsScope`, `ctx.slots`).
 *
 * Deterministic output: no sourcemap on the production bundle, so the same
 * source builds byte-identical `client.js`.
 *
 * @module dsh-mysql/tsdown.config
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TsdownPluginOption, UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = '@wzxm/dsh-mysql'
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Module-table entries this bundle leaves external: the platform seed rows the
 * loader's `require` answers. Anything else must be bundled.
 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Compile `x.module.css` into its hashed class map, injecting a tagged style
 * when the factory runs. Kept off tsdown's own CSS pipeline (hence the virtual
 * id, whose suffix must not end in `.css`).
 * @returns the bundler plugin.
 */
function cssModulesPlugin(): TsdownPluginOption {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      // Relative to the project root so the id — and therefore the emitted
      // hash — does not depend on an absolute build path.
      const stableId = relative(PROJECT_ROOT, abs).replaceAll('\\', '/')
      return CSS_VIRTUAL_PREFIX + stableId + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const stableId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolvePath(PROJECT_ROOT, stableId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: stableId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // Fixed UTF-16 comparison on local class names: localeCompare depends on
      // the system locale, which would make the build non-reproducible.
      const entries = Object.entries(cssExports ?? {})
        .map(([local, exp]) => [local, exp.name] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      const classMap = Object.fromEntries(entries)
      const tagId = `${ID}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/**
 * Refuse to bundle a harness package that is not in the module table: a second
 * copy of a platform module (React, cordis, ui-primitives) would give the card
 * a different DI realm than the shell.
 * @returns the bundler plugin.
 */
function purityGate(): TsdownPluginOption {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the module table (EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services',
      )
    },
  }
}

/** The browser-half card bundle. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // No declarations: this artifact is loaded by the browser module loader at
  // runtime and is never imported as a value (the purity gate forbids that), so
  // there is no TypeScript consumer to serve.
  dts: false,
  minify: true,
  // No sourcemap on the production bundle: nothing ships the map and nothing
  // rewrites paths, so builds stay byte-identical.
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [purityGate(), cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** The node-half plugin. */
const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  dts: { sourcemap: true },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  // The committed `lib/` is what the release workflow packs, so the build must
  // reproduce the whole artifact set, sourcemaps included.
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
      '@deepseek-ai/dsh-settings',
    ],
  },
  // `clean` must not run per-config: the client config writes into the same
  // outDir, so whichever ran second would delete the other's artifact.
  clean: false,
}

export default [libConfig, clientConfig]
