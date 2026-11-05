import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The strict loop (KRIYA_STRICT_LOOP=on, `--strict-loop`; Kriya repository,
// docs/kriya-harness/harness_upgradation/KRIYA_CODING_HARNESS_REPORT.md): the
// pure half. Task kinds and their planning bounds, what counts as weakening a
// test or silencing the compiler, and the fast rungs that run before the
// person's check. Every rung can only fail a step early: "passing" still
// means the person's confirmed check exited 0.

export const TASK_KINDS = ["surgical_bugfix", "feature_dag", "deep_research", "refactoring_migration"]
// The most plan steps a kind may have: a one-line fix doesn't need a graph
export const PLAN_LIMITS = { surgical_bugfix: 2, deep_research: 3, feature_dag: 7, refactoring_migration: 7 }

/** A task's kind from the words of its goal, when the plan names none. Fixed patterns, no model. */
export function taskKind(text) {
  const t = String(text ?? "").toLowerCase()
  if (/\b(research|investigate|compare|survey)\b/.test(t)) return "deep_research"
  if (/\b(refactor|migrat\w*|rename|restructure|extract|upgrade)\b/.test(t)) return "refactoring_migration"
  if (/\b(fix|bug|crash\w*|regression|broken|fail\w*|error)\b/.test(t)) return "surgical_bugfix"
  return "feature_dag"
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*)/
const ASSERTION = /\b(assert\w*|expect|should|t\.(is|not|deepEqual|true|false|throws)|self\.assert\w*|require\.\w+)\s*[.(]/g
const SKIPPED = /\b(it|test|describe)\.(skip|todo|only)\b|\bx(it|describe)\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]/g
const count = (text, re) => (text.match(re) ?? []).length
const live = (text) => text.split("\n").filter((line) => !COMMENT.test(line)).join("\n")

/**
 * Why a test file's new text is weaker than its old text, or undefined.
 * Adding tests is fine (the owner's "grade on originals" ruling, HU-F-20): only
 * fewer live assertions, more skips, or a deleted file count.
 * @param {string} before @param {string | null} after null when the file is gone
 */
export function weakenedTest(before, after) {
  if (after === null) return "deleted"
  const [was, now] = [live(before), live(after)]
  if (count(now, ASSERTION) < count(was, ASSERTION)) return `fewer assertions (${count(was, ASSERTION)} to ${count(now, ASSERTION)})`
  if (count(now, SKIPPED) > count(was, SKIPPED)) return "tests skipped"
  return undefined
}

const SILENCERS = [
  ["`any`", /(:\s*any\b|\bas any\b|<any>)/g],
  ["a compiler suppression", /@ts-(ignore|nocheck|expect-error)|eslint-disable|#\s*type:\s*ignore|#\s*noqa/g],
  ["an empty catch", /catch\s*(\([^)]*\))?\s*\{\s*\}|except[^\n]*:\s*\n?\s*pass\b/g],
]
const SOURCE = /\.(m?[jt]sx?|cjs|py)$/

/** What this change adds to quiet the compiler or swallow an error, as words; empty when nothing */
export function silencers(before, after) {
  return SILENCERS.filter(([, re]) => count(after, re) > count(before ?? "", re)).map(([name]) => name)
}
export const isSource = (rel) => SOURCE.test(rel)

const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`
const MAX_FILES = 40
const read = (file) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** The command that parses these files without running them, or undefined; `node --check` and Python's ast only read */
export function syntaxCommand(paths) {
  const js = paths.filter((p) => /\.(m?js|cjs)$/.test(p)).slice(0, MAX_FILES)
  const py = paths.filter((p) => p.endsWith(".py")).slice(0, MAX_FILES)
  const json = paths.filter((p) => p.endsWith(".json")).slice(0, MAX_FILES)
  const parts = [
    ...js.map((p) => `node --check ${quote(p)}`),
    ...py.map((p) => `python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' ${quote(p)}`),
    ...json.map((p) => `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' ${quote(p)}`),
  ]
  return parts.length ? parts.join(" && ") : undefined
}

/** How this project runs named test files, or undefined when it can't be told */
function testCommand(root, tests) {
  const scripts = (() => {
    try {
      return JSON.stringify(JSON.parse(read(join(root, "package.json")) ?? "{}").scripts ?? {})
    } catch {
      return "{}"
    }
  })()
  const files = tests.map(quote).join(" ")
  if (/vitest/.test(scripts)) return `npx --no-install vitest run ${files}`
  if (/jest/.test(scripts)) return `npx --no-install jest ${files}`
  if (/node --test/.test(scripts)) return `node --test ${files}`
  if (tests.every((t) => t.endsWith(".py"))) return `python3 -m pytest -q ${files}`
  return undefined
}

/**
 * The rungs under the person's check, cheapest first, for the files that
 * changed. `names` keeps a rung to this work: a type error elsewhere in the
 * project is older than this change and isn't the builder's to fix.
 * @param {string} root the repository's top folder
 * @param {string[]} changed paths relative to it
 * @param {string[]} [tests] test files the change affects (src/recon.js)
 * @param {string[]} [neighbours] the blast radius's other test files (defensive)
 * @returns {Array<{ level: number, name: string, command: string, kind?: string, names?: string[] }>}
 */
export function ladder(root, changed, tests = [], neighbours = []) {
  const present = changed.filter((rel) => existsSync(join(root, rel)))
  const rungs = []
  const syntax = syntaxCommand(present)
  if (syntax) rungs.push({ level: 1, name: "syntax", command: syntax, kind: "syntax" })
  if (present.some((rel) => /\.tsx?$/.test(rel)) && existsSync(join(root, "tsconfig.json")) && existsSync(join(root, "node_modules", ".bin", "tsc")))
    rungs.push({ level: 2, name: "types", command: "npx --no-install tsc --noEmit", kind: "type", names: present })
  if (tests.length) {
    const command = testCommand(root, tests.slice(0, 10))
    if (command) rungs.push({ level: 3, name: "affected tests", command })
  }
  // Slower, so after the tests of the code itself: a failure there costs seconds, not minutes
  if (neighbours.length) {
    const command = testCommand(root, neighbours)
    if (command) rungs.push({ level: 3, name: "neighbouring tests", command })
  }
  return rungs
}
