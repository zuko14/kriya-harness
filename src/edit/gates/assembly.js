// QG-15 Assembly (TP2, ASSEMBLY_AND_INTENT §6.3): does the film have the files it was asked
// for, in the order asked? Two readings. From the cut as solved: the parts play in the
// assembly's order, each inside its own stretch, each `over` part inside its host. From the
// rendered file: half a second after each join, the frame matches the expected file at the
// expected source time (the same region of both, small and grey, compared by how its light and
// dark fall: a look or an encode moves that little, another file or moment moves it a lot). It runs on
// assembly makes only, and it is a note until its threshold is measured (TPX-04, EQ-22) and
// its seeded run passes 10 of 10 with no false alarm (EH-70). It can't tell two takes of the
// same shot apart; checking a join by its source sound isn't built.

import { edgeTime } from "../director/assembly.js"

const FLICKS = 705_600_000
const SPINE = ["story", "whole"]
export const THUMB = { w: 32, h: 18 }
// shortcut: not measured on natural footage (EQ-22, TPX-04). On barcoded synthetic files a frame either side
// reads about 0.17 and another file or a moment a second away reads 0.5 or more
export const ASSEMBLY_THRESHOLDS = { distance: 0.25, afterJoin: FLICKS / 2, stretchSlack: FLICKS / 2 }

const seconds = (flicks) => (flicks / FLICKS).toFixed(6)
const round = (n) => Math.round(n * 1000) / 1000

/**
 * How unlike two small grey pictures are, 0 (the same) to 2 (the negative): one minus the
 * correlation of their light and dark, so a brighter, flatter or tinted copy is still the same.
 * A picture with no light and dark at all (a black frame) is unlike everything but its like.
 */
export function thumbDistance(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 2
  const mean = (x) => x.reduce((sum, v) => sum + v, 0) / x.length
  const [ma, mb] = [mean(a), mean(b)]
  let [ab, aa, bb] = [0, 0, 0]
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb)
    aa += (a[i] - ma) ** 2
    bb += (b[i] - mb) ** 2
  }
  // Flat pictures: alike only when both are flat and as bright as each other
  if (aa < a.length || bb < a.length) return aa < a.length && bb < a.length && Math.abs(ma - mb) < 16 ? 0 : 1
  return 1 - ab / Math.sqrt(aa * bb)
}

/**
 * Where the same picture is in the source and in the output, under the plan's own geometry:
 * fill shows the source's middle over the whole frame; fit and blur show the whole source in
 * the frame's middle; a reframe shows the crop the plan chose at that moment.
 * @returns {{ source: { x: number, y: number, w: number, h: number }, output: { x: number, y: number, w: number, h: number } }}
 */
export function sameRegion({ source, output, mode = "fill", cropX }) {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2)
  if (mode === "fit" || mode === "blur") {
    const scale = Math.min(output.width / source.width, output.height / source.height)
    const [w, h] = [even(source.width * scale), even(source.height * scale)]
    return { source: { x: 0, y: 0, w: source.width, h: source.height }, output: { x: Math.floor((output.width - w) / 2), y: Math.floor((output.height - h) / 2), w, h } }
  }
  const frame = output.width / output.height
  const w = even(Math.min(source.width, source.height * frame))
  const h = even(Math.min(source.height, source.width / frame))
  return { source: { x: cropX === undefined ? Math.floor((source.width - w) / 2) : Math.max(0, Math.min(source.width - w, cropX)), y: Math.floor((source.height - h) / 2), w, h }, output: { x: 0, y: 0, w: output.width, h: output.height } }
}

async function thumbAt(file, t, region, run) {
  const chunks = []
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", seconds(Math.max(0, t)), "-protocol_whitelist", "file,pipe", "-i", file, "-frames:v", "1", "-vf", `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=${THUMB.w}:${THUMB.h}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"], { timeoutMs: 120_000, onStdout: (chunk) => chunks.push(chunk) })
  const data = Buffer.concat(chunks)
  return data.length >= THUMB.w * THUMB.h ? data.subarray(0, THUMB.w * THUMB.h) : null
}

