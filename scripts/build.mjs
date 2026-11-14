// Build/typecheck runner with no installed dependencies.
//
// TypeScript and the @deepseek-ai type packages are borrowed from a host
// checkout or a sibling plugin project. The script links the needed entries
// into this project's `node_modules` (a shim — `node_modules/` is gitignored),
// so tsc, vitest and the editor all resolve them natively without any paths
// block in the tsconfig.
//
// The deps root (a directory whose node_modules provides the types) is found
// in this order:
//   $DSH_NODE_MODULES   a node_modules directory, used as-is
//   $DSH_HOME           a DSH checkout; its node_modules is used
//   ./node_modules      if it already provides typescript + @deepseek-ai types
//                       (a previous run's shim, or a real install)
//   .dsh-buildrc.json   gitignored, next to package.json: {"nodeModules": …}
//                       and/or {"checkout": a DSH source checkout}
//   $DSH_CHECKOUT       a DSH source checkout, same as the rc field; tried as
//                       written, then translated to every mount under /media
//                       that carries it (the drive may move between machines)
//   sibling projects    <root>/../<name>/node_modules and grandparent entries
//                       offering the same
// `tsc` itself can also be pinned via $DSH_TSC (explicit path to tsc.js).
//
// The shim is refreshed on every run: entries are only added, never removed
// or overwritten when they resolve elsewhere, so a real `npm install` wins.
// Two deps-root layouts are understood:
//   published   @deepseek-ai/* are real packages inside node_modules
//   checkout    @deepseek-ai/* are workspace links, while cordis and cosmokit
//               live under vendor/ and need the @deepseek-ai alias
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = process.argv[2] ?? 'tsconfig.build.json'
const scopeName = '@deepseek-ai'
// Which DSH install's declarations to compile against is machine-specific, so no
// path is baked in: point DSH_NODE_MODULES (a node_modules directory), DSH_HOME
// (a checkout root) or DSH_CHECKOUT (a source checkout) at it, or write a
// gitignored `.dsh-buildrc.json` next to package.json —
// `{"checkout": "<source checkout>"}` or `{"nodeModules": "<node_modules dir>"}`.
function localBuildConfig() {
  try {
    const parsed = JSON.parse(readFileSync(join(root, '.dsh-buildrc.json'), 'utf8'))
    const pick = key => (typeof parsed[key] === 'string' && parsed[key] !== '' ? parsed[key] : undefined)
    return { checkout: pick('checkout'), nodeModules: pick('nodeModules') }
  } catch {
    return {}
  }
}

function isDirectory(path) {
  try { return readdirSync(path) !== null } catch { return false }
}

/** Whether a node_modules directory provides enough for tsc to resolve the sources. */
function providesNodeModules(nodeModules) {
  return nodeModules !== undefined
    && existsSync(join(nodeModules, 'typescript/lib/tsc.js'))
    && existsSync(join(nodeModules, '@types/node/package.json'))
    && existsSync(join(nodeModules, '@deepseek-ai/cordis/package.json'))
}

/** A deps root qualifies when it offers tsc plus the types in either layout. */
function qualifies(nodeModules) {
  return nodeModules !== undefined
    && existsSync(join(nodeModules, 'typescript/lib/tsc.js'))
    && existsSync(join(nodeModules, '@types/node/package.json'))
    && (existsSync(join(nodeModules, '@deepseek-ai/cordis/package.json'))
      || existsSync(join(dirname(nodeModules), 'vendor/cordis/package.json')))
}

/** Translate a `D:/...` Windows path to every /media mount carrying the same subtree. */
function windowsMounts(candidate) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(candidate)
  if (match === null) return []
  const rest = match[2].replaceAll('\\', '/')
  const mounts = []
  try {
    for (const user of readdirSync('/media')) {
      for (const drive of readdirSync(join('/media', user))) {
        const mounted = join('/media', user, drive, rest)
        if (existsSync(mounted)) mounts.push(mounted)
      }
    }
  } catch { /* no /media: not a mount-based host */ }
  return mounts
}

/** The DSH source checkout to borrow declarations from, when one is configured. */
const configuredCheckout = process.env['DSH_CHECKOUT'] ?? localBuildConfig().checkout
const checkoutCandidates = configuredCheckout ? [configuredCheckout, ...windowsMounts(configuredCheckout)] : []

