// The motion kit (MOTION_GRAPHICS.md, EDD-58): titles, name straps, opening and end cards,
// quotes and numbers over the footage, drawn by Kriya's own code from typed variables. No
// model writes code here. Web Animations only, so a graphic seeks and renders like every
// other tile: no clock, no randomness, no network. Each sits in the box the layout solver
// gives it, clear of the speaker's face and the captions, and its words are `text` and
// `subtitle`, so the copy and contrast gates read it as they read a title.

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
export function cleanGraphic(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const kind = pick(GRAPHIC_KINDS, raw.kind, null)
  if (!kind) return null
  const shape = GRAPHIC_KINDS[kind]
  const text = cleanText(raw.text)
  if (!text || (shape.number && !NUMBER.test(text))) return null
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
    // Set by the recipe on a graphic an approved plan asked for, so a remake replaces it
    ...(raw.plan === true ? { plan: true } : {}),
  }
}

/** How long a graphic stays up: long enough to read, never long enough to bore. In flicks. */
export function graphicLength(graphic) {
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
export function buildGraphic({ variables, area, output, duration }, springKeyframes) {
  const graphic = cleanGraphic(variables)
  if (!graphic) throw new EngineFailure("plan", "bad_graphic", "This graphic's variables don't describe a graphic.")
  const { kind, style, text, subtitle } = graphic
  const tone = GRAPHIC_TONES[graphic.tone]
  const accent = GRAPHIC_ACCENTS[graphic.accent]
  const font = GRAPHIC_FONTS[graphic.font]
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
