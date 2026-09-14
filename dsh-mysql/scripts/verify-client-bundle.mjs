/**
 * Verify the packed manifest satisfies every rule the client-modules scanner
 * enforces before it will serve a browser bundle, and that the bundle itself
 * speaks the module-loader protocol.
 *
 * Run after `pnpm build`; exits non-zero on any violation.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 1. dsh.client is declared, targets web, and carries the service injections.
const decl = pkg.dsh?.client
check('dsh.client declared', decl !== undefined && typeof decl === 'object')
check('dsh.client.platform is web', decl?.platform === 'web', String(decl?.platform))
check('dsh.client.inject is an array', Array.isArray(decl?.inject), JSON.stringify(decl?.inject))

// 2. The loader resolves exports["./client"] and joins it onto the package root,
//    so that exact path must exist on disk.
const clientRel = pkg.exports?.['./client']?.default
check('exports["./client"].default is a string', typeof clientRel === 'string', String(clientRel))
const clientFile = typeof clientRel === 'string' ? join(root, clientRel) : ''
check('the declared client bundle exists', clientFile !== '' && existsSync(clientFile), clientFile)

// 3. The host half is what the bundle patch mounts; it must exist too.
const mainRel = pkg.exports?.['.']?.default
check('exports["."].default exists', typeof mainRel === 'string' && existsSync(join(root, mainRel)))
const typesRel = pkg.exports?.['.']?.types
check('exports["."].types exists', typeof typesRel === 'string' && existsSync(join(root, typesRel)))

// 4. Every `files` entry that names a path must exist: a missing one is silently
//    dropped by npm pack, which would ship a bundle the manifest still advertise.
for (const entry of pkg.files ?? []) {
  check(`files entry present: ${entry}`, existsSync(join(root, entry)))
}

// 5. The bundle must speak the module-loader protocol under the exact package id,
//    because the loader keys the served module on that id.
if (clientFile !== '' && existsSync(clientFile)) {
  const source = readFileSync(clientFile, 'utf8')
  check('bundle calls window.__ModuleLoader__.load', source.includes('window.__ModuleLoader__.load('))
  check(
    'bundle registers under the package name',
    source.includes(JSON.stringify(pkg.name)) || source.includes(`\`${pkg.name}\``),
  )

  // Platform modules must be *requested* through the factory's require, not
  // bundled: a second copy of React or cordis would put the card in a different
  // DI realm than the shell. Read the require parameter out of the factory
  // signature rather than assuming its minified name.
  const factory = source.match(/factory:\s*([A-Za-z_$][\w$]*)\s*=>/)
  const requireParam = factory?.[1]
  check('bundle factory takes a require parameter', requireParam !== undefined)

  const requested = new Set()
  if (requireParam !== undefined) {
    const call = new RegExp(`\\b${requireParam}\\((["'])([^"']+)\\1\\)`, 'g')
    for (const match of source.matchAll(call)) requested.add(match[2])
  }
  const required = [...requested].sort()
  check('bundle requests at least one platform module', required.length > 0, required.join(', '))

  // Anything requested must be a platform seed row; a request for some other
  // package would fail at load time because the module table cannot answer it.
  const PLATFORM = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const unexpected = required.filter(spec => !PLATFORM.includes(spec))
  check('every requested module is a platform seed row', unexpected.length === 0, unexpected.join(', '))

  // And the react family must be among them, since the card renders JSX.
  check('react is resolved externally, not bundled', required.some(spec => spec.startsWith('react')))
}

console.log(failures.length === 0 ? '\nAll client-bundle contract checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
