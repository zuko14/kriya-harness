// Fonts that ship (TP7, CRAFT_UPGRADE §5.1, EDD-67): the Media Runtime's pack-fonts, each
// file pinned by hash in the signed manifest and licensed OFL-1.1 (checked per item, EQ-18).
// A composition names a font by id only (`url("kriya-font:<id>")`); the renderer puts the
// file in as data, so the same tile draws the same on every computer and in the Studio, and
// a computer without the pack keeps the system stacks, with a note, never a failed make.
// Script picks the font: each run of a line goes to a family that has it (EQ-17).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The fonts this client knows, by the manifest's artifact id. `family` is the CSS name
 * Kriya gives it; `scripts` what it is chosen for; `line` the line height its box needs; `system` the stack that stands in
 * when the pack isn't installed. Data only: no path, URL or price.
 */
export const FONTS = {
  "font-inter": { family: "Kriya Inter", role: "sans", scripts: ["latin"], line: 1.22, system: "'Helvetica Neue',Helvetica,Arial,sans-serif" },
  "font-oswald": { family: "Kriya Oswald", role: "condensed", scripts: ["latin"], line: 1.49, system: "'Avenir Next Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif" },
  "font-montserrat": { family: "Kriya Montserrat", role: "geometric", scripts: ["latin"], line: 1.22, system: "'Avenir Next',Futura,'Helvetica Neue',Arial,sans-serif" },
  "font-lora": { family: "Kriya Lora", role: "serif", scripts: ["latin"], line: 1.28, system: "Georgia,'Times New Roman',serif" },
  "font-jetbrains-mono": { family: "Kriya JetBrains Mono", role: "mono", scripts: ["latin"], line: 1.32, system: "'SF Mono',Menlo,Consolas,'Courier New',monospace" },
  "font-caveat": { family: "Kriya Caveat", role: "hand", scripts: ["latin"], line: 1.26, system: "'Bradley Hand','Segoe Print','Comic Sans MS',cursive" },
  "font-noto-sans-devanagari": { family: "Kriya Noto Sans Devanagari", role: "script", scripts: ["devanagari"], line: 1.31, system: "'Kohinoor Devanagari','Noto Sans Devanagari','Nirmala UI',sans-serif" },
  "font-noto-sans-telugu": { family: "Kriya Noto Sans Telugu", role: "script", scripts: ["telugu"], line: 1.36, system: "'Kohinoor Telugu','Noto Sans Telugu','Nirmala UI',sans-serif" },
  "font-noto-sans-tamil": { family: "Kriya Noto Sans Tamil", role: "script", scripts: ["tamil"], line: 1.24, system: "'Tamil Sangam MN','Noto Sans Tamil','Nirmala UI',sans-serif" },
  "font-noto-sans-kannada": { family: "Kriya Noto Sans Kannada", role: "script", scripts: ["kannada"], line: 1.35, system: "'Kannada Sangam MN','Noto Sans Kannada','Nirmala UI',sans-serif" },
  "font-noto-sans-malayalam": { family: "Kriya Noto Sans Malayalam", role: "script", scripts: ["malayalam"], line: 1.25, system: "'Malayalam Sangam MN','Noto Sans Malayalam','Nirmala UI',sans-serif" },
  "font-noto-sans-bengali": { family: "Kriya Noto Sans Bengali", role: "script", scripts: ["bengali"], line: 1.33, system: "'Kohinoor Bangla','Noto Sans Bengali','Nirmala UI',sans-serif" },
  "font-noto-sans-gujarati": { family: "Kriya Noto Sans Gujarati", role: "script", scripts: ["gujarati"], line: 1.31, system: "'Kohinoor Gujarati','Noto Sans Gujarati','Nirmala UI',sans-serif" },
  "font-noto-sans-gurmukhi": { family: "Kriya Noto Sans Gurmukhi", role: "script", scripts: ["gurmukhi"], line: 1.31, system: "'Gurmukhi MN','Noto Sans Gurmukhi','Nirmala UI',sans-serif" },
}

