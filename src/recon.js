import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path"

// Code reconnaissance (KRIYA_RECON=on, `--recon`): look before reading. The
// outline lists a file's symbols with their line numbers; impact lists the
// files that import a file. shortcut: both read source with fixed patterns,
// not a parser, so a symbol built at run time or an import through an alias
// is missed; a real parser would need a dependency, worth it only if real
// runs show these misses matter.

export const MAX_READ_LINES = 400
const MAX_SYMBOLS = 200
const MAX_FILES = 3000
const MAX_BYTES = 1_000_000
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", "coverage", "vendor", "venv", ".venv", "__pycache__", ".next"])

const PATTERNS = {
  js: [
    [/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, "function"],
    [/^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([\w$]+)/, "class"],
    [/^\s*(?:export\s+)?interface\s+([\w$]+)/, "interface"],
    [/^\s*(?:export\s+)?type\s+([\w$]+)\s*[=<]/, "type"],
    [/^\s*(?:export\s+)?enum\s+([\w$]+)/, "enum"],
    [/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)/, "const"],
    [/^\s{2,4}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?!if\b|for\b|while\b|switch\b|return\b|catch\b)([\w$]+)\s*\([^)]*\)\s*(?::[^={]+)?\{\s*$/, "method"],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+(\w+)/, "function"],
    [/^\s*class\s+(\w+)/, "class"],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, "function"],
    [/^type\s+(\w+)/, "type"],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, "function"],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/, "type"],
  ],
}
const FAMILY = { ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js", ".mts": "js", ".py": "py", ".go": "go", ".rs": "rs" }

export class ReconError extends Error {}

/** A path the agent gave, inside the session's folder */
export function insideFolder(cwd, path) {
  const file = resolve(cwd, String(path ?? ""))
  if (file !== cwd && !file.startsWith(cwd + sep)) throw new ReconError("That path is outside this session's folder.")
  return file
}

/** The symbols of source text, in order: { line, kind, name } */
export function outlineText(text, extension) {
  const patterns = PATTERNS[FAMILY[extension]]
  if (!patterns) return []
  const out = []
  text.split("\n").forEach((line, i) => {
    for (const [re, kind] of patterns) {
      const match = re.exec(line)
      if (match) {
        out.push({ line: i + 1, kind, name: match[1] })
        break
      }
    }
  })
  return out
}

/** One file's size and symbols, so the agent can read only the lines it needs */
export function outline(cwd, path) {
  const file = insideFolder(cwd, path)
  if (!existsSync(file) || !statSync(file).isFile()) throw new ReconError(`No file ${path}.`)
  if (statSync(file).size > MAX_BYTES) throw new ReconError(`${path} is over 1 MB; use grep.`)
  const text = readFileSync(file, "utf8")
  const symbols = outlineText(text, extname(file))
  return { path: relative(cwd, file), lines: text.split("\n").length, symbols: symbols.slice(0, MAX_SYMBOLS), ...(symbols.length > MAX_SYMBOLS && { cut: symbols.length - MAX_SYMBOLS }) }
}

function sourceFiles(root) {
  try {
    const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 })
    return listed.split("\n").filter((f) => FAMILY[extname(f)]).slice(0, MAX_FILES)
  } catch {
    const out = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= MAX_FILES || entry.name.startsWith(".") || SKIP.has(entry.name)) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (FAMILY[extname(entry.name)]) out.push(relative(root, path))
      }
    }
    walk(root)
    return out
  }
}

