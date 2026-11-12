import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { compile } from "../src/edit/core/plan.js"
import { solve } from "../src/edit/core/solver.js"
import { PLAN_SCHEMA, briefOf } from "../src/edit/director/plan.js"
import { ALL_MOODS, MOODS, writeAccent, writeMusicBed } from "../src/edit/engine/music-bed.js"
import { CUT_SOUNDS, INTRO_SOUNDS, SFX, SOUNDS, writeSfx } from "../src/edit/engine/sfx.js"
import { planReel } from "../src/edit/recipes/reel.js"
import { onBeat, quietStretch, SPLIT_MAX, splitOps, timelineBeats } from "../src/edit/recipes/sound.js"
import { indexOf, lengthOf } from "./edit/script.js"

// TP10 (CRAFT_UPGRADE §8, TOP_TIER_PLAN §5): every sound's peak, accents on the joins, the room tone from the
// take's own quiet, beat joins that move no word, J and L cuts through silence only, determinism, and the
// switch off. No media and no model here: tests/edit/media/sound.test.js renders and measures.

const FLICKS = 705_600_000
const dir = mkdtempSync(join(tmpdir(), "kh-sound-"))
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
// The loudest 5 ms of a WAV the generators wrote (16-bit stereo, 48 kHz, 44-byte header), read back from the file
function filePeak(file) {
  const data = readFileSync(file).subarray(44)
  const window = 240
  let [best, at] = [0, 0]
  for (let start = 0; start + window * 4 <= data.length; start += window * 4) {
    let sum = 0
    for (let i = start; i < start + window * 4; i += 2) sum += data.readInt16LE(i) ** 2
    if (sum > best) [best, at] = [sum, start / 4 + window / 2]
  }
  return at / 48_000
}

test("ET-SD-01: twenty sounds written by code, each the same bytes twice, each landing its loudest moment where it says", () => {
  assert.equal(SOUNDS.length, 20)
  assert.deepEqual(Object.keys(SFX), ["whoosh", "pop", "riser", "hit"], "the four before TP10 are the table they were")
  const off = []
  for (const kind of SOUNDS) {
    const [a, b] = [join(dir, `${kind}-a.wav`), join(dir, `${kind}-b.wav`)]
    const made = writeSfx(a, kind)
    writeSfx(b, kind)
    assert.equal(sha(a), sha(b), `${kind}: deterministic`)
    const said = made.peak / FLICKS
    const heard = filePeak(a)
    off.push([kind, Math.round((heard - said) * 1000)])
  }
  console.log(`ET-SD-01 loudest moment read back, against what each says (ms): ${off.map(([k, ms]) => `${k} ${ms}`).join(", ")}`)
  // TP10's sixteen measure their own peak, so they say where it is to the 5 ms window. The four from before TP10
  // keep the peaks they always said (rule 1); the whoosh's is 22 ms after its loudest moment, recorded, not changed
  for (const [kind, ms] of off) assert.ok(Math.abs(ms) <= (Object.hasOwn(SFX, kind) ? 30 : 10), `${kind}: ${ms} ms`)
  assert.ok(CUT_SOUNDS.length >= 9 && INTRO_SOUNDS.length >= 8)
  for (const mood of Object.keys(ALL_MOODS)) {
    const [a, b] = [join(dir, `${mood}-accent-a.wav`), join(dir, `${mood}-accent-b.wav`)]
    const made = writeAccent(a, mood)
    writeAccent(b, mood)
    assert.equal(sha(a), sha(b))
    assert.ok(Math.abs(filePeak(a) - made.peak) <= 0.01, `${mood} accent`)
  }
  assert.equal(Object.keys(ALL_MOODS).length, 10)
})