function findDepsRoots() {
  const candidates = []
  const envModules = process.env['DSH_NODE_MODULES']
  const envHome = process.env['DSH_HOME']
  if (envModules !== undefined && envModules !== '') candidates.push(envModules)
  if (envHome !== undefined && envHome !== '') candidates.push(join(envHome, 'node_modules'))
  const local = localBuildConfig()
  if (local.nodeModules !== undefined) candidates.push(local.nodeModules)
  candidates.push(join(root, 'node_modules'))
  // A source checkout outranks siblings — published @deepseek-ai packages may
  // lag the checkout's type surface. Try it as written, then every /media mount
  // that carries the same subtree, since the drive may move between machines.
  for (const candidate of checkoutCandidates) candidates.push(join(candidate, 'node_modules'))
  // Siblings one and two levels up: the repo may sit inside a checkout or
  // next to other plugin projects on either level.
  const seen = new Set([root, dirname(root)])
  for (const level of [dirname(root), dirname(dirname(root))]) {
    try {
      for (const entry of readdirSync(level)) {
        if (entry === 'node_modules') continue
        const candidate = join(level, entry, 'node_modules')
        if (seen.has(candidate)) continue
        seen.add(candidate)
        candidates.push(candidate)
      }
    } catch { /* level unreadable: skip the sibling scan */ }
  }
  return candidates.filter(candidate => qualifies(candidate))
}

const depsRoots = findDepsRoots()
const depsRoot = depsRoots[0]
if (depsRoot === undefined) {
  console.error(
    'No node_modules with typescript and the @deepseek-ai types found. Point DSH_NODE_MODULES at a'
    + ' node_modules directory (or DSH_HOME at a DSH checkout) and retry.',
  )
  process.exit(2)
}

/**
 * Source checkouts among the same places the deps roots were sought: a checkout
 * keeps its packages under `packages/` and vendored cordis under `vendor/`.
 */
function findCheckoutRoots() {
  const candidates = [...depsRoots.map(dirname), ...checkoutCandidates]
  return candidates.filter(directory => isDirectory(join(directory, 'packages')) || isDirectory(join(directory, 'vendor')))
}

const checkoutRoots = findCheckoutRoots()

/** Whether any directory entry sits at the path, even a broken link to it. */
function entryExists(path) {
  try { lstatSync(path); return true } catch { return false }
}

/** Link one borrowed entry into the project shim, replacing only stale links. */
function shimLink(source, target) {
  if (!isDirectory(source)) return
  if (entryExists(target)) {
    try {
      if (realpathSync(target) === realpathSync(source)) return
    } catch { /* a broken link: fall through and replace it */ }
    try { unlinkSync(target) } catch { return } // a real install wins over the shim
  }
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(realpathSync(source), target, kind)
}

/**
 * Link a scope directory (`@types`, `@deepseek-ai`) entry by entry.
 *
 * Linking the directory itself keeps the entries' own relative links pointed at
 * the borrowed tree, which breaks under pnpm's nested store layout; one link per
 * resolved entry works on every layout.
 */
/** Whether a linked scope directory resolves its own entries (a whole-directory
 *  link under pnpm keeps the entries' relative links pointed at the borrowed
 *  tree, which reads as a tree of broken links from here). */
function treeUsable(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return false }
  if (entries.length === 0) return false
  return entries.every(entry => isDirectory(join(dir, entry)))
}

function shimTree(source, target) {
  if (!isDirectory(source)) return
  let sourcePath
  let targetPath
  try { sourcePath = realpathSync(source) } catch { return }
  try { targetPath = realpathSync(target) } catch { targetPath = undefined }
  if (targetPath !== undefined && sourcePath === targetPath && treeUsable(target)) return // already borrowed from here
  // An earlier run may have linked the whole directory; drop that link (and
  // only a link to this same tree) so the per-entry links land in a real dir.
  if (targetPath !== undefined) {
    try { rmSync(target, { recursive: false, force: true }) } catch { return }
    if (!isDirectory(source)) {
      console.error(`Removing the shim link ${target} left the borrowed tree ${source} unreadable.`)
      process.exit(2)
    }
  }
  mkdirSync(target, { recursive: true })
  try {
    for (const entry of readdirSync(sourcePath)) shimLink(join(sourcePath, entry), join(target, entry))
  } catch { /* unreadable scope: nothing to borrow */ }
}

const nodeModules = join(root, 'node_modules')
mkdirSync(nodeModules, { recursive: true })
shimLink(join(depsRoot, 'typescript'), join(nodeModules, 'typescript'))
shimTree(join(depsRoot, '@types'), join(nodeModules, '@types'))
shimTree(join(depsRoot, '@standard-schema'), join(nodeModules, '@standard-schema'))
// The vitest package (not just its .bin entry) so `tsc` can typecheck the
// tests; the first root that actually carries one wins.
const vitestPackage = depsRoots.map(deps => join(deps, 'vitest')).find(dir => existsSync(join(dir, 'package.json')))
if (vitestPackage !== undefined) shimLink(vitestPackage, join(nodeModules, 'vitest'))

