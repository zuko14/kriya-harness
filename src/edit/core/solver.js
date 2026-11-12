// The solver (EDIT_ENGINE §5): anchors in, exact times out, in the document's order:
// resolve, sequence, snap, air, J and L, layout, budget. It reports what it couldn't
// satisfy and never silently drops a request.

import { anchorSource, openIndex, wordAfter, wordAt, wordBefore } from "./anchors.js"
import { mapBox } from "./faces.js"
import { isSceneBlock, REGIONS, safeZoneFor, sceneFrame, solveLayout } from "./layout.js"
import { flicksToFrames, frameAtTimestamp, framesToFlicks, scaleFlicks, snapToFrame } from "./time.js"

const ms = (n) => n * 705_600

export const DEFAULT_RULES = {
  padIn: ms(120),
  padOut: ms(240),
  zeroTolerance: ms(2),
  airAfter: ms(750),
  maxSplit: null,
  minFrames: 2,
  minShot: 0,
  targetTolerance: 0,
  // null: the strictest safe zone of the project's deliverables (layout.js SAFE_ZONES, ED8)
  safe: null,
  prefer: 80,
  boxWidth: 80,
  boxHeight: 12,
}

const AUDIO_ROLES = ["dialogue", "sfx", "music", "ambience"]
// Music to be fitted runs to the timeline's end; the plan edits it there on its downbeats (ED9)
const fitted = (clip) => clip.effects.some((e) => e.type === "fit")

const inverse = ({ n, d }) => ({ n: d, d: n })
const isWordCut = (ref, edge) => ref.word !== undefined && ref.edge === edge && !ref.exact

function nearestCrossing(list, t, low, high, tolerance) {
  let from = 0
  let to = list.length
  while (from < to) {
    const middle = (from + to) >> 1
    if (list[middle] < t) from = middle + 1
    else to = middle
  }
  const options = [list[from - 1], list[from]].filter((c) => c !== undefined && Math.abs(c - t) <= tolerance && c >= low && c <= high)
  return options.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0] ?? t
}

function snapper(s, asset) {
  const table = asset.facts.vfr ? s.raw.timestamps?.[asset.id] : undefined
  if (table?.length) {
    return {
      down: (t) => table[frameAtTimestamp(table, t)],
      up: (t) => {
        const i = frameAtTimestamp(table, t)
        return table[i] === t ? t : (table[i + 1] ?? table[i])
      },
    }
  }
  const rate = asset.facts.fps ?? s.fps
  return { down: (t) => snapToFrame(t, rate, "floor"), up: (t) => snapToFrame(t, rate, "ceil") }
}

const sourceOf = (s, ref, edge) => (typeof ref === "number" ? ref : (anchorSource(ref, s.index, edge)?.t ?? null))

