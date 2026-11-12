// The Viewer's Report (TP8, CRAFT_UPGRADE §6.2, EDD-68): the Director watches its own draft
// by code, free and always, in five-second windows. Picture changes come from the timeline
// and from the rendered file's own cuts; loudness and pauses from the rendered sound; text on
// screen, cutaways and speech from the solved timeline. It names typed findings and one score,
// deterministic for the same draft. No model is asked: watching by model (§6.3) needs
// editing.frameVision and the project's frame consent (EDD-14), and even then sends nothing here.

import { solve } from "../core/solver.js"
import { metadataFrames, ptsFlicks } from "../index/layers/meta.js"
import { CUT_SCORE } from "../index/layers/shots.js"
import { readSound, soundArgs, STEP } from "../index/layers/sound.js"

const FLICKS = 705_600_000
export const WINDOW = 5 * FLICKS
// still: scdet's mean frame difference on the 160 px copy, under which a window with no change is dull.
// Measured 2026-11-11: still bars with light noise 0.10, testsrc 0.15, testsrc2 0.81, a mandelbrot zoom 1.03
export const LIMITS = { deadAir: Math.round(1.5 * FLICKS), levelJump: 6, crowded: 3, still: 1 }
// Picture changes a window needs for its playbook's pace: the slow genres are never dull
const SLOW = new Set(["documentary", "podcast", "montage"])
export const paceOf = (genre) => (SLOW.has(genre) ? 0 : 1)
// What each finding costs the score; a crowded frame or a dead pause is worse than a still one
export const WEIGHT = { dull: 4, crowded: 8, dead_air: 8, repeated_cutaway: 8, level_jump: 6 }

/** Whether the model may look at frames: only with the switch on and the project's own consent (EDD-14, ET-DL-06). */
export const mayWatchFrames = (features = {}, project = {}) => features.frameVision === true && project.consent?.frames === true

/**
 * What the draft shows, from its solved timeline: where the picture changes, the text on screen,
 * the cutaways and the spoken words, all in timeline flicks, with the clip each came from.
 */
export function timelineOf(project, index = {}) {
  const solved = solve(project, index)
  const base = solved.picture.filter((p) => p.role !== "broll" && p.asset)
  const cutaways = solved.overlays.filter((o) => o.role === "broll" && o.asset).map(({ clip, asset, at, end, in: from, out }) => ({ clip, asset, at, end, in: from, out }))
  const blocks = solved.overlays.filter((o) => o.block).map(({ clip, at, end, block }) => ({ clip, at, end, kind: block.blockId === "scene" ? "scene" : "graphic", block }))
  const texts = [...(solved.captions ?? []).map(({ clip, at, end }) => ({ clip, at, end, kind: "caption" })), ...blocks]
  const zooms = (solved.zooms ?? []).map(({ clip, at, end }) => ({ clip, at, end }))
  const changes = [...base.slice(1).map((p) => p.at), ...cutaways.flatMap((c) => [c.at, c.end]), ...zooms.flatMap((z) => [z.at, z.end])].filter((t) => t > 0 && t < solved.duration)
  const words = []
  for (const piece of base) for (const word of index.words ?? []) if (word.asset === piece.asset && word.start >= piece.in && word.end <= piece.out && !word.flags?.includes("trimmed")) words.push({ at: piece.at + (word.start - piece.in), end: piece.at + (word.end - piece.in) })
  const faced = new Set(Object.entries(index.subjects ?? {}).filter(([, list]) => list?.length).map(([asset]) => asset))
  return { duration: solved.duration, base: base.map(({ clip, asset, at, end, in: from, out }) => ({ clip, asset, at, end, in: from, out, face: faced.has(asset) })), cutaways, texts, zooms, changes, words }
}

export const drawnArgs = (file) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-an", "-sn", "-dn", "-vf", `scale=160:-2,settb=AVTB,scdet=threshold=${CUT_SCORE},metadata=mode=print:file=-`, "-f", "null", "-"]

/** Reads the rendered draft: its own cuts and motion per frame, and its sound every 100 ms. */
export async function measureDraft(file, { run, duration }) {
  const frames = metadataFrames(await run("ffmpeg", drawnArgs(file), { timeoutMs: 600_000 })).map(({ pts, values }) => ({ t: ptsFlicks(pts, 1_000_000), mafd: Number(values["lavfi.scd.mafd"] ?? 0), score: Number(values["lavfi.scd.score"] ?? 0) }))
  const sound = readSound(await run("ffmpeg", soundArgs(file), { timeoutMs: 600_000 }), duration)
  return { frames, cuts: frames.filter((f) => f.score >= CUT_SCORE && f.t > 0).map((f) => f.t), loudness: sound.data.loudness, silences: sound.silences }
}

const energy = (values) => {
  const live = values.filter((v) => v !== null && v !== undefined)
  return live.length ? Math.round(10 * Math.log10(live.reduce((sum, v) => sum + 10 ** (v / 10), 0) / live.length) * 10) / 10 : null
}
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.at, b.at))
const near = (list, t, within = FLICKS / 5) => list.some((x) => Math.abs(x - t) <= within)

