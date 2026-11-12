// A reference Kriya makes itself (TOP_TIER_PLAN §3, TPX-03; ET-RF2-M1): scenes of plain colour
// with a moving box, cut and joined by Kriya's own Engine with a known mix of its own transitions,
// punch-ins, caption looks, graphics, effects and a code-made bed. Every trait's truth is known
// because this file placed it, and no one else's video is needed (EB-05).

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"

import { apply } from "../../../src/edit/core/ops.js"
import { newProject } from "../../../src/edit/core/project.js"
import { solve } from "../../../src/edit/core/solver.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic } from "../../../src/edit/engine/graphics.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { writeMusicBed } from "../../../src/edit/engine/music-bed.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { openJournal } from "../../../src/edit/graph/journal.js"

const FLICKS = 705_600_000
const ms = (n) => n * 705_600
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 })
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
// Mid-tone scenes, far enough apart that every join is a clear change, none near black or white
const SHADES = [[150, 110, 150], [70, 140, 100], [120, 150, 90], [90, 100, 160], [170, 120, 120], [60, 120, 140], [140, 90, 110], [100, 150, 150], [160, 140, 100], [80, 90, 120]]
export const SCENE_SECONDS = 6
// Uneven, like speech: evenly spaced bursts would read as a tempo
const WORD_TIMES = [0.5, 1.15, 2.05, 2.6]
// Forty different words, so no two caption pages are the same tile
const WORDS = "Start small keep going every single day build simple things first then make them better learn from each mistake share your work early often people notice steady effort more than sudden bursts trust slow patient progress always wins".split(" ")

/**
 * The scenes, one file: each a soft ramp of its own colour with a slow bright box, and a voice of tone bursts.
 * @returns {{ file: string, words: { start: number, end: number }[] }} words in seconds, four per scene
 */
export function scenesFile(dir, { width = 540, height = 960, scenes = SHADES.length, voice = true } = {}) {
  const file = join(dir, `scenes-${width}x${height}${voice ? "" : "-mute"}.mov`)
  const parts = SHADES.slice(0, scenes).map(([y, u, v], i) => `color=c=black:s=${width}x${height}:r=30:d=${SCENE_SECONDS},geq=lum='${y - 30}+60*X/W':cb=${u}:cr=${v},drawbox=x='${Math.round(width * 0.2)}+${Math.round(width * 0.25)}*sin(t/3+${i})':y=${Math.round(height * 0.25)}:w=${Math.round(width * 0.14)}:h=${Math.round(width * 0.14)}:color=0xd8d8d0:t=fill[s${i}]`)
  const words = []
  for (let s = 0; s < scenes; s++) for (const at of WORD_TIMES) words.push({ start: s * SCENE_SECONDS + at, end: s * SCENE_SECONDS + at + 0.45 })
  const speech = voice ? `aevalsrc='0.3*sin(2*PI*170*t)*(0.6+0.4*sin(2*PI*5*t))*${words.map((w) => `between(t,${w.start},${w.end})`).join("+").replace(/^/, "(")})+0.002*random(0)':s=48000:d=${scenes * SCENE_SECONDS}` : `anullsrc=r=48000:cl=mono:d=${scenes * SCENE_SECONDS}`
  ffmpeg("-f", "lavfi", "-i", speech, "-filter_complex", `${parts.join(";")};${parts.map((_, i) => `[s${i}]`).join("")}concat=n=${scenes}:v=1:a=0,noise=alls=2:allf=t[v]`, "-map", "[v]", "-map", "0:a", ...X264, "-c:a", "aac", "-b:a", "160k", "-t", String(scenes * SCENE_SECONDS), file)
  return { file, words }
}

/**
 * Renders a reference through the Engine.
 * @param {string} dir
 * @param {{ shots: { seconds: number, enter?: string, enterMs?: number }[], width?: number, height?: number, captions?: { look: string, words: number } | null, graphics?: object[], punches?: { shot: number, scale: number, ease?: string }[], effects?: { effect: string, params?: object }[], grade?: object, music?: string | null, voice?: boolean, motion?: object, name?: string }} spec
 * @returns {Promise<{ file: string, truth: object, plan: object }>}
 */