/** The picture as it plays, one run per stretch of one file: [{ asset, at, end, in, out, pieces }]. */
export function runsOf(picture) {
  const runs = []
  for (const piece of [...picture].sort((a, b) => a.at - b.at)) {
    if (piece.echo) continue
    const last = runs.at(-1)
    if (last && last.asset === piece.asset) Object.assign(last, { end: piece.end, in: Math.min(last.in, piece.in), out: Math.max(last.out, piece.out), pieces: [...last.pieces, piece] })
    else runs.push({ asset: piece.asset, at: piece.at, end: piece.end, in: piece.in, out: piece.out, pieces: [piece] })
  }
  return runs
}

/**
 * The cut against the assembly, with no file read: order, stretches, hosts.
 * @param {{ assembly: { parts: object[] }, timeline: object, project: object, index?: object, left?: string[] }} input left: part ids the make left out with a note (a file gone)
 * @returns {{ failures: object[], expected: { asset: string, at: number, end: number, in: number, out: number, pieces: object[] }[] }}
 */
export function judgeOrder({ assembly, timeline, project, index = {}, left = [] }) {
  const failures = []
  const parts = assembly.parts.filter((p) => !left.includes(p.id))
  const lengthOf = (asset) => project.assets.find((a) => a.id === asset)?.facts?.duration ?? Number.MAX_SAFE_INTEGER
  // Parts of one file that follow each other play as one run
  const asked = []
  for (const part of parts.filter((p) => SPINE.includes(p.use))) {
    const stretch = { from: edgeTime(part.from, index, "start") ?? 0, to: edgeTime(part.to, index, "end") ?? lengthOf(part.asset) }
    const last = asked.at(-1)
    if (last && last.asset === part.asset) last.stretches.push(stretch)
    else asked.push({ asset: part.asset, ids: [part.id], stretches: [stretch] })
    if (last && last.asset === part.asset) last.ids.push(part.id)
  }
  const runs = runsOf(timeline.picture)
  const played = runs.map((r) => r.asset)
  const wanted = asked.map((a) => a.asset)
  if (JSON.stringify(played) !== JSON.stringify(wanted)) {
    const missing = wanted.filter((asset) => !played.includes(asset))
    failures.push(missing.length ? { kind: "missing_part", assets: missing, asked: wanted, played } : { kind: "order", asked: wanted, played })
  } else {
    const slack = ASSEMBLY_THRESHOLDS.stretchSlack
    runs.forEach((run, i) => {
      for (const piece of run.pieces) {
        if (piece.hold) continue
        if (!asked[i].stretches.some((s) => piece.in >= s.from - slack && piece.out <= s.to + slack)) failures.push({ kind: "outside_stretch", part: asked[i].ids[0], asset: run.asset, seconds: round(piece.at / FLICKS), plays: [round(piece.in / FLICKS), round(piece.out / FLICKS)] })
      }
    })
  }
  // Each `over` part lies inside its host
  const overlays = timeline.overlays.filter((o) => !o.block)
  for (const part of parts.filter((p) => p.use === "over")) {
    const shown = overlays.filter((o) => o.asset === part.asset)
    const host = parts.find((p) => p.id === part.at?.part)
    const hostRuns = runs.filter((r) => r.asset === host?.asset)
    if (!shown.length) failures.push({ kind: "missing_part", assets: [part.asset], over: true })
    for (const o of shown) if (!hostRuns.some((r) => o.at >= r.at && o.end <= r.end)) failures.push({ kind: "over_outside_host", part: part.id, asset: part.asset, seconds: round(o.at / FLICKS) })
  }
  return { failures, expected: runs }
}

/**
 * QG-15, as the runner calls it.
 * @param {{ file: string, plan: object, project: object, index: object, sourcePath: (asset: string) => string, run: Function, assembly: { parts: object[], left?: string[] }, timeline: object }} input
 */
