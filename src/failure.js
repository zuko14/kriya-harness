// Kriya loop v2 (docs/kriya-harness/KRIYA_LOOP_V2.md in the Kriya
// repository): a failed check's output, classified by code and cut to its
// signal. The class is a fixed list matched by patterns, never a model's
// opinion; the excerpt keeps the lines that name the failure (and one line
// around each) instead of only the tail.

// Most specific first: a timeout hides everything after it, a missing tool
// isn't the code's fault, and code that doesn't parse can't fail a test
export const CLASSES = [
  ["environment", [/command not found/i, /\bENOENT\b/, /\bEACCES\b/, /\bECONNREFUSED\b/, /npm (ERR!|error) missing script/i, /No module named /, /Cannot find package /]],
  [
    "syntax",
    [/\bSyntaxError\b/, /\bIndentationError\b/, /\berror TS1\d{3}\b/, /\bsyntax error\b/i, /\bParseError\b/, /Unexpected token/, /error: expected /, /error\[E0(?:0|1)\d\d\]/],
  ],
  ["type", [/\berror TS[2-9]\d{3}\b/, /\bTypeError\b/, /mismatched types/, /error\[E0308\]/, /cannot use .+ as .+ value/, /incompatible type/i, /\bNameError\b/, /\bReferenceError\b/]],
  [
    "assertion",
    [/\bAssertionError\b/, /\bassert(ion)?\b.*fail/i, /^not ok \d+/m, /^--- FAIL/m, /^\s*E\s+assert /m, /\bExpected\b.*\b(Received|but got|to (be|equal))\b/i, /^\s*(✗|✕|×|FAIL)\s/m, /\b\d+ (failed|failing)\b/],
  ],
]

// The order a fix can move through: lower is further from passing
export const RANK = { timeout: 0, environment: 0, syntax: 1, type: 2, unknown: 2, assertion: 3, "tests changed": 3, silenced: 3, "invariant broken": 3, acceptance: 3, "no reproduction": 3, "invariant violated": 3, "regression hazard": 3, "no negative test": 3, "premortem open": 3, pass: 4 }

const EXCERPT = 2500

/**
 * @param {{ output?: string, exitCode?: number | null, timedOut?: boolean }} run
 * @returns {{ kind: string, excerpt: string }}
 */
export function classify({ output = "", exitCode, timedOut } = {}) {
  const kind = timedOut ? "timeout" : exitCode === 127 || exitCode === 126 ? "environment" : (CLASSES.find(([, res]) => res.some((re) => re.test(output)))?.[0] ?? "unknown")
  return { kind, excerpt: excerpt(output) }
}

const ANY = CLASSES.flatMap(([, res]) => res)
// Locations (file:line) are signal too: they say where to look
const LOCATION = /[\w./-]+\.\w+:\d+/
const LIBRARY = /node_modules|node:internal|site-packages/

/** The lines that name a failure, with one line of context each, in order and deduplicated. */
export function excerpt(output, limit = EXCERPT) {
  const lines = output.split("\n")
  const keep = new Set()
  lines.forEach((line, i) => {
    if (ANY.some((re) => re.test(line)) || (LOCATION.test(line) && !LIBRARY.test(line))) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j)
  })
  // Nothing recognisable: the end, where test runners report
  if (!keep.size) return output.length <= limit ? output : `… (${output.length - limit} earlier characters left out)\n${output.slice(-limit)}`
  const picked = []
  let last = -2
  const seen = new Set()
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i].trimEnd()
    if (seen.has(line) && line) continue
    seen.add(line)
    if (i !== last + 1 && picked.length) picked.push("…")
    picked.push(line)
    last = i
  }
  const text = picked.join("\n")
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (cut)`
}

/** What a repeated failure is recognised by: the command, the class and its first named line, without numbers that change between runs. */
export function signature(command, { kind, excerpt: text }) {
  const first = text.split("\n").find((line) => ANY.some((re) => re.test(line))) ?? ""
  return `${command}\0${kind}\0${first.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160)}`
}
