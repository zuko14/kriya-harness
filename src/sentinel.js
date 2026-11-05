// The defensive engine's code half (KRIYA_DEFENSIVE=on, `--defensive`;
// KRIYA_DEFENSIVE_ENGINE_REPORT.md in the Kriya repository). Everything here
// is a fixed rule over a diff, with no model: a model reviewing its own work
// is the weakest check there is (R-63), so a finding is a line in a file a
// person can read. shortcut: rules read source lines, not a syntax tree, so
// they miss what's split across lines; a parser is a dependency worth adding
// only if real runs show the misses matter.

const COMMENT = /^\s*(\/\/|#|\*|\/\*)/
const TEST = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.py$/
const CODE = /\.(m?[jt]sx?|cjs|py)$/
export const isTest = (rel) => TEST.test(rel)

/** Lines of `after` that `before` doesn't have, as many times as they're new, with their numbers */
export function addedLines(before, after) {
  const left = new Map()
  for (const line of String(before ?? "").split("\n")) left.set(line, (left.get(line) ?? 0) + 1)
  const out = []
  String(after ?? "").split("\n").forEach((text, i) => {
    const n = left.get(text) ?? 0
    if (n > 0) left.set(text, n - 1)
    else if (text.trim()) out.push({ line: i + 1, text })
  })
  return out
}

const SERVER = /(^|\/)(app\/api|pages\/api|actions|routes|controllers|handlers|server|api)\//
const UI = /(^|\/)components\/|\.tsx$|\.jsx$/
const DATA_PATH = /(^|\/)(actions|queries|app)\//
const MONEY = /\b\w*(amount|price|paise|rupee|inr|usd|cost|fee|tax|gst|charge|balance|total|salary)\w*\b/i
// Not toFixed: replayed on real commits it was only ever display
const FLOAT_MATH = /\bparseFloat\(|\bfloat\(|[*/]\s*\d+\.\d+|\b\d+\.\d+\s*\*/
const IDENTITY = "userId|user_id|ownerId|owner_id|tenantId|tenant_id|role|isAdmin|is_admin|plan|price"
const UNTRUSTED = "body|json\\(\\)|searchParams|formData|query|params|headers"

const RULES = [
  {
    rule: "tenant isolation",
    applies: (rel, facts) => facts.tenancy && DATA_PATH.test(rel),
    match: /\bprivileged\(|\bdb\.(select|insert|update|delete|execute)\(/,
    why: "runs outside withUser, so Row Level Security doesn't apply; go through withUser(userId, …)",
  },
  {
    rule: "sql injection",
    applies: () => true,
    match: /\.(query|execute|raw|unsafe)\(\s*`[^`]*\$\{|\.(query|execute|raw|unsafe)\(\s*["'][^"']*["']\s*\+|\.(execute|query)\(\s*f["']/,
    why: "builds SQL from a string; bind the value as a parameter",
  },
  {
    rule: "financial precision",
    applies: (rel) => !UI.test(rel),
    match: (text) => MONEY.test(text) && FLOAT_MATH.test(text),
    why: "does money math in floats; keep integers (paise, micros) and use the project's money helpers",
  },
  {
    rule: "session identity",
    applies: (rel) => SERVER.test(rel),
    match: new RegExp(`\\b(${IDENTITY})\\b[^=\\n]*=[^=>][^;\\n]*\\b(${UNTRUSTED})\\b|\\{[^}]*\\b(${IDENTITY})\\b[^}]*\\}\\s*=\\s*(await\\s+)?[\\w.]*\\b(${UNTRUSTED})`),
    why: "takes identity or price from the request; derive it from the session on the server",
  },
  {
    rule: "secret in code",
    applies: () => true,
    match: /\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\bghp_[A-Za-z0-9]{30,}/,
    why: "puts a secret in source; read it from the environment",
  },
]

/**
 * The invariant sentinel: added source lines against the rules.
 * @param {{ rel: string, before: string | null, after: string | null }[]} diffs
 * @param {{ tenancy?: boolean }} facts tenancy: the project scopes data through withUser
 * @returns {{ file: string, line: number, rule: string, why: string }[]}
 */
export function sentinel(diffs, facts = {}) {
  const found = []
  for (const { rel, before, after } of diffs) {
    if (after === null || isTest(rel) || !CODE.test(rel)) continue
    for (const { line, text } of addedLines(before, after)) {
      if (COMMENT.test(text)) continue
      for (const r of RULES) {
        if (!r.applies(rel, facts)) continue
        if (typeof r.match === "function" ? r.match(text) : r.match.test(text)) found.push({ file: rel, line, rule: r.rule, why: r.why })
      }
    }
  }
  return found
}

function splitParams(text) {
  const out = []
  let depth = 0
  let part = ""
  for (const ch of text) {
    if ("([{<".includes(ch)) depth++
    if (")]}>".includes(ch)) depth--
    if (ch === "," && depth === 0) (out.push(part.trim()), (part = ""))
    else part += ch
  }
  if (part.trim()) out.push(part.trim())
  return out
}

const param = (text) => {
  const [head, value] = text.split(/=(?!>)/, 2).map((t) => t.trim())
  const name = head.replace(/^\.\.\./, "").replace(/[?:].*$/, "").trim()
  return { name, required: value === undefined && !/\?\s*:/.test(head) && !head.startsWith("..."), default: value }
}

const FUNCTION = /^\s*export\s+(?:default\s+)?(async\s+)?function\s*\*?\s*([\w$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)|^\s*export\s+const\s+([\w$]+)\s*(?::[^=]+)?=\s*(async\s+)?\(([^)]*)\)\s*(?::[^=]+)?=>|^\s*(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm

/** A file's exported functions: name → whether async, and their parameters */
export function exportedFunctions(text) {
  const out = new Map()
  for (const m of String(text ?? "").matchAll(FUNCTION)) {
    const name = m[2] ?? m[4] ?? m[8]
    if (name.startsWith("_")) continue
    out.set(name, { async: Boolean(m[1] ?? m[5] ?? m[7]), params: splitParams(m[3] ?? m[6] ?? m[9] ?? "").map(param).filter((p) => p.name && p.name !== "self") })
  }
  return out
}
const REEXPORT = /^\s*export\s*\{([^}]*)\}/gm
const reexported = (text, name) => [...String(text ?? "").matchAll(REEXPORT)].some(([, list]) => list.split(",").some((n) => n.trim().split(/\s+as\s+/).at(-1) === name))

const calls = (text, name) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`).test(text)
const names = (text, name) => new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(text)

const GENERATED = /(\.bundle\.|\.min\.|(^|\/)dist\/)/

/** `const x = call()` with x awaited later is deliberate: the work starts now, and is waited for */
function heldForLater(text, file) {
  const held = /(?:const|let|var)\s+([\w$]+)\s*=/.exec(text)?.[1]
  return Boolean(held) && new RegExp(`\\bawait\\s+${held}\\b|\\b${held}\\.(then|catch|finally)\\(|Promise\\.\\w+\\([^)]*\\b${held}\\b`).test(file)
}

/**
 * The adversarial diff review: what this change does to code it didn't touch.
 * A hazard is unhandled only while a caller outside the change still relies on
 * the old shape: a change that updates its callers is handled.
 * @returns {{ file: string, line?: number, hazard: string, why: string }[]}
 */
export function reviewDiff(graph, diffs) {
  const found = []
  const changed = new Set(diffs.map((d) => d.rel))
  const outside = (rel) => [...(graph.importedBy.get(rel) ?? [])].filter((by) => !changed.has(by) && !isTest(by))
  for (const { rel, before, after } of diffs) {
    if (isTest(rel) || !CODE.test(rel) || GENERATED.test(rel)) continue
    const was = exportedFunctions(before)
    const now = exportedFunctions(after)
    for (const [name, old] of was) {
      const users = outside(rel).filter((by) => names(graph.text(by), name))
      if (!users.length) continue
      const next = now.get(name)
      if (!next) {
        if (!reexported(after, name) && !new RegExp(`\\b${name}\\b`).test(String(after ?? ""))) found.push({ file: rel, hazard: "removed export", why: `${name} is gone but ${users[0]} still uses it` })
        continue
      }
      const callers = users.filter((by) => calls(graph.text(by), name))
      if (!callers.length) continue
      const required = (f) => f.params.filter((p) => p.required).length
      if (required(next) > required(old)) found.push({ file: rel, hazard: "broken signature", why: `${name} now needs ${required(next)} arguments; ${callers[0]} still passes the old ones` })
      else if (next.params.length < old.params.length) found.push({ file: rel, hazard: "broken signature", why: `${name} lost a parameter; ${callers[0]} still calls it` })
      else if (!old.async && next.async) {
        const blind = callers.find((by) => graph.text(by).split("\n").some((line) => calls(line, name) && !/\b(await|return)\b|\.then\(/.test(line)))
        if (blind) found.push({ file: rel, hazard: "now async", why: `${name} now returns a promise; ${blind} isn't changed to await it` })
      }
      for (const p of old.params) {
        const q = next.params.find((x) => x.name === p.name)
        if (q && p.default !== undefined && q.default !== undefined && p.default !== q.default) found.push({ file: rel, hazard: "altered default", why: `${name}'s ${p.name} default went from ${p.default} to ${q.default}; ${callers[0]} relies on it` })
      }
    }
    if (after === null) continue
    // What this file can call that returns a promise: its own, and what it imports
    const pending = new Set([...now, ...[...String(after).matchAll(/\basync\s+function\s+([\w$]+)|(?:const|let)\s+([\w$]+)\s*=\s*async\b/g)].map((m) => [m[1] ?? m[2], { async: true }])].filter(([, f]) => f.async).map(([n]) => n))
    for (const dep of graph.importsOf.get(rel) ?? []) for (const [n, f] of exportedFunctions(graph.text(dep))) if (f.async && names(after, n)) pending.add(n)
    const added = addedLines(before, after)
    const lines = String(after).split("\n")
    // A call ending in a comma is an element of something, usually Promise.all
    const element = (text) => /,\s*$/.test(text)
    for (const { line, text } of added) {
      if (COMMENT.test(text)) continue
      for (const n of pending) {
        const floating = new RegExp(`^\\s*${n.replace(/\$/g, "\\$")}\\s*\\(|=\\s*${n.replace(/\$/g, "\\$")}\\s*\\(`).test(text)
        if (floating && !element(text) && !/=>\s*$/.test(lines[line - 2] ?? "") && !heldForLater(text, after) && !/\b(await|return|void|yield)\b|\.then\(|\.catch\(|Promise\.(all|race|allSettled)|=>\s*$/.test(text) && !/^\s*(async\s+)?(function|def)\b|^\s*export\b/.test(text)) found.push({ file: rel, line, hazard: "missing await", why: `${n}() returns a promise and nothing waits for it` })
      }
      if (/\.forEach\(\s*async\b/.test(text)) found.push({ file: rel, line, hazard: "race", why: "forEach doesn't wait for async callbacks, so these run unordered and errors are lost; use for…of or Promise.all" })
      if (/\.map\(\s*async\b/.test(text) && !/Promise\.(all|allSettled)/.test(lines.slice(Math.max(0, line - 4), line).join(" "))) found.push({ file: rel, line, hazard: "race", why: "these promises are never awaited together; wrap in Promise.all" })
    }
    for (const { text } of addedLines(after, before)) {
      const m = /\bawait\s+([\w$.]+)\s*\(/.exec(text)
      // The same line with only the await gone
      if (m && added.some((a) => a.text === text.replace(/\bawait\s+/, ""))) found.push({ file: rel, hazard: "missing await", why: `the change dropped the await on ${m[1]}()` })
    }
  }
  return found
}

// A file that adds a way in from outside
const NEW_API = /(^|\/)(app\/api\/.+\/route\.[jt]sx?|pages\/api\/.+\.[jt]sx?|routes\/.+\.[jt]sx?)$|(^|\/)actions\/[^/]+\.[jt]sx?$/
const BOUNDARY = /\b(toThrow|rejects|assert\.(throws|rejects)|pytest\.raises|assertRaises|ValueError|TypeError|RangeError)\b|\b(40[0-9]|41[0-9]|42[0-9])\b|\b(null|undefined|None|NaN|Infinity)\b|\b(empty|invalid|missing|malformed|unauthori[sz]ed|forbidden|boundary|negative|overflow|too (long|large|big)|zero)\b|\(\s*(""|''|\[\]|\{\})\s*[,)]/i

/** Whether this change adds something a caller can reach: a route, an action, or a new exported function */
export function newSurface(diffs) {
  const out = []
  for (const { rel, before, after } of diffs) {
    if (after === null || isTest(rel) || !CODE.test(rel)) continue
    if (before === null && NEW_API.test(rel)) out.push(rel)
    else {
      const was = exportedFunctions(before)
      if ([...exportedFunctions(after).keys()].some((n) => !was.has(n))) out.push(rel)
    }
  }
  return out
}

/** Whether this change's test lines try a bad input: an error, an empty value, a boundary */
export function hasBoundaryTest(diffs) {
  return diffs.some(({ rel, before, after }) => isTest(rel) && addedLines(before, after).some(({ text }) => !COMMENT.test(text) && BOUNDARY.test(text)))
}

const BLANK = /^(none|n\/?a|tbd|todo|nothing|no|unknown|-+)\.?$/i
const MIN_TEXT = 12
const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 300) : "")
const said = (value) => clean(value).length >= MIN_TEXT && !BLANK.test(clean(value))
export const MIN_FAILURES = 2

/**
 * The pre-mortem a plan must carry: how this could fail and what will prove it
 * doesn't, what else shares this surface, and which bad inputs were thought
 * through. `covered_by` turns a hypothesis into an obligation: the file must
 * exist before the plan can read verified. Code can't judge the thinking, so
 * it refuses blanks and makes each claim cost a test.
 * @returns {{ premortem?: object, problem?: string }}
 */
export function checkPremortem(input, steps) {
  if (!input && steps < 2) return {}
  const name = (what) => ({ problem: `This plan needs a pre-mortem before anything is built: premortem.${what}.` })
  const failures = (Array.isArray(input?.failures) ? input.failures : []).filter((f) => said(f?.what)).map((f) => ({ what: clean(f.what), coveredBy: clean(f.covered_by ?? f.coveredBy) }))
  const distinct = new Set(failures.map((f) => f.what.toLowerCase()))
  if (distinct.size < MIN_FAILURES) return name(`failures: at least ${MIN_FAILURES} different ways this could crash or misbehave, each with covered_by, the test file that will prove it can't`)
  const open = failures.find((f) => !f.coveredBy)
  if (open) return name(`failures: "${open.what}" needs covered_by, the test file that will prove it can't happen`)
  const radius = (Array.isArray(input?.blast_radius) ? input.blast_radius : []).filter(said).map(clean)
  if (!radius.length) return name("blast_radius: the other features, tables or routes that share this surface")
  const negatives = (Array.isArray(input?.negatives) ? input.negatives : []).filter(said).map(clean)
  if (!negatives.length) return name("negatives: the bad inputs to handle (nulls, empty states, boundary values, timeouts)")
  return { premortem: { failures: failures.slice(0, 6), blastRadius: radius.slice(0, 12), negatives: negatives.slice(0, 12) } }
}