/** Steps 1, 3 and 4 for one clip: where picture and sound really cut. */
function cutPoints(s, clip, asset) {
  const { rules } = s
  const words = s.index.words.get(asset.id) ?? []
  const duration = asset.facts.duration ?? Number.MAX_SAFE_INTEGER
  const refs = clip.source
  let start = sourceOf(s, refs.in, "start")
  let end = sourceOf(s, refs.out, "end")
  if (start === null || end === null) return null

  const moved = (word, t) => {
    s.issue("cut_moved_off_word", { clip: clip.id, word: word.id, message: "a cut would have landed inside a word, so it moved to the word's edge" })
    return t
  }
  // A seam is a join inside one continuous take (a speed ramp's step): it stays exactly where it is
  if (clip.seamIn && clip.seamOut) return { pictureIn: start, pictureOut: end, soundIn: start, soundOut: end }
  const inStart = clip.seamIn ? null : wordAt(words, start)
  if (inStart) start = moved(inStart, inStart.start)
  const inEnd = clip.seamOut ? null : wordAt(words, end)
  if (inEnd) end = moved(inEnd, inEnd.end)

  const floor = wordBefore(words, start)?.end ?? 0
  const ceiling = Math.min(wordAfter(words, end)?.start ?? duration, duration)
  const cutIn = Math.max(floor, start - (isWordCut(refs.in, "start") ? rules.padIn : 0))
  let cutOut = Math.min(ceiling, end + (isWordCut(refs.out, "end") ? rules.padOut : 0))
  const spoken = wordBefore(words, end)
  if (spoken && s.airWords.has(spoken.id)) cutOut = Math.max(cutOut, Math.min(ceiling, spoken.end + rules.airAfter))

  const { down, up } = snapper(s, asset)
  const firstWord = wordAfter(words, cutIn)?.start ?? duration
  const lastWord = wordBefore(words, cutOut)?.end ?? 0
  const noGap = () => s.issue("cut_no_frame_gap", { clip: clip.id, message: "no frame boundary falls in the gap, so the picture keeps the whole word and the sound makes the cut" })
  let pictureIn = down(cutIn)
  if (pictureIn < floor) {
    if (up(cutIn) <= firstWord) pictureIn = up(cutIn)
    else noGap()
  }
  let pictureOut = up(cutOut)
  if (pictureOut > ceiling) {
    if (down(cutOut) >= lastWord) pictureOut = down(cutOut)
    else noGap()
  }

  const crossings = s.raw.zeroCrossings?.[asset.id] ?? []
  let soundIn = nearestCrossing(crossings, cutIn, floor, firstWord, rules.zeroTolerance)
  let soundOut = nearestCrossing(crossings, cutOut, lastWord, ceiling, rules.zeroTolerance)

  let lead = clip.audioLead ?? 0
  let lag = clip.audioLag ?? 0
  if (rules.maxSplit !== null && Math.max(lead, lag) > rules.maxSplit) {
    lead = Math.min(lead, rules.maxSplit)
    lag = Math.min(lag, rules.maxSplit)
    s.issue("split_limited", { clip: clip.id, message: "picture and sound can't part by that much; held to the limit" })
  }
  soundIn = Math.max(0, soundIn - lead)
  soundOut = Math.min(duration, soundOut + lag)
  return clip.seamIn ? (clip.seamOut ? { pictureIn: start, pictureOut: end, soundIn: start, soundOut: end } : { pictureIn: start, pictureOut, soundIn: start, soundOut }) : clip.seamOut ? { pictureIn, pictureOut: end, soundIn, soundOut: end } : { pictureIn, pictureOut, soundIn, soundOut }
}

const framesFor = (span, fps) => (span <= 0 ? 0 : flicksToFrames(span - 1, fps) + 1)