export async function makeReference(dir, spec) {
  const { width = 540, height = 960, shots, captions = null, graphics = [], punches = [], effects = [], grade = null, music = null, voice = true, motion = null, name = "ref" } = spec
  const source = scenesFile(dir, { width, height, voice })
  const root = realpathSync(mkdtempSync(join(dir, `${name}-`)))
  const { facts } = await probe(source.file)
  const words = source.words.map((w, i) => ({ asset: "a1", id: `a1:w${i}`, start: Math.round(w.start * FLICKS), end: Math.round(w.end * FLICKS), text: WORDS[i % WORDS.length], lang: "en", speaker: "s0", conf: 1 }))
  const index = { words, sentences: [], shots: [], faces: [] }
  const ops = []
  shots.forEach((shot, i) => ops.push({ op: "keep_range", asset: "a1", from: ms(i * SCENE_SECONDS * 1000), to: ms(i * SCENE_SECONDS * 1000 + Math.round(shot.seconds * 1000)) }))
  ops.push({ op: "add_deliverable", preset: "reference", size: { width, height }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true, gates: [] })
  // Assets come in as the Host brings them (code); everything placed is the person's
  const start = apply(newProject({ id: "r", name: "Reference", width, height }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: sha(source.file), path: source.file, linked: true, rights: "own", facts }], { author: "code" })
  let made = apply(start.project, ops, { index, author: "person" })
  if (made.diagnostics.length) throw new Error(JSON.stringify(made.diagnostics))
  const clips = made.project.sequences[0].clips.filter((c) => c.source).map((c) => c.id)
  const more = []
  shots.forEach((shot, i) => shot.enter && more.push({ op: "transition", clip: clips[i], kind: shot.enter, duration: ms(shot.enterMs ?? 400) }))
  // Words kept by a shot: those wholly inside its range
  const kept = (i) => words.filter((w) => w.start >= ms(i * SCENE_SECONDS * 1000) && w.end <= ms(i * SCENE_SECONDS * 1000 + Math.round(shots[i].seconds * 1000)))
  let pages = 0
  if (captions) shots.forEach((_, i) => {
    const list = kept(i)
    for (let k = 0; k + captions.words <= list.length; k += captions.words) (more.push({ op: "caption_style", look: captions.look, words: list.slice(k, k + captions.words).map((w) => w.id) }), pages++)
  })
  for (const g of graphics) more.push({ op: "add_motion", block: "graphic", version: 1, variables: cleanGraphic(g.graphic, ALL_GRAPHIC_KINDS), at: { word: kept(g.shot)[g.word ?? 0].id, edge: "start" }, duration: ms(g.ms ?? 1600) })
  for (const p of punches) more.push({ op: "punch_in", at: { word: kept(p.shot)[0].id, edge: "start" }, duration: ms(p.ms ?? 1200), scale: p.scale, ...(p.ease ? { ease: p.ease } : {}) })
  for (const clip of clips) {
    for (const e of effects) more.push({ op: "add_effect", clip, effect: e.effect, ...(e.params ? { params: e.params } : {}) })
    if (grade) more.push({ op: "grade", clip, ...grade })
  }
  if (music) {
    const bed = join(root, `bed-${music}.wav`)
    writeMusicBed(bed, { mood: music, seconds: shots.reduce((sum, s) => sum + s.seconds, 0) + 2 })
    made = apply(made.project, [{ op: "add_asset", id: "m1", kind: "audio", fingerprint: sha(bed), path: bed, linked: true, rights: "own", facts: (await probe(bed)).facts }], { author: "code" })
    more.push({ op: "set_music", asset: "m1" })
  }
  made = apply(made.project, more, { index, author: "person" })
  if (made.diagnostics.length) throw new Error(JSON.stringify(made.diagnostics))
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities: await readCapabilities(), ...(motion ? { motion: () => motion } : {}) })
  engine.load(made.project, index)
  const { file, plan } = await engine.render({ quality: "master", deliverable: made.project.deliverables[0].id })
  // The truth, from what was placed: each join's time in seconds, read from the plan (a range ends
  // after the word it would have cut, so the plan knows the real time), and its kind
  const solved = solve(made.project, index).picture
  if (solved.length !== shots.length) throw new Error(`expected ${shots.length} shots, the timeline has ${solved.length}`)
  const starts = shots.slice(1).map((shot, i) => ({ t: solved[i + 1].at / FLICKS, kind: shot.enter ?? "cut", seconds: shot.enter ? (shot.enterMs ?? 400) / 1000 : 0 }))
  return { file, plan, truth: { seconds: plan.duration / FLICKS, joins: starts, pages, graphics: graphics.length, punches: punches.length, width, height } }
}
