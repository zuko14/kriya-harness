// The motion kit (MOTION_GRAPHICS.md, EDD-58): titles, name straps, opening and end cards,
// quotes and numbers over the footage, drawn by Kriya's own code from typed variables. No
// model writes code here. Web Animations only, so a graphic seeks and renders like every
// other tile: no clock, no randomness, no network. Each sits in the box the layout solver
// gives it, clear of the speaker's face and the captions, and its words are `text` and
// `subtitle`, so the copy and contrast gates read it as they read a title.

import { REGIONS } from "../core/layout.js"
import { regionOf } from "../core/effects.js"
import { against, readableColors } from "../core/type-kit.js"
import { fontFaces, fontsFor, fontStackFor, lineFor } from "./fonts.js"
import { EngineFailure } from "./tool.js"

const FLICKS = 705_600_000

export const GRAPHIC_BLOCK = "graphic"
export const GRAPHIC_VERSION = 1

/** The kinds: what each is for (the Director's prompt and the Plan Card read this), and its styles, the first the default. */
export const GRAPHIC_KINDS = {
  title: { label: "Title", styles: ["rise", "slam", "words"], subtitle: false, when: "a few strong words of the line being said, to land its point" },
  chapter: { label: "Chapter card", styles: ["wipe"], subtitle: false, when: "the name of a new part of the video, as the speaker starts it" },
  quote: { label: "Quote", styles: ["line"], subtitle: false, when: "a short sentence the speaker says that is worth reading as well as hearing" },
  lower: { label: "Name strap", styles: ["bar", "pill"], subtitle: true, when: "who is speaking: the name in `text`, the role in `subtitle`; only when the person gave them" },
  intro: { label: "Opening title", styles: ["sweep"], subtitle: true, when: "the video's title over its first seconds, with an optional second line" },
  end: { label: "End card", styles: ["sweep"], subtitle: true, when: "the closing call to action over the last seconds, with an optional handle or second line" },
  stat: { label: "Number", styles: ["pop"], subtitle: true, number: true, when: "one number the speaker says, as digits in `text` (with its unit if said), and what it counts in `subtitle`" },
}
export const STYLE_LABELS = { rise: "Rise", slam: "Slam", words: "Word by word", wipe: "Wipe", line: "Accent line", bar: "Bar", pill: "Pill", sweep: "Line sweep", pop: "Pop" }

/**
 * Motion kit 2 (TP7, CRAFT_UPGRADE §5.4, EDD-67), offered only with editing.typeKit on. Drawn
 * by code under MOTION_GRAPHICS §3.2's rules: the words are the speaker's or the person's own
 * (`person`: typed by the person only), code places and times them. The progress and chapter
 * bars and the logo bug span the cut, so they are FFmpeg overlays from the type kit, not kinds.
 */
export const KIT2_KINDS = {
  card: { label: "Full-frame card", styles: ["title", "quote"], subtitle: true, when: "a few words of what is said, alone on the whole frame, to open a part or land a line" },
  list: { label: "List", styles: ["steps", "bullets"], subtitle: false, steps: true, when: "steps or points the speaker lists, in `steps`, each arriving on its word; `text` is the list's heading" },
  callout: { label: "Callout", styles: ["ring", "box", "arrow"], subtitle: false, point: true, optionalText: true, textMax: 24, when: "a mark at a point the person chose, or on the speaker's face, with an optional short label" },
  count: { label: "Counting number", styles: ["count"], subtitle: true, number: true, when: "one number the speaker says, counted up to, as digits in `text`, and what it counts in `subtitle`" },
  handle: { label: "Handle strap", styles: ["strap"], subtitle: false, person: true, textMax: 32, when: "the person's own handle, only as they typed it" },
  cta: { label: "Call to action", styles: ["strap"], subtitle: true, person: true, when: "the person's own call to action, only as they typed it" },
  frame: { label: "Screen frame", styles: ["plain"], subtitle: false, noText: true, when: "a plain frame round a screen recording; no device and no brand's shape" },
}
/** Four more name straps. */
export const LOWER_STYLES_2 = ["underline", "box", "split", "tag"]
export const ALL_GRAPHIC_KINDS = { ...GRAPHIC_KINDS, lower: { ...GRAPHIC_KINDS.lower, styles: [...GRAPHIC_KINDS.lower.styles, ...LOWER_STYLES_2] }, ...KIT2_KINDS }
export const STYLE_LABELS_2 = { title: "Title", quote: "Quote", steps: "Numbered", bullets: "Bullets", ring: "Ring", box: "Box", arrow: "Arrow", count: "Count up", strap: "Strap", plain: "Plain", underline: "Underline", split: "Split", tag: "Tag" }
export const STEPS_MAX = 5
export const STEP_MAX = 32