/** Step 2: lay kept ranges end to end, on the timeline's frames. */
function layBase(s, clips) {
  let frame = 0
  for (const clip of clips) {
    const asset = s.assets.get(clip.source.asset)
    const cut = cutPoints(s, clip, asset)
    if (cut === null) {
      s.issue("anchor_removed", { clip: clip.id, message: "this clip's words aren't in the transcript any more" })
      continue
    }
    const { pictureIn, pictureOut, soundIn, soundOut } = cut
    const slow = inverse(clip.speed)
    const effects = clip.effects.filter((e) => e.type !== "freeze")
    const piece = (from, to, length, hold) => {
      const frames = framesFor(length, s.fps)
      if (frames === 0) return
      const item = { clip: clip.id, asset: asset.id, in: from, out: to, at: framesToFlicks(frame, s.fps), end: framesToFlicks(frame + frames, s.fps), speed: clip.speed, effects, ...(hold ? { hold } : {}), ...(clip.echo ? { echo: true } : {}) }
      frame += frames
      s.picture.push(item)
      return item
    }
    const first = frame
    const freeze = clip.effects.find((e) => e.type === "freeze")
    let stop = freeze ? sourceOf(s, freeze.at, "start") : null
    if (freeze && (stop === null || stop < pictureIn || stop >= pictureOut)) {
      s.issue("anchor_removed", { clip: clip.id, anchor: freeze.at, message: "the freeze's point is no longer inside this clip, so there is no hold" })
      stop = null
    }
    const pieces = (stop === null ? [piece(pictureIn, pictureOut, scaleFlicks(pictureOut - pictureIn, slow))] : [piece(pictureIn, stop, scaleFlicks(stop - pictureIn, slow)), piece(stop, stop, freeze.duration, true), piece(stop, pictureOut, scaleFlicks(pictureOut - stop, slow))]).filter(Boolean)
    if (pieces.length === 0) continue

    if (frame - first < s.rules.minFrames) s.issue("flash_frame", { clip: clip.id, message: `this clip lasts ${frame - first} frame(s), which reads as a flash` })
    if (framesToFlicks(frame - first, s.fps) < s.rules.minShot) s.issue("short_shot", { clip: clip.id, message: "this clip is shorter than the recipe's shortest shot" })

    if (asset.facts.hasAudio !== false && !s.tracks.get(clip.track).muted) {
      const sound = (from, to, anchor) => {
        const at = anchor.at + scaleFlicks(from - anchor.in, slow)
        const late = Math.max(0, -at)
        s.audio.push({ clip: clip.id, role: "dialogue", asset: asset.id, in: from + late, out: to, at: at + late, end: at + scaleFlicks(to - from, slow), speed: clip.speed, effects })
      }
      sound(soundIn, stop ?? soundOut, pieces[0])
      if (stop !== null) sound(stop, soundOut, pieces.at(-1))
    }
  }
  s.duration = framesToFlicks(frame, s.fps)
}

/** Where a time in an asset sits on the timeline, or null if it was cut. */
function mapSource(s, place, anchor, spot) {
  const edge = anchor.edge ?? "start"
  // A word lives where the story says it: never in a hold, never in a cold open's echo of it
  const hit = s.picture.find(({ asset, in: from, out, hold, echo }) => !hold && !echo && asset === spot.asset && (edge === "start" ? from <= spot.t && spot.t < out : from < spot.t && spot.t <= out))
  if (hit) return hit.at + scaleFlicks(spot.t - hit.in, inverse(hit.speed))
  for (const clip of s.rest) {
    if (clip.source?.asset !== spot.asset || s.tracks.get(clip.track).role === "ambience") continue
    const from = sourceOf(s, clip.source.in, "start")
    const to = sourceOf(s, clip.source.out, "end")
    if (from === null || to === null || spot.t < from || spot.t > to) continue
    const placed = place(clip)
    if (placed) return placed.at + scaleFlicks(spot.t - from, inverse(clip.speed))
  }
  return null
}