// `npm test` needs a runnable vitest in node_modules/.bin. A deps root whose
// node_modules was installed on another OS fails the moment vitest loads its
// native bundler binding (`--version` still exits 0), so every root is probed
// with a one-assertion smoke run before it is linked.
const binDir = join(nodeModules, '.bin')
mkdirSync(binDir, { recursive: true })
if (process.platform === 'win32') {
  // Linking the whole borrowed `.bin` directory would leave its shims' relative
  // paths pointed away from this project, so write one thin entry that runs the
  // borrowed vitest against this project instead.
  const runner = [depsRoot, ...checkoutRoots.map(entry => join(entry, 'node_modules'))]
    .map(entry => join(entry, 'vitest', 'vitest.mjs'))
    .find(entry => existsSync(entry))
  if (runner !== undefined) {
    writeFileSync(join(binDir, 'vitest.cmd'), `@echo off\r\nnode "${runner}" %*\r\n`)
  } else {
    console.warn('No runnable vitest found in any deps root; `npm test` will be unavailable.')
  }
} else {
  const target = join(binDir, 'vitest')
  try { unlinkSync(target) } catch { /* absent on a fresh shim */ }
  const probeDir = join(tmpdir(), 'dsh-agent-session-tools-vitest-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(
    join(probeDir, 'probe.test.js'),
    'import { it, expect } from "vitest"\nit("boots", () => { expect(1).toBe(1) })\n',
  )
  try {
    for (const candidateRoot of depsRoots) {
      const candidate = join(candidateRoot, '.bin', 'vitest')
      if (!existsSync(candidate)) continue
      const probe = spawnSync(candidate, ['run', '--root', probeDir], { stdio: 'pipe', timeout: 120_000 })
      if (probe.status === 0) {
        symlinkSync(realpathSync(candidate), target, 'dir')
        break
      }
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
  if (!existsSync(target)) {
    console.warn('No runnable vitest found in any deps root; `npm test` will be unavailable.')
  }
}

/**
 * Link every `@deepseek-ai` package a source checkout carries — `packages/<group>/<name>`
 * and `vendor/<name>` — under the scope by its manifest name. The checkout's own
 * root `node_modules/@deepseek-ai` only lists what the root package depends on,
 * so a plugin's imports have to be found from the workspace layout instead.
 */
function shimCheckoutScope(scope, checkoutRoot) {
  const directories = [
    ...safeReaddir(join(checkoutRoot, 'packages'))
      .flatMap(group => safeReaddir(join(checkoutRoot, 'packages', group)).map(name => join('packages', group, name))),
    ...safeReaddir(join(checkoutRoot, 'vendor')).map(name => join('vendor', name)),
  ]
  for (const relative of directories) {
    const directory = join(checkoutRoot, relative)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    } catch { continue } // no manifest: not a package directory
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(`${scopeName}/`)) continue
    shimLink(directory, join(scope, manifest.name.slice(scopeName.length + 1)))
  }
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** The resolved path of a directory, or undefined when it cannot be resolved. */
function realpathSafe(path) {
  try { return realpathSync(path) } catch { return undefined }
}

// @deepseek-ai: a published deps root carries the scope as real packages; a
// source checkout keeps them under packages/ and vendor/ and needs the manifest
// walk. Both are applied, and an entry that already resolves is left alone.
const scope = join(nodeModules, '@deepseek-ai')
const published = join(depsRoot, '@deepseek-ai')
mkdirSync(scope, { recursive: true })
if (isDirectory(published) && realpathSafe(published) !== realpathSafe(scope)) {
  for (const entry of safeReaddir(published)) shimLink(join(published, entry), join(scope, entry))
}
for (const checkoutRoot of checkoutRoots) {
  shimCheckoutScope(scope, checkoutRoot)
  shimLink(join(checkoutRoot, 'vendor/cordis'), join(scope, 'cordis'))
  shimLink(join(checkoutRoot, 'vendor/cosmokit'), join(scope, 'cosmokit'))
}

if (!providesNodeModules(nodeModules)) {
  console.error(`The deps root ${depsRoot} does not yield a usable shim (typescript + @deepseek-ai/cordis).`)
  process.exit(2)
}

const compiler = process.env['DSH_TSC'] ?? join(nodeModules, 'typescript', 'lib', 'tsc.js')
if (!existsSync(compiler)) {
  console.error(`No TypeScript compiler at ${compiler}. Set DSH_TSC to tsc.js.`)
  process.exit(2)
}

const result = spawnSync(process.execPath, [compiler, '-p', config], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
