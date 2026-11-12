// The effects registry (TP5, CRAFT_UPGRADE §3, EDD-64), behind editing.craft: every effect is a
// typed row of data. An operation may store only an id and values the row allows, so nothing is
// stored that the render can't draw; code alone turns a row into FFmpeg filter steps, from numbers.
// Each row's `needs` were confirmed against this computer's FFmpeg (9.0.2) in spike TPX-02; a
// runtime without one of them drops the effect at compile with a note, never fakes it.

import { escapeFilterValue } from "./ffmpeg.js"

const FLICKS = 705_600_000
export const MAX_POINTS = 16
export const EASES = ["linear", "in", "out", "inOut", "hold"]
// A look may move skin this far, no further (CRAFT §3.4); beyond it the effect is eased on that clip
export const SKIN = { hue: 12, saturation: 0.35 }
// Restraint (CRAFT §3.5): what an agent may add, per minute of the cut; the person is never capped
export const AGENT_CAP_PER_MINUTE = 3

const filter = (name, options = {}) => (Object.keys(options).length ? `${name}=${Object.entries(options).map(([k, v]) => `${k}=${escapeFilterValue(v)}`).join(":")}` : name)
const n = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(4))

// A hue angle as an RGB colour in 0…1, for duotone's ends
const rgbOf = (hue, light) => {
  const k = (m) => (m + hue / 30) % 12
  const a = 0.6 * Math.min(light, 1 - light)
  return [0, 8, 4].map((m) => light - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1)))
}

/**
 * The rows. params: name → [min, max, default]. keyable: params a keyframe may move (the filter takes
 * an expression evaluated per frame). build(values, ctx) → filter steps, where a keyed value arrives as
 * an expression string. preview: a CSS filter, or null when the monitor can't draw it. gate: what QG-07
 * and QG-11 should expect inside it. skin: how far it moves skin hue (degrees) and saturation, at most.
 */