/** a1 talks (the script), a2 is B-roll, x1 an accent, m1 a bed of 60 s with a beat every 0.5 s. */
function world({ pause = 0 } = {}) {
  const index = indexOf("a1")
  // A pause in the talk, after the sixth line, for the room tone to come from
  if (pause) {
    const after = index.words.findIndex((w) => w.text === "Our")
    for (const w of index.words.slice(after)) (w.start += pause), (w.end += pause)
  }
  index.beats = Array.from({ length: 120 }, (_, i) => ({ asset: "m1", id: `m1:b${i}`, t: Math.round(i * 0.5 * FLICKS), downbeat: i % 4 === 0, strength: 1 }))
  index.bars = []
  const length = Math.round((lengthOf() + pause / FLICKS) * FLICKS)
  const video = (id, duration) => ({ op: "add_asset", id, kind: "video", fingerprint: `f-${id}`, path: `${id}.mov`, linked: true, rights: "own", facts: { width: 1920, height: 1080, hasAudio: true, duration, vfr: false, fps: { n: 30, d: 1 } } })
  const sound = (id, duration, more = {}) => ({ op: "add_asset", id, kind: "audio", fingerprint: `f-${id}`, path: `${id}.wav`, linked: true, rights: "own", rightsNote: "Made by Kriya", facts: { duration, hasAudio: true, ...more } })
  const project = apply(newProject({ id: "p", name: "Reel" }), [video("a1", length), video("a2", 20 * FLICKS), sound("x1", FLICKS, { peak: Math.round(0.035 * FLICKS) }), sound("m1", 60 * FLICKS)], { author: "code" }).project
  return { project, index }
}
const fallback = async (slot) => ({ value: slot.fallback(), source: "default", calls: 0 })
const make = (w, brief) => planReel({ project: w.project, index: w.index, asset: "a1", ask: fallback, brief: { music: "m1", ...brief } })

test("ET-SD-02: an accent lands on every join of the story, peak on the cut", async () => {
  const w = world()
  const made = await make(w, { accent: "x1" })
  const timeline = solve(made.project, w.index)
  const story = [...new Set(timeline.picture.map((p) => p.clip))]
  const joins = story.slice(1).map((clip) => timeline.picture.find((p) => p.clip === clip).at)
  const accents = timeline.audio.filter((item) => item.asset === "x1")
  assert.equal(accents.length, joins.length)
  for (const [i, join] of joins.entries()) assert.ok(Math.abs(accents[i].at + Math.round(0.035 * FLICKS) - join) <= FLICKS / 1000, `accent ${i}: its peak on the join`)
})

test("ET-SD-03: the room tone comes from the take's own quiet: a stretch with no word in it, or none and a note", async () => {
  const { index } = world({ pause: Math.round(2 * FLICKS) })
  const quiet = quietStretch(index.words, "a1", undefined)
  assert.ok(quiet && quiet.to - quiet.from >= 0.8 * FLICKS)
  assert.equal(index.words.some((w) => w.asset === "a1" && w.end > quiet.from && w.start < quiet.to), false, "no word in it")
  const made = await make(world({ pause: Math.round(2 * FLICKS) }), { ambience: true })
  const tone = made.project.sequences[0].clips.find((c) => c.loop)
  assert.deepEqual([tone.source.asset, tone.source.in, tone.source.out], ["a1", quiet.from, quiet.to])
  const none = await make(world(), { ambience: true })
  assert.equal(none.project.sequences[0].clips.some((c) => c.loop), false)
  assert.ok(none.notes.some((n) => /No room tone/.test(n)))
})

