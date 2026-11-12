// Captions (EDITOR_WORKFLOWS §7, ED8): pages from the transcript's own words, three
// looks written as Kriya's own CSS and WAAPI (no GSAP, no Remotion: EDD-08, EDD-09),
// and each caption a HyperFrames tile, so preview and final match (EDIT_ENGINE §6).

import { boxFor, readableColors } from "../core/type-kit.js"
import { fontFaces, fontsFor, fontStackFor, lineFor } from "./fonts.js"
import { springKeyframes, tileDocument } from "./motion.js"

const FLICKS = 705_600_000
const ms = (flicks) => Math.round((flicks / FLICKS) * 1000)

const FONTS = {
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  rounded: "'Arial Rounded MT Bold', 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
}

/**
 * The looks' caption blocks. size: a share of the frame's height. Box alphas are set
 * so white text and the accent hold 4.5:1 even over a white frame (QG-09).
 */
export const LOOKS = {
  clean: { font: "sans", weight: 800, size: 0.042, color: "#ffffff", accent: "#ffd23f", box: null, stroke: "#000000", highlight: false },
  karaoke: { font: "sans", weight: 800, size: 0.046, color: "#ffffff", accent: "#ffd23f", box: { color: "#0a0a0a", alpha: 0.7 }, stroke: null, highlight: true },
  boxed: { font: "sans", weight: 700, size: 0.04, color: "#f2eadf", accent: "#ffb347", box: { color: "#13292b", alpha: 0.92 }, stroke: null, highlight: false },
  // The playbooks' looks (DP3): bold and word by word for a promo, quieter for a story, plain for a talk
  pop: { font: "rounded", weight: 800, size: 0.05, color: "#ffffff", accent: "#ffe14d", box: null, stroke: "#000000", highlight: true },
  story: { font: "serif", weight: 700, size: 0.036, color: "#fff8ec", accent: "#ffd9a0", box: { color: "#14110d", alpha: 0.78 }, stroke: null, highlight: false },
  minimal: { font: "sans", weight: 700, size: 0.034, color: "#ffffff", accent: "#ffffff", box: { color: "#000000", alpha: 0.72 }, stroke: null, highlight: false },
}

/**
 * TP7 (CRAFT_UPGRADE §5.3, EDD-67): eight more looks, offered only with editing.typeKit on.
 * Data like the six: words per page (1 to 5), lines, how a word arrives (pop, rise, fade, type
 * on), how the spoken word is marked (colour, box, underline, size), how an emphasised word
 * differs, where the page sits. Web Animations only; QG-08 and QG-09 judge each as before.
 */
export const MORE_CAPTION_LOOKS = {
  single: { font: "sans", weight: 900, size: 0.07, color: "#ffffff", accent: "#ffd23f", box: null, stroke: "#000000", highlight: false, words: 1, lines: 1, arrive: "pop", mark: "none", emphasis: "color", place: "middle" },
  duo: { font: "sans", weight: 900, size: 0.06, color: "#ffffff", accent: "#4fd1c5", box: null, stroke: "#000000", highlight: false, words: 2, lines: 1, arrive: "pop", mark: "color", emphasis: "size", place: "middle" },
  marker: { font: "sans", weight: 800, size: 0.05, color: "#ffffff", accent: "#ffd23f", box: null, stroke: "#000000", highlight: false, words: 3, lines: 2, arrive: "rise", mark: "box", emphasis: "box", place: "bottom" },
  underline: { font: "sans", weight: 800, size: 0.046, color: "#ffffff", accent: "#ff7ab6", box: { color: "#0a0a0a", alpha: 0.72 }, stroke: null, highlight: false, words: 4, lines: 2, arrive: "fade", mark: "underline", emphasis: "underline", place: "bottom" },
  grow: { font: "sans", weight: 800, size: 0.05, color: "#ffffff", accent: "#ffb347", box: null, stroke: "#000000", highlight: false, words: 3, lines: 2, arrive: "pop", mark: "size", emphasis: "color", place: "bottom" },
  typewriter: { font: "sans", weight: 700, size: 0.04, color: "#f2eadf", accent: "#ffb347", box: { color: "#13292b", alpha: 0.92 }, stroke: null, highlight: false, words: 5, lines: 2, arrive: "type", mark: "none", emphasis: "color", place: "bottom" },
  headline: { font: "sans", weight: 900, size: 0.052, color: "#ffffff", accent: "#ffd23f", box: { color: "#0a0a0a", alpha: 0.8 }, stroke: null, highlight: false, words: 3, lines: 2, arrive: "rise", mark: "color", emphasis: "box", place: "top", case: "upper" },
  subtle: { font: "sans", weight: 600, size: 0.034, color: "#ffffff", accent: "#cfe8ff", box: { color: "#000000", alpha: 0.6 }, stroke: null, highlight: false, words: 5, lines: 2, arrive: "fade", mark: "color", emphasis: "underline", place: "bottom" },
}
export const ALL_LOOKS = { ...LOOKS, ...MORE_CAPTION_LOOKS }
export const ARRIVALS = ["pop", "rise", "fade", "type"]
export const MARKS = ["none", "color", "box", "underline", "size"]

