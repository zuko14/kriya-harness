// The compiler (EDIT_ENGINE §1, §6, §7): one RenderPlan of plain data for every
// output. Times inside a node are relative to its segment, and clip ids stay out of
// it, so a segment that only moved keeps its cache key.

import { CROSSFADE, crowdedEffects, DUCK_DEFAULTS, fitMusic, speechSpans } from "./audio.js"
import { outputFaces, unionBox } from "./faces.js"
import { canonical, sha256 } from "./project.js"
import { solveReframe } from "./reframe.js"
import { solve } from "./solver.js"
import { flicksToFrames, FLICKS, framesToFlicks, scaleFlicks, snapToFrame } from "./time.js"

const MAX_SEGMENT = 6 * FLICKS
const DRAFT_SHORT_SIDE = 720
const PICTURE_EFFECTS = new Set(["reframe", "grade", "lut", "stabilize", "transition", "fade"])
const AUDIO_EFFECTS = new Set(["level", "eq", "duck", "fade", "fit"])

const even = (value) => Math.round(value / 2) * 2
const only = (effects, types) => effects.filter((effect) => types.has(effect.type))

function outputOf(project, quality, id) {
  const { width, height, fps } = project.canvas
  if (quality !== "master") {
    const scale = DRAFT_SHORT_SIDE / Math.min(width, height)
    return { width: even(width * scale), height: even(height * scale), fps, codec: "h264" }
  }
  if (id === undefined) return { width, height, fps, codec: "h264" }
  const deliverable = project.deliverables.find((d) => d.id === id)
  if (!deliverable) throw new RangeError(`no deliverable "${id}"`)
  return { width: deliverable.size.width, height: deliverable.size.height, fps: deliverable.fps, codec: deliverable.codec }
}

function cropPaths(project, rawIndex, timeline, issues) {
  const paths = new Map()
  for (const piece of timeline.picture) {
    const reframe = piece.effects.find((e) => e.type === "reframe")
    if (!reframe || paths.has(piece.clip)) continue
    if (reframe.mode === "fixed") {
      paths.set(piece.clip, [{ t: piece.in, x: reframe.x ?? 0 }])
      continue
    }
    const samples = rawIndex.subjects?.[piece.asset]
    if (!samples?.length) {
      issues.push({ code: "no_subject_track", clip: piece.clip, message: "this clip asks to follow a subject, but the index has no subject track for it" })
      paths.set(piece.clip, null)
      continue
    }
    const facts = project.assets.find((a) => a.id === piece.asset).facts
    const shots = [...new Set(samples.map((sample) => sample.shot))].map((id) => ({ id, samples: samples.filter((sample) => sample.shot === id) }))
    const cropWidth = Math.round((facts.height * project.canvas.width) / project.canvas.height)
    // ED11: the face box stays whole (L8's w), and the crop crosses at most its own width a second (ET-SOL-03)
    paths.set(piece.clip, solveReframe(shots, { sourceWidth: facts.width, cropWidth, deadzone: Math.round(facts.width / 100), maxSpeed: cropWidth }).flatMap((shot) => shot.path))
  }
  return paths
}

// A segment's crop points, with one either side so the crop glides across the segment's
// edge (ffmpeg.js interpolates); never across a shot change, where the path resets
function cropFor(path, part, shotStarts) {
  const crosses = (a, b) => shotStarts.some((s) => s > a && s <= b)
  const before = path.findLast((point) => point.t < part.in)
  const after = path.find((point) => point.t > part.out)
  return [...(before && !crosses(before.t, part.in) ? [before] : []), ...path.filter((point) => point.t >= part.in && point.t <= part.out), ...(after && !crosses(part.out, after.t) ? [after] : [])]
}

// A punch-in as a segment sees it. ED11's focus (x, y in thousandths of the framed
// picture) and smooth ease are added only when set, so older plans keep their keys;
// an eased zoom needs where this segment sits inside it
function zoomNode(zoom, start) {
  const node = { scale: zoom.scale, ease: zoom.ease }
  if (zoom.x !== undefined) Object.assign(node, { x: zoom.x, y: zoom.y })
  if (zoom.ease === "smooth") Object.assign(node, { since: start - zoom.at, length: zoom.end - zoom.at })
  return node
}