function placeRest(s) {
  const placed = new Map()
  const placing = new Set()
  let cycle = false

  const span = (id) => {
    const pieces = s.picture.filter((p) => p.clip === id)
    if (pieces.length) return { at: pieces[0].at, end: pieces.at(-1).end }
    const clip = s.rest.find((c) => c.id === id)
    return clip ? place(clip) : null
  }

  const resolve = (ref, edge) => {
    if (typeof ref === "number") return ref
    if (ref.marker !== undefined) {
      const marker = s.sequence.markers.find((m) => m.name === ref.marker || m.id === ref.marker)
      return marker ? resolve(marker.at, edge) : null
    }
    if (ref.clip !== undefined) {
      const other = span(ref.clip)
      return other ? other[ref.edge === "end" ? "end" : "at"] + (ref.offset ?? 0) : null
    }
    const spot = anchorSource(ref, s.index, edge)
    return spot ? mapSource(s, place, ref, spot) : null
  }

  const lost = (clip, ref) => {
    if (cycle) s.issue("anchor_cycle", { clip: clip.id, message: "clips are anchored to each other in a circle, so neither can be placed" })
    else s.issue("anchor_removed", { clip: clip.id, anchor: ref, message: "what this was anchored to is no longer on the timeline" })
    cycle = false
  }

  function compute(clip) {
    const role = s.tracks.get(clip.track).role
    let at = resolve(clip.at ?? 0, "start")
    if (at === null) {
      lost(clip, clip.at)
      return null
    }
    if (clip.peak) {
      at -= clip.peak
      if (at < 0) {
        s.issue("peak_before_start", { clip: clip.id, message: "this sound's build-up starts before the timeline, so its peak lands late" })
        at = 0
      }
    }
    if (at >= s.duration) {
      s.issue("past_end", { clip: clip.id, message: "this starts after the timeline ends" })
      return null
    }

    const from = clip.source ? sourceOf(s, clip.source.in, "start") : 0
    const to = clip.source ? sourceOf(s, clip.source.out, "end") : 0
    const available = clip.source ? scaleFlicks(to - from, inverse(clip.speed)) : null
    let end
    if (clip.until !== undefined) {
      end = resolve(clip.until, "end")
      if (end === null) {
        lost(clip, clip.until)
        end = at + (available ?? 0)
      }
    } else if (clip.duration !== undefined) end = at + clip.duration
    else if (clip.loop || fitted(clip)) end = s.duration
    else if (available !== null) end = at + available
    // A punch-in with no span holds until the next cut
    else end = s.picture.find((p) => p.at <= at && at < p.end)?.end ?? s.duration

    if (end <= at) {
      s.issue("span_inverted", { clip: clip.id, message: "this ends before it starts" })
      return null
    }
    if (clip.source && !clip.loop && !fitted(clip) && available < end - at) {
      s.issue("source_too_short", { clip: clip.id, message: "the source runs out before the span ends; kept at the length it has" })
      end = at + available
    }
    if (end > s.duration) {
      if (!AUDIO_ROLES.includes(role)) s.issue("past_end", { clip: clip.id, message: "this runs past the end of the timeline, and was cut there" })
      end = s.duration
    }
    if (AUDIO_ROLES.includes(role)) return { at, end, from, to, role }
    const frameAt = snapToFrame(at, s.fps, "nearest")
    return { at: frameAt, end: Math.max(snapToFrame(end, s.fps, "nearest"), frameAt + 1), from, to, role }
  }

  function place(clip) {
    if (placed.has(clip.id)) return placed.get(clip.id)
    if (placing.has(clip.id)) {
      cycle = true
      return null
    }
    placing.add(clip.id)
    const result = compute(clip)
    placing.delete(clip.id)
    placed.set(clip.id, result)
    return result
  }

  function caption(clip, effect) {
    const on = []
    const missing = []
    for (const id of effect.words) {
      const word = s.index.word.get(id)
      const at = word ? mapSource(s, place, { edge: "start" }, { asset: word.asset, t: word.start }) : null
      const end = word ? mapSource(s, place, { edge: "end" }, { asset: word.asset, t: word.end }) : null
      if (at === null || end === null) missing.push(id)
      else on.push({ id, text: word.text, at, end })
    }
    if (missing.length) s.issue("anchor_removed", { clip: clip.id, words: missing, message: "these words were cut, so the caption no longer shows them" })
    if (on.length === 0) return
    s.captions.push({
      clip: clip.id,
      at: Math.min(...on.map((w) => w.at)),
      end: Math.max(...on.map((w) => w.end)),
      words: on,
      text: effect.text ?? on.map((w) => w.text).join(" "),
      look: effect.look,
      emphasis: effect.emphasis,
      placement: effect.placement ?? null,
      ...(behind(clip) ? { behind: true } : {}),
    })
  }

  // Text on a track below the matte track goes behind the speaker (EDIT_ENGINE §3: a stacking rule)
  const matteTrack = [...s.tracks.values()].find((t) => t.role === "matte")
  const behind = (clip) => matteTrack !== undefined && s.tracks.get(clip.track).order < matteTrack.order

  for (const clip of s.rest) {
    const effect = clip.effects.find((e) => e.type === "caption")
    if (effect) {
      caption(clip, effect)
      continue
    }
    const spot = place(clip)
    if (!spot) continue
    const zoom = clip.effects.find((e) => e.type === "zoom")
    const block = clip.effects.find((e) => e.type === "block")
    const matte = clip.effects.find((e) => e.type === "matte")
    const item = { clip: clip.id, role: spot.role, at: spot.at, end: spot.end }
    if (zoom) s.zooms.push({ ...item, scale: zoom.scale, ease: zoom.ease ?? null, ...(zoom.x === undefined ? {} : { x: zoom.x, y: zoom.y }) })
    else if (matte) s.mattes.push({ ...item, model: matte.model ?? "face-box" })
    // An effect over a stretch of the cut (TP5): no picture of its own, the effect's window on the timeline
    else if (!clip.source && clip.effects.some((e) => e.type === "fx")) s.adjustments.push({ ...item, fx: clip.effects.find((e) => e.type === "fx") })
    else if (AUDIO_ROLES.includes(spot.role)) {
      if (!s.tracks.get(clip.track).muted) s.audio.push({ ...item, asset: clip.source.asset, in: spot.from, out: spot.to, speed: clip.speed, effects: clip.effects, ...(clip.loop ? { loop: true } : {}), ...(clip.peak ? { peak: clip.peak } : {}) })
    } else if (block) s.overlays.push({ ...item, block: { blockId: block.blockId, version: block.version, variables: block.variables }, placement: null, ...(behind(clip) ? { behind: true } : {}) })
    else s.overlays.push({ ...item, asset: clip.source.asset, in: spot.from, out: spot.to, speed: clip.speed, effects: clip.effects })
  }
}

