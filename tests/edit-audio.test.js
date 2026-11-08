import assert from "node:assert/strict"
import { test } from "node:test"

import { BUSES, busOf, crowdedEffects, duckEnvelope, fitMusic, LOUDNESS_TARGETS, speechSpans, voiceClean } from "../src/edit/core/audio.js"
import { audioArgs } from "../src/edit/core/mix.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { energyMean, judgeMix } from "../src/edit/gates/sound.js"
import { analyseMusic, RATE } from "../src/edit/index/layers/music.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"
import { drums } from "./edit/sound.js"

// ED9: the audio plan, the mix's arguments, L12 beats and QG-06's mix judgement,
// without FFmpeg. The real renders are in tests/edit/media/audio.test.js.

const FLICKS = 705_600_000
const VERSIONS = { engineVersion: "t", runtimeVersion: "t" }
const index = makeIndex()

test("L12: tempo, beats and downbeats from a drum track, 80 to 150 BPM, within half a hop", () => {
  for (const bpm of [80, 96, 120, 128, 150]) {
    const offset = 0.37
    const { bpm: found, beats, bars } = analyseMusic(drums(bpm, 20, { offset }))
    assert.ok(Math.abs(found - bpm) <= 1, `${bpm} BPM read as ${found}`)
    const beat = 60 / bpm
    for (const b of beats.slice(1, -1)) {
      const s = b.t / FLICKS - offset
      assert.ok(Math.abs(s - Math.round(s / beat) * beat) <= 0.007, `${bpm}: a beat ${((s - Math.round(s / beat) * beat) * 1000).toFixed(1)} ms off`)
    }
    const downs = beats.filter((b) => b.downbeat).map((b) => Math.round((b.t / FLICKS - offset) / beat) % 4)
    assert.deepEqual([...new Set(downs)], [0], `${bpm}: downbeats on the kick`)
    assert.ok(bars.length >= Math.floor(beats.length / 4) - 1)
    assert.ok(beats.every((b) => Number.isSafeInteger(b.t)), "integer flicks")
  }
  assert.deepEqual(analyseMusic(new Float32Array(RATE * 10)), { bpm: null, beats: [], bars: [] }, "silence has no beat")
})

test("L12's known limit: 174 BPM reads as half-time, 87 (recorded in PERCEPTION_AND_INDEX)", () => {
  assert.ok(Math.abs(analyseMusic(drums(174, 20)).bpm - 87) <= 1)
})

/* ─────────────────────────────── music fit ─────────────────────────────── */

// A 120 BPM grid over the whole of the fixture's song
const songBeats = (p) => {
  const length = p.assets.find((a) => a.id === "m1").facts.duration
  return Array.from({ length: Math.floor(length / ms(500)) }, (_, i) => ({ asset: "m1", id: `m1:b${i}`, t: i * ms(500), downbeat: i % 4 === 0, strength: 1 }))
}

const bar = 2 * FLICKS // 120 BPM in 4/4
const downbeats = (seconds) => Array.from({ length: Math.floor(seconds / 2) + 1 }, (_, i) => i * bar)
const total = (segments, crossfade = ms(50)) => segments.reduce((sum, s) => sum + (s.out - s.in), 0) - crossfade * (segments.length - 1)

test("music fit: shorter by whole bars from the middle, joined on downbeats, the ending on the last frame", () => {
  const fit = fitMusic({ from: 0, to: 60 * FLICKS, downbeats: downbeats(60), target: 37 * FLICKS })
  assert.ok(fit.segments.length === 2)
  const [head, tail] = fit.segments
  assert.equal(tail.out, 60 * FLICKS, "the song's own ending")
  for (const t of [head.out, tail.in]) assert.equal(t % bar, 0, "cuts on downbeats")
  assert.ok(head.out >= 2 * bar && tail.in <= 58 * FLICKS, "the first and last bars stay whole")
  assert.equal(total(fit.segments), 37 * FLICKS, "exactly the length, the extra off the head")
  assert.ok(head.in > 0 && head.in < bar, "less than a bar comes off the head")
})

test("music fit: longer by repeating bars; a song that already fits is only trimmed; no beats, no fit", () => {
  const long = fitMusic({ from: 0, to: 20 * FLICKS, downbeats: downbeats(20), target: 50 * FLICKS })
  assert.ok(long.segments.length >= 3)
  assert.equal(long.segments.at(-1).out, 20 * FLICKS)
  assert.equal(total(long.segments), 50 * FLICKS)
  for (const s of long.segments.slice(1)) assert.equal(s.in % bar, 0)
  const near = fitMusic({ from: 0, to: 31 * FLICKS, downbeats: downbeats(31), target: 30 * FLICKS })
  assert.equal(near.segments.length, 1)
  assert.equal(total(near.segments), 30 * FLICKS)
  assert.equal(fitMusic({ from: 0, to: 60 * FLICKS, downbeats: [], target: 30 * FLICKS }), null)
})

