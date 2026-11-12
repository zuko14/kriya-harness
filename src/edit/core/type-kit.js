// The type kit and the person's brand (TP7, CRAFT_UPGRADE §5.2, EDD-67): one per film, a
// heading face and a text face from a fixed table of pairs, a size scale tied to the frame's
// height, tracking, case and weight; the person's own colours, typed as hex, with the plate or
// outline chosen by code so text still holds 4.5:1; a logo from the bin as a corner bug; a
// bar across the cut. Stored on the project (`look.brand.type`) only when the person or an
// approved plan chooses it (EH-69): a project without one keeps the system stacks, and every
// box it draws is the box it drew. Data only: font ids, never a path, URL or file.

/** The pairs. Font ids are the Media Runtime's pack-fonts artifacts (engine/fonts.js). */
export const PAIRS = {
  clean: { label: "Clean", heading: { font: "font-inter", weight: 800, case: "none", tracking: -0.01 }, body: { font: "font-inter", weight: 600, case: "none", tracking: 0 } },
  bold: { label: "Bold", heading: { font: "font-oswald", weight: 700, case: "upper", tracking: 0.02 }, body: { font: "font-inter", weight: 700, case: "none", tracking: 0 } },
  modern: { label: "Modern", heading: { font: "font-montserrat", weight: 800, case: "none", tracking: -0.01 }, body: { font: "font-inter", weight: 600, case: "none", tracking: 0 } },
  story: { label: "Story", heading: { font: "font-lora", weight: 700, case: "none", tracking: 0 }, body: { font: "font-lora", weight: 600, case: "none", tracking: 0 } },
  tech: { label: "Technical", heading: { font: "font-jetbrains-mono", weight: 700, case: "none", tracking: -0.02 }, body: { font: "font-inter", weight: 600, case: "none", tracking: 0 } },
  hand: { label: "Handwritten", heading: { font: "font-caveat", weight: 700, case: "none", tracking: 0 }, body: { font: "font-inter", weight: 600, case: "none", tracking: 0 } },
}

/** Sizes as shares of the frame's height (a tall frame and a wide one read alike). The smallest stays over QG-09's 0.02. */
export const SCALE = { display: 0.085, heading: 0.06, caption: 0.044, body: 0.032, small: 0.024 }
export const typeScale = (height) => Object.fromEntries(Object.entries(SCALE).map(([step, share]) => [step, Math.round(share * height)]))

export const BARS = ["progress", "chapters"]
export const CORNERS = ["tl", "tr", "bl", "br"]
export const CONTRAST = 4.5 // QG-09's floor, WCAG AA
const HEX = /^#[0-9a-f]{6}$/i
const COLOR_KEYS = ["text", "accent", "plate"]

/* ─────────────────────────────── contrast ─────────────────────────────── */

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
/** WCAG relative luminance of a #rrggbb. */
export function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel(((n >> 16) & 255) / 255) + 0.7152 * channel(((n >> 8) & 255) / 255) + 0.0722 * channel((n & 255) / 255)
}
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const DARK = "#0a0a0a"
const LIGHT = "#ffffff"
/** Of black and white, the one further from `hex`. */
export const against = (hex) => (contrastRatio(hex, DARK) >= contrastRatio(hex, LIGHT) ? DARK : LIGHT)

/**
 * A box behind `ink` in the colour of `accent`, moved toward black or white in steps until the ink
 * holds 4.5:1 on it (TP7's box marks): the word keeps its own ink and outline, so QG-09 reads it as
 * it reads the page.
 */
