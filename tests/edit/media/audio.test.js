import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { measureLoudness } from "../../../src/edit/engine/loudness.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { openIndexDb } from "../../../src/edit/index/db.js"
import { createIndexer } from "../../../src/edit/index/index.js"
import { makeProject, ms } from "../fixture.js"
import { drums, voice, writeWav } from "../sound.js"

// ED9 on real media: the stems, the band duck, music fitted on detected downbeats,
// and QG-06 on the master and its stems. Synthetic sound only: tone-burst "speech",
// tone beds and drum tracks made here.

const FLICKS = 705_600_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-audio-")))
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
let capabilities

// Two stretches of "speech", 2–7 s and 11–16 s: words of 0.4 s with 0.1 s gaps
const WORDS = []
for (const start of [2, 11]) for (let i = 0; i < 10; i++) WORDS.push({ s: start + i * 0.5, e: start + i * 0.5 + 0.4 })
const INDEX = { words: WORDS.map((w, i) => ({ asset: "a1", id: `a1:w${i}`, start: Math.round(w.s * FLICKS), end: Math.round(w.e * FLICKS), text: `w${i}` })), sentences: [], shots: [], faces: [] }

before(async () => {
  capabilities = await readCapabilities()
  writeWav(join(dir, "voice.wav"), voice(20, WORDS), 48_000)
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=20", "-i", join(dir, "voice.wav"), "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "192k", "-shortest", "-y", join(dir, "take.mov")])
  // A bed with one tone in each band: bass 60 Hz, the speech band 1 kHz, air 10 kHz
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc=0.15*sin(2*PI*60*t)+0.15*sin(2*PI*1000*t)+0.15*sin(2*PI*10000*t):s=48000:d=40", "-ac", "2", "-c:a", "pcm_s16le", "-y", join(dir, "bed.wav")])
  // A 30 s song at 120 BPM whose last bar carries a 2 kHz tone
  writeWav(join(dir, "song.wav"), drums(120, 30, { offset: 0, rate: 48_000, ending: 2 }), 48_000)
  // A short, loud effect
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anoisesrc=d=0.6:c=pink:a=0.9", "-af", "afade=t=out:st=0.2:d=0.4", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-y", join(dir, "whoosh.wav")])
})

async function setup(name, ops, { index = INDEX, extra = [], seconds = 20, later = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(dir, `${name}-`)))
  const asset = async (id, file, kind) => ({ id, kind, path: join(dir, file), fingerprint: sha(join(dir, file)), linked: true, rights: "own", role: kind === "video" ? "aroll" : "music", facts: (await probe(join(dir, file))).facts })
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: 640, height: 360, fps: { n: 30, d: 1 } }
  project.assets = [await asset("a1", "take.mov", "video"), await asset("m1", "bed.wav", "audio"), await asset("s1", "song.wav", "audio"), await asset("x1", "whoosh.wav", "audio"), ...extra]
  const all = [{ op: "keep_range", asset: "a1", from: 0, to: ms(seconds * 1000) }, { op: "add_deliverable", preset: "reel-9x16", size: { width: 640, height: 360 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false }, ...ops]
  let applied = apply(project, all, { index })
  assert.deepEqual(applied.diagnostics, [])
  // Then: changes that name a clip by its role ({ op, role } becomes { op, clip })
  const roleOf = (clip) => applied.project.sequences[0].tracks.find((t) => t.id === clip.track).role
  const named = later.map(({ role, ...op }) => ({ ...op, clip: applied.project.sequences[0].clips.find((c) => roleOf(c) === role).id }))
  if (named.length) applied = apply(applied.project, named, { index })
  assert.deepEqual(applied.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities })
  engine.load(applied.project, index)
  const deliverable = applied.project.deliverables[0].id
  const rendered = await engine.render({ quality: "master", deliverable })
  return { engine, project: applied.project, ...rendered }
}