export async function judgeAssembly({ file, plan, project, index, sourcePath, run, assembly, timeline }) {
  const { failures, expected } = judgeOrder({ assembly, timeline, project, index, left: assembly.left })
  const factsOf = (asset) => project.assets.find((a) => a.id === asset)?.facts ?? {}
  const output = plan.output
  // What to look at: half a second into each run (the first too), its middle and near its end, and the middle
  // of each cutaway. One moment can look like another by chance; three rarely all do
  const frame = Math.round((FLICKS * output.fps.d) / output.fps.n)
  const overlays = timeline.overlays.filter((o) => !o.block)
  const within = (r, t) => Math.max(r.at, Math.min(r.end - 2 * frame, t))
  // Under a cutaway the part's own picture can't be seen, so it is read where it can be
  const covered = (t) => overlays.some((o) => o.at - frame <= t && t <= o.end + frame)
  const points = [
    ...expected.flatMap((r) => [...new Set([within(r, r.at + ASSEMBLY_THRESHOLDS.afterJoin), within(r, Math.floor((r.at + r.end) / 2)), within(r, r.end - ASSEMBLY_THRESHOLDS.afterJoin)])].filter((t) => !covered(t)).map((t) => ({ t, piece: r.pieces.find((p) => p.at <= t && t < p.end) ?? r.pieces[0], what: "join" }))),
    // A cutaway is read a few frames in: the Engine shows an overlay a frame after its start
    ...overlays.map((o) => ({ t: Math.floor((o.at + o.end) / 2), piece: o, what: "over" })),
  ]
  let worst = 0
  let checked = 0
  let unread = 0
  for (const { t, piece, what } of points) {
    const facts = factsOf(piece.asset)
    if (!facts.width || !facts.height || piece.hold) continue
    const rate = piece.speed ?? { n: 1, d: 1 }
    const sourceT = piece.in + Math.round(((t - piece.at) * rate.n) / rate.d)
    const framed = piece.effects?.find((e) => e.type === "frame")
    const reframe = piece.effects?.find((e) => e.type === "reframe")
    // shortcut: a reframe that follows a face is read at the centre crop; a moving crop can read a little off
    const region = sameRegion({ source: { width: facts.width, height: facts.height }, output, mode: framed?.mode ?? "fill", ...(reframe?.mode === "fixed" ? { cropX: reframe.x ?? 0 } : {}) })
    const wanted = await thumbAt(sourcePath(piece.asset), sourceT, region.source, run)
    if (!wanted) {
      unread++
      continue
    }
    const seen = await thumbAt(file, t, region.output, run)
    checked++
    // The film has no frame where this part should be playing: it is shorter than the order asked for
    if (!seen) {
      failures.push({ kind: "frame_missing", what, asset: piece.asset, seconds: round(t / FLICKS) })
      continue
    }
    const distance = thumbDistance(seen, wanted)
    worst = Math.max(worst, distance)
    if (distance > ASSEMBLY_THRESHOLDS.distance) failures.push({ kind: "frame_mismatch", what, asset: piece.asset, seconds: round(t / FLICKS), distance: round(distance), allowed: ASSEMBLY_THRESHOLDS.distance })
  }
  const numbers = { parts: assembly.parts.length, joins: Math.max(0, expected.length - 1), framesChecked: checked, framesUnread: unread, worstDistance: round(worst), allowed: ASSEMBLY_THRESHOLDS.distance, threshold: "not measured on natural footage (EQ-22)" }
  return { failures, numbers }
}

/** A failure in plain words. */
export function sayFailure(f, numberOf = (asset) => asset) {
  switch (f.kind) {
    case "missing_part":
      return `${f.assets.map(numberOf).join(" and ")} ${f.over ? "was to play over the voice and doesn't" : "was asked for and isn't in the film"}.`
    case "order":
      return `The parts play as ${f.played.map(numberOf).join(", ")}; the order asked for was ${f.asked.map(numberOf).join(", ")}.`
    case "outside_stretch":
      return `${numberOf(f.asset)} plays ${f.plays[0]} to ${f.plays[1]} s of its file at ${f.seconds} s, outside the stretch asked for.`
    case "over_outside_host":
      return `${numberOf(f.asset)} plays over a part it wasn't asked to, at ${f.seconds} s.`
    case "frame_missing":
      return `The film has no picture at ${f.seconds} s, where ${numberOf(f.asset)} should be playing.`
    default:
      return `At ${f.seconds} s the picture doesn't look like ${numberOf(f.asset)} at that moment (unlike by ${f.distance}; ${f.allowed} allowed).`
  }
}