/** Words per page a look asks for: the six keep 2 to 5, as before. */
export function pageLimits(id) {
  const words = MORE_CAPTION_LOOKS[id]?.words
  return words ? { min: Math.min(2, words), max: words } : { min: 2, max: 5 }
}

/** Where a look's page sits when it isn't the recipe's row (TP7): "middle" or "top", else nothing. */
export const placeOf = (id) => (["middle", "top"].includes(MORE_CAPTION_LOOKS[id]?.place) ? MORE_CAPTION_LOOKS[id].place : undefined)

const HEX = /^#[0-9a-f]{6}$/i

/** A look with the project's typed overrides; anything else in the style is ignored, never passed on. */
export function lookOf(id, style = {}) {
  const base = ALL_LOOKS[id] ?? ALL_LOOKS[style.style] ?? LOOKS.clean
  const look = { ...base }
  if (HEX.test(style.color ?? "")) look.color = style.color
  if (HEX.test(style.accent ?? "")) look.accent = style.accent
  if (style.font in FONTS) look.font = style.font
  if (Number.isFinite(style.size) && style.size >= 0.02 && style.size <= 0.1) look.size = style.size
  if (HEX.test(style.box ?? "") && look.box) look.box = { ...look.box, color: style.box }
  if (style.stroke === "none") look.stroke = null
  // The repair ladder's contrast fix (QUALITY_GATES §4 rung 0): a dark scrim behind the words
  if (style.scrim === true) look.box = look.box ? { ...look.box, alpha: Math.max(look.box.alpha, 0.85) } : { color: "#000000", alpha: 0.8 }
  return look
}

/* ───────────────────────────── phrase breaks ───────────────────────────── */

const CLAUSE = /[.!?;:,]$/
const isNumber = (text) => /\d/.test(text)
const isName = (text, i) => i > 0 && /^\p{Lu}/u.test(text)

/**
 * Pages of 2 to 5 words, broken at clause ends, never leaving one word alone and never
 * between two parts of a number or a name (EDITOR_WORKFLOWS §7).
 * @param {{ id: string, text: string }[]} words in the order they're heard
 * @returns {string[][]} word ids per page
 */
export function pages(words, { min = 2, max = 5 } = {}) {
  const out = []
  let page = []
  const joined = (a, b) => (isNumber(a.text) && isNumber(b.text)) || (isName(a.text, 1) && isName(b.text, 1))
  words.forEach((word, i) => {
    page.push(word)
    const next = words[i + 1]
    if (!next) return
    const left = words.length - 1 - i
    const full = page.length >= max
    const clause = CLAUSE.test(word.text) && page.length >= min
    if ((full || clause) && left >= min && !joined(word, next)) {
      out.push(page)
      page = []
    }
  })
  if (page.length) {
    // An orphan joins the page before it
    if (page.length < min && out.length) out[out.length - 1].push(...page)
    else out.push(page)
  }
  // A page the orphan rule or a long name pushed over the limit splits in two, not inside a name or number
  const split = (p) => {
    if (p.length <= max) return [p]
    const middle = Math.ceil(p.length / 2)
    const points = []
    for (let at = min; at <= p.length - min; at++) if (!joined(p[at - 1], p[at])) points.push(at)
    const at = points.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0] ?? middle
    return [...split(p.slice(0, at)), ...split(p.slice(at))]
  }
  return out.flatMap(split).map((p) => p.map((w) => w.id))
}