export const EFFECTS = {
  // region (TP9): may act on a box drawn on the frame only
  blur: { group: "focus", label: "Blur", params: { amount: [0.5, 40, 8] }, needs: ["gblur"], weight: "light", region: true, build: ({ amount }) => [filter("gblur", { sigma: amount })], preview: ({ amount }) => `blur(${(amount * 0.5).toFixed(1)}px)` },
  sharpen: { group: "focus", label: "Sharpen", params: { amount: [0.1, 3, 1] }, needs: ["unsharp"], weight: "light", build: ({ amount }) => [filter("unsharp", { luma_msize_x: 5, luma_msize_y: 5, luma_amount: amount })], preview: () => "contrast(1.05)" },
  vignette: { group: "focus", label: "Vignette", params: { strength: [0, 1, 0.5] }, keyable: ["strength"], needs: ["vignette"], weight: "light", build: ({ strength }) => [filter("vignette", { angle: typeof strength === "string" ? `0.25+0.45*(${strength})` : n(0.25 + 0.45 * strength), eval: "frame" })], preview: () => null },
  grain: { group: "texture", label: "Grain", params: { amount: [1, 40, 12] }, needs: ["noise"], weight: "light", build: ({ amount }) => [filter("noise", { alls: Math.round(amount), allf: "t+u", all_seed: 1234 })], preview: () => null },
  glow: { group: "texture", label: "Glow", params: { amount: [0.05, 1, 0.4], radius: [2, 40, 12] }, needs: ["split", "gblur", "blend"], weight: "light", build: ({ amount, radius }, { uid }) => { const i = uid(); return [`split[gw${i}][gx${i}];[gx${i}]${filter("gblur", { sigma: radius })}[gy${i}];[gw${i}][gy${i}]${filter("blend", { all_mode: "screen", all_opacity: amount })}`] }, preview: ({ amount }) => `brightness(${(1 + amount * 0.25).toFixed(2)})` },
  blackWhite: { group: "colour", label: "Black and white", params: { amount: [0, 1, 1] }, keyable: ["amount"], needs: ["hue"], weight: "light", build: ({ amount }) => [filter("hue", { s: typeof amount === "string" ? `1-(${amount})` : n(1 - amount) })], preview: ({ amount }) => `grayscale(${amount})` },
  tint: { group: "colour", label: "Tint", params: { hue: [0, 360, 30], amount: [0, 1, 0.3] }, needs: ["colorize"], weight: "light", build: ({ hue, amount }) => [filter("colorize", { hue, saturation: 0.6, lightness: 0.5, mix: amount })], preview: ({ amount }) => `sepia(${amount})`, skin: ({ amount }) => ({ hue: 180 * amount, saturation: 0 }) },
  duotone: { group: "colour", label: "Duotone", params: { dark: [0, 360, 220], light: [0, 360, 40] }, needs: ["hue", "curves"], weight: "heavy", build: ({ dark, light }) => { const [d, l] = [rgbOf(dark, 0.2), rgbOf(light, 0.85)]; return [filter("hue", { s: 0 }), filter("curves", { r: `0/${d[0].toFixed(3)} 1/${l[0].toFixed(3)}`, g: `0/${d[1].toFixed(3)} 1/${l[1].toFixed(3)}`, b: `0/${d[2].toFixed(3)} 1/${l[2].toFixed(3)}` })] }, preview: () => "grayscale(1) sepia(0.6)", skin: () => ({ hue: 180, saturation: 0 }) },
  invert: { group: "colour", label: "Invert", params: {}, needs: ["negate"], weight: "heavy", build: () => ["negate"], preview: () => "invert(1)", skin: () => ({ hue: 180, saturation: 0 }) },
  mirror: { group: "frame", label: "Mirror", params: {}, needs: ["hflip"], weight: "light", build: () => ["hflip"], preview: () => null },
  letterbox: { group: "frame", label: "Letterbox", params: { ratio: [1.5, 3, 2.39] }, needs: ["drawbox"], weight: "light", build: ({ ratio }, { width, height }) => { const bar = Math.max(0, Math.floor((height - width / ratio) / 2)); return bar ? [filter("drawbox", { x: 0, y: 0, w: width, h: bar, color: "black", t: "fill" }), filter("drawbox", { x: 0, y: height - bar, w: width, h: bar, color: "black", t: "fill" })] : [] }, preview: () => null },
  pixelate: { group: "energy", label: "Pixelate", params: { size: [2, 64, 16] }, needs: ["scale"], weight: "heavy", region: true, build: ({ size }, { width, height }) => [filter("scale", { w: Math.max(2, Math.round(width / size)), h: Math.max(2, Math.round(height / size)), flags: "neighbor" }), filter("scale", { w: width, h: height, flags: "neighbor" })], preview: () => null },
  colourSplit: { group: "energy", label: "Colour split", params: { amount: [1, 30, 6] }, needs: ["rgbashift"], weight: "heavy", build: ({ amount }) => [filter("rgbashift", { rh: -Math.round(amount), bh: Math.round(amount) })], preview: () => null },
  shake: { group: "energy", label: "Shake", params: { amount: [1, 40, 8], speed: [1, 30, 8] }, keyable: ["amount"], needs: ["crop", "scale"], weight: "heavy", gate: "motion", build: ({ amount, speed }, { width, height, max }) => { const a = typeof amount === "string" ? `(${amount})` : n(amount); const m = Math.ceil(max.amount); return [filter("crop", { w: width - 2 * m, h: height - 2 * m, x: `${m}+${a}*sin(2*PI*${n(speed)}*t)`, y: `${m}+${a}*cos(2*PI*${n(speed * 1.3)}*t)` }), filter("scale", { w: width, h: height })] }, preview: () => null },
  flash: { group: "energy", label: "Flash", params: { length: [0.05, 1, 0.2] }, needs: ["fade"], weight: "heavy", gate: "flash", build: ({ length }, { origin }) => (origin < -length ? [] : [filter("fade", { t: "in", st: n(Math.max(0, origin)), d: n(Math.max(0.01, length + Math.min(0, origin))), color: "white" })]), preview: () => null },
  glitch: { group: "energy", label: "Glitch", params: { amount: [0.1, 1, 0.5] }, needs: ["crop", "scale", "rgbashift"], weight: "heavy", gate: "motion", build: ({ amount }, { width, height }) => { const m = Math.max(2, Math.round(16 * amount)); return [filter("crop", { w: width - 2 * m, h: height - 2 * m, x: `${m}+if(lt(mod(n*7919,97),${Math.round(30 * amount)}),${m}*(mod(n*104729,3)-1),0)`, y: m }), filter("scale", { w: width, h: height }), filter("rgbashift", { rh: -m, bh: m })] }, preview: () => null },
  // TP9: "mask this": the frame outside a drawn box darkened and drained, so the eye goes to what was drawn.
  // Needs a region; drawn on the whole frame, then the box laid back over it untouched (fxSteps)
  mask: { group: "focus", label: "Mask", params: { amount: [0.1, 1, 0.6] }, needs: ["eq", "crop", "split"], weight: "light", region: true, needsRegion: true, outside: true, build: ({ amount }) => [filter("eq", { brightness: n(-0.45 * amount), saturation: n(1 - 0.7 * amount) })], preview: () => null },
  // Looks (CRAFT §3.4): data, made by Kriya, each a few filters with fixed numbers
  film: { group: "look", label: "Film", params: {}, needs: ["curves", "noise", "vignette"], weight: "light", build: () => [filter("curves", { preset: "vintage" }), filter("noise", { alls: 8, allf: "t+u", all_seed: 2718 }), filter("vignette", { angle: 0.45 })], preview: () => "sepia(0.25) contrast(1.05)", skin: () => ({ hue: 8, saturation: 0 }) },
  noir: { group: "look", label: "Noir", params: {}, needs: ["hue", "eq", "noise", "vignette"], weight: "light", build: () => [filter("hue", { s: 0 }), filter("eq", { contrast: 1.25 }), filter("noise", { alls: 10, allf: "t+u", all_seed: 3141 }), filter("vignette", { angle: 0.6 })], preview: () => "grayscale(1) contrast(1.25)" },
  faded: { group: "look", label: "Faded", params: {}, needs: ["curves", "eq"], weight: "light", build: () => [filter("curves", { all: "0/0.08 1/0.92" }), filter("eq", { saturation: 0.8 })], preview: () => "saturate(0.8) contrast(0.85)" },
  punchy: { group: "look", label: "Punchy", params: {}, needs: ["eq"], weight: "light", build: () => [filter("eq", { contrast: 1.12, saturation: 1.3 })], preview: () => "contrast(1.12) saturate(1.3)", skin: () => ({ hue: 0, saturation: 0.3 }) },
  tealOrange: { group: "look", label: "Teal and orange", params: {}, needs: ["colorbalance"], weight: "light", build: () => [filter("colorbalance", { rs: -0.08, bs: 0.1, rh: 0.1, bh: -0.08 })], preview: () => null, skin: () => ({ hue: 6, saturation: 0.1 }) },
}