// Faces under a caption, on the output, mapped as the render draws the frame (faces.js's mapBox:
// one scale that covers the frame, centred). Found in use: scaling width and height apart put
// faces in the wrong place whenever the take's shape differs from the frame, so captions sat on them.
// shortcut: a reframe's crop path isn't known yet here (plan.js makes it after the solver), so x is
// the centred crop's; a caption is a full-width row, so its y, which this gets exactly, is what matters
const FACE_REACH = 705_600_000 // faces are sampled once a second (L8), so look a second either side
function facesDuring(s, at, end) {
  const canvas = s.project.canvas
  const boxes = []
  const zooms = s.zooms.filter((z) => z.at < end && at < z.end)
  for (const piece of s.picture) {
    if (piece.end <= at || piece.at >= end) continue
    const facts = s.assets.get(piece.asset).facts
    const size = { width: facts.width ?? canvas.width, height: facts.height ?? canvas.height }
    const from = piece.in + scaleFlicks(Math.max(0, at - piece.at), piece.speed) - FACE_REACH
    const to = piece.in + scaleFlicks(Math.min(piece.end, end) - piece.at, piece.speed) + FACE_REACH
    for (const face of s.raw.faces ?? []) {
      if (face.asset !== piece.asset || face.t < from || face.t > to) continue
      // Clear the face both as shot and inside any punch-in over the caption
      for (const zoom of [undefined, ...zooms]) {
        const box = mapBox(face.box, { zoom }, size, canvas, canvas, face.t)
        // A little room around the face: a caption touching the chin still reads as on it
        if (box) boxes.push({ x: box.x - Math.round(box.w * 0.1), y: box.y - Math.round(box.h * 0.1), w: Math.round(box.w * 1.2), h: Math.round(box.h * 1.25) })
      }
    }
  }
  return boxes
}

// A page a fast speaker says in a blink stays up long enough to read, until the next one starts (found on real footage)
const MIN_CAPTION = 1.2 * 705_600_000
function holdCaptions(s) {
  // Only where a playbook asked for it (DP3): off, every existing project solves exactly as before
  if (s.project.look?.caption?.hold !== true) return
  const list = [...s.captions].sort((a, b) => a.at - b.at)
  list.forEach((caption, i) => {
    const next = list[i + 1]?.at ?? s.duration
    // Text behind the speaker keeps its matte's window exactly
    if (!caption.behind && caption.end - caption.at < MIN_CAPTION) caption.end = Math.max(caption.end, Math.min(caption.at + MIN_CAPTION, next, s.duration))
  })
}