function boundaries(timeline, rawIndex, fps) {
  const cuts = new Set([0, timeline.duration])
  for (const piece of timeline.picture) {
    cuts.add(piece.at)
    for (const shot of rawIndex.shots ?? []) {
      if (shot.asset === piece.asset && shot.start > piece.in && shot.start < piece.out) cuts.add(snapToFrame(piece.at + scaleFlicks(shot.start - piece.in, { n: piece.speed.d, d: piece.speed.n }), fps, "floor"))
    }
  }
  // A zoom's edges are segment edges, so each piece has one constant zoom
  for (const zoom of timeline.zooms) {
    cuts.add(zoom.at)
    cuts.add(zoom.end)
  }
  const sorted = [...cuts].filter((t) => t >= 0 && t <= timeline.duration).sort((a, b) => a - b)
  const spans = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [start, end] = [sorted[i], sorted[i + 1]]
    const parts = Math.ceil((end - start) / MAX_SEGMENT)
    const [first, last] = [flicksToFrames(start, fps), flicksToFrames(end, fps)]
    for (let p = 0; p < parts; p++) spans.push([framesToFlicks(first + Math.floor(((last - first) * p) / parts), fps), framesToFlicks(first + Math.floor(((last - first) * (p + 1)) / parts), fps)])
  }
  return spans
}

function clipped(item, start, end) {
  const from = Math.max(item.at, start)
  const to = Math.min(item.end, end)
  const rate = item.speed ?? { n: 1, d: 1 }
  const pieceIn = item.in + scaleFlicks(from - item.at, rate)
  const pieceOut = Math.min(item.out, item.in + scaleFlicks(to - item.at, rate))
  return { asset: item.asset, in: item.hold ? item.in : pieceIn, out: item.hold ? item.out : pieceOut, at: from - start, end: to - start, speed: rate }
}

/** All of a plan as one segment: a master is one continuous encode, so it has no seams. */
export function wholeSegment(plan) {
  const absolute = (start) => (item) => ({ ...item, at: item.at + start, end: item.end + start })
  const seen = new Set()
  return {
    id: "whole",
    start: 0,
    end: plan.duration,
    node: {
      picture: plan.segments.flatMap((s) => s.node.picture.map(absolute(s.start))),
      overlays: plan.segments.flatMap((s) => s.node.overlays.map(absolute(s.start))),
      tiles: plan.tiles.filter((tile) => !seen.has(tile.key) && seen.add(tile.key)).map(({ key, at, end }) => ({ key, at, end })),
      ...(plan.mattes?.length ? { mattes: plan.mattes } : {}),
    },
  }
}

/**
 * @param {object} project
 * @param {object} rawIndex
 * @param {{ engineVersion: string, runtimeVersion: string, quality?: "draft" | "master", deliverable?: string, rules?: object }} options
 * @returns {object} the RenderPlan: plain data, no I/O
 */