/** The OFL-1.1 notice of each font, for THIRD_PARTY_NOTICES and the licence test (ET-LIC-01). */
export const FONT_LICENCES = {
  "font-inter": "Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)",
  "font-oswald": "Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont)",
  "font-montserrat": "Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git)",
  "font-lora": "Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), with Reserved Font Name \"Lora\".",
  "font-jetbrains-mono": "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)",
  "font-caveat": "Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)",
  "font-noto-sans-devanagari": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari)",
  "font-noto-sans-telugu": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/telugu)",
  "font-noto-sans-tamil": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tamil)",
  "font-noto-sans-kannada": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/kannada)",
  "font-noto-sans-malayalam": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/malayalam)",
  "font-noto-sans-bengali": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/bengali)",
  "font-noto-sans-gujarati": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gujarati)",
  "font-noto-sans-gurmukhi": "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gurmukhi)",
}

export const FONT_PACK = "pack-fonts"

/** The scripts a font is shipped for, in the order a mixed line's chain tries them. */
export const SCRIPTS = ["latin", "devanagari", "telugu", "tamil", "kannada", "malayalam", "bengali", "gujarati", "gurmukhi"]
const SCRIPT_TEST = {
  latin: /\p{Script=Latin}/u,
  devanagari: /\p{Script=Devanagari}/u,
  telugu: /\p{Script=Telugu}/u,
  tamil: /\p{Script=Tamil}/u,
  kannada: /\p{Script=Kannada}/u,
  malayalam: /\p{Script=Malayalam}/u,
  bengali: /\p{Script=Bengali}/u,
  gujarati: /\p{Script=Gujarati}/u,
  gurmukhi: /\p{Script=Gurmukhi}/u,
}
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u
/** The shipped font for each Indic script. */
export const SCRIPT_FONTS = Object.fromEntries(Object.entries(FONTS).filter(([, f]) => f.role === "script").map(([id, f]) => [f.scripts[0], id]))

/** One character's script: a shipped one, "common" (spaces, digits, marks shared by all) or "other". */
export function scriptOfChar(char) {
  if (SHARED.test(char)) return "common"
  return SCRIPTS.find((script) => SCRIPT_TEST[script].test(char)) ?? "other"
}

/**
 * A line as runs of one script each; shared characters join the run they sit in.
 * @returns {{ script: string, text: string }[]}
 */
export function scriptRuns(text) {
  const runs = []
  let pending = ""
  for (const char of String(text)) {
    const script = scriptOfChar(char)
    if (script === "common") {
      if (runs.length) runs.at(-1).text += char
      else pending += char
    } else if (runs.at(-1)?.script === script) runs.at(-1).text += char
    else {
      runs.push({ script, text: pending + char })
      pending = ""
    }
  }
  if (pending) runs.push({ script: "common", text: pending })
  return runs
}

/** The scripts a text needs, beyond the shared characters. */
export const scriptsIn = (text) => [...new Set(scriptRuns(text).map((run) => run.script).filter((s) => s !== "common"))]

/**
 * The font ids a text needs with `primary` as its face: the face, then a shipped font for
 * each other script in it. A script with no shipped font ("other") adds none: the system
 * stack draws it, and the glyph check says so.
 */