/** The brand kit a project may choose from; hex and font stacks stay in code. Ink on plate holds WCAG 4.5:1 (tested). */
export const GRAPHIC_ACCENTS = { teal: "#4fd1c5", yellow: "#ffd23f", amber: "#ffb347", pink: "#ff7ab6", white: "#ffffff" }
export const GRAPHIC_TONES = { dark: { plate: "#13292b", ink: "#f2eadf", chip: "#13292b" }, light: { plate: "#f6f1e7", ink: "#1c2530", chip: "#1c2530" } }
// System fonts only: nothing is downloaded, and every stack ends in a family each platform has
export const GRAPHIC_FONTS = {
  sans: "'Helvetica Neue',Helvetica,Arial,sans-serif",
  serif: "Georgia,'Times New Roman',serif",
  condensed: "'Avenir Next Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif",
  mono: "'SF Mono',Menlo,Consolas,'Courier New',monospace",
}
export const TEXT_MAX = 48
export const SUBTITLE_MAX = 32 // one line under the main one, in the narrowest frame at the smallest readable size
const NUMBER = /^[₹$€£]?\d{1,7}(?:[.,]\d{1,3})*\s?(?:%|[A-Za-z₹$€£]{1,8})?$/

// Too long is cut at a word, never through one
const cleanText = (value, max = TEXT_MAX) => {
  if (typeof value !== "string") return ""
  const text = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max + 1)
  return (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut.slice(0, max)).trim()
}
const pick = (table, value, fallback) => (Object.hasOwn(table, value ?? "") ? value : fallback)

/**
 * A graphic's shape, at every trust boundary (a model's answer, a browser's request, a saved
 * project). Unknown fields go; text is cleaned. Whether its words may be shown is `graphicProblems`' job.
 * @returns {object | null} null when it can't be a graphic
 */
export function cleanGraphic(raw, kinds = GRAPHIC_KINDS) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const kind = pick(kinds, raw.kind, null)
  if (!kind) return null
  const shape = kinds[kind]
  const text = shape.noText ? "" : cleanText(raw.text, shape.textMax ?? TEXT_MAX)
  if ((!text && !shape.noText && !shape.optionalText) || (shape.number && !NUMBER.test(text))) return null
  // Kit 2's own fields (TP7), only on the kinds that have them
  const steps = shape.steps && Array.isArray(raw.steps) ? raw.steps.map((step) => cleanText(step, STEP_MAX)).filter(Boolean).slice(0, STEPS_MAX) : null
  if (shape.steps && (!steps || steps.length < 2)) return null
  const stepAt = steps && Array.isArray(raw.stepAt) && raw.stepAt.length === steps.length && raw.stepAt.every((t) => Number.isSafeInteger(t) && t >= 0 && t <= 60_000) ? raw.stepAt : null
  const point = shape.point && raw.point && Number.isSafeInteger(raw.point.x) && Number.isSafeInteger(raw.point.y) && raw.point.x >= 0 && raw.point.y >= 0 && raw.point.x <= 10_000 && raw.point.y <= 10_000 ? { x: raw.point.x, y: raw.point.y } : null
  // TP9: the box the person drew on the frame, in thousandths of it; the callout is drawn round exactly that
  const mark = shape.point ? cleanMarkBox(raw.mark) : null
  const corner = kind === "handle" && ["tl", "tr", "bl", "br"].includes(raw.corner) ? raw.corner : null
  const subtitle = shape.subtitle ? cleanText(raw.subtitle, SUBTITLE_MAX) : ""
  const id = typeof raw.at === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(raw.at) ? raw.at : null
  return {
    kind,
    style: shape.styles.includes(raw.style) ? raw.style : shape.styles[0],
    text,
    ...(subtitle ? { subtitle } : {}),
    accent: pick(GRAPHIC_ACCENTS, raw.accent, "teal"),
    tone: pick(GRAPHIC_TONES, raw.tone, "dark"),
    font: pick(GRAPHIC_FONTS, raw.font, "sans"),
    ...(id ? { at: id } : {}),
    ...(steps ? { steps } : {}),
    ...(stepAt ? { stepAt } : {}),
    ...(point ? { point } : {}),
    ...(mark ? { mark } : {}),
    ...(corner ? { corner } : {}),
    // Set by the recipe on a graphic an approved plan asked for, so a remake replaces it
    ...(raw.plan === true ? { plan: true } : {}),
  }
}

/**
 * A box drawn on the frame (TP9, CRAFT_UPGRADE §7): whole thousandths of the frame, inside it,
 * at least MARK_MIN on each side. @returns {{ x: number, y: number, w: number, h: number } | null}
 */
export const cleanMarkBox = regionOf

