import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CONTRACTS_DIR } from "./contracts.js"

// Harness 2.0 W14 (WD-18): Explore (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// THREE_D_AND_CREATIVE.md §5). A creative step marked `explore: 2 | 3` builds
// that many takes one after another in the same folder (a builder can't get
// its own directory), each from the step's starting files and each in a
// different direction chosen here, by code, so diversity isn't left to
// sampling. Only gates decide pass; the person (or, with no UI, the critic)
// picks among passing takes. Pure helpers; src/loop.js runs the takes.

export const EXPLORE_ROLES = Object.freeze(["frontend", "designer", "graphics"])
export const MIN_TAKES = 2
export const MAX_TAKES = 3
export const RELOAD_MS = 20_000

/** THREE_D_AND_CREATIVE §3's lighting recipes, in table order (graphics). */
export const SCENE_DIRECTIONS = Object.freeze([
  ["studio-product", "Studio product: an HDR studio environment with a soft key and a rim light, a contact shadow, filmic tone mapping (AgX or ACES)."],
  ["daylight-exterior", "Daylight exterior: a sky environment and one directional sun with a single shadow, filmic tone mapping."],
  ["night-neon", "Night and neon: a dark environment, emissive materials, restrained bloom, neutral tone mapping."],
  ["soft-clay", "Soft clay, illustrative: an ambient environment and one soft key, no hard shadows, neutral tone mapping."],
  ["data-abstract", "Data and abstract: unlit or minimal light, instanced points and lines, no or neutral tone mapping."],
])
/** Visual directions for interface steps (frontend, designer), in table order. */
export const UI_DIRECTIONS = Object.freeze([
  ["editorial", "Editorial: generous whitespace, one strong typeface in two weights, restrained colour, content first."],
  ["precise", "Dense and precise: compact spacing on a strict grid, tabular figures, quiet colour, information first."],
  ["warm", "Warm and soft: rounded shapes, gentle tinted surfaces, friendly copy, generous touch targets."],
  ["bold", "Bold: high contrast, large display type, one confident accent colour, strong hierarchy."],
])

const readJson = (root, file) => {
  try {
    return JSON.parse(readFileSync(join(root, CONTRACTS_DIR, file), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * The takes' direction hints, by code: the first is the contract's own
 * direction (scene_direction.json `lighting` for graphics, design_tokens.json
 * `direction` for interface steps), the others its two neighbours in the table.
 * @returns {Array<{ id: string, text: string }>}
 */
export function directionHints(role, takes, root) {
  const table = role === "graphics" ? SCENE_DIRECTIONS : UI_DIRECTIONS
  const named = role === "graphics" ? readJson(root, "scene_direction.json")?.lighting : readJson(root, "design_tokens.json")?.direction
  const at = Math.max(0, table.findIndex(([id]) => id === named))
  const order = [at, (at + 1) % table.length, (at - 1 + table.length) % table.length]
  return order.slice(0, takes).map((i) => ({ id: table[i][0], text: table[i][1] }))
}

/** The section a take's builder gets after its normal prompt. */
export const takeSection = (take, of, hint) =>
  [
    `## This is take ${take} of ${of}`,
    "",
    `The person will compare ${of} takes of this step side by side and keep one. Build the whole step, fully working, in this direction:`,
    "",
    hint.text,
    "",
    "Commit to it: a half-way take loses the comparison. The checks still decide pass or fail; the direction never excuses a failing check.",
  ].join("\n")

/** What a served route looks like now: its ETag or Last-Modified, else a hash of its body. */
export async function fingerprint(url, fetchImpl = fetch) {
  const r = await fetchImpl(url, { cache: "no-store", redirect: "manual" })
  const tag = r.headers.get("etag") ?? r.headers.get("last-modified")
  return tag ? `h:${tag}` : `b:${createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex")}`
}

/**
 * Waits until the dev server serves something other than `before` (its file
 * watcher reloaded the take), up to RELOAD_MS.
 * shortcut: fingerprints the route itself, not its main module; upgrade if a dev server serves an unchanged HTML shell for changed modules.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function waitForReload(url, before, { timeoutMs = RELOAD_MS, everyMs = 250, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = now() + timeoutMs
  for (;;) {
    try {
      if ((await fingerprint(url, fetchImpl)) !== before) return { ok: true }
    } catch {
      // Reloading: try again
    }
    if (now() >= until) return { ok: false, reason: "dev server didn't reload" }
    await sleep(everyMs)
  }
}

/** The person's choice among passing takes: one option per take, in take order. */
export const takeQuestion = (survivors, stepTitle) => ({
  id: "kriya-explore",
  header: "Explore",
  question: `Which take of "${stepTitle}" do you want to keep?`,
  detail: "Every take shown passed the project's check and its gates. The others stay in kriya undo --list.",
  options: survivors.map((t) => ({ label: `Take ${t.v}`, description: t.hint.text })),
})