export function fontsFor(text, primary) {
  const ids = [primary]
  for (const script of scriptsIn(text)) {
    const id = script === "latin" ? null : SCRIPT_FONTS[script]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The line height a text needs (TP7): each shipped font's box (its hhea ascent and descent, measured
 * from the pinned file and rounded up, SPIKES §6) is taller than a 1.18 line for most of them, and
 * Chrome counts the box past the line as overflow. The look's own height when none is taller.
 */
export function lineFor(text, primary, base) {
  return Math.max(base, ...fontsFor(text, primary).map((id) => FONTS[id]?.line ?? 0))
}

/**
 * The CSS font-family for a text: the shipped families it needs, in order, then the
 * system stacks standing in for each, so a missing pack degrades to today's look.
 * @param {string} text
 * @param {string} primary a font id of FONTS
 * @param {{ has(id: string): boolean } | null} installed the pack's fonts here; null: assume all
 */
export function fontStackFor(text, primary, installed = null) {
  const ids = fontsFor(text, FONTS[primary] ? primary : "font-inter")
  const shipped = ids.filter((id) => !installed || installed.has(id)).map((id) => `'${FONTS[id].family}'`)
  return [...shipped, ...ids.map((id) => FONTS[id].system)].join(",")
}

/** The family names a stack would draw with if no system font existed: what ET-TY-M1 renders the second time. */
export const shippedOnly = (stack) => stack.split(",").filter((name) => /^'Kriya /.test(name)).join(",") || "monospace"

/** @font-face rules naming each font by id; the renderer fills in the file (withFonts). */
export function fontFaces(ids) {
  return [...new Set(ids)]
    .filter((id) => FONTS[id])
    .map((id) => `@font-face{font-family:'${FONTS[id].family}';src:url("kriya-font:${id}") format("truetype");font-weight:100 900;font-display:block}`)
    .join("")
}

const FACE = /@font-face\{font-family:'[^']+';src:url\("kriya-font:([a-z0-9-]+)"\)[^}]*\}/g

/** The font ids a composition asks for. */
export const fontsAsked = (html) => [...String(html).matchAll(FACE)].map((m) => m[1])

/**
 * A composition with each asked font's file put in as data. A font this computer
 * doesn't have is dropped from the page, so its system stack draws.
 * @param {string} html
 * @param {Map<string, string> | undefined} files font id → path, from installedFonts()
 */
export function withFonts(html, files) {
  if (!html.includes("kriya-font:")) return html
  return html.replace(FACE, (rule, id) => {
    const path = files?.get(id)
    if (!path) return ""
    return rule.replace(`kriya-font:${id}`, `data:font/ttf;base64,${readFileSync(path).toString("base64")}`)
  })
}

/**
 * The pack's fonts installed in a runtime: id → file. Only from a pack that finished
 * installing, and only the files its signed manifest names.
 * @param {{ dir: string, manifest: object } | null} runtime
 * @returns {Map<string, string>}
 */
export function installedFonts(runtime, platform = `${process.platform}-${process.arch}`) {
  const out = new Map()
  const offered = runtime?.manifest?.platforms?.[platform]?.packs?.[FONT_PACK]?.artifacts ?? []
  const dir = runtime && join(runtime.dir, "packs", FONT_PACK)
  if (!dir || !existsSync(join(dir, ".complete"))) return out
  for (const artifact of offered) {
    const path = join(dir, artifact.id, artifact.entry)
    if (FONTS[artifact.id] && existsSync(path)) out.set(artifact.id, path)
  }
  return out
}

/* ─────────────────────────────── the glyph check ─────────────────────────────── */

/** Scripts the OCR helper reads, and the language it reads each with (TPX-05, SPIKES §6). */
export const OCR_READS = { latin: "en-US", devanagari: "hi-IN" }

/** Grapheme clusters a text should show, spaces aside: what the shaped count is compared to. */
export function clusterCount(text) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return [...segmenter.segment(String(text))].filter(({ segment }) => /\S/u.test(segment)).length
}

/**
 * QG-10 where no reader reads the script (CRAFT §5.1): every glyph drawn by a font, none by
 * the last-resort box font; with the pack installed, none by a system font either; and as
 * many clusters drawn as the text has.
 * @param {{ text: string, fonts: { family: string, custom: boolean, glyphs: number }[], drawn: number, missing?: number }} report from checkGlyphs, per text element
 * @param {{ shipped: boolean }} expect shipped: the pack's fonts were installed for this render
 * @returns {string[]} what is wrong; empty when it holds
 */
export function glyphProblems({ text, fonts, drawn, missing: boxes = 0 }, { shipped }) {
  const problems = []
  const missing = fonts.filter((f) => /last ?resort/i.test(f.family))
  if (missing.length) problems.push(`${missing.reduce((n, f) => n + f.glyphs, 0)} missing glyph(s) in "${text}"`)
  // A cluster drawn as its font's empty box (readClusters' canvas check): no font in the stack has it
  else if (boxes > 0) problems.push(`${boxes} missing glyph(s) in "${text}", drawn as an empty box`)
  if (shipped) {
    const system = fonts.filter((f) => !f.custom && !/last ?resort/i.test(f.family))
    if (system.length) problems.push(`"${text}" drew with ${system.map((f) => f.family).join(", ")}, not the shipped fonts`)
  }
  const expected = clusterCount(text)
  if (drawn !== expected) problems.push(`"${text}" shows ${drawn} of its ${expected} clusters`)
  return problems
}
