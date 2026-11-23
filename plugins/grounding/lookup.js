import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

// Harness 2.0 grounding (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GROUNDING_AND_CONNECTORS.md §5, WD-20): facts about the packages a project
// has installed, read from their own files: type definitions, stubs,
// changelogs and lockfiles. Exact for the installed version, local, free and
// deterministic. Nothing is imported, required or executed (importing a
// module runs its code), nothing goes on the network, and nothing outside the
// project folder is read.

export const MAX_ANSWER = 8 * 1024
const MAX_FILE = 2 * 1024 * 1024
const MAX_FILES = 60
const MAX_DECL_LINES = 60

export class GroundingError extends Error {}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const PY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SYMBOL = /^[A-Za-z_$][\w$]{0,99}$/

const cut = (text) => (text.length <= MAX_ANSWER ? text : `${text.slice(0, MAX_ANSWER - 30)}\n… (cut at 8 KB)`)

/** A file's text, if it is a regular file inside `root` and not too large. */
function readInside(root, file) {
  try {
    const real = realpathSync(file)
    const base = realpathSync(root)
    if (real !== base && !real.startsWith(base + sep)) return undefined
    const st = statSync(real)
    if (!st.isFile() || st.size > MAX_FILE) return undefined
    return readFileSync(real, "utf8")
  } catch {
    return undefined
  }
}
const readJson = (root, file) => {
  const text = readInside(root, file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/* ─────────────────────────────── where ─────────────────────────────── */

/** The installed package's folder: node_modules, else a Python environment in the project. */
export function findPackage(root, name) {
  if (typeof name !== "string" || !(NPM_NAME.test(name) || PY_NAME.test(name))) throw new GroundingError("That isn't a package name.")
  const npm = join(root, "node_modules", name)
  if (NPM_NAME.test(name) && readJson(root, join(npm, "package.json"))) return { kind: "npm", dir: npm }
  for (const site of sitePackages(root)) {
    const module = name.replace(/-/g, "_")
    for (const candidate of [join(site, module), join(site, name), join(site, name.toLowerCase().replace(/-/g, "_"))])
      if (existsSync(candidate) && readInside(root, join(candidate, "__init__.py")) !== undefined) return { kind: "python", dir: candidate, site, module }
    for (const candidate of [join(site, `${module}.py`), join(site, `${module}.pyi`)])
      if (readInside(root, candidate) !== undefined) return { kind: "python", dir: site, site, module, single: candidate }
  }
  // Types only (@types/<pkg>)
  if (NPM_NAME.test(name) && typesPackage(root, name)) return { kind: "npm", dir: npm, typesOnly: true }
  return undefined
}

/** site-packages of a virtual environment in the project (.venv, venv, env). */
export function sitePackages(root) {
  const out = []
  for (const env of [".venv", "venv", "env"]) {
    for (const lib of ["lib", "Lib"]) {
      const dir = join(root, env, lib)
      if (!existsSync(dir)) continue
      if (lib === "Lib" && existsSync(join(dir, "site-packages"))) out.push(join(dir, "site-packages"))
      else
        for (const py of safeList(dir).filter((d) => /^python\d/.test(d)))
          if (existsSync(join(dir, py, "site-packages"))) out.push(join(dir, py, "site-packages"))
    }
  }
  return out
}

const safeList = (dir) => {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

const typesName = (name) => (name.startsWith("@") ? name.slice(1).replace("/", "__") : name)
function typesPackage(root, name) {
  const dir = join(root, "node_modules", "@types", typesName(name))
  return readJson(root, join(dir, "package.json")) ? dir : undefined
}

/** The `types` entry of an exports value, searched in a fixed order. */
function exportsTypes(value) {
  if (!value) return undefined
  if (typeof value === "string") return /\.d\.[cm]?ts$/.test(value) ? value : undefined
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = exportsTypes(v)
      if (found) return found
    }
    return undefined
  }
  if (typeof value === "object") {
    if (typeof value.types === "string") return value.types
    for (const key of ["import", "require", "node", "default"]) {
      const found = exportsTypes(value[key])
      if (found) return found
    }
  }
  return undefined
}

/** The package's declaration entry: types/typings, exports["."].types, index.d.ts; then @types/<pkg>. */
export function typesEntry(root, name) {
  const dir = join(root, "node_modules", name)
  const pkg = readJson(root, join(dir, "package.json"))
  const tries = []
  if (pkg) {
    for (const field of [pkg.types, pkg.typings]) if (typeof field === "string") tries.push(join(dir, field))
    const dot = pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) && "." in pkg.exports ? pkg.exports["."] : pkg.exports
    const fromExports = exportsTypes(dot)
    if (fromExports) tries.push(join(dir, fromExports))
    tries.push(join(dir, "index.d.ts"))
  }
  for (const file of tries) if (readInside(root, file) !== undefined) return { file, from: "package" }
  const types = typesPackage(root, name)
  if (types) {
    const tpkg = readJson(root, join(types, "package.json"))
    for (const file of [tpkg?.types, tpkg?.typings, "index.d.ts"].filter((f) => typeof f === "string").map((f) => join(types, f)))
      if (readInside(root, file) !== undefined) return { file, from: "@types" }
  }
  return undefined
}