test("ET-SD-04: B-roll lands on the beat, later and inside its host clip; no picture clip and no word moves", async () => {
  assert.equal(onBeat(1000, 5000, 1000, [900, 1200, 4000]), 1200)
  assert.equal(onBeat(1000, 2000, 1000, [1200]), 1000, "it would run past its host")
  assert.equal(onBeat(1000, 5000, 1000, [1000 + 0.3 * FLICKS]), 1000, "too far to reach")
  const w = world()
  const plain = await make(w, { broll: "own" })
  const beat = await make(w, { broll: "own", beatJoins: true })
  const pictures = (p) => solve(p, w.index).picture.map(({ clip, at, end, in: i, out }) => [clip, at, end, i, out])
  assert.deepEqual(pictures(beat.project), pictures(plain.project), "the story's picture and words are where they were")
  const beats = timelineBeats(compile(beat.project, w.index, { engineVersion: "e", runtimeVersion: "r" }).audio.items.find((a) => a.asset === "m1"), w.index.beats)
  assert.ok(beats.length > 10)
  const moved = beat.project.sequences[0].clips.filter((c) => c.source?.asset === "a2" && typeof c.at === "number")
  assert.ok(moved.length >= 1, "at least one cutaway moved onto a beat")
  // The picture changes on frames: a beat between two frames is met on the nearer one, within half a frame
  for (const c of moved) assert.ok(solve(beat.project, w.index).overlays.some((o) => o.clip === c.id && beats.some((b) => Math.abs(b - o.at) <= FLICKS / 60)), "each one on a beat")
  assert.ok(beat.notes.some((n) => /on the music's beat/.test(n)))
})

test("ET-SD-05: J and L cuts lead or trail through silence only: no extra sound reaches a word, none longer than 150 ms", async () => {
  const w = world()
  const plain = await make(w, {})
  const split = await make(w, { splits: true })
  const trims = split.ops.filter((op) => op.op === "trim" && (op.audioLead || op.audioLag))
  assert.ok(trims.length >= 2, `${trims.length} joins split`)
  for (const t of trims) assert.ok((t.audioLead ?? t.audioLag) <= SPLIT_MAX)
  const before = solve(plain.project, w.index)
  const after = solve(split.project, w.index)
  assert.deepEqual(after.picture.map((p) => [p.at, p.in, p.out]), before.picture.map((p) => [p.at, p.in, p.out]), "the picture doesn't move")
  // Each dialogue item's sound beyond its picture holds no part of any word
  for (const item of after.audio.filter((a) => a.asset === "a1")) {
    const pic = after.picture.filter((p) => p.clip === item.clip)
    const [pin, pout] = [Math.min(...pic.map((p) => p.in)), Math.max(...pic.map((p) => p.out))]
    const extra = [[item.in, pin], [pout, item.out]].filter(([a, b]) => b > a)
    for (const [a, b] of extra) assert.equal(w.index.words.some((x) => x.end > a && x.start < b), false, `${item.clip}: ${a / FLICKS}–${b / FLICKS} s is silence`)
  }
  assert.ok(after.audio.some((a) => a.asset === "a1" && before.audio.some((b) => b.clip === a.clip && (a.in < b.in || a.out > b.out))), "some sound now leads or trails")
  assert.deepEqual(splitOps([{ clip: "c1", asset: "a1", in: 0, out: FLICKS }, { clip: "c2", asset: "a1", in: 2 * FLICKS, out: 3 * FLICKS }], [{ asset: "a1", start: 0.5 * FLICKS, end: 0.99 * FLICKS }, { asset: "a1", start: 1.02 * FLICKS, end: 1.98 * FLICKS }, { asset: "a1", start: 2.01 * FLICKS, end: 2.5 * FLICKS }]), [], "no room either side: no split")
})

test("ET-SD-06: the same brief makes the same operations twice; the beds and accents are the same bytes", async () => {
  const w = world({ pause: Math.round(2 * FLICKS) })
  const brief = { accent: "x1", ambience: true, splits: true, broll: "own", beatJoins: true }
  assert.deepEqual((await make(w, brief)).ops, (await make(w, brief)).ops)
  const [a, b] = [join(dir, "bed-a.wav"), join(dir, "bed-b.wav")]
  writeMusicBed(a, { mood: "epic", seconds: 8 })
  writeMusicBed(b, { mood: "epic", seconds: 8 })
  assert.equal(sha(a), sha(b))
})

test("TP10's switch off: the plan's schema and moods are what they were, a brief without the new keys makes what it made, briefOf adds nothing", async () => {
  assert.deepEqual(Object.keys(MOODS), ["calm", "upbeat", "warm"])
  assert.deepEqual(PLAN_SCHEMA.properties.settings.properties.music.enum, ["none", "reference", "calm", "upbeat", "warm"])
  assert.deepEqual(PLAN_SCHEMA.properties.settings.properties.cutSound.enum, ["none", "whoosh", "pop"])
  assert.equal("arrange" in PLAN_SCHEMA.properties.settings.properties, false)
  assert.deepEqual(briefOf({ captions: "clean", music: "calm" }), { captions: "clean", music: "generated:calm" })
  const w = world()
  const plain = await make(w, { broll: "own" })
  const again = await make(w, { broll: "own", accent: undefined, ambience: undefined, splits: undefined, beatJoins: undefined })
  assert.deepEqual(again.ops, plain.ops)
  assert.equal(plain.ops.some((op) => op.op === "room_tone" || (op.op === "trim" && (op.audioLead || op.audioLag))), false)
})
