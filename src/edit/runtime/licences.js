// The licence gate (SKILLS_AND_OPEN_SOURCE §2, ET-LIC-01), per item: every package,
// runtime artifact, Python package, pack weight and bundled file has a licence in the
// table, or nothing ships. Checked in the test suite against the lockfile, the Studio
// bundle's metafile and the runtime manifest, and again when a runtime or a pack is
// installed. Remotion (EDD-08) and GSAP (EDD-09) are refused by name, wherever they appear.

/** Allowed outright, with notices. */
export const ALLOWED = ["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "Unlicense", "CC0-1.0", "0BSD", "BlueOak-1.0.0", "Python-2.0"]
/** Allowed only where the table says. */
export const CONDITIONAL = {
  "OFL-1.1": "fonts only",
  "MPL-2.0": "unmodified, as a dependency",
  "LGPL-2.1-or-later": "a separate process or library (FFmpeg, EQ-02)",
  "LGPL-3.0-or-later": "a separate process or library",
}
/** The owner's alpha exception (2026-11-07, EQ-15): the Media Runtime only, pending counsel. */
export const RUNTIME_ONLY = ["PSF-2.0", "CNRI-Python", "Zlib"]
/** Never, whatever the item. */
export const REFUSED_LICENCES = /\b(CC-BY-NC|PolyForm-Noncommercial|AGPL|GPL-[23]\.0(?!-or-later.*LGPL)|SSPL|BUSL|Commons-Clause)\b/i
/** Refused by owner decision, by name. */
export const REFUSED_NAMES = /(^|[/@])(remotion|gsap)([/@-]|$)/i

// SPDX ids start with a capital or a digit (0BSD); lower-case words are prose; the word after WITH is an exception, not a licence
function ids(text) {
  const out = []
  const words = text.replace(/[()]/g, " ").split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "WITH") i++
    else if (!/^(AND|OR)$/.test(words[i]) && /^[A-Z0-9][A-Za-z0-9.+-]*$/.test(words[i])) out.push(words[i])
  }
  return out
}

/**
 * Whether a licence expression may ship `where`: "client" (the npm release and
 * the Studio), "runtime" (Media Runtime artifacts and Python packages) or "weight".
 * SPDX ids decide; a choice (OR) passes when one side does; prose after the ids
 * ("and third-party notices") is a note, not a licence.
 * @returns {{ ok: boolean, why: string }}
 */
export function licenceVerdict(expression, where = "client") {
  const text = String(expression ?? "").trim()
  if (!text) return { ok: false, why: "no licence is recorded, which means all rights reserved" }
  const fits = (id) => ALLOWED.includes(id) || id in CONDITIONAL || (where === "runtime" && RUNTIME_ONLY.includes(id))
  const sides = text.split(/\s+OR\s+/).map((side) => ({ side, ids: ids(side) }))
  const good = sides.find(({ side, ids: list }) => list.length && !REFUSED_LICENCES.test(side) && list.every(fits))
  if (good) return { ok: true, why: good.ids.filter((id) => id in CONDITIONAL).map((id) => `${id}: ${CONDITIONAL[id]}`).join("; ") }
  if (sides.every(({ ids: list }) => !list.length)) return { ok: false, why: `"${text}" names no licence the table knows` }
  if (REFUSED_LICENCES.test(text)) return { ok: false, why: `${text} is outside the licence table` }
  const unfit = [...new Set(sides.flatMap(({ ids: list }) => list.filter((id) => !fits(id))))]
  return { ok: false, why: `${unfit.join(", ")} isn't allowed for the ${where}` }
}

/**
 * Every licence in a runtime manifest: artifacts, Python packages and pack weights.
 * @returns {{ item: string, problem: string }[]}
 */
export function manifestLicenceProblems(data) {
  const problems = []
  const check = (item, licence, where) => {
    if (REFUSED_NAMES.test(item)) problems.push({ item, problem: "refused by the owner (Remotion, EDD-08; GSAP, EDD-09)" })
    const verdict = licenceVerdict(licence, where)
    if (!verdict.ok) problems.push({ item, problem: verdict.why })
  }
  for (const [platform, spec] of Object.entries(data?.platforms ?? {})) {
    for (const artifact of spec.artifacts ?? []) check(`${platform}/${artifact.id}`, artifact.licence, "runtime")
    for (const pkg of spec.python?.packages ?? []) check(`${platform}/python/${pkg.name}`, pkg.licence, "runtime")
    for (const [pack, offered] of Object.entries(spec.packs ?? {})) for (const artifact of offered.artifacts ?? []) check(`${platform}/${pack}/${artifact.id}`, artifact.licence, "weight")
  }
  return problems
}

/**
 * The npm side: refused names anywhere in the lockfile (dev tools included), and the
 * Studio bundle taking in nothing but its own code (esbuild's metafile).
 * @param {{ lock: object, metafile?: { inputs: Record<string, unknown> }, sources?: { file: string, text: string }[] }} input
 * @returns {{ item: string, problem: string }[]}
 */
export function bundleLicenceProblems({ lock, metafile, sources = [] }) {
  const problems = []
  for (const path of Object.keys(lock?.packages ?? {})) {
    const name = path.replace(/^.*node_modules\//, "")
    if (name && REFUSED_NAMES.test(name)) problems.push({ item: name, problem: "refused by the owner (Remotion, EDD-08; GSAP, EDD-09)" })
  }
  for (const input of Object.keys(metafile?.inputs ?? {})) if (!/(^|\/)studio\/src\//.test(input)) problems.push({ item: input, problem: "the Studio bundle took in code from outside studio/src, with no licence recorded" })
  for (const { file, text } of sources) if (/\b(?:from|import\(|require\()\s*["'](?:@?remotion|gsap)(?:["'/])/.test(text)) problems.push({ item: file, problem: "imports Remotion or GSAP" })
  return problems
}