/* ────────────────────────────── lookup ────────────────────────────── */

const RE_EXPORT = /^\s*export\s+(?:\*|\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+["'](\.{1,2}\/[^"']+)["']/gm
const REFERENCE = /^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["']/gm

/** The declaration files reachable from an entry through relative re-exports (bounded). */
function declarationFiles(root, entry) {
  const seen = []
  const queue = [entry]
  while (queue.length && seen.length < MAX_FILES) {
    const file = queue.shift()
    if (seen.some((s) => s.file === file)) continue
    const text = readInside(root, file)
    if (text === undefined) continue
    seen.push({ file, text })
    for (const re of [RE_EXPORT, REFERENCE]) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        const target = resolve(dirname(file), m[1])
        for (const f of [target, `${target}.d.ts`, target.replace(/\.(m|c)?js$/, ".d.$1ts"), join(target, "index.d.ts")])
          if (/\.d\.[cm]?ts$/.test(f) && readInside(root, f) !== undefined) {
            queue.push(f)
            break
          }
      }
    }
  }
  return seen
}

const DECL = (name) =>
  new RegExp(String.raw`^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var|enum|namespace|module)\s+${name.replace(/\$/g, "\\$")}\b`)
const MEMBER = (name) => new RegExp(String.raw`^\s+(?:readonly\s+|static\s+|public\s+|protected\s+)*${name.replace(/\$/g, "\\$")}\??\s*[(:<]`)

/** One declaration from line `i`: its doc comment and its text until braces balance or a `;` ends it. */
function declarationAt(lines, i) {
  let start = i
  if (lines[i - 1]?.trim().endsWith("*/")) {
    let j = i - 1
    while (j >= 0 && !lines[j].includes("/**")) j--
    if (j >= 0) start = j
  }
  const out = []
  let depth = 0
  for (let k = i; k < lines.length && k < i + MAX_DECL_LINES; k++) {
    const line = lines[k]
    out.push(line)
    depth += (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length
    if (depth <= 0 && (/[;}]\s*$/.test(line) || (k === i && !/[{(]\s*$/.test(line) && /\)\s*:\s*[^=]+;?$/.test(line)))) break
  }
  return [...lines.slice(start, i), ...out].join("\n")
}

function searchTs(root, files, symbol) {
  const exact = []
  const prefix = new Set()
  const decl = DECL(symbol)
  const member = MEMBER(symbol)
  for (const { file, text } of files) {
    const lines = text.split("\n")
    lines.forEach((line, i) => {
      if (decl.test(line) || member.test(line)) exact.push(`// ${relative(root, file)}:${i + 1}\n${declarationAt(lines, i)}`)
      else {
        const m = /^\s*(?:export\s+)?(?:declare\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)
        if (m && m[1] !== symbol && m[1].startsWith(symbol)) prefix.add(m[1])
      }
    })
  }
  return { exact, prefix: [...prefix].sort().slice(0, 30) }
}

function pythonFiles(root, found) {
  if (found.single) return [found.single]
  const out = []
  const walk = (dir, depth) => {
    for (const entry of safeList(dir)) {
      if (out.length >= MAX_FILES * 4) return
      const full = join(dir, entry)
      if (entry === "__pycache__" || entry.startsWith(".")) continue
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory() && depth < 4) walk(full, depth + 1)
      else if (/\.pyi?$/.test(entry)) out.push(full)
    }
  }
  walk(found.dir, 0)
  // Stubs first: they are the declared API
  return out.sort((a, b) => Number(b.endsWith(".pyi")) - Number(a.endsWith(".pyi")) || a.localeCompare(b))
}