test("the plan fits music with a beat grid, says so without one, and keeps the picture's keys", () => {
  const ops = [{ op: "keep_range", asset: "a1", from: ms(1000), to: ms(13000) }, { op: "set_music", asset: "m1" }, { op: "music_shape", fit: true }]
  const p = apply(makeProject(), ops, { index }).project
  const beats = songBeats(p)
  const fitted = compile(p, { ...index, beats }, VERSIONS)
  const music = fitted.audio.items.find((i) => i.role === "music")
  assert.ok(music.fit, JSON.stringify(fitted.issues))
  assert.equal(total(music.fit.segments), music.end - music.at)
  const bare = compile(p, { ...index, beats: [] }, VERSIONS)
  assert.ok(bare.issues.some((i) => i.code === "no_beats"))
  assert.equal(bare.audio.items.find((i) => i.role === "music").fit, undefined)
  assert.deepEqual(fitted.segments.map((s) => s.key), bare.segments.map((s) => s.key), "only the sound changes")
  assert.equal(apply(p, [{ op: "music_shape", fit: false }], { index }).project.sequences[0].clips.find((c) => c.effects.some((e) => e.type === "fit")), undefined)
})

/* ─────────────────────────────── speech and the duck ─────────────────────────────── */

test("speech spans: words mapped onto the output, through speed, close ones joined", () => {
  const items = [{ role: "dialogue", asset: "a1", in: ms(1000), out: ms(5000), at: 0, end: ms(2000), speed: { n: 2, d: 1 } }]
  const words = [{ asset: "a1", start: ms(1000), end: ms(1400) }, { asset: "a1", start: ms(1500), end: ms(1900) }, { asset: "a1", start: ms(4000), end: ms(4400) }]
  assert.deepEqual(speechSpans(items, words), [{ at: 0, end: ms(450) }, { at: ms(1500), end: ms(1700) }])
  assert.deepEqual(speechSpans([{ ...items[0], asset: "a2" }], words), [{ at: 0, end: ms(2000) }], "no words: all of it counts")
  assert.deepEqual(speechSpans([{ role: "music", asset: "a1", in: 0, out: ms(9000), at: 0, end: ms(9000) }], words), [])
})

test("the duck's gain curve: full depth during speech, ramps of attack and release, untouched elsewhere", () => {
  const curve = duckEnvelope([{ at: ms(1000), end: ms(2000) }], { duration: ms(4000), depth: -12, attack: ms(100), release: ms(300), rate: 1000 })
  const floor = 10 ** (-12 / 20)
  assert.equal(curve.length, 4000)
  assert.equal(curve[500], 1)
  assert.ok(Math.abs(curve[950] - (1 - (1 - floor) * 0.5)) < 0.02, "half way down the attack")
  assert.ok(Math.abs(curve[1500] - floor) < 1e-6)
  assert.ok(curve[2150] > floor && curve[2150] < 1)
  assert.equal(curve[2400], 1)
})

test("restraint: two effects closer than the spacing are reported", () => {
  const items = [{ role: "sfx", clip: "c1", at: 0, peak: ms(200) }, { role: "sfx", clip: "c2", at: ms(600), peak: 0 }, { role: "sfx", clip: "c3", at: ms(3000), peak: 0 }]
  assert.deepEqual(crowdedEffects(items).map((i) => i.clip), ["c2"])
})

/* ─────────────────────────────── the mix's arguments ─────────────────────────────── */

function soundProject(extra = []) {
  return apply(makeProject(), [{ op: "keep_range", asset: "a1", from: ms(1000), to: ms(9000) }, { op: "set_music", asset: "m1" }, ...extra], { index }).project
}
const graphOf = (args) => args[args.indexOf("-filter_complex") + 1]

