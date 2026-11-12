// The live preview's arithmetic (TP3, CRAFT_UPGRADE §2.1): where a picture goes in the frame,
// how a transition mixes its two frames, what a look does, and how loud each sound is at a time.
// All from the draft's plan (GET /projects/{id}/preview). Geometry and transitions follow the
// render's own builder (core/ffmpeg.js, FFmpeg's xfade, measured 2026-11-11); looks are close,
// not exact, and the monitor says "Preview". Nothing here touches the page.

export const FLICKS = 705_600_000
export const PLATE = "#101014" // the bars of a fitted picture, as core/ffmpeg.js PLATE
// Levels the render measures against the voice when the person set none (core/audio.js):
// the preview can't measure, so it puts them this far under, and says it's an estimate
export const UNDER = { music: 12, sfx: 6, ambience: 0, dialogue: 0 }
const EDGE_FADE = 0.015 * FLICKS // core/mix.js: every boundary gets one

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** The preview's picture item playing at timeline time t, or null. */
export const itemAt = (picture, t) => picture?.find((p) => t >= p.at && t < p.end) ?? null

/** The transition drawn at t: its kind, the held frame's asset and source time, and progress 0…1. */
export function transitionAt(picture, t) {
  for (const item of picture ?? []) {
    if (!item.enter || t < item.at || t >= item.at + item.enter.duration) continue
    const before = picture.find((p) => p.end === item.at && p !== item) ?? null
    return { ...item.enter, progress: (t - item.at) / item.enter.duration, item, before }
  }
  return null
}

/**
 * Where a w×h picture lands in a W×H frame. No mode: it covers the frame (the render's
 * scale-up and crop); `fit`: the whole picture on bars; `blur`: the whole picture over a
 * covering copy. `zoom` is the monitor's own zoom from the centre, as before. `out`: the
 * render's output size, where FFmpeg rounds, scaled to W×H after.
 * @returns {{ picture: {x,y,w,h}, behind?: {x,y,w,h}, plate?: boolean }}
 */
export function frameRects(mode, w, h, W, H, zoom = 1, out = { width: W, height: H }) {
  const centred = (s) => ({ x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s })
  const cover = centred(Math.max(W / w, H / h) * zoom)
  if (mode !== "fit" && mode !== "blur") return { picture: cover }
  // At the output's size, as FFmpeg 9.0.2 does (measured 2026-11-11): force_original_aspect_ratio=decrease
  // with force_divisible_by=2 rounds to the nearest even size (405 → 406); pad and overlay floor the
  // offset to even for 4:2:0 (437 → 436)
  const s = Math.min(out.width / w, out.height / h)
  const even = (v) => Math.max(2, Math.round(v / 2) * 2)
  const [pw, ph] = [even(w * s), even(h * s)]
  const k = W / out.width
  const whole = { x: Math.floor((out.width - pw) / 4) * 2 * k, y: Math.floor((out.height - ph) / 4) * 2 * k, w: pw * k, h: ph * k }
  return mode === "fit" ? { picture: whole, plate: true } : { picture: whole, behind: centred(Math.max(W / w, H / h)) }
}

/** The blur behind a `blur` frame, as CSS: boxblur radius min(W,H)/24, twice, then eq brightness −0.12, saturation 0.9. */
export function blurFilter(W, H, scale = 1) {
  const radius = Math.max(2, Math.round(Math.min(W, H) / 24)) * scale
  // Two box passes of radius r spread like a Gaussian of σ ≈ 0.82 r
  return `blur(${(0.82 * radius).toFixed(2)}px) brightness(0.88) saturate(0.9)`
}

/** A grade as a canvas filter: close, not exact (eq's brightness adds, CSS's multiplies; gamma and temperature aren't drawn). */
export function gradeFilter(grade) {
  if (!grade) return "none"
  const parts = []
  const brightness = 1 + (grade.lift ?? 0) + (grade.ev ?? 0) / 8
  if (brightness !== 1) parts.push(`brightness(${brightness.toFixed(3)})`)
  if (grade.gain !== undefined && grade.gain !== 1) parts.push(`contrast(${grade.gain})`)
  const saturation = (grade.saturation ?? 1) * (1 + (grade.vibrance ?? 0) * 0.5)
  if (saturation !== 1) parts.push(`saturate(${saturation.toFixed(3)})`)
  return parts.length ? parts.join(" ") : "none"
}