function searchPython(root, found, symbol) {
  const files = pythonFiles(root, found)
  const stubs = files.filter((f) => f.endsWith(".pyi"))
  const exact = []
  const prefix = new Set()
  const def = new RegExp(String.raw`^(\s*)(?:async\s+)?(?:def|class)\s+${symbol}\b`)
  for (const file of stubs.length ? stubs : files) {
    const text = readInside(root, file)
    if (text === undefined) continue
    const lines = text.split("\n")
    lines.forEach((line, i) => {
      if (def.test(line)) {
        // From stubs the whole signature; from source only the def/class lines (never run, never imported)
        const block = [line]
        for (let k = i + 1; k < lines.length && k < i + 8 && !/:\s*(#.*)?$/.test(lines[k - 1]); k++) block.push(lines[k])
        exact.push(`# ${relative(root, file)}:${i + 1}${stubs.length ? "" : " (source; stubs not shipped)"}\n${block.join("\n")}`)
      } else {
        const m = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line)
        if (m && m[1] !== symbol && m[1].startsWith(symbol)) prefix.add(m[1])
      }
    })
    if (exact.length >= 20) break
  }
  return { exact, prefix: [...prefix].sort().slice(0, 30), from: stubs.length ? "stubs" : "source" }
}

/** api_lookup: the installed declaration(s) of `symbol` in `pkg`, with doc comments; exact name, then names starting with it. */
export function apiLookup(root, pkg, symbol) {
  if (typeof symbol !== "string" || !SYMBOL.test(symbol)) throw new GroundingError("Give one exported name, e.g. createClient.")
  const found = findPackage(root, pkg)
  if (!found) return { package: pkg, symbol, text: `${pkg} isn't installed in this project (node_modules or a .venv).` }
  let result
  let from
  if (found.kind === "npm") {
    const entry = typesEntry(root, pkg)
    if (!entry) return { package: pkg, symbol, text: `${pkg} ships no type definitions and there is no @types/${typesName(pkg)} installed.` }
    result = searchTs(root, declarationFiles(root, entry.file), symbol)
    from = entry.from === "@types" ? `@types/${typesName(pkg)}` : "its type definitions"
  } else {
    result = searchPython(root, found, symbol)
    from = result.from === "stubs" ? "its .pyi stubs" : "its source (def and class lines only)"
  }
  const version = apiVersion(root, pkg).installed
  const head = `${pkg}${version ? ` ${version}` : ""}, from ${from}:`
  const text = result.exact.length
    ? `${head}\n\n${result.exact.slice(0, 20).join("\n\n")}${result.exact.length > 20 ? `\n\n(20 of ${result.exact.length} declarations shown)` : ""}`
    : `${head} no declaration named ${symbol}.${result.prefix.length ? ` Names starting with it: ${result.prefix.join(", ")}.` : ""}`
  return { package: pkg, symbol, found: result.exact.length, text: cut(text) }
}

/* ───────────────────────────── versions ───────────────────────────── */

const LOCK_VERSION = (lock, name) => lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version

/** api_version: what the project declares, what its lockfile pins, what is installed. */
export function apiVersion(root, name) {
  const found = findPackage(root, name)
  const out = { package: name }
  const manifest = readJson(root, join(root, "package.json"))
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const v = manifest?.[field]?.[name]
    if (typeof v === "string") {
      out.declared = v
      break
    }
  }
  const locked = LOCK_VERSION(readJson(root, join(root, "package-lock.json")), name)
  if (locked) out.locked = locked
  else {
    const pnpm = readInside(root, join(root, "pnpm-lock.yaml"))
    const m = pnpm && new RegExp(String.raw`^\s{2,}'?${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}'?:\s*\n(?:\s+specifier:.*\n)?\s+version:\s*'?([0-9][^\s'(]*)`, "m").exec(pnpm)
    if (m) out.locked = m[1]
  }
  if (found?.kind === "npm" && !found.typesOnly) out.installed = readJson(root, join(found.dir, "package.json"))?.version
  if (found?.kind === "python") {
    for (const site of sitePackages(root)) {
      const info = safeList(site).find((d) => new RegExp(String.raw`^${name.replace(/[-_.]/g, "[-_.]")}-([^-]+)\.(dist|egg)-info$`, "i").test(d))
      if (info) {
        out.installed = /-([^-]+)\.(?:dist|egg)-info$/.exec(info)[1]
        break
      }
    }
    if (!out.declared) {
      const req = readInside(root, join(root, "requirements.txt")) ?? ""
      const m = new RegExp(String.raw`^${name.replace(/[-_.]/g, "[-_.]")}\s*([<>=!~][^#\n]*)`, "im").exec(req)
      if (m) out.declared = m[1].trim()
    }
  }
  if (!found) out.note = "not installed"
  return out
}