/** A drawn box (thousandths of the frame) as whole pixels of a canvas. */
export const markPixels = (mark, { width, height }) => ({ x: Math.round((mark.x * width) / 1000), y: Math.round((mark.y * height) / 1000), w: Math.max(1, Math.round((mark.w * width) / 1000)), h: Math.max(1, Math.round((mark.h * height) / 1000)) })

/** Step 6: every caption and card gets a place, or a report. */
function layOut(s) {
  holdCaptions(s)
  const { rules } = s
  const { width, height } = s.project.canvas
  const safe = rules.safe ?? safeZoneFor(s.project)
  // Narrower than the look's width when the safe zone is (found in ED8: else no row fits)
  const w = Math.min(Math.floor((width * rules.boxWidth) / 100), width - (safe.left ?? 0) - (safe.right ?? 0))
  const h = Math.floor((height * rules.boxHeight) / 100)
  // A scene takes its content box; what plays over it sits on the row below that, with no face to clear
  // TP7: a full-frame card covers the frame as a scene does; a screen frame is drawn round all of it, with no text to place
  const regionOf = (o) => (o.block?.blockId === "graphic" ? REGIONS[o.block.variables?.kind] : undefined)
  const covers = (o) => isSceneBlock(o.block) || regionOf(o)?.region === "full"
  for (const o of s.overlays) if (regionOf(o)?.region === "frame") o.placement = { x: 0, y: 0, w: width, h: height }
  // TP9: a custom animation is drawn over the whole frame by its own design; the gates judge where its words land
  for (const o of s.overlays) if (o.block?.blockId === "custom") o.placement = { x: 0, y: 0, w: width, h: height }
  const scenes = s.overlays.filter(covers)
  const frame = sceneFrame({ width, height }, safe, { w, h })
  for (const scene of scenes) scene.placement = frame.content
  // A definition has its own place, above the caption row or at the top, wherever no face is; with none free
  // it stays out. Captions under it keep to their row, so the two never meet
  const terms = s.overlays.filter((o) => o.block?.blockId === "term")
  for (const term of terms) {
    const tall = Math.floor(height * 0.18)
    const gap = Math.round(height * 0.012)
    const clash = (box) => facesDuring(s, term.at, term.end).some((f) => box.x < f.x + f.w && f.x < box.x + box.w && box.y < f.y + f.h && f.y < box.y + box.h)
    const options = [{ ...frame.row, y: frame.row.y - gap - tall, h: tall }, { ...frame.row, y: frame.content.y, h: tall }]
    term.placement = options.find((box) => !clash(box)) ?? null
    if (!term.placement) s.issue("no_placement", { clip: term.clip, message: "there's no place for this definition clear of the speaker's face, so it isn't shown" })
  }
  const onScene = (item) => [...scenes, ...terms].some((scene) => scene.at < item.end && item.at < scene.end)
  // Footage over the whole frame hides the speaker, so a caption there has no face to clear
  const footage = s.overlays.filter((o) => !o.block)
  const hidden = (item) => footage.some((o) => o.at <= item.at && item.end <= o.end)
  const placeable = [...s.captions, ...s.overlays.filter((o) => o.block && !covers(o) && regionOf(o)?.region !== "frame" && o.block.blockId !== "term" && o.block.blockId !== "custom")]
  // A caption look that sits in the middle or at the top (TP7) says so in look.caption.place; none, and the recipe's row as before
  const place = s.project.look?.caption?.place
  const captionPrefer = place === "middle" ? Math.round(((height - h) / 2 / height) * 100) : place === "top" ? 0 : undefined
  const captionIds = new Set(s.captions.map((c) => c.clip))
  // Text behind the speaker may sit on the face: the matte puts the speaker in front of it
  const items = placeable.map((item) => {
    const covered = onScene(item)
    const region = regionOf(item)
    const faces = item.behind || covered || hidden(item) ? [] : facesDuring(s, item.at, item.end)
    if (region && !item.placement && !covered) {
      const v = item.block.variables
      // A callout marks a point the person gave, or else the first face it sees
      // TP9: a box the person drew (thousandths of the frame) is placed exactly, as pixels of this canvas
      if (region.region === "point" && v.mark) return { id: item.clip, at: item.at, end: item.end, w: 0, h: 0, region: "point", fixed: markPixels(v.mark, { width, height }), faces: [] }
      const point = region.region === "point" ? (v.point ?? (faces[0] ? { x: Math.round(faces[0].x + faces[0].w / 2), y: Math.round(faces[0].y + faces[0].h / 2) } : undefined)) : undefined
      const across = region.region === "corner" ? width : width - (safe.left ?? 0) - (safe.right ?? 0)
      return { id: item.clip, at: item.at, end: item.end, w: Math.floor(across * region.w), h: Math.floor(height * region.h), region: region.region, ...(point ? { point } : {}), ...(v.corner ? { corner: v.corner } : {}), faces: region.region === "point" ? [] : faces }
    }
    return { id: item.clip, at: item.at, end: item.end, w, h, faces, ...(item.placement ? { fixed: item.placement } : covered ? { fixed: frame.row } : {}), ...(captionPrefer !== undefined && captionIds.has(item.clip) ? { prefer: captionPrefer } : {}) }
  })
  const { placements, issues } = solveLayout(items, { canvas: { width, height }, safe, prefer: rules.prefer })
  for (const item of placeable) item.placement = placements[item.clip]
  for (const issue of issues) s.issue(issue.code, issue)
}

