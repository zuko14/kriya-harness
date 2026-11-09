// Quality gates (QUALITY_GATES.md): verdicts are code, read from the rendered file.
// Each gate reports its numbers, its threshold and where it failed; a gate that
// couldn't run is `not_checked`, never `passed`. Thresholds are data (§1 rule 4).
// Built: QG-01, -02, -05, -06, -12 (ED7); QG-08, -09 (ED8); QG-06 complete (ED9);
// QG-03, -04, -07, -10, -11, -13, -14 (ED10). A gate whose tool isn't here says `not_checked`.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { busOf, speechSpans } from "../core/audio.js"
import { isSceneBlock } from "../core/layout.js"
import { wholeSegment } from "../core/plan.js"
import { solve } from "../core/solver.js"
import { measureLoudness } from "../engine/loudness.js"
import { runTool } from "../engine/tool.js"
import { judgeCopy, ocrHelper, readOcr } from "./copy.js"
import { healthArgs, judgeHealth, judgeMotion, judgeSync, readHealth, streamTimes, tileFrames } from "./picture.js"
import { curveOf, judgeMix, rangeOf } from "./sound.js"
import { expectedWords, judgeReview, judgeSpeech, REVIEWER_SCHEMA } from "./speech.js"
import { judgeLayout, judgeLegibility, measurePlan } from "./text.js"
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../index/views.js"

const FLICKS = 705_600_000
const RATE = 48_000

export const THRESHOLDS = {
  frames: 1, // QG-02: off by more than this many frames
  minShotFrames: 3, // QG-05
  voicedRatio: 4, // QG-05: RMS at a cut over the recording's own floor × this is speech
  voicedFloorDb: -50, // and above this, so a silent recording has no "speech"
  clickRatio: 10, // QG-05: a jump this many times the local slope is a pop
  clickMin: 0.05,
  loudnessLU: 0.5, // QG-06
  maxRange: null, // QG-06: a recipe's loudness range limit, in LU; none by default
  speechOverMusic: 8, // QG-06: LU the speech stays over the music in each stretch of speech (untuned)
  sfxOverVoice: 3, // QG-06: LU an effect's loudest moment may pass the voice's integrated loudness (untuned)
  lengthTolerance: 0.15, // QG-12: target length ± this share
  contrast: 4.5, // QG-09: WCAG AA for text, against the pixels behind it
  minTextShare: 0.02, // QG-09: text under this share of the frame's height is too small
  maxDriftMs: 40, // QG-03
  exposureJump: 30, // QG-07: mean luma steps (of 255) at a cut between pieces of one source; a note
  minMotion: 0.5, // QG-11: mean alpha change (of 255) in a tile's first second
  copySimilarity: 0.9, // QG-10: rendered text against the intended text
}

export const GATES = ["QG-01", "QG-02", "QG-03", "QG-04", "QG-05", "QG-06", "QG-07", "QG-08", "QG-09", "QG-10", "QG-11", "QG-12", "QG-13", "QG-14"]
const BUILT = new Set(GATES)

const frameFlicks = (fps) => (FLICKS * fps.d) / fps.n
const ratio = (text) => {
  const [n, d] = String(text).split("/").map(Number)
  return n > 0 && d > 0 ? { n, d } : null
}
const seconds = (flicks) => (flicks / FLICKS).toFixed(6)
const SEVERITY = { "QG-13": "note", "QG-14": "note" }
const result = (id, status, numbers = {}, message = "", at = null, severity = SEVERITY[id] ?? "block") => ({ id, status, severity, numbers, message, ...(at === null ? {} : { at }) })

async function probeFile(file, run) {
  return JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-count_frames", file], { timeoutMs: 600_000 }))
}

/** Mono samples of a file between two times, as Float32 in [-1, 1]. */
async function samples(file, from, length, run) {
  const chunks = []
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", seconds(Math.max(0, from)), "-t", seconds(length), "-i", file, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"], { timeoutMs: 120_000, onStdout: (chunk) => chunks.push(chunk) })
  const data = Buffer.concat(chunks)
  const out = new Float32Array(Math.floor(data.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768
  return out
}

const rms = (x, from = 0, to = x.length) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += x[i] * x[i]
  return to > from ? Math.sqrt(sum / (to - from)) : 0
}