/* ───────────────────────────── changelog ───────────────────────────── */

const parse = (v) => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ""))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const HEADING = /^(#{1,3})\s+\[?v?(\d+\.\d+(?:\.\d+)?)\]?/

/**
 * api_changes: the installed package's changelog sections after the version
 * the code was written for (`since`, else the lower bound of what the
 * project declares) up to the installed one.
 */
export function apiChanges(root, name, since) {
  const found = findPackage(root, name)
  if (!found || found.typesOnly) return { package: name, text: `${name} isn't installed in this project.` }
  const version = apiVersion(root, name)
  const installed = parse(version.installed)
  const from = parse(since) ?? parse(version.declared)
  const dir = found.dir
  const file = safeList(dir).find((f) => /^(changelog|history|changes)(\.md|\.rst|\.txt)?$/i.test(f))
  const text = file && readInside(root, join(dir, file))
  if (!text) return { package: name, installed: version.installed, text: `${name} ${version.installed ?? ""} ships no changelog.`.replace("  ", " ") }
  const lines = text.split("\n")
  const kept = []
  let keep = false
  let level = 0
  for (const line of lines) {
    const h = HEADING.exec(line)
    if (h && (!level || h[1].length <= level)) {
      const v = parse(h[2])
      level = h[1].length
      keep = Boolean(v && (!from || cmp(v, from) > 0) && (!installed || cmp(v, installed) <= 0))
    }
    if (keep) kept.push(line)
  }
  const range = `${from ? from.join(".") : "the start"} → ${version.installed ?? "installed"}`
  return {
    package: name,
    installed: version.installed,
    ...(from && { since: from.join(".") }),
    text: cut(kept.length ? `${name} ${file}, ${range}:\n\n${kept.join("\n").trim()}` : `${name} ${file} has no sections between ${range}.`),
  }
}

/** Whether the project has installed packages at all (for the prompt hint). */
export const hasInstalled = (root) => existsSync(join(root, "node_modules")) || sitePackages(root).length > 0