/**
 * Named moves (CRAFT §3.3): what the Director picks instead of writing points; code expands each
 * over the effect's own span into keyframes, so the same move is the same expression every render.
 */
export const MOVES = {
  drain: { effect: "blackWhite", param: "amount", label: "colour drains to black and white", points: (span) => [{ at: 0, value: 0, ease: "inOut" }, { at: span, value: 1, ease: "linear" }] },
  settle: { effect: "shake", param: "amount", label: "a shake that settles", points: (span, v) => [{ at: 0, value: v, ease: "out" }, { at: span, value: 1, ease: "linear" }] },
  closeIn: { effect: "vignette", param: "strength", label: "the edges close in", points: (span, v) => [{ at: 0, value: 0, ease: "in" }, { at: span, value: v, ease: "linear" }] },
}

/** A drawn region (TP9): whole thousandths of the frame, inside it, each side at least 10. @returns {{ x: number, y: number, w: number, h: number } | null} */
export function regionOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["x", "y", "w", "h"].includes(key))) return null
  const { x, y, w, h } = raw
  if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < 10 || h < 10 || x + w > 1000 || y + h > 1000) return null
  return { x, y, w, h }
}

// A region in whole, even pixels of a width × height picture, so 4:2:0 chroma never splits (shortcut: even
// edges move a box by at most a pixel; a 4:4:4 pipeline would take them as drawn)
const even = (v) => 2 * Math.round(v / 2)
export function regionPixels(region, width, height) {
  const x = Math.min(even((region.x * width) / 1000), width - 2)
  const y = Math.min(even((region.y * height) / 1000), height - 2)
  return { x, y, w: Math.max(2, Math.min(even((region.w * width) / 1000), width - x)), h: Math.max(2, Math.min(even((region.h * height) / 1000), height - y)) }
}

/** A row's values: the defaults, then what was given; each checked against its range. @returns {{ values: object } | { problem: string }} */
export function valuesOf(id, params = {}) {
  const row = EFFECTS[id]
  if (!row) return { problem: `there is no "${id}" effect: ${Object.keys(EFFECTS).join(", ")}` }
  if (params === null || typeof params !== "object" || Array.isArray(params)) return { problem: "an effect's values are named numbers" }
  for (const key of Object.keys(params)) if (!Object.hasOwn(row.params, key)) return { problem: `${row.label} has no value "${key}"` }
  const values = {}
  for (const [key, [min, max, fallback]] of Object.entries(row.params)) {
    const value = params[key] ?? fallback
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return { problem: `${row.label}'s ${key} is between ${min} and ${max}` }
    values[key] = value
  }
  return { values }
}

