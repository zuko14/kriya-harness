import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { signature } from "./failure.js"
import { kriyaHome } from "./paths.js"
import { projectRoot } from "./skill-switches.js"

// Kriya loop v2, R_{n+1} = R_n ⊕ rule(fail) (KRIYA_LOOP_V2.md): the same
// failure (command, class, first named line) seen twice becomes a proposed
// rule. Code writes the proposal from a fixed template; it reaches the
// agent only after the person confirms it (`kriya rules confirm`), and may
// be reworded then. Kept in ~/.kriya/rules/, never in the project, so the
// agent can't write a "confirmed" rule with its file tools and Read only
// stays read-only.

export const SEEN_TWICE = 2
const KEEP_SEEN = 200
const RULE = 300
export const PROMPT_LIMIT = 2000

export class RulesError extends Error {}

const fileFor = (root) => join(kriyaHome(), "rules", `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`)

function load(root) {
  try {
    const value = JSON.parse(readFileSync(fileFor(root), "utf8"))
    if (value && Array.isArray(value.proposed) && Array.isArray(value.confirmed)) return { seen: {}, dismissed: [], ...value }
  } catch {
    // None yet
  }
  return { version: 1, root, seen: {}, proposed: [], confirmed: [], dismissed: [] }
}

function store(root, value) {
  const file = fileFor(root)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

const ADVICE = {
  syntax: "Code in this project has failed to parse; re-read each edited file for syntax before finishing a step.",
  type: "Check types, names and call signatures against their definitions before finishing a step.",
  assertion: "Read the failing test's expectation before changing code, and fix the code, not the test.",
  "tests changed": "Never change existing tests or the check's configuration to make the check pass; fix the code.",
  environment: "The check needs something the machine lacks; stop and tell the person instead of retrying.",
  timeout: "The check has timed out; keep changes small and look for loops that never end.",
  unknown: "Read the check's whole output before changing code.",
}

/** The proposed rule's text: a fixed sentence for the class, and the evidence */
export function ruleText(command, failure) {
  const line = signature(command, failure).split("\0")[2]
  return `${ADVICE[failure.kind] ?? ADVICE.unknown} (\`${command}\` failed twice this way${line ? `: ${line}` : ""})`.slice(0, RULE)
}

/**
 * Notes one failed check. On the SEEN_TWICE-th time a signature is seen, a
 * rule is proposed, once (not again after it's confirmed or dismissed).
 * @returns {undefined | { text: string }} the new proposal, if this made one
 */
export function noteFailure(root, command, failure, now = () => new Date()) {
  const value = load(root)
  const sig = signature(command, failure)
  const count = (value.seen[sig]?.count ?? 0) + 1
  value.seen[sig] = { count, at: now().toISOString() }
  const entries = Object.entries(value.seen)
  if (entries.length > KEEP_SEEN) value.seen = Object.fromEntries(entries.sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, KEEP_SEEN))
  const known = [...value.proposed, ...value.confirmed].some((r) => r.sig === sig) || value.dismissed.includes(sig)
  let made
  if (count >= SEEN_TWICE && !known) {
    made = { sig, kind: failure.kind, text: ruleText(command, failure), at: now().toISOString() }
    value.proposed.push(made)
  }
  store(root, value)
  return made && { text: made.text }
}

/** The project's proposed and confirmed rules */
export function listRules(cwd) {
  const { proposed, confirmed } = load(projectRoot(cwd))
  return { proposed: proposed.map((r) => r.text), confirmed: confirmed.map((r) => r.text) }
}

function pick(value, n) {
  const at = Number(n) - 1
  if (!Number.isInteger(at) || at < 0 || at >= value.proposed.length) throw new RulesError(`There's no proposed rule ${n}; kriya rules lists them.`)
  return at
}

/** The person confirms proposal n (CLI only; no tool calls this), optionally in their own words */
export function confirmRule(cwd, n, text, now = () => new Date()) {
  const root = projectRoot(cwd)
  const value = load(root)
  const at = pick(value, n)
  const [rule] = value.proposed.splice(at, 1)
  const words = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : ""
  if (words.length > RULE) throw new RulesError(`A rule is at most ${RULE} characters.`)
  value.confirmed.push({ ...rule, text: words || rule.text, confirmedAt: now().toISOString() })
  store(root, value)
  return words || rule.text
}

/** The person dismisses proposal n: that failure is never proposed again */
export function dismissRule(cwd, n) {
  const root = projectRoot(cwd)
  const value = load(root)
  const [rule] = value.proposed.splice(pick(value, n), 1)
  value.dismissed.push(rule.sig)
  store(root, value)
  return rule.text
}

/** The person removes confirmed rule n */
export function forgetRule(cwd, n) {
  const root = projectRoot(cwd)
  const value = load(root)
  const at = Number(n) - 1
  if (!Number.isInteger(at) || at < 0 || at >= value.confirmed.length) throw new RulesError(`There's no confirmed rule ${n}; kriya rules lists them.`)
  const [rule] = value.confirmed.splice(at, 1)
  value.dismissed.push(rule.sig)
  store(root, value)
  return rule.text
}

/** The confirmed rules as prompt lines, newest kept when they don't all fit */
export function confirmedRules(cwd) {
  const lines = []
  let size = 0
  for (const { text } of load(projectRoot(cwd)).confirmed.toReversed()) {
    if (size + text.length > PROMPT_LIMIT) break
    lines.unshift(`- ${text}`)
    size += text.length
  }
  return lines
}