test("the mix: voice clean on the dialogue, one bus at a time, measured gains, the duck only on the speech band", () => {
  const p = soundProject([{ op: "clean_voice", clip: "c1", strength: 1 }, { op: "duck", depth: -10 }])
  const plan = compile(p, index, VERSIONS)
  const io = { input: (a) => `/m/${a}`, output: "/o.wav", encoder: [], envelope: "/e.f32" }
  const dialogue = graphOf(audioArgs(plan, { ...io, bus: "dialogue" }))
  for (const step of voiceClean(1)) assert.ok(dialogue.includes(step.split("=")[0]), step)
  assert.doesNotMatch(dialogue, /acrossover/, "the dialogue stem has no music")
  const music = audioArgs(plan, { ...io, bus: "music", gains: { m1: -7.5 } })
  const graph = graphOf(music)
  assert.match(graph, /volume=volume=-7\.50dB/, "the music sits where the measured voice puts it")
  assert.match(graph, /acrossover=split=300\\\\\\ 3500\[lo\]\[mid\]\[hi\]/)
  assert.match(graph, /\[mid\]\[env\]amultiply\[midd\];\[lo\]\[midd\]\[hi\]amix/)
  assert.ok(music.includes("f32le") && music.includes("/e.f32"), "the gain curve is an input")
  assert.throws(() => audioArgs(plan, { ...io, envelope: undefined, bus: "music" }), /gain curve/)
  const levelled = compile(soundProject([{ op: "set_level", clip: "c2", db: -3 }]), index, VERSIONS)
  assert.doesNotMatch(graphOf(audioArgs(levelled, { ...io, bus: "music", gains: { m1: -7.5 } })), /-7\.50dB/, "a level the person set wins over the measured one")
  const bad = structuredClone(plan)
  bad.audio.items[0].effects = [{ type: "eq", preset: "telephone" }]
  assert.throws(() => audioArgs(bad, { ...io, bus: "dialogue" }), /no "telephone" EQ/)
})

test("a fitted song is trimmed into pieces and joined with equal-power crossfades", () => {
  const p = soundProject([{ op: "music_shape", fit: true }])
  const beats = songBeats(p)
  const plan = compile(p, { ...index, beats }, VERSIONS)
  const graph = graphOf(audioArgs(plan, { input: (a) => `/m/${a}`, output: "/o.wav", encoder: [], bus: "music" }))
  const pieces = plan.audio.items.find((i) => i.role === "music").fit.segments.length
  assert.ok(pieces >= 2)
  assert.equal((graph.match(/acrossfade=d=0\.050*:c1=qsin:c2=qsin/g) ?? []).length, pieces - 1)
  assert.match(graph, new RegExp(`asplit=${pieces}`))
})

test("buses and loudness targets: every role has a bus; only published targets claim a source", () => {
  assert.deepEqual(BUSES, ["dialogue", "music", "sfx", "ambience"])
  assert.deepEqual(["base", "dialogue", "music", "sfx", "ambience"].map(busOf), ["dialogue", "dialogue", "music", "sfx", "ambience"])
  assert.equal(LOUDNESS_TARGETS.broadcast.lufs, -23)
  assert.equal(LOUDNESS_TARGETS.broadcast.source, "EBU R128")
  for (const id of ["reel-9x16", "youtube", "tiktok-9x16"]) assert.match(LOUDNESS_TARGETS[id].source, /not a platform spec/)
})

/* ─────────────────────────────── QG-06's mix judgement ─────────────────────────────── */

test("QG-06: music that crowds the speech, and an effect over the voice, fail; a clear mix passes", () => {
  const steps = 50 // 5 s at 100 ms
  const flat = (v) => Array.from({ length: steps }, () => v)
  const speech = [{ at: ms(1000), end: ms(4000) }]
  const thresholds = { speechOverMusic: 8, sfxOverVoice: 3 }
  const clear = judgeMix({ speech, dialogue: flat(-16), music: flat(-30), sfx: flat(null), voice: -16, thresholds })
  assert.deepEqual(clear.failures, [])
  assert.equal(clear.numbers.speechOverMusic, 14)
  const masked = judgeMix({ speech, dialogue: flat(-16), music: flat(-20), voice: -16, thresholds })
  assert.equal(masked.failures[0].kind, "music_masks_speech")
  assert.equal(masked.failures[0].margin, 4)
  const loud = judgeMix({ speech, dialogue: flat(-16), sfx: [...flat(null).slice(0, 30), -9, ...flat(null).slice(31)], voice: -16, thresholds })
  assert.equal(loud.failures[0].kind, "effect_over_voice")
  assert.equal(loud.failures[0].seconds, 3)
  assert.equal(judgeMix({ speech: [{ at: 0, end: ms(500) }], dialogue: flat(-16), music: flat(-16), voice: -16, thresholds }).failures.length, 0, "a stretch under a second isn't judged")
  assert.equal(Math.round(energyMean([-20, -20, null]) * 10) / 10, -20)
  assert.equal(energyMean([null, null]), null)
})