/** How long a graphic stays up: long enough to read, never long enough to bore. In flicks. */
export function graphicLength(graphic) {
  if (KIT2_KINDS[graphic.kind]) return kit2Length(graphic)
  const letters = graphic.text.length + (graphic.subtitle?.length ?? 0)
  const seconds = graphic.kind === "intro" || graphic.kind === "end" ? 3.2 : graphic.kind === "lower" ? 4 : Math.min(5, Math.max(1.8, letters / 15 + 1.2))
  return Math.round(seconds * FLICKS)
}

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const round = (n) => Math.round(n * 10000) / 10000
const EASE = "cubic-bezier(.2,.8,.2,1)"
const SPRING = { damping: 0.6, frequency: 12, ms: 620 }

/**
 * @param {{ variables: object, area: { x: number, y: number, w: number, h: number }, output: { width: number, height: number }, duration: number }} input
 * @param {(spring: object) => object[]} springKeyframes motion.js's, handed in so the two files don't import each other
 * @returns {{ css: string, body: string, animations: object[], fit: object }}
 */
export function buildGraphic({ variables, area, output, duration, type }, springKeyframes) {
  const graphic = cleanGraphic(variables, ALL_GRAPHIC_KINDS)
  if (!graphic) throw new EngineFailure("plan", "bad_graphic", "This graphic's variables don't describe a graphic.")
  if (KIT2_KINDS[graphic.kind] || LOWER_STYLES_2.includes(graphic.style)) return buildKit2({ graphic, area, output, duration, type }, springKeyframes)
  const { kind, style, text, subtitle } = graphic
  // TP7: with a type kit, its faces and the person's colours, held readable; without one, as before
  const kit = type ? kitLook(graphic, type, [text, subtitle].join(" ")) : null
  const tone = kit?.tone ?? GRAPHIC_TONES[graphic.tone]
  const accent = kit?.accent ?? GRAPHIC_ACCENTS[graphic.accent]
  const font = kit?.font ?? GRAPHIC_FONTS[graphic.font]
  const ms = (duration / FLICKS) * 1000
  const floor = Math.ceil(output.height * 0.0205) // QG-09's smallest readable size
  const two = !!subtitle
  const pad = Math.round(area.h * 0.08)
  const big = kind === "stat" || kind === "intro"
  const main = Math.max(floor, Math.round(area.h * (two ? (big ? 0.4 : 0.34) : big ? 0.5 : 0.42)))
  const small = Math.max(floor, Math.round(area.h * 0.19))
  const left = kind === "lower" || kind === "chapter" || kind === "quote"
  const radius = style === "pill" ? Math.round(area.h / 2) : Math.round(area.h * 0.1)
  const bar = Math.max(4, Math.round(area.h * 0.05))

  const animations = []
  const animate = (id, keyframes, options) => animations.push({ id, keyframes, options: { fill: "both", ...options } })
  // In and out with the whole graphic, so it never pops off on a cut
  const out = Math.min(220, ms * 0.12)
  animate("a", [{ opacity: 1, offset: 0 }, { opacity: 1, offset: round(1 - out / ms) }, { opacity: 0, offset: 1 }], { duration: ms })
  const spring = (id, from, delay = 0) => animate(id, springKeyframes({ ...SPRING, from, to: { y: 0, scale: 1, opacity: 1 } }), { duration: SPRING.ms, delay })
  const grow = (id, axis, delay = 0, length = 380) => animate(id, [{ transform: `scale${axis}(0)` }, { transform: `scale${axis}(1)` }], { duration: length, delay, easing: EASE })
  const fade = (id, delay, length = 300) => animate(id, [{ opacity: 0 }, { opacity: 1 }], { duration: length, delay, easing: "ease-out" })

  // Room on the left for what leads the text in: the bar or the dot
  const lead = Math.round(pad * 2.2) + (kind === "lower" || kind === "chapter" || kind === "quote" ? bar * 4 : 0)
  let words = escape(text)
  let rule = ""
  if (kind === "title" && style === "slam") {
    spring("t", { scale: 1.6, opacity: 0 })
    rule = "under"
    grow("k", "X", 260)
  } else if (kind === "title" && style === "words") {
    // Each word lands in turn, all in within half a second so the line reads at once
    const parts = text.split(" ")
    const step = Math.min(90, 480 / parts.length)
    words = parts.map((word, i) => `<span id="w${i}" class="w">${escape(word)}</span>`).join(" ")
    fade("t", 0, 120)
    parts.forEach((_, i) => spring(`w${i}`, { y: Math.round(main * 0.6), opacity: 0 }, Math.round(i * step)))
  } else if (kind === "chapter") {
    rule = "side"
    grow("k", "Y", 0, 320)
    animate("t", [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 460, delay: 120, easing: EASE })
  } else if (kind === "quote") {
    // No quote-mark glyph: a reader takes one for "66" and the copy gate rightly fails it (found on a real make)
    rule = "side"
    grow("k", "Y", 0, 320)
    spring("t", { y: Math.round(main * 0.5), opacity: 0 }, 90)
  } else if (kind === "lower") {
    rule = style === "pill" ? "dot" : "side"
    animate("t", [{ transform: `translateX(-${Math.round(area.w * 0.12)}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: 480, easing: EASE })
    grow("k", style === "pill" ? "" : "Y", 180, 320)
  } else if (kind === "intro" || kind === "end") {
    rule = "under"
    spring("t", { y: Math.round(main * 0.8), scale: 0.92, opacity: 0 })
    grow("k", "X", 220, 520)
  } else if (kind === "stat") {
    rule = "under"
    spring("t", { scale: 0.5, opacity: 0 })
    grow("k", "X", 200)
  } else spring("t", { y: Math.round(main * 1.2), scale: 0.85, opacity: 0 })
  if (two) fade("u", 320)

  // The end card's second line is a chip in the accent colour, with the plate's dark ink on it
  const chip = kind === "end" && two
  // QG-09 reads a text's plate from the text's own element, so each line carries the plate's colour
  const css = [
    kit?.faces ?? "",
    `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:center;justify-content:${left ? "flex-start" : "center"}}`,
    `#t{position:relative;box-sizing:border-box;max-width:100%;display:flex;flex-direction:column;align-items:${left ? "flex-start" : "center"};justify-content:center;gap:${Math.round(pad * 0.3)}px;padding:${pad}px ${Math.round(pad * 2.2)}px ${pad}px ${lead}px;background:${tone.plate};border-radius:${radius}px;font-family:${font};color:${tone.ink};text-align:${left ? "left" : "center"};text-wrap:balance;box-shadow:0 ${Math.round(pad * 0.3)}px ${pad * 2}px #00000040}`,
    `#m{display:block;padding:0 .08em;background:${tone.plate};font-size:${main}px;line-height:1.2;font-weight:800;${kind === "quote" ? "font-style:italic;font-weight:600;" : ""}${kind === "stat" ? "font-variant-numeric:tabular-nums;" : ""}}`,
    `.w{display:inline-block}`,
    `#u{display:block;white-space:nowrap;font-size:${small}px;line-height:1.25;font-weight:600;${chip ? `background:${accent};color:${GRAPHIC_TONES.dark.chip};padding:${Math.round(small * 0.18)}px ${Math.round(small * 0.5)}px;border-radius:${Math.round(small * 0.3)}px` : `background:${tone.plate}`}}`,
    rule === "under" ? `#k{height:${bar}px;width:100%;background:${accent};border-radius:${bar}px;transform-origin:${left ? "left" : "center"}}` : "",
    rule === "side" ? `#k{position:absolute;left:0;top:0;bottom:0;width:${bar * 2}px;background:${accent};border-radius:${radius}px 0 0 ${radius}px;transform-origin:top}` : "",
    rule === "dot" ? `#k{position:absolute;left:${Math.round(pad * 1.6)}px;top:50%;width:${bar * 2}px;height:${bar * 2}px;margin-top:-${bar}px;background:${accent};border-radius:50%}` : "",
  ].join("")
  const body = `<div id="a"><div id="t"><span id="m" data-text>${words}</span>${rule === "under" ? `<span id="k"></span>` : ""}${two ? `<span id="u" data-text>${escape(subtitle)}</span>` : ""}${rule === "side" || rule === "dot" ? `<span id="k"></span>` : ""}</div></div>`
  // The main line wraps, then steps down until the plate fits its box, never under the readable floor
  return { css, body, animations, fit: { id: "m", within: "a", min: floor, box: "t" } }
}

/* ─────────────────────────────── TP7: the kit and motion kit 2 ─────────────────────────────── */

/**
 * A graphic's faces and colours from the project's type kit (CRAFT §5.2): the heading face,
 * the person's colours made to hold 4.5:1 on the plate, and the fonts to ask the renderer for.
 */
function kitLook(graphic, type, text) {
  const tone = GRAPHIC_TONES[graphic.tone]
  const colors = readableColors({ text: type.colors?.text ?? tone.ink, accent: type.colors?.accent ?? GRAPHIC_ACCENTS[graphic.accent], plate: type.colors?.plate ?? tone.plate }, { plate: true })
  const face = type.heading
  return {
    tone: { plate: colors.plate, ink: colors.text, chip: against(colors.accent) },
    accent: colors.accent,
    font: `${fontStackFor(text, face.font, type.shipped ? null : new Set())};${face.case === "upper" ? "text-transform:uppercase;" : ""}${face.tracking ? `letter-spacing:${face.tracking}em;` : ""}font-synthesis:none`,
    // A script whose font needs a taller line gets it on every line of text, over the kind's own (SPIKES §6)
    faces: `${type.shipped ? fontFaces(fontsFor(text, face.font)) : ""}${lineFor(text, face.font, 0) > 0 ? `#stage [data-text],#stage .i{line-height:${lineFor(text, face.font, 0)}}#stage #u{white-space:normal}` : ""}`,
  }
}

function kit2Length(graphic) {
  if (graphic.kind === "frame") return Math.round(6 * FLICKS)
  if (graphic.kind === "list") return Math.round(Math.min(10, Math.max(3.5, 1.2 + graphic.steps.length * 1.4)) * FLICKS)
  if (graphic.kind === "card") return Math.round(Math.min(5, Math.max(2.4, (graphic.text.length + (graphic.subtitle?.length ?? 0)) / 14 + 1.2)) * FLICKS)
  if (graphic.kind === "handle" || graphic.kind === "cta") return Math.round(3.5 * FLICKS)
  return Math.round(Math.min(5, Math.max(2, (graphic.text.length + (graphic.subtitle?.length ?? 0)) / 15 + 1.4)) * FLICKS)
}

// A number's steps on the way up: the same digits, grouping and decimals as the said number, eased out
const COUNT = /^([₹$€£]?)(\d{1,3}(?:,\d{2,3})+|\d{1,9})(\.\d{1,3})?(\s?(?:%|[A-Za-z₹$€£]{1,8})?)$/
export function countSteps(text, steps = 10) {
  const m = COUNT.exec(text)
  if (!m) return null
  const [, before, whole, decimals = "", after] = m
  const target = Number(whole.replaceAll(",", ""))
  const indian = /^\d{1,2}(?:,\d\d)+,\d{3}$/.test(whole)
  const format = (n) => (whole.includes(",") ? n.toLocaleString(indian ? "en-IN" : "en-US") : String(n))
  const out = []
  for (let i = 0; i < steps; i++) out.push(`${before}${format(Math.round(target * (1 - (1 - i / steps) ** 3)))}${decimals ? `.${"0".repeat(decimals.length - 1)}` : ""}${after}`)
  return [...out, text]
}

/**
 * Motion kit 2's drawing: same rules as buildGraphic (words escaped, WAAPI only, each line on
 * the plate's colour so QG-09 reads it, a fit that never goes under the readable floor).
 */
function buildKit2({ graphic, area, output, duration, type }, springKeyframes) {
  const { kind, style, text, subtitle } = graphic
  const words = [text, subtitle, ...(graphic.steps ?? [])].filter(Boolean).join(" ")
  const kit = type ? kitLook(graphic, type, words) : null
  const tone = kit?.tone ?? GRAPHIC_TONES[graphic.tone]
  const accent = kit?.accent ?? GRAPHIC_ACCENTS[graphic.accent]
  const font = kit?.font ?? GRAPHIC_FONTS[graphic.font]
  const ink = against(accent)
  const ms = (duration / FLICKS) * 1000
  const floor = Math.ceil(output.height * 0.0205)
  const pad = Math.round(Math.min(area.h, area.w) * 0.08)
  const bar = Math.max(4, Math.round(output.height * 0.006))
  const animations = []
  const animate = (id, keyframes, options) => animations.push({ id, keyframes, options: { fill: "both", ...options } })
  const outMs = Math.min(220, ms * 0.12)
  animate("a", [{ opacity: 1, offset: 0 }, { opacity: 1, offset: round(1 - outMs / ms) }, { opacity: 0, offset: 1 }], { duration: ms })
  const spring = (id, from, delay = 0) => animate(id, springKeyframes({ ...SPRING, from, to: { y: 0, scale: 1, opacity: 1 } }), { duration: SPRING.ms, delay })
  const fade = (id, delay, length = 300) => animate(id, [{ opacity: 0 }, { opacity: 1 }], { duration: length, delay, easing: "ease-out" })
  const box = `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:center;justify-content:center}`
  const line = (id, size, weight, extra = "") => `#${id}{display:block;padding:0 .08em;background:${tone.plate};font-size:${size}px;line-height:1.2;font-weight:${weight};${extra}}`
  let css = []
  let body = ""
  let fit = null

  if (kind === "card") {
    // The whole frame: a plate behind, the words large in the content box
    const main = Math.max(floor, Math.round(area.h * (subtitle ? 0.12 : 0.15)))
    const small = Math.max(floor, Math.round(main * 0.42))
    css = [
      `#bg{position:absolute;inset:0;background:${tone.plate}}`,
      box,
      `#t{box-sizing:border-box;max-width:100%;display:flex;flex-direction:column;align-items:center;gap:${pad}px;padding:${pad}px;font-family:${font};color:${tone.ink};text-align:center;text-wrap:balance}`,
      line("m", main, style === "quote" ? 600 : 800, style === "quote" ? "font-style:italic;" : ""),
      line("u", small, 600, `color:${accent};`),
      `#k{width:${Math.round(area.w * 0.18)}px;height:${bar}px;background:${accent};border-radius:${bar}px}`,
    ]
    body = `<div id="bg"></div><div id="a"><div id="t">${style === "quote" ? `<span id="k"></span>` : ""}<span id="m" data-text>${escape(text)}</span>${style === "title" ? `<span id="k"></span>` : ""}${subtitle ? `<span id="u" data-text>${escape(subtitle)}</span>` : ""}</div></div>`
    animate("bg", [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" })
    spring("t", { y: Math.round(main * 0.6), scale: 0.94, opacity: 0 }, 80)
    animate("k", [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 420, delay: 260, easing: EASE })
    if (subtitle) fade("u", 380)
    fit = { id: "m", within: "a", min: floor, box: "t" }
  } else if (kind === "list") {
    // Each step arrives on its word (stepAt, from the plan), else evenly through the first half
    const n = graphic.steps.length
    const item = Math.max(floor, Math.round((area.h / (n + 2)) * 0.62))
    css = [
      box,
      `#t{box-sizing:border-box;width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:.3em;padding:${pad}px ${Math.round(pad * 1.6)}px;background:${tone.plate};border-radius:${Math.round(pad * 0.8)}px;font-family:${font};color:${tone.ink};font-size:${item}px}`,
      `#m{display:block;padding:0 .08em;background:${tone.plate};font-size:1.28em;line-height:1.2;font-weight:800}`,
      `.i{display:flex;align-items:baseline;gap:.4em;background:${tone.plate};font-size:1em;line-height:1.2;font-weight:600}`,
      `.n{flex:none;min-width:1.3em;text-align:center;border-radius:.3em;background:${accent};color:${ink};font-weight:800}`,
    ]
    const marker = (i) => (style === "steps" ? String(i + 1) : "•")
    body = `<div id="a"><div id="t"><span id="m" data-text>${escape(text)}</span>${graphic.steps.map((step, i) => `<span class="i" id="i${i}"><span class="n">${marker(i)}</span><span data-text>${escape(step)}</span></span>`).join("")}</div></div>`
    spring("t", { y: Math.round(item * 0.6), opacity: 0 })
    graphic.steps.forEach((_, i) => {
      const at = graphic.stepAt?.[i] ?? Math.round(((i + 1) * ms * 0.5) / (n + 1))
      // In from the left: a transform toward the start never reads as overflow
      animate(`i${i}`, [{ opacity: 0, transform: `translateX(-${Math.round(item)}px)` }, { opacity: 1, transform: "translateX(0px)" }], { duration: 320, delay: Math.max(0, Math.min(at - 320, ms - 900)), easing: EASE })
    })
    fit = { id: "t", within: "a", min: floor }
  } else if (kind === "callout" && graphic.mark) {
    // TP9: round the box the person drew, exactly: the solver gave its pixels as the area. A ring is an
    // ellipse inside it, a box its edges, an arrow points down at its top from above (or up from below
    // when there is no room); a label sits on the side away from the arrow
    const side = Math.min(area.w, area.h)
    const label = Math.max(floor, Math.round(Math.max(side, output.height * 0.12) * 0.13))
    const head = Math.max(bar * 3, Math.round(output.height * 0.03))
    const shaft = Math.round(head * 1.6)
    const below = area.y < head + shaft + label * 2
    const arrow = style === "arrow"
    css = [
      `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px}`,
      arrow
        ? `#k{position:absolute;left:50%;${below ? `top:${area.h}px` : `bottom:${area.h}px`};width:${bar * 2}px;height:${shaft + head}px;margin-left:-${bar}px;transform-origin:50% ${below ? "0" : "100%"}}#k::after{content:"";position:absolute;left:50%;${below ? "top:0" : "bottom:0"};margin-left:-${head}px;border-left:${head}px solid transparent;border-right:${head}px solid transparent;${below ? `border-bottom:${head}px solid ${accent}` : `border-top:${head}px solid ${accent}`}}#k::before{content:"";position:absolute;left:0;right:0;${below ? `top:${head - 1}px` : `bottom:${head - 1}px`};height:${shaft}px;background:${accent}}`
        : `#k{position:absolute;inset:0;${style === "ring" ? "border-radius:50%" : `border-radius:${Math.round(side * 0.06)}px`};border:${bar}px solid ${accent};box-sizing:border-box;box-shadow:0 0 0 ${Math.max(2, Math.round(bar / 2))}px #00000055}`,
      `#m{position:absolute;left:50%;${arrow ? (below ? `top:${area.h + shaft + head + Math.round(label * 0.3)}px` : `bottom:${area.h + shaft + head + Math.round(label * 0.3)}px`) : area.y > label * 2 ? `bottom:${area.h + Math.round(label * 0.3)}px` : `top:${area.h + Math.round(label * 0.3)}px`};transform:translateX(-50%);width:max-content;max-width:${Math.round(output.width * 0.8)}px;text-align:center;font-family:${font};font-size:${label}px;font-weight:800;line-height:1.2;color:${ink};background:${accent};padding:${Math.round(label * 0.15)}px ${Math.round(label * 0.45)}px;border-radius:${Math.round(label * 0.3)}px}`,
    ]
    body = `<div id="a"><span id="k"></span>${text ? `<span id="m" data-text>${escape(text)}</span>` : ""}</div>`
    animate("k", arrow ? [{ transform: "scaleY(0)", opacity: 0 }, { transform: "scaleY(1)", opacity: 1 }] : [{ transform: "scale(1.15)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 380, easing: EASE })
    if (text) fade("m", 220)
  } else if (kind === "callout") {
    // A mark round the point: its size is the box the solver gave, the label above it when there is one
    const side = Math.min(area.w, area.h)
    const label = Math.max(floor, Math.round(side * 0.13))
    const shape = style === "ring" ? `border-radius:50%;border:${bar}px solid ${accent}` : style === "box" ? `border-radius:${Math.round(side * 0.08)}px;border:${bar}px solid ${accent}` : ""
    css = [
      `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${side}px;height:${side}px}`,
      style === "arrow"
        ? `#k{position:absolute;left:50%;top:${Math.round(side * 0.5)}px;width:0;height:0;margin-left:-${Math.round(side * 0.09)}px;border-left:${Math.round(side * 0.09)}px solid transparent;border-right:${Math.round(side * 0.09)}px solid transparent;border-top:${Math.round(side * 0.16)}px solid ${accent};transform-origin:50% 0}`
        : `#k{position:absolute;inset:${Math.round(side * 0.06)}px;${shape};box-sizing:border-box;box-shadow:0 0 0 ${Math.max(2, Math.round(bar / 2))}px #00000055}`,
      `#m{position:absolute;left:50%;bottom:${style === "arrow" ? Math.round(side * 0.52) : Math.round(side * 0.98)}px;transform:translateX(-50%);width:max-content;max-width:${Math.round(Math.min(output.width * 0.8, Math.max(side, output.width * 0.5)))}px;text-align:center;font-family:${font};font-size:${label}px;font-weight:800;line-height:1.2;color:${ink};background:${accent};padding:${Math.round(label * 0.15)}px ${Math.round(label * 0.45)}px;border-radius:${Math.round(label * 0.3)}px}`,
    ]
    body = `<div id="a"><span id="k"></span>${text ? `<span id="m" data-text>${escape(text)}</span>` : ""}</div>`
    animate("k", [{ transform: "scale(1.4)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 380, easing: EASE })
    if (text) fade("m", 220)
  } else if (kind === "count") {
    const main = Math.max(floor, Math.round(area.h * (subtitle ? 0.4 : 0.55)))
    const ratio = 0.42 // the subtitle's size to the number's
    const steps = countSteps(text)
    css = [
      box,
      `#t{position:relative;box-sizing:border-box;max-width:100%;display:flex;flex-direction:column;align-items:center;gap:.12em;padding:${pad}px ${Math.round(pad * 2)}px;background:${tone.plate};border-radius:${Math.round(area.h * 0.1)}px;font-family:${font};color:${tone.ink};text-align:center;font-size:${main}px}`,
      `#c{display:grid}#c>span{grid-area:1/1;font-size:1em;line-height:1.2;font-weight:800;font-variant-numeric:tabular-nums;background:${tone.plate};white-space:nowrap}`,
      `#u{display:block;padding:0 .08em;background:${tone.plate};font-size:max(${floor}px,${ratio}em);line-height:1.25;font-weight:600}`,
      `#k{height:${bar}px;width:100%;background:${accent};border-radius:${bar}px}`,
    ]
    // The said number is the last step and the text QG-10 reads at rest; the steps before it are only shown, never measured
    const shown = steps ?? [text]
    body = `<div id="a"><div id="t"><span id="c">${shown.map((v, i) => `<span id="c${i}"${i === shown.length - 1 ? " data-text" : ""}>${escape(v)}</span>`).join("")}</span><span id="k"></span>${subtitle ? `<span id="u" data-text>${escape(subtitle)}</span>` : ""}</div></div>`
    spring("t", { scale: 0.7, opacity: 0 })
    const step = 70
    shown.forEach((_, i) => {
      const on = i * step
      const off = i === shown.length - 1 ? ms : on + step
      animate(`c${i}`, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: round(on / ms) }, { opacity: 1, offset: round(Math.min(1, on / ms)) }, { opacity: 1, offset: round(Math.min(1, off / ms)) }, { opacity: i === shown.length - 1 ? 1 : 0, offset: round(Math.min(1, off / ms)) }, { opacity: i === shown.length - 1 ? 1 : 0, offset: 1 }], { duration: ms, easing: "linear" })
    })
    if (subtitle) fade("u", 320)
    fit = { id: "t", within: "a", min: floor }
  } else if (kind === "handle" || kind === "cta") {
    const main = Math.max(floor, Math.round(area.h * (kind === "cta" && subtitle ? 0.36 : 0.5)))
    const ratio = 0.6
    css = [
      box,
      `#t{box-sizing:border-box;max-width:100%;display:flex;flex-direction:column;align-items:center;gap:.1em;padding:${Math.round(pad * 0.8)}px ${Math.round(pad * 1.8)}px;background:${accent};border-radius:${Math.round(area.h / 2)}px;font-family:${font};color:${ink};font-size:${main}px}`,
      // A handle is a name: it may break anywhere rather than run out of its corner
      `#m{display:block;background:${accent};font-size:1em;line-height:1.2;font-weight:800;text-align:center;text-wrap:balance${kind === "handle" ? ";overflow-wrap:anywhere" : ""}}`,
      `#u{display:block;background:${accent};font-size:max(${floor}px,${ratio}em);line-height:1.2;font-weight:600;text-align:center}`,
    ]
    body = `<div id="a"><div id="t"><span id="m" data-text>${escape(text)}</span>${subtitle ? `<span id="u" data-text>${escape(subtitle)}</span>` : ""}</div></div>`
    animate("t", [{ transform: "translateY(40%)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], { duration: 420, easing: EASE })
    if (subtitle) fade("u", 260)
    fit = { id: "t", within: "a", min: floor }
  } else if (kind === "frame") {
    // A plain drawn frame round the picture: a border and a soft shadow, nothing of any device
    const inset = Math.round(Math.min(output.width, output.height) * 0.035)
    css = [`#a{position:absolute;inset:0}`, `#k{position:absolute;inset:${inset}px;border:${Math.max(4, Math.round(bar * 1.4))}px solid ${accent};border-radius:${Math.round(inset * 0.6)}px;box-shadow:0 0 0 ${inset}px #00000033}`]
    body = `<div id="a"><span id="k"></span></div>`
    animate("k", [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }], { duration: 520, easing: EASE })
  } else {
    // The four more name straps (kind lower)
    const main = Math.max(floor, Math.round(area.h * (subtitle ? 0.34 : 0.42)))
    const ratio = 0.56
    const radius = style === "box" ? 0 : Math.round(area.h * 0.1)
    css = [
      `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:center;justify-content:flex-start}`,
      `#t{position:relative;box-sizing:border-box;max-width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:.15em;padding:${pad}px ${Math.round(pad * 2.2)}px;background:${tone.plate};border-radius:${radius}px;font-family:${font};color:${tone.ink};font-size:${main}px;${style === "box" ? `border-left:${bar * 3}px solid ${accent};` : ""}}`,
      `#m{display:block;padding:0 .08em;background:${tone.plate};font-size:1em;line-height:1.2;font-weight:800}`,
      style === "split" ? `#u{display:block;white-space:nowrap;font-size:max(${floor}px,${ratio}em);line-height:1.25;font-weight:700;background:${accent};color:${ink};padding:.15em .45em;border-radius:.25em}` : `#u{display:block;padding:0 .08em;background:${tone.plate};font-size:max(${floor}px,${ratio}em);line-height:1.25;font-weight:600;white-space:nowrap}`,
      style === "tag" ? `#g{display:block;width:1.6em;height:${bar * 2}px;background:${accent};border-radius:${bar}px}` : "",
      style === "underline" ? `#k{height:${bar}px;width:100%;background:${accent};border-radius:${bar}px;transform-origin:left}` : "",
    ]
    body = `<div id="a"><div id="t">${style === "tag" ? `<span id="g"></span>` : ""}<span id="m" data-text>${escape(text)}</span>${style === "underline" ? `<span id="k"></span>` : ""}${subtitle ? `<span id="u" data-text>${escape(subtitle)}</span>` : ""}</div></div>`
    animate("t", [{ transform: `translateX(-${Math.round(area.w * 0.1)}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: 460, easing: EASE })
    if (style === "underline") animate("k", [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 380, delay: 200, easing: EASE })
    if (subtitle) fade("u", 300)
    fit = { id: "t", within: "a", min: floor }
  }
  return { css: [kit?.faces ?? "", ...css].join(""), body, animations, ...(fit ? { fit } : {}) }
}

/** Kit 2 kinds a make or chat may offer: the person's own words only where `person` (handle, cta). */
export const kindsFor = ({ typeKit }) => (typeKit === true ? ALL_GRAPHIC_KINDS : GRAPHIC_KINDS)
export { REGIONS }