/**
 * How a transition mixes its frames at progress p (0 at the cut, 1 when it's over), as FFmpeg's
 * xfade does with the held frame A and the incoming frame B (P = 1 − p in its terms):
 * weights of A, B and a backdrop that sum to 1, and for wipe and slide where each is drawn.
 */
export function transitionMix(kind, p) {
  const P = 1 - Math.min(1, Math.max(0, p))
  switch (kind) {
    case "fade":
      return { a: P, b: 1 - P, bg: 0 }
    case "dip":
    case "flash": {
      // xfade fadeblack / fadewhite: mix(mix(A, bg, s1), mix(bg, B, s2), P)
      const s1 = smoothstep(0.8, 1, P)
      const s2 = smoothstep(0.2, 1, P)
      return { a: s1 * P, b: (1 - s2) * (1 - P), bg: (1 - s1) * P + s2 * (1 - P), backdrop: kind === "dip" ? "#000" : "#fff" }
    }
    case "wipe":
      return { a: 1, b: 1, bg: 0, edge: P } // B is drawn right of edge × width
    case "slide":
      return { a: 1, b: 1, bg: 0, shift: 1 - P } // A moves left by shift × width; B comes in behind it
    case "zoom": {
      const s = smoothstep(0, 0.5, P)
      return { a: s, b: 1 - s, bg: 0, magnify: smoothstep(0.5, 1, P) } // A seen at 1/magnify from its centre
    }
    default:
      return { a: 0, b: 1, bg: 0 }
  }
}

/** Linear gain of a decibel level. */
export const gainOf = (db) => 10 ** (db / 20)

/** The duck's gain at timeline time t, from the plan's curve; 1 without one. */
export function duckAt(duck, t) {
  if (!duck?.curve?.length) return 1
  const i = Math.min(duck.curve.length - 1, Math.max(0, Math.floor((t / FLICKS) * duck.rate)))
  return duck.curve[i]
}

/**
 * How loud an item of the plan's sound plays at timeline time t, as a linear gain: its level
 * (or the estimate under the voice), its edge and asked-for fades, and the duck on music.
 * 0 outside the item. The render's band-split duck lowers only 300–3500 Hz: the preview lowers it all.
 */
export function gainAt(item, t, duck) {
  if (t < item.at || t >= item.end) return 0
  const level = gainOf(item.db ?? -UNDER[item.bus ?? "dialogue"])
  const since = t - item.at
  const left = item.end - t
  let fade = Math.min(1, since / EDGE_FADE, left / EDGE_FADE)
  if (item.fadeIn) fade = Math.min(fade, since / item.fadeIn)
  if (item.fadeOut) fade = Math.min(fade, left / item.fadeOut)
  return level * Math.max(0, fade) * (item.bus === "music" ? duckAt(duck, t) : 1)
}

/**
 * Where in its file an item is at timeline time t, and until when that holds: a fitted bed jumps
 * between its pieces, a looped sound wraps, anything else plays straight on.
 * @returns {{ source: number, until: number } | null} flicks; until is timeline time
 */
export function sourceOf(item, t) {
  if (t < item.at || t >= item.end) return null
  const rate = item.speed ? item.speed.n / item.speed.d : 1
  let offset = (t - item.at) * rate
  if (item.fit?.segments?.length) {
    // Each piece after the first starts a crossfade early (core/mix.js acrossfade); the preview jumps at the middle of it
    let start = item.at
    const { segments, crossfade = 0 } = item.fit
    for (const [i, piece] of segments.entries()) {
      const length = (piece.out - piece.in) / rate - (i < segments.length - 1 ? crossfade / 2 : 0) - (i > 0 ? crossfade / 2 : 0)
      const skip = i > 0 ? crossfade / 2 : 0
      if (t < start + length || i === segments.length - 1) return { source: piece.in + (skip + t - start) * rate, until: Math.min(item.end, start + length) }
      start += length
    }
  }
  if (item.loop) {
    const span = item.out - item.in
    offset %= span
    return { source: item.in + offset, until: Math.min(item.end, t + (span - offset) / rate) }
  }
  return { source: item.in + offset, until: item.end }
}