/** A recording's own noise floor: the 10th percentile of its 20 ms RMS. */
function floorOf(x) {
  const step = RATE / 50
  const levels = []
  for (let i = 0; i + step <= x.length; i += step) levels.push(rms(x, i, i + step))
  levels.sort((a, b) => a - b)
  return levels[Math.floor(levels.length * 0.1)] ?? 0
}

/* ─────────────────────────────── the gates ─────────────────────────────── */

async function qg01({ file, plan, run }) {
  try {
    const data = await probeFile(file, run)
    const video = data.streams.find((s) => s.codec_type === "video")
    const audio = data.streams.find((s) => s.codec_type === "audio")
    const fps = ratio(video?.avg_frame_rate)
    const want = plan.output
    const numbers = { codec: video?.codec_name, width: video?.width, height: video?.height, fps: video?.avg_frame_rate, pixFmt: video?.pix_fmt, primaries: video?.color_primaries, audio: audio?.codec_name }
    const wrong = []
    if (video?.codec_name !== "h264") wrong.push("codec")
    if (video?.width !== want.width || video?.height !== want.height) wrong.push("size")
    if (!fps || fps.n * want.fps.d !== want.fps.n * fps.d) wrong.push("fps")
    if (video?.pix_fmt !== "yuv420p") wrong.push("pixel format")
    if (video?.color_primaries !== "bt709" || video?.color_transfer !== "bt709") wrong.push("colour tags")
    if (audio?.codec_name !== "aac") wrong.push("audio codec")
    // A full read: any decode error fails it
    await run("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { timeoutMs: 600_000 })
    return wrong.length ? result("QG-01", "failed", numbers, `Not to spec: ${wrong.join(", ")}.`) : result("QG-01", "passed", numbers)
  } catch (error) {
    return result("QG-01", "failed", {}, `The file doesn't play: ${error.message}`)
  }
}

async function qg02({ file, plan, run }) {
  const data = await probeFile(file, run)
  const video = data.streams.find((s) => s.codec_type === "video")
  const audio = data.streams.find((s) => s.codec_type === "audio")
  const frame = frameFlicks(plan.output.fps)
  const expected = Math.round(plan.duration / frame)
  const frames = Number(video?.nb_read_frames)
  const base = (stream) => stream.time_base.split("/").map(Number)
  const flicksOf = (stream) => (stream?.duration_ts ? (Number(stream.duration_ts) * base(stream)[0] * FLICKS) / base(stream)[1] : Number(stream?.duration ?? 0) * FLICKS)
  const audioFrames = audio ? flicksOf(audio) / frame : null
  const numbers = { expectedFrames: expected, videoFrames: frames, audioFrames: audioFrames === null ? null : Math.round(audioFrames * 100) / 100, tolerance: THRESHOLDS.frames }
  if (!Number.isFinite(frames)) return result("QG-02", "not_checked", numbers, "The frames couldn't be counted.")
  if (Math.abs(frames - expected) > THRESHOLDS.frames) return result("QG-02", "failed", numbers, `${frames} frames, the plan says ${expected}.`)
  if (audioFrames === null || Math.abs(audioFrames - frames) > THRESHOLDS.frames) return result("QG-02", "failed", numbers, "Sound and picture aren't the same length.")
  return result("QG-02", "passed", numbers)
}

/** Cuts in the base picture: where one piece ends and a non-contiguous one begins. */
export function cutsOf(picture) {
  const cuts = []
  for (let i = 1; i < picture.length; i++) {
    const [a, b] = [picture[i - 1], picture[i]]
    if (a.asset !== b.asset || a.out !== b.in) cuts.push({ at: b.at, out: { asset: a.asset, t: a.out }, in: { asset: b.asset, t: b.in } })
  }
  return cuts
}

async function qg05({ file, project, index, sourcePath, run }) {
  const timeline = solve(project, index)
  const picture = [...timeline.picture].sort((a, b) => a.at - b.at)
  const fps = project.canvas.fps
  const problems = []
  const short = picture.filter((p) => (p.end - p.at) / frameFlicks(fps) < THRESHOLDS.minShotFrames)
  for (const p of short) problems.push({ at: p.at, kind: "short_shot", frames: Math.round((p.end - p.at) / frameFlicks(fps)) })
  const cuts = cutsOf(picture)
  const words = index.words ?? []
  const inside = (edge) => words.find((w) => w.asset === edge.asset && edge.t > w.start && edge.t < w.end)
  const sources = new Map()
  const sourceOf = async (asset) => {
    if (!sources.has(asset)) {
      const x = await samples(sourcePath(asset), 0, project.assets.find((a) => a.id === asset).facts.duration, run)
      sources.set(asset, { x, floor: floorOf(x) })
    }
    return sources.get(asset)
  }
  let worstClick = 0
  for (const cut of cuts) {
    for (const [side, edge] of [["out", cut.out], ["in", cut.in]]) {
      const word = inside(edge)
      if (word) problems.push({ at: cut.at, kind: "cut_inside_word", side, word: word.id })
      // The source's own sound just inside the kept side of the edge
      const { x, floor } = await sourceOf(edge.asset)
      const at = Math.round((edge.t / FLICKS) * RATE)
      const window = RATE / 100
      const level = side === "out" ? rms(x, Math.max(0, at - window), at) : rms(x, at, Math.min(x.length, at + window))
      const db = 20 * Math.log10(Math.max(level, 1e-9))
      if (level > floor * THRESHOLDS.voicedRatio && db > THRESHOLDS.voicedFloorDb) problems.push({ at: cut.at, kind: "cut_in_voiced_speech", side, db: Math.round(db * 10) / 10 })
    }
    // A pop in the output at the cut: a jump far above the local slope
    const y = await samples(file, cut.at - FLICKS / 50, FLICKS / 25, run)
    let slope = 0
    let jump = 0
    for (let i = 1; i < y.length; i++) {
      const d = Math.abs(y[i] - y[i - 1])
      slope += d
      jump = Math.max(jump, d)
    }
    slope /= Math.max(1, y.length - 1)
    const score = jump / Math.max(slope, 1e-4)
    worstClick = Math.max(worstClick, jump >= THRESHOLDS.clickMin ? score : 0)
    if (jump >= THRESHOLDS.clickMin && score > THRESHOLDS.clickRatio) problems.push({ at: cut.at, kind: "pop", jump: Math.round(jump * 1000) / 1000 })
  }
  const numbers = { cuts: cuts.length, worstClickRatio: Math.round(worstClick * 10) / 10, problems: problems.length }
  return problems.length ? result("QG-05", "failed", { ...numbers, first: problems[0] }, `A cut isn't clean: ${problems[0].kind.replaceAll("_", " ")}.`, problems[0].at) : result("QG-05", "passed", numbers)
}

async function qg06({ file, plan, index, run, thresholds, stems }) {
  const target = plan.audio.loudness
  if (!target) return result("QG-06", "not_applicable", {}, "This render has no loudness target.")
  const { integrated, truePeak } = await measureLoudness(file, { run })
  const range = await rangeOf(file, run)
  const numbers = { integrated, truePeak: truePeak === null ? null : Math.round(truePeak * 100) / 100, target: target.lufs, ceiling: target.tp, tolerance: thresholds.loudnessLU, range }
  if (integrated === null) return result("QG-06", "failed", numbers, "The file is silent.")
  // Every failure is listed, so the report says all of what's wrong
  const failures = []
  if (Math.abs(integrated - target.lufs) > thresholds.loudnessLU) failures.push({ kind: "off_target", message: `Loudness ${integrated.toFixed(1)} LUFS, the target is ${target.lufs}.` })
  if (truePeak !== null && truePeak > target.tp) failures.push({ kind: "over_ceiling", message: `True peak ${truePeak.toFixed(1)} dBTP is over ${target.tp}.` })
  if (thresholds.maxRange !== null && range !== null && range > thresholds.maxRange) failures.push({ kind: "range", message: `The loudness range is ${range} LU, over the recipe's ${thresholds.maxRange}.` })
  // The mix (ED9): speech over music where there is speech, effects against the voice, from the stems
  const buses = new Set(plan.audio.items.map((item) => busOf(item.role)))
  let all = numbers
  let mixed = true
  if (buses.has("music") || buses.has("sfx")) {
    if (!stems) mixed = false
    else {
      const { stems: files, voice } = await stems(plan.audio.key)
      if (files.dialogue) {
        const curve = async (bus) => (files[bus] ? curveOf(files[bus], { run, duration: plan.duration }) : undefined)
        const speech = plan.audio.duck?.speech ?? speechSpans(plan.audio.items, index?.words ?? [])
        const judged = judgeMix({ speech, dialogue: await curve("dialogue"), music: await curve("music"), sfx: await curve("sfx"), voice, thresholds })
        all = { ...numbers, ...judged.numbers, voice }
        for (const f of judged.failures) failures.push({ ...f, message: f.kind === "music_masks_speech" ? (f.margin < 0 ? `The music is ${-f.margin} LU over the speech at ${f.seconds} s.` : `The music is only ${f.margin} LU under the speech at ${f.seconds} s.`) : `A sound effect is ${f.over} LU over the voice at ${f.seconds} s.` })
      }
    }
  }
  if (failures.length) return { ...result("QG-06", "failed", { ...all, first: failures[0] }, failures[0].message), failures }
  if (!mixed) return result("QG-06", "not_checked", all, "Loudness passed; the mix needs the Engine's stems, which this run didn't have.")
  return result("QG-06", "passed", all)
}

/** Sentence ids or phrases the brief names, resolved to their words. */
function wordsFor(entry, index) {
  const sentence = (index.sentences ?? []).find((s) => s.id === entry)
  const words = index.words ?? []
  if (sentence) {
    const [first, last] = [sentence.firstWord, sentence.lastWord].map((id) => words.findIndex((w) => w.id === id))
    return words.slice(first, last + 1).filter((w) => !w.flags.includes("filler") && !w.flags.includes("stutter"))
  }
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim()
  const want = norm(entry).split(/\s+/)
  for (let i = 0; i + want.length <= words.length; i++) if (want.every((token, k) => norm(words[i + k].text) === token)) return words.slice(i, i + want.length)
  return null
}

async function qg12({ file, project, index, run, thresholds }) {
  const brief = project.brief
  if (!brief) return result("QG-12", "not_applicable", {}, "This project has no brief.")
  const timeline = solve(project, index)
  const plays = (word) => timeline.picture.some((p) => p.asset === word.asset && word.start >= p.in && word.end <= p.out)
  const misses = []
  for (const entry of brief.mustKeep ?? []) {
    const words = wordsFor(entry, index)
    if (!words?.length) misses.push({ kind: "must_keep_unknown", entry })
    else if (!words.every(plays)) misses.push({ kind: "must_keep_missing", entry })
  }
  for (const entry of brief.mustCut ?? []) {
    const words = wordsFor(entry, index)
    if (words?.some(plays)) misses.push({ kind: "must_cut_present", entry })
  }
  const data = await probeFile(file, run)
  const length = Number(data.format?.duration ?? 0) * FLICKS
  const target = brief.targetDuration
  if (target && Math.abs(length - target) > target * thresholds.lengthTolerance) misses.push({ kind: "length", seconds: Math.round((length / FLICKS) * 10) / 10, target: target / FLICKS })
  const numbers = { mustKeep: brief.mustKeep?.length ?? 0, mustCut: brief.mustCut?.length ?? 0, seconds: Math.round((length / FLICKS) * 10) / 10, targetSeconds: target ? target / FLICKS : null, misses: misses.length }
  return misses.length ? { ...result("QG-12", "failed", { ...numbers, first: misses[0] }, `The brief isn't met: ${misses[0].kind.replaceAll("_", " ")}.`), misses } : result("QG-12", "passed", numbers)
}

// QG-08 and QG-09 share one measurement of the text, made once per run
const textOf = (input) => (input.text ??= input.motion && !input.motion.missing ? measurePlan(input.plan, { motion: input.motion, work: input.work }) : Promise.resolve(null))
const noText = (plan) => !plan.tiles.some((tile) => tile.kind === "caption" || tile.kind === "block")

async function qg08(input) {
  if (noText(input.plan)) return result("QG-08", "not_applicable", {}, "No text on screen.")
  const measured = await textOf(input)
  if (!measured) return result("QG-08", "not_checked", {}, input.motion?.missing ?? "The gate has no Chrome to measure text in.")
  const judged = judgeLayout({ ...input, measured })
  const first = judged.failures[0]
  return { ...result("QG-08", judged.status, { ...judged.numbers, ...(first ? { first } : {}) }, first ? `Text ${first.kind.replaceAll("_", " ")} at ${first.seconds} s.` : "", first ? first.t : null), failures: judged.failures }
}

async function qg09(input) {
  if (noText(input.plan)) return result("QG-09", "not_applicable", {}, "No text on screen.")
  if (input.plan.input !== "source" && !input.inputPath) return result("QG-09", "not_checked", {}, "Legibility reads a master's pixels.")
  const measured = await textOf(input)
  if (!measured) return result("QG-09", "not_checked", {}, input.motion?.missing ?? "The gate has no Chrome to measure text in.")
  const judged = await judgeLegibility({ ...input, measured, inputPath: input.inputPath ?? input.sourcePath, thresholds: input.thresholds })
  const first = judged.failures[0]
  return { ...result("QG-09", judged.status, { ...judged.numbers, ...(first ? { first } : {}) }, first ? `Text ${first.kind.replaceAll("_", " ")} at ${first.seconds} s.` : ""), failures: judged.failures }
}

/* ─────────────────────────────── ED10 ─────────────────────────────── */

const outcome = (id, judged, { at = null, severity } = {}) => {
  const first = judged.failures[0]
  const level = severity ?? (judged.failures.some((f) => (f.severity ?? "block") === "block") ? "block" : "note")
  if (!first) return result(id, "passed", judged.numbers)
  return { ...result(id, "failed", { ...judged.numbers, first }, `${first.kind.replaceAll("_", " ")}${first.seconds !== undefined ? ` at ${first.seconds} s` : ""}.`, at ?? first.t ?? null, level), failures: judged.failures }
}

async function qg03({ file, run, thresholds }) {
  const judged = judgeSync(await streamTimes(file, run), thresholds)
  if (judged.applicable === false) return result("QG-03", "not_applicable", judged.numbers, "This file has no sound, or no picture.")
  return outcome("QG-03", judged)
}

// The recogniser hears the output once; QG-04 and QG-14 share it
const heardOf = (input) => (input.heard ??= input.recognise(input.file))

async function qg04(input) {
  if (!input.recognise) return result("QG-04", "not_checked", {}, "No verified speech recogniser in this Media Runtime (EB-11), so the output wasn't listened to.")
  const expected = expectedWords(input.plan, input.index?.words ?? [])
  if (!expected.kept.length) return result("QG-04", "not_applicable", {}, "No words are kept, so there is nothing to hear.")
  return outcome("QG-04", judgeSpeech(expected, await heardOf(input)))
}

async function qg07({ file, plan, run, thresholds }) {
  const health = readHealth(await run("ffmpeg", healthArgs(file), { timeoutMs: 600_000 }))
  const picture = wholeSegment(plan).node.picture.sort((a, b) => a.at - b.at)
  // A freeze the plan asks for; and a scene may rest on a finished diagram while the voice explains it
  const holds = [...picture.filter((p) => p.hold), ...plan.tiles.filter((tile) => isSceneBlock(tile.node))].map(({ at, end }) => ({ at, end }))
  const cuts = picture.slice(1).map((p, i) => ({ t: p.at, same: p.asset === picture[i].asset && !p.hold && !picture[i].hold }))
  return outcome("QG-07", judgeHealth(health, { duration: plan.duration, fps: plan.output.fps, holds, cuts }, thresholds))
}

const textTiles = (plan) => plan.tiles.filter((t) => t.kind === "caption" || t.kind === "block")

async function qg10({ plan, run, thresholds, tilePath, binDir, work }) {
  const tiles = textTiles(plan)
  if (!tiles.length) return result("QG-10", "not_applicable", {}, "No text on screen.")
  if (!tilePath || !binDir || !work) return result("QG-10", "not_checked", {}, "The gate has no tiles or helper folder to read text from.")
  const helper = await ocrHelper(binDir, run)
  if (helper.missing) return result("QG-10", "not_checked", {}, helper.missing)
  mkdirSync(work, { recursive: true })
  const dir = mkdtempSync(join(work, "ocr-"))
  try {
    // Each tile at rest, over mid grey, as the reader sees it
    for (const [i, tile] of tiles.entries()) {
      const length = (tile.end - tile.at) / FLICKS
      // A scene's labels come in as they're said, so it's read when they're all in, before it fades
      const at = isSceneBlock(tile.node) ? Math.max(0, length - 0.5) : Math.min(length * 0.9, tile.kind === "caption" ? 0.4 : 1)
      // The tile from zero: a seek rounded to just before a frame made the overlay's first output plain grey, an empty read (found on real footage)
      await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", at.toFixed(3), "-i", tilePath(tile.key), "-f", "lavfi", "-i", `color=c=0x808080:s=${plan.output.width}x${plan.output.height}`, "-filter_complex", "[0:v]setpts=PTS-STARTPTS[tile];[1:v][tile]overlay=shortest=1", "-frames:v", "1", "-y", join(dir, `t${String(i).padStart(4, "0")}.png`)], { timeoutMs: 60_000 })
    }
    let seen = readOcr(await run(helper.path, [dir], { timeoutMs: 300_000 }))
    // The reader swallows its own errors: every tile blank at once is the reader, not the screen (found under load).
    // One more read; a render that's really blank still fails
    if (tiles.length > 1 && tiles.every((_, i) => !seen.get(`t${String(i).padStart(4, "0")}.png`)?.text)) seen = readOcr(await run(helper.path, [dir], { timeoutMs: 300_000 }))
    const judged = judgeCopy(tiles.map((tile, i) => {
      const read = seen.get(`t${String(i).padStart(4, "0")}.png`)
      return { tile, seen: read?.text ?? "", unsure: read?.unsure ?? [] }
    }), thresholds)
    if (judged.unread.length === tiles.length) return result("QG-10", "not_checked", judged.numbers, `No reader for ${judged.unread[0].script} script here, so its shaping wasn't checked.`)
    return outcome("QG-10", judged)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function qg11({ plan, run, thresholds, tilePath }) {
  const tiles = textTiles(plan)
  if (!tiles.length) return result("QG-11", "not_applicable", {}, "No motion layer in this render.")
  if (!tilePath) return result("QG-11", "not_checked", {}, "The gate has no tiles to look at.")
  const fps = plan.output.fps
  const read = []
  for (const tile of tiles) read.push({ tile, frames: await tileFrames(tilePath(tile.key), run), expected: Math.ceil(((tile.end - tile.at) * fps.n) / (FLICKS * fps.d) - 1e-9) })
  return outcome("QG-11", judgeMotion(read, thresholds))
}

// Third-party material: music, effects and footage on any track but the base
function qg13({ plan, project }) {
  // EDD-23, ET-SEC-08: a reference gives numbers only; its picture or sound in an output is a failure, however it got there
  const kindOf = (id) => project.assets.find((a) => a.id === id)?.kind
  const references = [...new Set([...plan.segments.flatMap((s) => [...s.node.picture, ...s.node.overlays]), ...plan.audio.items].map((item) => item.asset))].filter((id) => kindOf(id) === "reference")
  if (references.length) return { ...result("QG-13", "failed", { references }, `A reference (${references.join(", ")}) is in this output; a reference gives numbers only, never its picture or sound.`), failures: references.map((asset) => ({ kind: "reference_in_output", asset })) }
  const used = new Map()
  for (const s of plan.segments) {
    for (const item of s.node.overlays) used.set(item.asset, "overlay footage")
  }
  for (const item of plan.audio.items) if (item.role === "music" || item.role === "sfx") used.set(item.asset, item.role)
  const unknown = [...used].map(([id, use]) => ({ id, use, rights: project.assets.find((a) => a.id === id)?.rights ?? "unknown" })).filter((a) => a.rights === "unknown")
  const numbers = { checked: used.size, unknown: unknown.map((a) => a.id) }
  if (!unknown.length) return result("QG-13", used.size ? "passed" : "not_applicable", numbers, used.size ? "" : "No third-party material in this render.")
  return { ...result("QG-13", "failed", numbers, `The rights to ${unknown.map((a) => `${a.id} (${a.use})`).join(", ")} aren't known.`), failures: unknown.map((a) => ({ kind: "rights_unknown", asset: a.id, use: a.use })) }
}

async function qg14(input) {
  if (!input.recognise || !input.ask) return result("QG-14", "not_checked", {}, "The blind reviewer hears the output through the speech recogniser, which isn't verified here (EB-11).")
  const heard = await heardOf(input)
  if (!heard.length) return result("QG-14", "not_checked", {}, "Nothing was heard in the output.")
  // The reviewer gets only what a viewer gets: the words heard, never the plan or the brief
  const review = await input.ask({ task: "reviewer", schema: REVIEWER_SCHEMA, view: `${UNTRUSTED_OPEN}\nwords heard in the video\n${JSON.stringify(heard.map((w) => w.text).join(" ").replace(/[<>]/g, "").slice(0, 6000))}\n${UNTRUSTED_CLOSE}`, request: "In one sentence, what is this video about?", maxOutput: 120, fallback: () => ({ about: "" }) })
  if (!review.value.about) return result("QG-14", "not_checked", {}, review.reason ?? "The reviewer gave no answer.")
  const brief = input.project.brief ?? {}
  const sentences = input.index?.sentences ?? []
  const words = input.index?.words ?? []
  const lineOf = (id) => {
    const s = sentences.find((x) => x.id === id)
    if (!s) return null
    const i = words.findIndex((w) => w.id === s.firstWord)
    const j = words.findIndex((w) => w.id === s.lastWord)
    return words.slice(i, j + 1).map((w) => w.text).join(" ")
  }
  const keyLines = (brief.mustKeep ?? []).map(lineOf).filter(Boolean)
  const judged = judgeReview(review.value.about, keyLines.length ? keyLines : [heard.slice(0, 12).map((w) => w.text).join(" ")])
  const numbers = { ...judged.numbers, about: review.value.about.slice(0, 300) }
  return judged.note ? result("QG-14", "failed", numbers, "The blind reviewer's summary doesn't mention what the brief says the video is for.") : result("QG-14", "passed", numbers)
}

const RUN = { "QG-01": qg01, "QG-02": qg02, "QG-03": qg03, "QG-04": qg04, "QG-05": qg05, "QG-06": qg06, "QG-07": qg07, "QG-08": qg08, "QG-09": qg09, "QG-10": qg10, "QG-11": qg11, "QG-12": qg12, "QG-13": qg13, "QG-14": qg14 }

/** Verdict words (QUALITY_GATES §5), from gate results only. */
export function verdictOf(results) {
  const blocking = results.filter((r) => r.status === "failed" && r.severity === "block").length
  const briefMisses = results.find((r) => r.id === "QG-12")?.misses?.length ?? 0
  const notes = results.filter((r) => r.status === "failed" && r.severity === "note").length
  const ran = results.filter((r) => r.status === "passed" || r.status === "failed")
  const unchecked = results.filter((r) => r.status === "not_checked").length
  const verdict = ran.length === 0 ? "not_checked" : blocking > 0 ? "blocked" : notes > 0 || unchecked > 0 ? "delivered_with_notes" : "delivered"
  return { verdict, blocking: blocking - (briefMisses ? 1 : 0), briefMisses, notes: notes + unchecked }
}

/**
 * Runs the gates on a rendered file.
 * @param {{ file: string, plan: object, project: object, index: object, sourcePath: (asset: string) => string, run?: typeof runTool, only?: string[], thresholds?: Partial<typeof THRESHOLDS>, tilePath?: (key: string) => string, motion?: object, work?: string, inputPath?: (asset: string) => string, stems?: (audioKey: string) => Promise<{ stems: Record<string, string>, voice: number | null }> }} input
 *   thresholds: the recipe's values; only tighter or the recipe's own, never loosened by a model.
 *   tilePath, motion, work: the Engine's tiles, the runtime's Chrome and a scratch folder, for QG-08 and QG-09; stems: the Engine's, for QG-06's mix;
 *   recognise: a verified recogniser (file → words), for QG-04 and QG-14; ask: the Director, for QG-14 only; binDir: where helpers are built (QG-10)
 */
export async function runGates({ file, plan, project, index, sourcePath, run = runTool, only = [...BUILT], thresholds = {}, tilePath, motion, work, inputPath, stems, recognise, ask, binDir }) {
  // Frozen: no gate, fix or model can loosen what the recipe set (QUALITY_GATES §4)
  const limits = Object.freeze({ ...THRESHOLDS, ...thresholds })
  const shared = { file, plan, project, index, sourcePath, run, thresholds: limits, tilePath, motion, work, inputPath, stems, recognise, ask, binDir }
  const results = []
  for (const id of GATES) {
    if (!only.includes(id)) continue
    if (!BUILT.has(id)) {
      results.push(result(id, "not_checked", {}, "This gate isn't built yet."))
      continue
    }
    try {
      results.push(await RUN[id](shared))
    } catch (error) {
      results.push(result(id, "not_checked", {}, `The gate couldn't run: ${error.message}`))
    }
  }
  return { gates: results, ...verdictOf(results) }
}