/* ─────────────────────────────── reading speed ─────────────────────────────── */

/**
 * Words a second a reader keeps up with, per script.
 * shortcut: untuned defaults; EX-04's check with readers sets them per script.
 */
export const READING_LIMITS = { latin: 4, devanagari: 3.5, telugu: 3, other: 3.5 }

export function scriptOf(text) {
  if (/\p{Script=Devanagari}/u.test(text)) return "devanagari"
  if (/\p{Script=Telugu}/u.test(text)) return "telugu"
  if (/\p{Script=Latin}/u.test(text)) return "latin"
  return "other"
}

/**
 * Pages a reader keeps up with: a burst of fast speech joins its neighbour, so it stays on screen
 * longer, rather than flash by (found on real footage). A page that's readable is left alone.
 * @param {string[][]} list pages of word ids, from pages()
 * @param {{ id: string, text: string, start: number, end: number }[]} words
 */
export function readablePages(list, words) {
  const byId = new Map(words.map((w) => [w.id, w]))
  const tooFast = (ids) => {
    const script = scriptOf(ids.map((id) => byId.get(id)?.text ?? "").join(" "))
    const seconds = (byId.get(ids.at(-1)).end - byId.get(ids[0]).start) / FLICKS
    return seconds < 1.2 && ids.length / Math.max(seconds, 1e-3) > READING_LIMITS[script]
  }
  const out = list.map((p) => [...p])
  for (let i = 0; i < out.length && out.length > 1; i++) {
    if (!tooFast(out[i])) continue
    // With the smaller neighbour, so the page stays short; never over ten words, and the gate says so if it's still fast
    const before = i > 0 ? out[i - 1].length : Infinity
    const after = i + 1 < out.length ? out[i + 1].length : Infinity
    const into = before < after ? i - 1 : i
    if (Math.min(before, after) + out[i].length > 10) continue
    out.splice(into, 2, [...out[into], ...out[into + 1]])
    i = into - 1
  }
  return out
}

/* ─────────────────────────────── the composition ─────────────────────────────── */

const ENTRANCE = { damping: 0.7, frequency: 14, ms: 320 }

/**
 * A caption tile's composition (HyperFrames' format): one page, its words timed to the
 * speech, at its placement scaled to the output.
 * @param {object} node the plan's caption node
 * @param {{ output: { width: number, height: number }, canvas: { width: number, height: number } }} frame
 */