export function boxFor(accent, ink) {
  const toward = against(ink) === DARK ? [10, 10, 10] : [255, 255, 255]
  const n = Number.parseInt(accent.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  for (let step = 0; step <= 20; step++) {
    const mixed = `#${rgb.map((c, i) => Math.round(c + ((toward[i] - c) * step) / 20).toString(16).padStart(2, "0")).join("")}`
    if (contrastRatio(ink, mixed) >= CONTRAST) return mixed
  }
  return against(ink)
}

/**
 * The person's colours made readable (CRAFT §5.2): text and accent are kept as typed; what
 * is behind them is chosen so both hold 4.5:1. With a plate, the plate is theirs if it
 * holds, else black or white; with no plate, an outline in black or white, and a plate
 * when even that can't hold (a mid grey reads on neither).
 * @param {{ text?: string, accent?: string, plate?: string }} colors hex
 * @param {{ plate: boolean }} look whether the look draws a plate behind the words
 * @returns {{ text: string, accent: string, plate: string | null, stroke: string | null, clamped: string[] }}
 */
export function readableColors(colors, { plate: hasPlate }) {
  const text = HEX.test(colors.text ?? "") ? colors.text.toLowerCase() : LIGHT
  const accent = HEX.test(colors.accent ?? "") ? colors.accent.toLowerCase() : text
  const holds = (bg) => contrastRatio(text, bg) >= CONTRAST && contrastRatio(accent, bg) >= CONTRAST
  const worst = (bg) => Math.min(contrastRatio(text, bg), contrastRatio(accent, bg))
  const best = worst(DARK) >= worst(LIGHT) ? DARK : LIGHT
  const clamped = []
  // On a plate, what can't hold gives way: the text to black or white, then the accent to the text
  const onPlate = (plate) => {
    let ink = text
    if (contrastRatio(ink, plate) < CONTRAST) {
      ink = against(plate)
      clamped.push(`text ${text} → ${ink}`)
    }
    let mark = accent
    if (contrastRatio(mark, plate) < CONTRAST) {
      mark = ink
      clamped.push(`accent ${accent} → ${ink}`)
    }
    return { text: ink, accent: mark, plate, stroke: null, clamped }
  }
  if (hasPlate) {
    const typed = HEX.test(colors.plate ?? "") ? colors.plate.toLowerCase() : null
    if (typed && holds(typed)) return { text, accent, plate: typed, stroke: null, clamped }
    // Their plate holds their text: keep it, and only the accent gives way
    if (typed && contrastRatio(text, typed) >= CONTRAST) return onPlate(typed)
    if (typed) clamped.push(`plate ${typed} → ${best}`)
    return onPlate(best)
  }
  if (holds(best)) return { text, accent, plate: null, stroke: best, clamped }
  clamped.push("a plate behind the words, since no outline holds 4.5:1")
  return onPlate(best)
}

/* ─────────────────────────────── the stored kit ─────────────────────────────── */

/**
 * A type kit at a trust boundary (an operation, a browser, a plan): unknown fields go.
 * @param {unknown} raw
 * @param {{ packs?: Record<string, unknown> }} [tables] style pack ids allowed
 * @returns {{ kit: object | null, problem: string | null }} kit null with no problem: no kit (system stacks)
 */
export function cleanTypeKit(raw, { packs = {} } = {}) {
  if (raw === null || raw === undefined) return { kit: null, problem: null }
  if (typeof raw !== "object" || Array.isArray(raw)) return { kit: null, problem: "a type kit is an object" }
  if (!Object.hasOwn(PAIRS, raw.pair ?? "")) return { kit: null, problem: `a type kit needs a pair: ${Object.keys(PAIRS).join(", ")}` }
  const kit = { pair: raw.pair }
  if (raw.colors !== undefined) {
    if (!raw.colors || typeof raw.colors !== "object") return { kit: null, problem: "colours are { text, accent, plate } in #rrggbb" }
    const colors = {}
    for (const key of COLOR_KEYS) {
      if (raw.colors[key] === undefined) continue
      if (!HEX.test(raw.colors[key])) return { kit: null, problem: `the ${key} colour must be #rrggbb` }
      colors[key] = raw.colors[key].toLowerCase()
    }
    if (Object.keys(colors).length) kit.colors = colors
  }
  if (raw.logo !== undefined) {
    if (typeof raw.logo !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.logo)) return { kit: null, problem: "the logo is a file of this project, by its id" }
    kit.logo = raw.logo
    kit.corner = CORNERS.includes(raw.corner) ? raw.corner : "tr"
  }
  if (raw.bar !== undefined) {
    if (!BARS.includes(raw.bar)) return { kit: null, problem: `a bar is ${BARS.join(" or ")}` }
    kit.bar = raw.bar
  }
  if (raw.pack !== undefined) {
    if (!Object.hasOwn(packs, raw.pack)) return { kit: null, problem: "there is no style pack by that name" }
    kit.pack = raw.pack
  }
  return { kit, problem: null }
}

/**
 * The kit a project chose, read defensively from `look.brand.type` (an older `set_look`
 * could write anything there): null when there is none or it isn't one.
 */
export function typeKitOf(project) {
  const raw = project?.look?.brand?.type
  if (!raw || !Object.hasOwn(PAIRS, raw.pair ?? "")) return null
  // The pack's name is only a label here: the pack's choices are already stored as themselves
  const { kit } = cleanTypeKit({ ...raw, pack: undefined })
  return kit && typeof raw.pack === "string" && /^[a-z0-9-]{1,40}$/.test(raw.pack) ? { ...kit, pack: raw.pack } : kit
}

/**
 * The kit as a tile node carries it (plan.js): the pair's faces, the colours, and whether
 * this computer has the shipped fonts. Part of the tile's key, so a change re-renders.
 * @param {object} kit from typeKitOf
 * @param {string[] | undefined} installed the pack's font ids here
 */
export function kitNode(kit, installed) {
  const pair = PAIRS[kit.pair]
  const have = new Set(installed ?? [])
  return {
    pair: kit.pair,
    heading: pair.heading,
    body: pair.body,
    ...(kit.colors ? { colors: kit.colors } : {}),
    shipped: have.has(pair.heading.font) && have.has(pair.body.font),
  }
}