/** RMS level in dB of one band of a file between two times, from FFmpeg's astats. */
function rmsOf(file, hz, from, to) {
  const { stderr } = spawnSyncText(["-hide_banner", "-nostdin", "-ss", String(from), "-t", String(to - from), "-i", file, "-af", `bandpass=f=${hz}:width_type=q:w=8,bandpass=f=${hz}:width_type=q:w=8,astats=measure_perchannel=none:measure_overall=RMS_level`, "-f", "null", "-"])
  return Number(/RMS level dB: (-?[\d.]+)/.exec(stderr.split("Overall").at(-1))[1])
}

const spawnSyncText = (args) => spawnSync("ffmpeg", args, { encoding: "utf8" })

test("ET-ENG-13: the duck lowers only the speech band of the music; bass and air stay; the master hits its loudness", { timeout: 280_000 }, async () => {
  const { engine, project, file, plan } = await setup("duck", [{ op: "set_music", asset: "m1" }, { op: "duck", depth: -12, attack: ms(80), release: ms(300) }])
  const { stems, voice: voiceLufs } = await engine.stems(plan.audio.key)
  assert.ok(stems.dialogue && stems.music, JSON.stringify(stems))
  // Inside speech (4–5 s) against a quiet stretch (8.5–9.5 s), on the music stem
  const drop = (hz) => rmsOf(stems.music, hz, 4, 5) - rmsOf(stems.music, hz, 8.5, 9.5)
  const [bass, mid, air] = [drop(60), drop(1000), drop(10000)]
  console.log(`ET-ENG-13: under speech, bass ${bass.toFixed(2)} dB, speech band ${mid.toFixed(2)} dB, air ${air.toFixed(2)} dB; voice ${voiceLufs?.toFixed(1)} LUFS`)
  assert.ok(Math.abs(mid + 12) <= 1.5, `the speech band ducks by its depth: ${mid}`)
  assert.ok(Math.abs(bass) <= 1, `bass stays: ${bass}`)
  assert.ok(Math.abs(air) <= 1, `air stays: ${air}`)
  const loud = await measureLoudness(file)
  assert.ok(Math.abs(loud.integrated + 14) <= 0.5 && loud.truePeak <= -1, JSON.stringify(loud))
  const qg06 = (await runGates({ file, plan, project, index: INDEX, sourcePath: () => join(dir, "take.mov"), only: ["QG-06"], stems: engine.stems })).gates[0]
  console.log(`QG-06: ${JSON.stringify(qg06.numbers)}`)
  assert.equal(qg06.status, "passed", JSON.stringify(qg06))
  assert.ok(qg06.numbers.speechOverMusic >= 8 && qg06.numbers.range !== null)
})

test("QG-06 on real stems: music over the speech, and an effect over the voice, each fail", { timeout: 280_000 }, async () => {
  const loudBed = await setup("masked", [{ op: "set_music", asset: "m1" }], { later: [{ op: "set_level", role: "music", db: 6 }] })
  const masked = (await runGates({ file: loudBed.file, plan: loudBed.plan, project: loudBed.project, index: INDEX, sourcePath: () => join(dir, "take.mov"), only: ["QG-06"], stems: loudBed.engine.stems })).gates[0]
  assert.equal(masked.status, "failed", JSON.stringify(masked))
  assert.ok(masked.failures.some((f) => f.kind === "music_masks_speech"), JSON.stringify(masked))

  const at = { word: "a1:w3", edge: "start" }
  const levelled = await setup("sfx", [{ op: "add_sfx", asset: "x1", peak_at: at }])
  const fine = (await runGates({ file: levelled.file, plan: levelled.plan, project: levelled.project, index: INDEX, sourcePath: () => join(dir, "take.mov"), only: ["QG-06"], stems: levelled.engine.stems })).gates[0]
  assert.equal(fine.status, "passed", `an effect levelled against the voice passes: ${JSON.stringify(fine.numbers)}`)
  const blaring = await setup("sfx-loud", [{ op: "add_sfx", asset: "x1", peak_at: at }], { later: [{ op: "set_level", role: "sfx", db: 12 }] })
  const loud = (await runGates({ file: blaring.file, plan: blaring.plan, project: blaring.project, index: INDEX, sourcePath: () => join(dir, "take.mov"), only: ["QG-06"], stems: blaring.engine.stems })).gates[0]
  console.log(`effects: levelled ${JSON.stringify(fine.numbers)}; +12 dB ${JSON.stringify(loud.numbers)}`)
  assert.equal(loud.status, "failed", JSON.stringify(loud))
  assert.ok(loud.failures.some((f) => f.kind === "effect_over_voice"), JSON.stringify(loud))
})