/** The most text layers on screen at once inside [at, end), and the clips at that moment. */
function crowdIn(texts, at, end) {
  let most = { count: 0, at, clips: [] }
  for (const t of texts.filter((x) => x.at < end && x.end > at)) {
    const moment = Math.max(t.at, at)
    const on = texts.filter((x) => x.at <= moment && x.end > moment)
    if (on.length > most.count) most = { count: on.length, at: moment, end: Math.min(...on.map((x) => x.end), end), clips: on.map((x) => x.clip) }
  }
  return most
}

/**
 * The report: per window its measures, the findings against the playbook's pace, and one score
 * (100 with nothing found, lower for each finding, never below 0). Pure: the same input, the same report.
 * @param {{ timeline: ReturnType<typeof timelineOf>, measured?: Awaited<ReturnType<typeof measureDraft>> | null, genre?: string }} input
 */
export function viewerReport({ timeline, measured = null, genre = "opinion" }) {
  const { duration } = timeline
  const pace = paceOf(genre)
  const changes = [...timeline.changes]
  for (const t of measured?.cuts ?? []) if (!near(changes, t)) changes.push(t)
  const windows = []
  for (let at = 0; at < duration; at += WINDOW) {
    const end = Math.min(duration, at + WINDOW)
    const span = { at, end }
    const length = end - at
    const shown = timeline.base.filter((p) => p.face).reduce((sum, p) => sum + overlap(p, span), 0) - timeline.cutaways.reduce((sum, c) => sum + overlap(c, span), 0)
    const frames = measured?.frames?.filter((f) => f.t >= at && f.t < end) ?? []
    windows.push({
      at,
      end,
      changes: changes.filter((t) => t >= at && t < end).length,
      face: Math.max(0, Math.round((shown / length) * 100) / 100),
      text: crowdIn(timeline.texts, at, end).count,
      loudness: measured ? energy(measured.loudness.slice(Math.floor(at / STEP), Math.ceil(end / STEP))) : null,
      speech: Math.round((timeline.words.filter((w) => w.at >= at && w.at < end).length / (length / FLICKS)) * 10) / 10,
      motion: frames.length ? Math.round((frames.reduce((sum, f) => sum + f.mafd, 0) / frames.length) * 100) / 100 : null,
    })
  }
  const findings = []
  for (const w of windows) {
    // Dull: a whole window where the picture never changes and barely moves, for a pace that wants change
    if (pace && w.end - w.at >= WINDOW * 0.8 && w.changes < pace && (w.motion === null || w.motion < LIMITS.still)) findings.push({ kind: "dull", at: w.at, end: w.end })
    const crowd = crowdIn(timeline.texts, w.at, w.end)
    if (crowd.count >= LIMITS.crowded) findings.push({ kind: "crowded", at: crowd.at, end: crowd.end, clips: crowd.clips })
  }
  // Dead air: a pause in the rendered sound (or, unrendered, between spoken words) longer than a breath
  const pauses = measured ? measured.silences : timeline.words.slice(1).map((w, i) => ({ start: timeline.words[i].end, end: w.at }))
  for (const p of pauses) if (p.end - p.start >= LIMITS.deadAir && p.start > 0 && p.end < duration) findings.push({ kind: "dead_air", at: p.start, end: p.end })
  // The same B-roll twice: the same file back to back, or the same stretch of it again anywhere
  const shown = [...timeline.cutaways].sort((a, b) => a.at - b.at)
  shown.forEach((c, i) => {
    const again = shown.slice(0, i).some((d) => d.asset === c.asset && (d === shown[i - 1] || (c.in < d.out && d.in < c.out)))
    if (again) findings.push({ kind: "repeated_cutaway", at: c.at, end: c.end, clip: c.clip, asset: c.asset })
  })
  // A level jump: two voiced windows side by side whose loudness steps by more than the limit
  for (let i = 1; i < windows.length; i++) {
    const [a, b] = [windows[i - 1], windows[i]]
    if (a.loudness === null || b.loudness === null) continue
    const step = Math.round((b.loudness - a.loudness) * 10) / 10
    if (Math.abs(step) >= LIMITS.levelJump) findings.push({ kind: "level_jump", at: b.at, end: b.end, db: step, louder: step > 0 ? { at: b.at, end: b.end } : { at: a.at, end: a.end } })
  }
  findings.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind))
  const penalty = findings.reduce((sum, f) => sum + WEIGHT[f.kind], 0)
  // Never saturates: a fix that removes any finding raises it, however long the film
  const score = windows.length ? Math.round((100 * windows.length) / (windows.length + penalty / 10) * 10) / 10 : 0
  return { windows, findings, score }
}

const clock = (t) => {
  const s = Math.round(t / (FLICKS / 10)) / 10
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`
}
const WORDS = { dull: "a still stretch", crowded: "too much text at once", dead_air: "a long pause", repeated_cutaway: "the same B-roll again", level_jump: "a jump in loudness" }
/** A finding in the person's words, with its time. */
export const sayFinding = (f) => `${WORDS[f.kind]} at ${clock(f.at)}`