/** Step 7: the budget. */
function checkBudget(s) {
  const target = s.project.brief?.targetDuration
  if (target === undefined) return
  const off = s.duration - target
  if (Math.abs(off) <= s.rules.targetTolerance) return
  s.issue(off > 0 ? "over_target" : "under_target", { target, actual: s.duration, message: `the cut ${off > 0 ? "runs over" : "falls short of"} the target duration` })
}

/**
 * @param {object} project
 * @param {object} rawIndex rows from the index: words, shots, beats, faces, timestamps, zeroCrossings
 * @param {Partial<typeof DEFAULT_RULES>} [overrides] a recipe's values
 */
export function solve(project, rawIndex = {}, overrides = {}) {
  const sequence = project.sequences.find((q) => q.id === project.active)
  const tracks = new Map(sequence.tracks.map((track) => [track.id, track]))
  const isBase = (clip) => tracks.get(clip.track).role === "base"
  const index = openIndex(rawIndex)
  const s = {
    project,
    sequence,
    tracks,
    index,
    raw: rawIndex,
    rules: { ...DEFAULT_RULES, ...overrides },
    assets: new Map(project.assets.map((asset) => [asset.id, asset])),
    fps: project.canvas.fps,
    rest: sequence.clips.filter((clip) => !isBase(clip)),
    picture: [],
    audio: [],
    overlays: [],
    zooms: [],
    captions: [],
    mattes: [],
    adjustments: [],
    issues: [],
    duration: 0,
    issue(code, details) {
      this.issues.push({ ...details, code })
    },
  }
  const sounds = s.rest.filter((clip) => tracks.get(clip.track).role === "sfx" && clip.at?.word !== undefined)
  s.airWords = new Set(s.rules.airAfter > 0 ? sounds.map((clip) => clip.at.word) : [])

  layBase(s, sequence.clips.filter(isBase))
  placeRest(s)
  layOut(s)
  checkBudget(s)
  const { picture, audio, overlays, zooms, captions, mattes, issues, duration, fps, adjustments } = s
  // An adjustment's key exists only when one is used, so today's timelines are the objects they were (EH-59)
  return { fps, duration, picture, audio, overlays, zooms, captions, mattes, issues, ...(adjustments.length ? { adjustments } : {}) }
}