export function captionComposition(node, { output, canvas }) {
  const look = lookOf(node.look, node.style)
  // TP7: a project with a type kit draws in its faces and colours; one without draws as it did
  const kit = node.type
  if (kit?.colors) {
    const colors = readableColors({ text: kit.colors.text ?? look.color, accent: kit.colors.accent ?? look.accent, plate: kit.colors.plate }, { plate: !!look.box })
    look.color = colors.text
    look.accent = colors.accent
    look.stroke = colors.stroke
    look.box = colors.plate ? { color: colors.plate, alpha: look.box ? Math.max(look.box.alpha, 0.92) : 0.92 } : null
  }
  const sx = output.width / canvas.width
  const sy = output.height / canvas.height
  const box = node.placement ?? { x: Math.round(canvas.width * 0.1), y: Math.round(canvas.height * 0.7), w: Math.round(canvas.width * 0.8), h: Math.round(canvas.height * 0.12) }
  const size = Math.round(look.size * output.height)
  const area = { x: Math.round(box.x * sx), y: Math.round(box.y * sy), w: Math.round(box.w * sx), h: Math.round(box.h * sy) }
  const plate = look.box ? `background:${look.box.color}${Math.round(look.box.alpha * 255).toString(16).padStart(2, "0")};border-radius:${Math.round(size * 0.35)}px;padding:${Math.round(size * 0.22)}px ${Math.round(size * 0.45)}px;` : ""
  const stroke = look.stroke ? `-webkit-text-stroke:${Math.max(2, Math.round(size * 0.08))}px ${look.stroke};paint-order:stroke fill;` : ""
  const duration = node.duration
  const pageText = node.text ?? node.words.map((w) => w.text).join(" ")
  const face = kit ? (look.weight >= 900 || look.case === "upper" ? kit.heading : kit.body) : null
  // Not shipped here: the kit's own system stacks, no font asked for, so the tile is the same with or without the pack
  const family = face ? fontStackFor(pageText, face.font, kit.shipped ? null : new Set()) : FONTS[look.font]
  const typeCss = face ? `${face.case === "upper" || look.case === "upper" ? "text-transform:uppercase;" : ""}${face.tracking ? `letter-spacing:${face.tracking}em;` : ""}` : look.case === "upper" ? "text-transform:uppercase;" : ""
  const css = [
    face && kit.shipped ? fontFaces(fontsFor(pageText, face.font)) : "",
    `#area{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:center;justify-content:center}`,
    // A look that marks the spoken word by size wraps narrower, so the word can grow inside the box
    `#t{max-width:${look.mark === "size" ? Math.floor(area.w / 1.2) : area.w}px;box-sizing:border-box;text-align:center;font-family:${family};font-weight:${look.weight};font-size:${size}px;line-height:${face ? lineFor(pageText, face.font, 1.18) : 1.18};color:${look.color};${plate}${stroke}${typeCss}${look.lines === 1 ? "white-space:nowrap;" : ""}}`,
    `#t span{display:inline-block;white-space:pre}`,
    `#t .e{color:${look.accent}}`,
    look.arrive ? emphasisCss(look, size) : "",
  ].join("")
  // The person's corrected text is what shows (caption_edit): word by word when it has as many
  // words as were said, else as one block (found in ED10: the edit wasn't drawn at all)
  const said = node.words.map((w) => w.text).join(" ")
  const edited = node.text !== undefined && node.text !== said ? node.text.split(/\s+/).filter(Boolean) : null
  const shown = !edited ? node.words : edited.length === node.words.length ? node.words.map((w, i) => ({ ...w, text: edited[i] })) : [{ text: node.text, at: 0, end: duration, emphasis: false }]
  const words = shown.map((word, i) => ({ ...word, id: `w${i}` }))
  const body = `<div id="area"><div id="t" data-text>${words.map((w, i) => `<span id="${w.id}"${w.emphasis ? ' class="e"' : ""} data-at="${ms(w.at)}" data-end="${ms(w.end)}">${i ? " " : ""}${escapeText(w.text)}</span>`).join("")}</div></div>`
  const animations = look.arrive ? arrivals(look, words, size, duration) : [{ id: "t", keyframes: springKeyframes({ ...ENTRANCE, from: { y: Math.round(size * 0.6), opacity: 0 }, to: { y: 0, opacity: 1 } }), options: { duration: ENTRANCE.ms, fill: "both" } }]
  if (look.highlight) {
    const total = Math.max(1, ms(duration))
    for (const word of words) {
      if (word.emphasis) continue
      const on = Math.min(1, Math.max(0, ms(word.at) / total))
      const off = Math.min(1, Math.max(on, ms(word.end) / total))
      const base = { color: look.color, transform: "scale(1)" }
      const lit = { color: look.accent, transform: "scale(1.08)" }
      animations.push({ id: word.id, keyframes: [{ ...base, offset: 0 }, { ...base, offset: on }, { ...lit, offset: on }, { ...lit, offset: off }, { ...base, offset: off }, { ...base, offset: 1 }], options: { duration: total, fill: "both", easing: "linear" } })
    }
  }
  // A page fits its placement: the font steps down, never under QG-09's smallest size
  // A kit page with a script font may step down to QG-09's own floor, not the Latin one (TP7)
  const floor = face && fontsFor(pageText, face.font).length > 1 ? 0.0205 : 0.025
  return tileDocument({ width: output.width, height: output.height, duration, css, body, animations, fit: { id: "t", within: "area", min: Math.ceil(output.height * floor) } })
}