const SPECIFIER = /(?:from\s+|import\s+|require\(\s*|import\(\s*|vi\.mock\(\s*)["']([^"']+)["']/g
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm
const stem = (rel) => rel.replace(/\.[^./]+$/, "").replace(/\/index$/, "")

// tsconfig's `paths` ("@/*": ["./*"]): how most TypeScript projects import across folders
function pathAliases(root) {
  try {
    const text = readFileSync(join(root, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")
    const paths = JSON.parse(text).compilerOptions?.paths ?? {}
    return Object.entries(paths).flatMap(([from, [to]]) => (from.endsWith("/*") && to?.endsWith("/*") ? [{ from: from.slice(0, -1), to: normalize(to.slice(0, -1)) }] : []))
  } catch {
    return []
  }
}

/**
 * The project's import graph, read once: who imports whom, by what each
 * import statement resolves to (relative paths, tsconfig aliases, Python's
 * dotted modules). `text` hands out what was read.
 * @returns {{ root: string, files: string[], importedBy: Map<string, Set<string>>, importsOf: Map<string, Set<string>>, text: (rel: string) => string }}
 */
export function importGraph(root) {
  const files = sourceFiles(root)
  const stems = new Map(files.map((rel) => [stem(normalize(rel)), rel]))
  const aliases = pathAliases(root)
  const texts = new Map()
  const importedBy = new Map()
  const importsOf = new Map()
  const edge = (from, to) => {
    if (!to || to === from) return
    if (!importsOf.has(from)) importsOf.set(from, new Set())
    if (!importedBy.has(to)) importedBy.set(to, new Set())
    importsOf.get(from).add(to)
    importedBy.get(to).add(from)
  }
  for (const rel of files) {
    let text = ""
    try {
      const file = join(root, rel)
      if (statSync(file).size <= MAX_BYTES) text = readFileSync(file, "utf8")
    } catch {
      // Listed but gone: nothing to read
    }
    texts.set(rel, text)
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      if (spec.startsWith(".")) edge(rel, stems.get(stem(normalize(join(dirname(rel), spec)))))
      else {
        const alias = aliases.find((a) => spec.startsWith(a.from))
        if (alias) edge(rel, stems.get(stem(normalize(join(alias.to, spec.slice(alias.from.length))))))
      }
    }
    if (rel.endsWith(".py"))
      for (const [, a, b] of text.matchAll(PY_IMPORT)) {
        const dotted = (a ?? b).replaceAll(".", sep)
        edge(rel, stems.get(dotted) ?? [...stems.keys()].filter((k) => k.endsWith(`${sep}${dotted}`)).map((k) => stems.get(k))[0])
      }
  }
  return { root, files, importedBy, importsOf, text: (rel) => texts.get(rel) ?? "" }
}

/** Project files that import `target`, by what their import statements resolve to */
export function importers(root, target, graph = importGraph(root)) {
  return [...(graph.importedBy.get(normalize(target)) ?? [])]
}

const TEST = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.py$/

/** Test files a change touches: changed ones and the ones importing a changed file */
export function affectedTests(root, changed) {
  const tests = new Set(changed.filter((rel) => TEST.test(rel) && existsSync(join(root, rel))))
  for (const rel of changed.filter((f) => FAMILY[extname(f)] && !TEST.test(f)).slice(0, 20)) for (const by of importers(root, rel)) if (TEST.test(by)) tests.add(by)
  return [...tests].sort()
}

// A file that defines shared data: everything naming its tables is in reach, imported or not
const SCHEMA = /(^|\/)(schema\.(ts|js|prisma|py|rb)|models?\.(py|ts|js))$|(^|\/)migrations?\//
const ROUTE = /(^|\/)(app\/api\/(.+)\/route\.[jt]sx?|pages\/api\/(.+)\.[jt]sx?)$/
const MAX_SYMBOLS_TRACED = 30
const MAX_TESTS = 40

/** The names a change touches: symbols whose definition line is new or gone */
export function changedSymbols(before, after, extension) {
  const lines = (text) => new Set(String(text ?? "").split("\n"))
  const [was, now] = [lines(before), lines(after)]
  const named = (text, other) => {
    const rows = String(text ?? "").split("\n")
    return outlineText(text ?? "", extension).filter((s) => s.kind !== "method" && !other.has(rows[s.line - 1])).map((s) => s.name)
  }
  return [...new Set([...named(before, now), ...named(after, was)])]
}

const word = (name) => new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}([^\\w$]|$)`)

/**
 * What a change can reach: files that import it (near, then through them),
 * files naming a changed schema table or exported symbol, callers of a
 * changed API route, and the test suites of all of those, nearest first.
 * @param {{ rel: string, before: string | null, after: string | null }[]} diffs
 * @returns {{ direct: string[], transitive: string[], symbols: string[], callers: string[], tests: string[], cut: number }}
 */
export function blastRadius(graph, diffs, { depth = 3 } = {}) {
  const changed = new Set(diffs.map((d) => d.rel))
  const seen = new Map([...changed].map((rel) => [rel, 0]))
  let frontier = [...changed]
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next = []
    for (const rel of frontier) for (const by of graph.importedBy.get(rel) ?? []) if (!seen.has(by)) (seen.set(by, level), next.push(by))
    frontier = next
  }
  const symbols = [...new Set(diffs.flatMap((d) => changedSymbols(d.before, d.after, extname(d.rel))))].slice(0, MAX_SYMBOLS_TRACED)
  const shared = diffs.filter((d) => SCHEMA.test(d.rel)).flatMap((d) => changedSymbols(d.before, d.after, extname(d.rel)))
  const named = (names) => {
    const res = names.filter((n) => n.length > 3).map(word)
    return res.length ? graph.files.filter((rel) => !changed.has(rel) && res.some((re) => re.test(graph.text(rel)))) : []
  }
  // A table is shared by whoever names it; an ordinary symbol, only tests are looked for by name
  const schemaUsers = named(shared)
  for (const rel of schemaUsers) if (!seen.has(rel)) seen.set(rel, depth)
  const urls = diffs.flatMap((d) => {
    const m = ROUTE.exec(d.rel)
    const path = m && (m[3] ?? m[4])
    return path ? [`/api/${path.replace(/\[[^\]]+\]/g, "").replace(/\/$/, "")}`] : []
  })
  const callers = graph.files.filter((rel) => !changed.has(rel) && urls.some((url) => graph.text(rel).includes(url)))
  for (const rel of callers) if (!seen.has(rel)) seen.set(rel, 1)
  const byName = named(symbols).filter((rel) => TEST.test(rel))
  for (const rel of byName) if (!seen.has(rel)) seen.set(rel, depth)
  const rows = [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  const tests = rows.filter(([rel]) => TEST.test(rel) && existsSync(join(graph.root, rel))).map(([rel]) => rel)
  return {
    direct: rows.filter(([rel, d]) => d === 1 && !TEST.test(rel)).map(([rel]) => rel),
    transitive: rows.filter(([rel, d]) => d > 1 && !TEST.test(rel)).map(([rel]) => rel),
    symbols,
    callers,
    tests: tests.slice(0, MAX_TESTS),
    cut: Math.max(0, tests.length - MAX_TESTS),
  }
}

/** A long read's first page, in the read tool's own format, saying what's left; undefined when it fits */
export function readPage({ path, offset, lines, totalLines }) {
  if (!(lines?.length > MAX_READ_LINES)) return undefined
  const page = lines.slice(0, MAX_READ_LINES)
  const end = page.at(-1).number
  const body = page.map((line) => `${line.number}: ${line.text}`).join("\n")
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n(Showing lines ${offset}-${end} of ${totalLines}. Use offset=${end + 1} to continue, or code_outline to find the part you need.)\n</content>`
}
