// The live preview (TP3, CRAFT_UPGRADE §2, EDD-63): what the Studio's monitor needs to draw
// the film, taken from the draft's own compiled plan, so it shows what the render will make.
// Tiles are the renderer's own documents; transitions, framing, looks and sound are data the
// monitor draws. A preview is never evidence: the rendered file and its gates are.

import { busOf, duckEnvelope } from "../core/audio.js"
import { compile, wholeSegment } from "../core/plan.js"
import { captionComposition } from "../engine/captions.js"
import { ENGINE_VERSION } from "../engine/index.js"
import { compositionFor } from "../engine/motion.js"

export const DUCK_RATE = 100 // the duck's gain curve, values per second, for WebAudio
const KEPT = 400 // tile documents a Host remembers per project (the latest previews')

// The tile pauses its animations at the time the monitor posts: no clock of its own, as the
// renderer seeks it (renderTileInChrome). It answers only its parent
const SYNC = `<script>addEventListener("message",(e)=>{if(e.source!==parent||typeof e.data?.t!=="number")return;for(const a of document.getAnimations()){a.pause();a.currentTime=e.data.t}})</script>`

// ET-HR-01's order, as the render layers them: behind-the-speaker text, then cards, then captions
const depthOf = (tile) => (tile.node.behind === true && !tile.front ? 0 : tile.kind === "caption" ? 2 : 1)

/**
 * The monitor's plan of a project: one draft compile.
 * @param {object} project
 * @param {object} index
 * @param {{ runtimeVersion: string, tiles?: Map<string, object> }} options tiles: where to remember documents for tileDocument()
 */
export function previewOf(project, index, { runtimeVersion, tiles }) {
  const plan = compile(project, index, { engineVersion: ENGINE_VERSION, runtimeVersion })
  const whole = wholeSegment(plan)
  const picture = whole.node.picture.map((item) => {
    const frame = item.effects.find((e) => e.type === "frame")
    const grade = item.effects.find((e) => e.type === "grade")
    const lut = item.effects.some((e) => e.type === "lut") || grade?.match !== undefined
    return {
      asset: item.asset,
      at: item.at,
      end: item.end,
      ...(frame ? { frame: frame.mode } : {}),
      ...(grade ? { grade: Object.fromEntries(["gamma", "saturation", "lift", "gain", "ev", "temperature", "vibrance", "vignette"].filter((k) => grade[k] !== undefined).map((k) => [k, grade[k]])) } : {}),
      // A LUT or a colour match isn't drawn by the monitor; it says so
      ...(lut ? { lut: true } : {}),
      ...(item.enter ? { enter: { kind: item.enter.kind, duration: item.enter.duration, asset: item.enter.from.asset, source: item.enter.from.in } } : {}),
    }
  })
  const drawn = plan.tiles.filter((tile) => !(tile.kind === "caption" && tile.node.style?.burn === true))
  for (const tile of drawn) {
    tiles?.delete(tile.key)
    tiles?.set(tile.key, { tile, output: plan.output, canvas: plan.canvas })
  }
  while (tiles && tiles.size > KEPT) tiles.delete(tiles.keys().next().value)
  const items = plan.audio.items.map((item) => {
    const level = item.effects.find((e) => e.type === "level")
    const fade = item.effects.find((e) => e.type === "fade")
    return {
      asset: item.asset,
      bus: busOf(item.role),
      at: item.at,
      end: item.end,
      in: item.in,
      out: item.out,
      ...(item.loop ? { loop: true } : {}),
      ...(item.speed && item.speed.n !== item.speed.d ? { speed: item.speed } : {}),
      ...(item.fit?.segments?.length ? { fit: { segments: item.fit.segments, crossfade: item.fit.crossfade } } : {}),
      ...(level ? { db: level.db } : {}),
      ...(fade?.in ? { fadeIn: fade.in } : {}),
      ...(fade?.out ? { fadeOut: fade.out } : {}),
    }
  })
  const { duck } = plan.audio
  // Beats where the music plays them on the timeline, for a trimmed edge to snap to
  const beats = []
  for (const item of plan.audio.items.filter((i) => busOf(i.role) === "music")) {
    const pieces = item.fit?.segments?.length ? item.fit.segments : [{ in: item.in, out: item.out }]
    let start = item.at
    for (const piece of pieces) {
      for (const beat of index.beats ?? []) if (beat.asset === item.asset && beat.t >= piece.in && beat.t < piece.out && start + beat.t - piece.in < item.end) beats.push(start + beat.t - piece.in)
      start += piece.out - piece.in - (item.fit?.crossfade ?? 0)
    }
  }
  return {
    output: plan.output,
    canvas: plan.canvas,
    duration: plan.duration,
    picture,
    tiles: drawn.map((tile) => ({ key: tile.key, kind: tile.kind, at: tile.at, end: tile.end, depth: depthOf(tile) })),
    audio: { items, ...(duck ? { duck: { rate: DUCK_RATE, curve: [...duckEnvelope(duck.speech, { duration: plan.duration, depth: duck.depth, attack: duck.attack, release: duck.release, rate: DUCK_RATE })].map((v) => Math.round(v * 1e4) / 1e4) } } : {}) },
    beats: [...new Set(beats)].sort((a, b) => a - b),
    keys: plan.keys,
  }
}

/** A tile's own document, as the render draws it, with the monitor's time listener. Null when unknown. */
export function tileDocument(tiles, key) {
  const found = typeof key === "string" && /^[0-9a-f]{64}$/.test(key) ? tiles.get(key) : undefined
  if (!found) return null
  return compositionFor(found.tile, { output: found.output, canvas: found.canvas }, captionComposition).replace("</body>", `${SYNC}</body>`)
}