test("L12 and music fit on real files: beats from the song, cut on its downbeats, its ending on the last frame, no pop at the join", { timeout: 280_000 }, async () => {
  // The real indexer reads the song's beats
  const db = openIndexDb(":memory:")
  const indexer = createIndexer({ db, cache: join(dir, "icache"), binDir: join(dir, "bin") })
  const songFile = join(dir, "song.wav")
  const song = { id: "s1", kind: "audio", fingerprint: sha(songFile), facts: (await probe(songFile)).facts }
  const report = await indexer.indexAsset(song, songFile, { only: ["L0", "L12"] })
  assert.deepEqual(report.map((r) => [r.layer, r.status]), [["L0", "ok"], ["L12", "ok"]], JSON.stringify(report))
  const raw = db.read(["s1"])
  const bpm = db.layer(song.fingerprint, "L12").data.bpm
  assert.ok(Math.abs(bpm - 120) <= 1, `${bpm} BPM`)
  const downs = raw.beats.filter((b) => b.downbeat).map((b) => b.t / FLICKS)
  assert.ok(downs.every((t) => Math.abs(t - Math.round(t / 2) * 2) <= 0.012), `downbeats every 2 s: ${downs.slice(0, 6)}`)

  const index = { ...INDEX, beats: raw.beats, bars: raw.bars }
  const { engine, plan } = await setup("fit", [{ op: "set_music", asset: "s1" }, { op: "music_shape", fit: true }], { index, seconds: 15 })
  const music = plan.audio.items.find((i) => i.role === "music")
  assert.ok(music.fit, JSON.stringify(plan.issues))
  assert.equal(plan.duration, 15 * FLICKS)
  for (const s of music.fit.segments.slice(1)) assert.ok(Math.abs(s.in / FLICKS - Math.round(s.in / FLICKS / 2) * 2) <= 0.012, `a join on a downbeat: ${s.in / FLICKS}`)
  assert.ok(Math.abs(music.fit.segments.at(-1).out / FLICKS - 30) < 0.001, "the song's own ending")
  const { stems } = await engine.stems(plan.audio.key)
  const ending = rmsOf(stems.music, 2000, 13.3, 14.8)
  const middle = rmsOf(stems.music, 2000, 4, 9)
  console.log(`music fit: ${music.fit.segments.map((s) => `${(s.in / FLICKS).toFixed(3)}–${(s.out / FLICKS).toFixed(3)}`).join(", ")}; 2 kHz ending ${ending.toFixed(1)} dB at the end, ${middle.toFixed(1)} dB in the middle`)
  assert.ok(ending - middle > 20, "the ending's tone is in the last bar of the picture, not before")
  // No pop at the join: the largest step between samples near it is no bigger than the drums' own
  const seam = (music.fit.segments[0].out - music.fit.segments[0].in) / FLICKS
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-ss", String(seam - 0.1), "-t", "0.2", "-i", stems.music, "-ac", "1", "-f", "f32le", "-"])
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4)
  let step = 0
  for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i] - x[i - 1]))
  assert.ok(step < 0.3, `largest step at the join ${step.toFixed(3)}`)
})