export function compile(project, rawIndex, { engineVersion, runtimeVersion, quality = "draft", deliverable, rules } = {}) {
  if (!engineVersion || !runtimeVersion) throw new TypeError("compile needs engineVersion and runtimeVersion: they are part of every cache key")
  const timeline = solve(project, rawIndex, rules)
  const output = outputOf(project, quality, deliverable)
  const input = quality === "master" ? "source" : "proxy"
  const issues = [...timeline.issues]
  const fingerprint = new Map(project.assets.map((asset) => [asset.id, asset.fingerprint]))
  const settings = { ...output, input }

  // key = sha256(engine ‖ runtime ‖ inputs' content ids ‖ resolved plan node ‖ output settings)
  const key = (node, assets) => sha256(canonical([engineVersion, runtimeVersion, [...new Set(assets)].map((id) => fingerprint.get(id)).sort(), node, settings]))

  const burnCaptions = deliverable === undefined || project.deliverables.find((d) => d.id === deliverable)?.burnCaptions !== false
  const captionTiles = burnCaptions
    ? timeline.captions.map((caption) => {
        const node = {
          kind: "caption",
          text: caption.text,
          words: caption.words.map((word) => ({ text: word.text, at: word.at - caption.at, end: word.end - caption.at, emphasis: caption.emphasis.includes(word.id) })),
          look: caption.look,
          style: project.look.caption,
          placement: caption.placement,
          duration: caption.end - caption.at,
          ...(caption.behind ? { behind: true } : {}),
        }
        return { key: key(node, []), kind: "caption", at: caption.at, end: caption.end, node }
      })
    : []
  const blockTiles = timeline.overlays
    .filter((overlay) => overlay.block)
    .map((overlay) => {
      const node = { kind: "block", ...overlay.block, placement: overlay.placement, duration: overlay.end - overlay.at, ...(overlay.behind ? { behind: true } : {}) }
      return { key: key(node, []), kind: "block", at: overlay.at, end: overlay.end, node }
    })
  const tiles = [...captionTiles, ...blockTiles].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))

  const crops = cropPaths(project, rawIndex, timeline, issues)
  // A proxy is normalised when it's made, so only a source needs this (EX-10)
  const sourceColor = (id) => {
    const color = project.assets.find((asset) => asset.id === id).facts.color
    return input === "source" && color && (color.hdr || !color.tagged) ? color : undefined
  }
  // A colour match (ED13) as what the Engine measures: this clip's whole range against the reference clip's, so every segment of a clip gets the same LUT
  const rangeOf = (clip) => {
    const pieces = timeline.picture.filter((p) => p.clip === clip && !p.hold)
    return pieces.length ? { asset: pieces[0].asset, in: Math.min(...pieces.map((p) => p.in)), out: Math.max(...pieces.map((p) => p.out)) } : null
  }
  const lost = new Set()
  const resolved = (piece) =>
    piece.effects.map((effect) => {
      if (effect.type !== "grade" || effect.match === undefined) return effect
      const { match, ...rest } = effect
      const [from, to] = [rangeOf(piece.clip), rangeOf(match)]
      if (!from || !to) {
        if (!lost.has(piece.clip)) issues.push({ code: "match_reference_removed", clip: piece.clip, message: "the shot this was matched to isn't in the cut any more, so it isn't matched" })
        lost.add(piece.clip)
        return rest
      }
      return { ...rest, match: { key: sha256(canonical(["match-1", fingerprint.get(from.asset), from, fingerprint.get(to.asset), to])), from, to } }
    })
  const footage = timeline.overlays.filter((overlay) => !overlay.block)
  const during = (start, end) => (item) => item.at < end && start < item.end

  // The speaker's matte (EDD-49): the faces under each matte window, on the output.
  // shortcut: one box per window from L8 faces, not a per-frame segmentation; MediaPipe's selfie segmenter replaces it when the runtime has it
  const sizeOf = (id) => project.assets.find((asset) => asset.id === id)?.facts
  const playing = timeline.picture.map((piece) => ({ ...piece, crop: crops.get(piece.clip) ?? undefined }))
  const zoomAt = (t) => timeline.zooms.find((zoom) => zoom.at <= t && t < zoom.end)
  const faces = outputFaces(playing, rawIndex.faces, sizeOf, { canvas: project.canvas, output, zoomAt })
  const mattes = []
  for (const window of timeline.mattes ?? []) {
    const box = unionBox(faces.filter((face) => face.t >= window.at && face.t <= window.end).map((face) => face.box))
    if (box) mattes.push({ at: window.at, end: window.end, box })
    else issues.push({ code: "no_subject_for_matte", clip: window.clip, message: "there is no face under this text, so it is drawn in front, not behind" })
  }
  const hidden = (tile) => tile.node.behind === true && mattes.some((m) => m.at <= tile.at && tile.end <= m.end)
  for (const tile of tiles) if (tile.node.behind && !hidden(tile)) tile.front = true

  const segments = boundaries(timeline, rawIndex, project.canvas.fps).map(([start, end], i) => {
    const picture = timeline.picture.filter(during(start, end)).map((piece) => {
      const part = clipped(piece, start, end)
      const color = sourceColor(piece.asset)
      const path = crops.get(piece.clip)
      const crop = path ? cropFor(path, part, (rawIndex.shots ?? []).filter((s) => s.asset === piece.asset).map((s) => s.start)) : undefined
      const zoom = timeline.zooms.find(during(start, end))
      return { ...part, ...(piece.hold ? { hold: true } : {}), effects: only(resolved(piece), PICTURE_EFFECTS), ...(crop ? { crop } : {}), ...(zoom ? { zoom: zoomNode(zoom, start) } : {}), ...(color ? { color } : {}) }
    })
    const overlays = footage.filter(during(start, end)).map((overlay) => ({ ...clipped(overlay, start, end), effects: only(overlay.effects, PICTURE_EFFECTS) }))
    const node = {
      picture,
      overlays,
      tiles: tiles.filter(during(start, end)).map((tile) => ({ key: tile.key, at: tile.at - start, end: tile.end - start })),
      ...(mattes.some(during(start, end)) ? { mattes: mattes.filter(during(start, end)).map((m) => ({ at: m.at - start, end: m.end - start, box: m.box })) } : {}),
    }
    const luts = picture.flatMap((item) => item.effects.filter((e) => e.type === "lut").map((e) => e.asset))
    return { id: `s${i}`, start, end, key: key(node, [...picture.map((item) => item.asset), ...overlays.map((item) => item.asset), ...luts]), node }
  })

  issues.push(...crowdedEffects(timeline.audio))
  const items = timeline.audio.map(({ clip: _, effects, ...item }) => ({ ...item, effects: only(effects, AUDIO_EFFECTS) }))
  // Music fitted to the length on its downbeats (ED9); without beats it is cut at the end, and says so
  for (const [i, item] of items.entries()) {
    if (!item.effects.some((e) => e.type === "fit")) continue
    const downbeats = (rawIndex.beats ?? []).filter((b) => b.asset === item.asset && b.downbeat).map((b) => b.t)
    const fit = fitMusic({ from: item.in, to: item.out, downbeats, bars: (rawIndex.bars ?? []).filter((b) => b.asset === item.asset), target: item.end - item.at })
    if (fit) item.fit = { segments: fit.segments, crossfade: CROSSFADE }
    else {
      issues.push({ code: "no_beats", clip: timeline.audio[i].clip, message: "this music has no beat grid yet, so it is cut at the end instead of fitted" })
      item.out = Math.min(item.out, item.in + (item.end - item.at))
      item.effects = item.effects.filter((e) => e.type !== "fit")
    }
  }
  // The duck's speech times on the output, so a new transcript gives a new mix
  const duckEffect = items.flatMap((item) => item.effects).find((e) => e.type === "duck")
  const duck = duckEffect ? { depth: duckEffect.depth ?? DUCK_DEFAULTS.depth, attack: duckEffect.attack ?? DUCK_DEFAULTS.attack, release: duckEffect.release ?? DUCK_DEFAULTS.release, speech: speechSpans(items, rawIndex.words) } : undefined
  // The deliverable's loudness target masters the mix (ED7, for QG-06); none, and the key is as before
  const loudness = deliverable === undefined ? undefined : project.deliverables.find((d) => d.id === deliverable)?.loudness
  const sound = { items, ...(loudness ? { loudness } : {}), ...(duck ? { duck } : {}) }
  const audio = loudness || duck ? { key: key(sound, items.map((item) => item.asset)), ...sound } : { key: key(items, items.map((item) => item.asset)), items }
  const pictureNodes = segments.map(({ node: { tiles: _, ...node } }) => node)

  return {
    schema: 1,
    quality,
    input,
    canvas: project.canvas,
    output,
    duration: timeline.duration,
    segments,
    tiles,
    ...(mattes.length ? { mattes } : {}),
    audio,
    keys: { picture: sha256(canonical(pictureNodes)), audio: audio.key, caption: sha256(canonical(tiles.map((tile) => tile.key))) },
    issues,
  }
}
