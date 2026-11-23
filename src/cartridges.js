import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { call, deviceFromEnv } from "./api.js"
import { rankSkills } from "./intent.js"
import { PACKAGE_ROOT } from "./paths.js"

// Harness 2.0 role cartridges (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// CARTRIDGES.md, W1): one discipline's guidance per builder, mounted first in
// its prompt. Kriya serves them (GET /skills, items with a `cartridge` block,
// only with harness.workforce on); this module picks one for a plan step, by
// code, and fetches its text. Off unless kriya was started with --cartridges
// (KRIYA_CARTRIDGES=on): off, nothing here is called.

/** The role ids Kriya's contract allows (contract/contract.json, copied from Kriya). */
export const ROLES = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "contract", "contract.json"), "utf8")).cartridgeIds?.roles ?? []
  } catch {
    return []
  }
})()

/** A simple glob (`*`, `**`, literal names) as a regex over a forward-slash path. */
export function globRegex(glob) {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more folders; a trailing `**` matches the rest
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?"
        i += 2
      } else {
        out += ".*"
        i += 1
      }
    } else if (c === "*") out += "[^/]*"
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

/**
 * The cartridge for one plan step, deterministic: the role the plan named (if
 * Kriya serves it), else the role whose globs match most of the step's files
 * (ties: more gates, then the name), else the best BM25 match of the step's
 * title and done-when over the roles' descriptions; undefined when nothing fits.
 * @param {{ title: string, doneWhen: string, files: string[], role?: string }} step
 * @param {Array<{ id: string, description: string, cartridge: { role: string, gates: string[], globs: string[] } }>} cartridges
 */
export function selectCartridge(step, cartridges) {
  if (!cartridges.length) return undefined
  if (step.role) {
    const named = cartridges.find((c) => c.cartridge.role === step.role)
    if (named) return named
  }
  const files = (step.files ?? []).map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))
  if (files.length) {
    const scored = cartridges
      .map((c) => {
        const res = c.cartridge.globs.map(globRegex)
        return { c, hits: files.filter((f) => res.some((re) => re.test(f))).length }
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.c.cartridge.gates.length - a.c.cartridge.gates.length || a.c.id.localeCompare(b.c.id))
    if (scored.length) return scored[0].c
  }
  const [best] = rankSkills(`${step.title} ${step.doneWhen}`, cartridges.map((c) => ({ name: c.id, description: c.description })))
  return best ? cartridges.find((c) => c.id === best.name) : undefined
}

/** The first lines of a builder's prompt with a cartridge: stable text only, so the cached prefix holds across builders of one role. */
export function cartridgeSection(name, body) {
  return [`Your role for this step: ${name}. Work as the best engineer in this discipline would, following this guidance.`, "", body.trim(), "", "---", ""]
}

/**
 * KriyaBench's candidate arm (Kriya-Tavi upgrade_2.0/SELF_EVOLUTION.md §3,
 * OR-20): with KRIYA_BENCH=on, which only the bench runner sets, the
 * candidate file's body replaces one cartridge's text. Without it the file
 * is never read. A file whose body doesn't match its sha256 is refused.
 */
export function benchCandidate(env = process.env) {
  if (env.KRIYA_BENCH !== "on" || !env.KRIYA_CARTRIDGE_FILE) return undefined
  const file = JSON.parse(readFileSync(env.KRIYA_CARTRIDGE_FILE, "utf8"))
  if (file?.kind !== "kriya-cartridge-candidate" || typeof file.body !== "string" || typeof file.cartridgeId !== "string")
    throw new Error("KRIYA_CARTRIDGE_FILE isn't a cartridge candidate.")
  if (createHash("sha256").update(file.body).digest("hex") !== file.sha256) throw new Error("The cartridge candidate doesn't match its sha256.")
  return { cartridgeId: file.cartridgeId, body: file.body.slice(0, 6000) }
}

/**
 * Kriya's served cartridges and their texts, fetched once per process
 * (a session's builders share them). Signed out or unreachable: none, and
 * builders get the prompt they get without cartridges.
 */
export function cartridgeSource({ device = deviceFromEnv, request = call, env = process.env } = {}) {
  let listed
  const bodies = new Map()
  const candidate = benchCandidate(env)
  return {
    async list() {
      if (listed) return listed
      const d = device()
      if (!d) return []
      try {
        const { skills } = await request(d.url, "GET", "/skills", { token: d.token })
        listed = (skills ?? []).filter((s) => s.cartridge && ROLES.includes(s.cartridge.role))
      } catch {
        return []
      }
      return listed
    },
    async body(c) {
      if (candidate && c.id === candidate.cartridgeId) return candidate.body
      const key = `${c.id}@${c.version}`
      if (bodies.has(key)) return bodies.get(key)
      const d = device()
      if (!d) return undefined
      try {
        const response = await request(d.url, "GET", `/skills/${c.id}/${c.version}`, { token: d.token, raw: true })
        if (!response.ok) return undefined
        const text = (await response.text()).slice(0, 6000)
        bodies.set(key, text)
        return text
      } catch {
        return undefined
      }
    },
  }
}