/** Keyframes checked: keyable params only, at most 16 points, integer flicks in order, values in range, a known ease. */
export function keysProblem(id, keys) {
  const row = EFFECTS[id]
  if (!Array.isArray(keys)) return "keyframes are a list"
  for (const key of keys) {
    if (!key || !(row.keyable ?? []).includes(key.param)) return `${row.label} can't be keyframed${row.keyable?.length ? ` except ${row.keyable.join(", ")}` : ""}`
    const [min, max] = row.params[key.param]
    if (!Array.isArray(key.points) || key.points.length < 2 || key.points.length > MAX_POINTS) return `keyframes have 2 to ${MAX_POINTS} points`
    let last = -1
    for (const p of key.points) {
      if (!Number.isSafeInteger(p?.at) || p.at < 0 || p.at <= last) return "keyframe times are whole flicks from the effect's start, in order"
      if (typeof p.value !== "number" || p.value < min || p.value > max) return `${key.param} is between ${min} and ${max}`
      if (!EASES.includes(p.ease ?? "linear")) return `an ease is one of ${EASES.join(", ")}`
      last = p.at
    }
  }
  return null
}

const EASE = { linear: (u) => u, in: (u) => `(${u})*(${u})`, out: (u) => `(1-(1-(${u}))*(1-(${u})))`, inOut: (u) => `(${u})*(${u})*(3-2*(${u}))`, hold: () => "0" }

/** Points → one piecewise expression in the filter's `t`, shifted so 0 is the effect's start (origin, seconds). */
export function keyExpression(points, origin = 0) {
  const T = origin === 0 ? "t" : `(t-${n(origin)})`
  const secs = (at) => n(at / FLICKS)
  let expr = n(points.at(-1).value)
  for (let i = points.length - 2; i >= 0; i--) {
    const [a, b] = [points[i], points[i + 1]]
    const u = `(${T}-${secs(a.at)})/${secs(b.at - a.at)}`
    expr = `if(lt(${T},${secs(b.at)}),${n(a.value)}+${n(b.value - a.value)}*${EASE[a.ease ?? "linear"](u)},${expr})`
  }
  return `if(lt(${T},${secs(points[0].at)}),${n(points[0].value)},${expr})`
}

/** A named move expanded over a span (flicks) into keys; null when the move isn't for this effect. */
export function expandMove(move, id, values, span) {
  const m = MOVES[move]
  if (!m || m.effect !== id || span <= 0) return null
  return [{ param: m.param, points: m.points(span, values[m.param]) }]
}

/**
 * The filter steps for one stored effect `{ type: "fx", id, params?, keys?, move?, ease? }`.
 * origin: seconds from this chain's 0 to the effect's start; span: its length in flicks.
 * ease (the skin guard's): the effect is mixed back with the picture at that strength.
 */
export function fxSteps(fx, { width, height, uid, origin = 0, span = 0 }) {
  const row = EFFECTS[fx.id]
  const { values } = valuesOf(fx.id, fx.params)
  const keys = fx.keys ?? (fx.move ? expandMove(fx.move, fx.id, values, span) : null) ?? []
  const max = { ...values }
  const given = { ...values }
  for (const key of keys) {
    given[key.param] = keyExpression(key.points, origin)
    max[key.param] = Math.max(...key.points.map((p) => p.value))
  }
  let steps
  if (fx.region) {
    // TP9: crop the drawn box, act on it, lay it back exactly where it was; a mask acts outside it instead
    const box = regionPixels(fx.region, width, height)
    const crop = filter("crop", { w: box.w, h: box.h, x: box.x, y: box.y })
    const place = filter("overlay", { x: box.x, y: box.y })
    const i = uid()
    const inner = row.build(given, { width: row.outside ? width : box.w, height: row.outside ? height : box.h, uid, origin, max })
    if (!inner.length) return []
    steps = row.outside ? [`split[ra${i}][rb${i}];[ra${i}]${inner.join(",")}[rc${i}];[rb${i}]${crop}[rd${i}];[rc${i}][rd${i}]${place}`] : [`split[ra${i}][rb${i}];[rb${i}]${crop},${inner.join(",")}[rc${i}];[ra${i}][rc${i}]${place}`]
  } else steps = row.build(given, { width, height, uid, origin, max })
  if (!steps.length || fx.ease === undefined || fx.ease >= 1) return steps
  const i = uid()
  return [`split[sk${i}][sl${i}];[sl${i}]${steps.join(",")}[sm${i}];[sk${i}][sm${i}]${filter("blend", { all_mode: "normal", all_opacity: n(fx.ease) })}`]
}

/** How strongly the skin guard lets this effect act on a clip with faces: 1, or less with the reason. */
export function skinEase(fx) {
  const row = EFFECTS[fx.id]
  const moved = row?.skin?.(valuesOf(fx.id, fx.params).values ?? {}) ?? { hue: 0, saturation: 0 }
  const k = Math.min(1, moved.hue > SKIN.hue ? SKIN.hue / moved.hue : 1, moved.saturation > SKIN.saturation ? SKIN.saturation / moved.saturation : 1)
  return k
}

/** What an effect's span means to the health gate: its planned motion or flash, so neither is a fault. */
export const gateOf = (id) => EFFECTS[id]?.gate ?? null