/* ─────────────────────────────── TP7's looks ─────────────────────────────── */

// An emphasised word: in the accent, boxed, underlined or larger. A box keeps the page's ink and outline, on the accent moved until that ink holds 4.5:1
function emphasisCss(look, size) {
  const pad = Math.round(size * 0.12)
  const rules = {
    color: `#t .e{color:${look.accent}}`,
    box: `#t .e{color:${look.color};background:${boxFor(look.accent, look.color)};border-radius:${pad}px;padding:0 ${pad}px}`,
    underline: `#t .e{box-shadow:inset 0 -${Math.max(3, Math.round(size * 0.12))}px 0 ${look.accent}}`,
    size: `#t .e{color:${look.accent};font-size:1.15em}`,
  }
  return rules[look.emphasis] ?? ""
}

/**
 * Each word arrives as it is said, and the spoken word is marked while it is said. Timed on
 * the tile's whole length, so a seek to any frame draws the same.
 */
function arrivals(look, words, size, duration) {
  const total = Math.max(1, ms(duration))
  const at = (t) => Math.min(1, Math.max(0, t / total))
  const out = []
  for (const word of words) {
    // A word is fully in by the moment it is said, so a gate reading at a word's start sees it whole
    const on = ms(word.at)
    const arrive = look.arrive === "type" ? 260 : 220
    const a = at(Math.max(0, on - arrive))
    const b = Math.max(a, at(on))
    const from = {
      pop: { transform: "scale(0.6)", opacity: 0 },
      rise: { transform: "scaleY(0.2)", transformOrigin: "50% 100%", opacity: 0 },
      fade: { opacity: 0 },
      type: { clipPath: "inset(0 100% 0 0)" },
    }[look.arrive]
    const to = { pop: { transform: "scale(1)", opacity: 1 }, rise: { transform: "scaleY(1)", transformOrigin: "50% 100%", opacity: 1 }, fade: { opacity: 1 }, type: { clipPath: "inset(0 0% 0 0)" } }[look.arrive]
    out.push({ id: word.id, keyframes: [{ ...from, offset: 0 }, { ...from, offset: a }, { ...to, offset: b }, { ...to, offset: 1 }], options: { duration: total, fill: "both", easing: "linear" } })
    if (look.mark === "none" || word.emphasis) continue
    const lit = Math.max(b, at(ms(word.end)))
    // A mark that doesn't touch what the arrival moves: colour, background, a shadow line, or the size (a second animation on font-size)
    // The size mark is in em, so it follows the page the fit shrank
    const mark = { color: ["color", look.color, look.accent], box: ["backgroundColor", `${boxFor(look.accent, look.color)}00`, boxFor(look.accent, look.color)], underline: ["boxShadow", `inset 0 0 0 ${look.accent}00`, `inset 0 -${Math.max(3, Math.round(size * 0.12))}px 0 ${look.accent}`], size: ["fontSize", "1em", "1.18em"] }[look.mark]
    const [prop, base, on2] = mark
    const frames = [{ [prop]: base, offset: 0 }, { [prop]: base, offset: b }, { [prop]: on2, offset: b }, { [prop]: on2, offset: lit }, { [prop]: base, offset: lit }, { [prop]: base, offset: 1 }]
    out.push({ id: word.id, keyframes: frames, options: { duration: total, fill: "both", easing: "linear" } })
  }
  return out
}

/** When a page with arriving words is all in: QG-10 reads it then (ms into the tile). */
export function captionAtRest(node) {
  const look = lookOf(node.look, node.style)
  if (!look.arrive) return null
  return Math.max(0, ...node.words.map((w) => ms(w.at))) + 320
}

/** Text for an element's content: markup can't get in (ES-05, ET-SEC-02). */
export function escapeText(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}
