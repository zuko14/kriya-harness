import assert from "node:assert/strict"
import { test } from "node:test"

import { alignWords, remapAnchors } from "../src/edit/core/anchors.js"
import { solveLayout } from "../src/edit/core/layout.js"
import { apply } from "../src/edit/core/ops.js"
import { validateProject } from "../src/edit/core/project.js"
import { solveReframe } from "../src/edit/core/reframe.js"
import { DEFAULT_RULES, solve } from "../src/edit/core/solver.js"
import { frameFlicks } from "../src/edit/core/time.js"
import { makeIndex, makeProject, ms, prng } from "./edit/fixture.js"

const index = makeIndex()
const ctx = { index, author: "agent" }
const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
const FRAME = frameFlicks({ n: 30, d: 1 })
const done = (project, ops, c = ctx) => {
  const result = apply(project, ops, c)
  assert.deepEqual(result.diagnostics, [])
  return result.project
}
const wordOf = (n, i = index) => i.words.find((x) => x.id === `a1:w${n}`)
const codes = (timeline) => timeline.issues.map((i) => i.code)

/** All fifty words kept as one clip, with a caption, a sound and a zoom on word 30. */
function decorated() {
  return done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(49, "end") },
    { op: "caption_style", look: "bold", words: ["a1:w30", "a1:w31"] },
    { op: "add_sfx", asset: "sfx:whoosh-soft", peak_at: w(30) },
    { op: "punch_in", at: w(30), scale: 1.12 },
  ])
}

const REMOVE_SENTENCE_2 = { op: "remove_range", from: w(10), to: w(14, "end") }

test("ET-ANC-01: removing a sentence moves anchored captions, SFX and zooms with their words", () => {
  const before = solve(decorated(), index)
  const after = solve(done(decorated(), [REMOVE_SENTENCE_2]), index)
  const shift = before.captions[0].at - after.captions[0].at
  assert.ok(shift > ms(2000) && shift < ms(4000), `shift ${shift}`)
  assert.equal(before.audio.find((a) => a.role === "sfx").at - after.audio.find((a) => a.role === "sfx").at, shift)
  assert.ok(Math.abs(before.zooms[0].at - after.zooms[0].at - shift) < FRAME, "a zoom moves too, snapped to a frame")
  assert.equal(before.duration - after.duration, shift)
  assert.deepEqual(after.issues, [])

  // The sound's peak, not its start, lands on the word
  const sfx = after.audio.find((a) => a.role === "sfx")
  assert.equal(sfx.at + ms(200), after.captions[0].at)

  // And the word still sits where the picture says it does
  const piece = after.picture.find((p) => p.in <= wordOf(30).start && wordOf(30).start < p.out)
  assert.equal(after.captions[0].at, piece.at + wordOf(30).start - piece.in)
})

test("ET-ANC-01: reordering moves them too; marker and clip anchors follow", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(4, "end") },
    { op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") },
    { op: "mark", name: "hook", at: w(5) },
    { op: "add_title", text: "On marker", at: { marker: "hook" }, duration: ms(1000) },
    { op: "add_title", text: "After clip", at: { clip: "c1", edge: "start", offset: ms(500) }, duration: ms(1000) },
  ])
  const before = solve(project, index)
  const after = solve(done(project, [{ op: "reorder", clip: "c2", after: null }]), index)
  assert.ok(after.overlays[0].at < before.overlays[0].at)
  assert.ok(after.overlays[1].at > before.overlays[1].at)
  assert.deepEqual(after.issues, [])
})

test("ET-ANC-01: a beat anchor lands on the music's beat", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(9, "end") },
    { op: "set_music", asset: "m1", in: ms(500) },
    { op: "add_title", text: "On the beat", at: { beat: "m1:b4" }, duration: ms(500) },
  ])
  assert.equal(solve(project, index).overlays[0].at, ms(1500))
})

test("ET-ANC-02: an anchor to removed content is reported, never guessed", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(49, "end") },
    { op: "caption_style", look: "bold", words: ["a1:w12", "a1:w13"] },
    { op: "caption_style", look: "bold", words: ["a1:w9", "a1:w10"] },
    { op: "add_sfx", asset: "sfx:whoosh-soft", peak_at: w(12) },
    { op: "punch_in", at: w(12), scale: 1.12 },
    { op: "mark", name: "gone", at: w(12) },
    { op: "add_title", text: "On a gone marker", at: { marker: "gone" }, duration: ms(1000) },
    REMOVE_SENTENCE_2,
  ])
  const timeline = solve(project, index)
  const removed = timeline.issues.filter((i) => i.code === "anchor_removed")
  assert.deepEqual(removed.map((i) => i.clip).sort(), ["c2", "c3", "c4", "c5", "c7"].sort())
  assert.equal(timeline.zooms.length, 0)
  assert.equal(timeline.overlays.length, 0)
  assert.equal(timeline.audio.some((a) => a.role === "sfx"), false)

  // A caption that lost one word keeps the rest and says what went
  assert.equal(timeline.captions.length, 1)
  assert.deepEqual(timeline.captions[0].words.map((x) => x.id), ["a1:w9"])
  assert.deepEqual(removed.find((i) => i.clip === "c3").words, ["a1:w10"])

  // Undoing the cut brings everything back: nothing was lost
  const restored = solve(done(project, [{ op: "keep_range", asset: "a1", from: w(10), to: w(14, "end") }]), index)
  assert.equal(codes(restored).includes("anchor_removed"), false)
})

test("ET-ANC-03: re-transcription remaps ids by alignment; unmappable ones are listed", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(9, "end") },
    { op: "caption_style", look: "bold", words: ["a1:w1", "a1:w2"] },
    { op: "caption_emphasis", caption: "c2", word: "a1:w2" },
    { op: "mark", name: "hook", at: w(3) },
  ])
  // A new engine: new ids, slightly different times, punctuation, and one word heard differently
  const renamed = index.words.map((word) => ({ ...word, id: word.id.replace("w", "x"), start: word.start + ms(20), end: word.end + ms(10), text: word.id === "a1:w3" ? "different" : `${word.text.toUpperCase()},` }))
  const mapping = alignWords(index.words, renamed)
  assert.equal(mapping["a1:w1"], "a1:x1")
  assert.equal(mapping["a1:w3"], null)

  const { project: moved, unmapped } = remapAnchors(project, mapping)
  assert.deepEqual(unmapped, ["a1:w3"])
  assert.deepEqual(validateProject(moved), [])
  const clips = moved.sequences[0].clips
  assert.deepEqual(clips[0].source.in, { word: "a1:x0", edge: "start" })
  assert.deepEqual(clips[1].effects[0].words, ["a1:x1", "a1:x2"])
  assert.deepEqual(clips[1].effects[0].emphasis, ["a1:x2"])
  assert.equal(moved.sequences[0].markers[0].at.word, "a1:w3", "kept and reported, never guessed")
  assert.equal(project.sequences[0].clips[0].source.in.word, "a1:w0", "pure")

  const timeline = solve(moved, { ...index, words: renamed })
  assert.equal(timeline.captions[0].words[0].id, "a1:x1")
})

test("ET-SOL-01: cuts land on frames, take their pads, and clear the neighbouring words", () => {
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") }])
  const { picture, audio } = solve(project, index)
  const first = wordOf(5)
  const lastWord = wordOf(9)
  assert.equal(picture[0].in % FRAME, 0)
  assert.equal(picture[0].out % FRAME, 0)
  assert.equal(picture[0].at, 0)
  assert.equal(DEFAULT_RULES.padIn, ms(120))
  assert.equal(DEFAULT_RULES.padOut, ms(240))
  assert.ok(picture[0].in <= first.start - ms(120) && picture[0].in > first.start - ms(120) - FRAME)
  assert.ok(picture[0].out >= lastWord.end + ms(240) && picture[0].out < lastWord.end + ms(240) + FRAME)
  assert.equal(audio[0].in, first.start - ms(120))
  assert.equal(audio[0].out, lastWord.end + ms(240))
})

test("ET-SOL-01: a pad never reaches into the next word; audio snaps to a zero crossing within ±2 ms", () => {
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(1), to: w(2, "end") }])
  const plain = solve(project, index).audio[0]
  assert.equal(plain.in, wordOf(0).end, "only 100 ms of gap, so the pad stops at the word before")
  assert.equal(plain.out, wordOf(3).start)

  const zero = { ...index, zeroCrossings: { a1: [wordOf(0).end + ms(1), wordOf(3).start - ms(50), wordOf(3).start - ms(1)] } }
  const snapped = solve(project, zero).audio[0]
  assert.equal(snapped.in, wordOf(0).end + ms(1))
  assert.equal(snapped.out, wordOf(3).start - ms(1))

  const far = { ...index, zeroCrossings: { a1: [wordOf(0).end + ms(3)] } }
  assert.equal(solve(project, far).audio[0].in, wordOf(0).end, "outside the tolerance, no snap")
  const inside = { ...index, zeroCrossings: { a1: [wordOf(0).end - ms(1)] } }
  assert.equal(solve(project, inside).audio[0].in, wordOf(0).end, "a crossing inside a word is refused")
})

test("ET-SOL-01: a plain time inside a word moves off it, and says so", () => {
  const inside = wordOf(0).start + ms(200)
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: inside, to: wordOf(4).end - ms(100) }])
  const timeline = solve(project, index)
  assert.ok(timeline.audio[0].in <= wordOf(0).start)
  assert.ok(timeline.audio[0].out >= wordOf(4).end)
  assert.deepEqual(codes(timeline), ["cut_moved_off_word", "cut_moved_off_word"])
})

test("ET-SOL-01: fuzzed transcripts: every cut on a frame, no audio cut inside a word", () => {
  const random = prng(11)
  for (let round = 0; round < 40; round++) {
    const words = []
    let t = ms(200)
    for (let i = 0; i < 60; i++) {
      const start = t + ms(Math.floor(random() * 300))
      const end = start + ms(50 + Math.floor(random() * 500))
      words.push({ asset: "a1", id: `a1:w${i}`, start, end, text: `w${i}` })
      t = end
    }
    const fuzz = { ...index, words }
    const ops = []
    for (let i = 0; i < 6; i++) {
      const a = Math.floor(random() * 59)
      ops.push({ op: "keep_range", asset: "a1", from: w(a), to: w(Math.min(59, a + Math.floor(random() * 10)), "end") })
    }
    const timeline = solve(done(makeProject(), ops, { ...ctx, index: fuzz }), fuzz)
    for (const piece of timeline.picture) {
      assert.equal(piece.in % FRAME, 0)
      assert.equal(piece.at % FRAME, 0)
      assert.equal(piece.end % FRAME, 0)
    }
    for (const piece of timeline.audio) {
      for (const cut of [piece.in, piece.out]) assert.equal(words.some((x) => cut > x.start && cut < x.end), false, `round ${round}`)
    }
    for (let i = 1; i < timeline.picture.length; i++) assert.equal(timeline.picture[i].at, timeline.picture[i - 1].end, "end to end")
  }
})

test("ET-SOL-01: with no frame boundary in the gap, the picture keeps the word and it is reported", () => {
  const tight = { ...index, words: [{ asset: "a1", id: "a1:w0", start: ms(100), end: ms(405), text: "a" }, { asset: "a1", id: "a1:w1", start: ms(410), end: ms(800), text: "b" }] }
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(1), to: w(1, "end") }], { ...ctx, index: tight })
  const timeline = solve(project, tight)
  assert.ok(timeline.picture[0].in <= ms(410))
  assert.equal(timeline.audio[0].in, ms(405))
  assert.deepEqual(codes(timeline), ["cut_no_frame_gap"])
})

test("ET-CORE-02: a VFR source cuts on its real timestamps, and its audio doesn't drift", () => {
  const vfr = makeProject()
  vfr.assets[0].facts = { ...vfr.assets[0].facts, vfr: true, fps: null }
  const table = []
  for (let t = 0, i = 0; t < ms(60000); i++) table.push((t += ms(i % 3 === 0 ? 20 : 41)))
  const timeline = solve(done(vfr, [{ op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") }]), { ...index, timestamps: { a1: table } })
  assert.ok(table.includes(timeline.picture[0].in))
  assert.ok(table.includes(timeline.picture[0].out))
  assert.equal(timeline.audio[0].in, wordOf(5).start - ms(120))
  assert.equal(timeline.picture[0].at % FRAME, 0, "the timeline stays on its own frames")
})

test("speed scales the timeline, and anchors inside the clip follow", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") },
    { op: "speed", clip: "c1", rate: { n: 2, d: 1 } },
    { op: "caption_style", look: "bold", words: ["a1:w7"] },
  ])
  const timeline = solve(project, index)
  const piece = timeline.picture[0]
  assert.ok(Math.abs(piece.end - (piece.out - piece.in) / 2) <= FRAME)
  assert.equal(timeline.captions[0].at, Math.ceil((wordOf(7).start - piece.in) / 2))
})

test("freeze holds the picture and pushes what follows", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") },
    { op: "caption_style", look: "bold", words: ["a1:w8"] },
  ])
  const before = solve(project, index)
  const after = solve(done(project, [{ op: "freeze", clip: "c1", at: w(7), duration: ms(1000) }]), index)
  assert.equal(after.picture.length, 3)
  assert.equal(after.picture[1].hold, true)
  assert.equal(after.picture[1].in, after.picture[1].out)
  assert.ok(Math.abs(after.duration - before.duration - ms(1000)) <= 2 * FRAME)
  assert.ok(Math.abs(after.captions[0].at - before.captions[0].at - ms(1000)) <= 2 * FRAME)
  assert.equal(after.issues.length, 0)
})

test("a freeze that lost its place is reported, not ignored or misplaced", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") },
    { op: "freeze", clip: "c1", at: w(7), duration: ms(1000) },
    { op: "trim", clip: "c1", in: w(8) },
  ])
  const timeline = solve(project, index)
  assert.equal(timeline.picture.length, 1, "no hold, and no footage from before the cut")
  assert.ok(codes(timeline).includes("anchor_removed"))
  const gone = solve(project, { ...index, words: index.words.filter((x) => x.id !== "a1:w7") })
  assert.ok(codes(gone).includes("anchor_removed"))
})

test("air rule: a sound on the last word extends the cut, up to the next word", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") },
    { op: "add_sfx", asset: "sfx:whoosh-soft", peak_at: w(9) },
  ])
  const audio = solve(project, index, { airAfter: ms(500) }).audio[0]
  assert.equal(audio.out, wordOf(9).end + ms(500))
  assert.equal(solve(project, index, { airAfter: ms(5000) }).audio[0].out, wordOf(10).start)
  assert.equal(solve(project, index, { airAfter: 0 }).audio[0].out, wordOf(9).end + ms(240))
})

test("J and L cuts: sound parts from picture by the set amount, and no more", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") },
    { op: "keep_range", asset: "a1", from: w(15), to: w(19, "end") },
    { op: "trim", clip: "c2", audioLead: ms(300) },
  ])
  const timeline = solve(project, index)
  const second = timeline.audio[1]
  assert.equal(second.in, wordOf(15).start - ms(120) - ms(300))
  assert.equal(second.at, timeline.picture[1].at + (second.in - timeline.picture[1].in))
  const limited = solve(project, index, { maxSplit: ms(100) })
  assert.equal(limited.audio[1].in, wordOf(15).start - ms(120) - ms(100))
  assert.deepEqual(codes(limited), ["split_limited"])
})

test("ET-SOL-04: impossible requests are reported, not dropped", () => {
  const brief = { format: "reel", targetDuration: ms(1000), mustKeep: [], mustCut: [], effort: "fast" }
  const base = [{ op: "keep_range", asset: "a1", from: w(0), to: w(9, "end") }]

  const over = solve({ ...done(makeProject(), base), brief }, index)
  assert.ok(codes(over).includes("over_target"))
  assert.equal(over.issues.find((i) => i.code === "over_target").target, ms(1000))
  assert.ok(codes(solve({ ...done(makeProject(), base), brief: { ...brief, targetDuration: ms(60000) } }, index)).includes("under_target"))
  assert.deepEqual(codes(solve({ ...done(makeProject(), base), brief }, index, { targetTolerance: ms(60000) })), [])

  const inverted = solve(done(makeProject(), [...base, { op: "add_title", text: "x", at: w(5), until: w(1) }]), index)
  assert.ok(codes(inverted).includes("span_inverted"))

  const shortBroll = solve(done(makeProject(), [...base, { op: "place_broll", asset: "a2", in: ms(7000), out: ms(8000), at: w(0), until: w(9, "end") }]), index)
  assert.ok(codes(shortBroll).includes("source_too_short"))
  assert.equal(shortBroll.overlays.length, 1, "kept at the length it has")

  const early = solve(done(makeProject(), [...base, { op: "add_sfx", asset: "sfx:whoosh-soft", peak_at: 0 }]), index)
  assert.ok(codes(early).includes("peak_before_start"))

  const late = solve(done(makeProject(), [...base, { op: "add_title", text: "x", at: ms(60000), duration: ms(1000) }]), index)
  assert.ok(codes(late).includes("past_end"))

  const flash = solve(done(makeProject(), [{ op: "keep_range", asset: "a2", from: 0, to: ms(20) }]), index)
  assert.ok(codes(flash).includes("flash_frame"))
  assert.ok(codes(solve(done(makeProject(), [{ op: "keep_range", asset: "a2", from: 0, to: ms(2000) }]), index, { minShot: ms(3000) })).includes("short_shot"))

  // Two clips anchored on each other can't be placed: reported, and no hang
  const cycle = structuredClone(done(makeProject(), [...base, { op: "add_title", text: "a", at: 0, duration: ms(1000) }, { op: "add_title", text: "b", at: { clip: "c2", edge: "end" }, duration: ms(1000) }]))
  cycle.sequences[0].clips[1].at = { clip: "c3", edge: "end" }
  assert.ok(codes(solve(cycle, index)).includes("anchor_cycle"))

  const full = solve(done(makeProject(), [...base, { op: "caption_style", look: "bold", words: ["a1:w2"] }]), { ...index, faces: [{ asset: "a1", shot: "a1:s0", t: ms(2100), box: { x: 0, y: 0, w: 1080, h: 1920 } }] })
  assert.ok(codes(full).includes("no_placement"))
  assert.equal(full.captions[0].placement, null)
})

const CANVAS = { width: 1000, height: 2000 }
const page = (id, at, faces = []) => ({ id, at: ms(at), end: ms(at + 900), w: 800, h: 200, faces })
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test("ET-SOL-02: never on a face, inside safe zones, stable across pages (golden cases)", () => {
  const safe = { top: 200, right: 100, bottom: 300, left: 100 }
  const face = { x: 200, y: 1200, w: 600, h: 400 }
  const pages = [page("p1", 0), page("p2", 1000, [face]), page("p3", 2000, [face]), page("p4", 3000)]
  const { placements, issues } = solveLayout(pages, { canvas: CANVAS, safe, prefer: 75 })
  assert.deepEqual(issues, [])
  const box = placements.p1
  assert.deepEqual([box.x, box.w, box.h], [100, 800, 200])
  for (const id of ["p2", "p3", "p4"]) assert.deepEqual(placements[id], box, "one row for every page")
  assert.equal(overlaps(box, face), false)
  assert.ok(box.x >= safe.left && box.y >= safe.top && box.x + box.w <= CANVAS.width - safe.right && box.y + box.h <= CANVAS.height - safe.bottom)
})

test("ET-SOL-02: the dynamic programme moves once, not on every page", () => {
  const low = { x: 0, y: 1300, w: 1000, h: 700 }
  const high = { x: 0, y: 0, w: 1000, h: 700 }
  const pages = [page("p1", 0, [low]), page("p2", 1000, [low]), page("p3", 2000, [low]), page("p4", 3000, [high]), page("p5", 4000, [high])]
  const { placements } = solveLayout(pages, { canvas: CANVAS, safe: { top: 0, right: 100, bottom: 0, left: 100 }, prefer: 85 })
  const ys = Object.values(placements).map((box) => box.y)
  assert.equal(new Set(ys).size, 1, "one row clears both faces, so nothing jumps")

  const wall = { x: 0, y: 700, w: 1000, h: 1300 }
  const roof = { x: 0, y: 0, w: 1000, h: 1300 }
  const forced = solveLayout([page("p1", 0, [wall]), page("p2", 1000, [wall]), page("p3", 2000, [roof]), page("p4", 3000, [roof])], { canvas: CANVAS, safe: { top: 0, right: 100, bottom: 0, left: 100 }, prefer: 85 }).placements
  assert.equal(forced.p1.y, forced.p2.y)
  assert.equal(forced.p3.y, forced.p4.y)
  assert.notEqual(forced.p2.y, forced.p3.y, "the speaker moved a lot, so the caption moves, once")
})

test("ET-SOL-02: a person's own placement stands; items at one time don't collide; no room is reported", () => {
  const fixed = { x: 10, y: 10, w: 100, h: 100 }
  assert.deepEqual(solveLayout([{ ...page("p1", 0), fixed }], { canvas: CANVAS, prefer: 80 }).placements.p1, fixed)

  const { placements } = solveLayout([page("a", 0), page("b", 0)], { canvas: CANVAS, prefer: 80 })
  assert.equal(overlaps(placements.a, placements.b), false)

  const blocked = solveLayout([page("p1", 0, [{ x: 0, y: 0, w: 1000, h: 2000 }])], { canvas: CANVAS, prefer: 80 })
  assert.equal(blocked.placements.p1, null)
  assert.equal(blocked.issues[0].code, "no_placement")
})

const REFRAME = { sourceWidth: 1920, cropWidth: 608, deadzone: 12, hold: 40, smooth: 20 }
const samples = (fn, n = 120) => Array.from({ length: n }, (_, i) => ({ t: ms(i * 200), x: fn(i) }))

test("ET-SOL-03: the subject stays in frame; the crop stays on the source", () => {
  const random = prng(3)
  const subject = samples((i) => 200 + i * 12 + Math.floor(random() * 30))
  const [{ path }] = solveReframe([{ id: "s0", samples: subject }], { ...REFRAME, margin: 40 })
  path.forEach(({ x }, i) => {
    assert.ok(Number.isSafeInteger(x))
    assert.ok(x >= 0 && x + REFRAME.cropWidth <= REFRAME.sourceWidth)
    assert.ok(subject[i].x >= x + 40 - 1 && subject[i].x <= x + REFRAME.cropWidth - 40 + 1, `sample ${i}`)
    assert.equal(path[i].t, subject[i].t)
  })
})

test("ET-SOL-03: the path holds, then moves decisively, with no constant drift", () => {
  const random = prng(5)
  const noisy = samples((i) => (i < 60 ? 500 : 1200) + Math.floor(random() * 40) - 20)
  const [{ path }] = solveReframe([{ id: "s0", samples: noisy }], REFRAME)
  const moves = path.slice(1).filter((p, i) => p.x !== path[i].x).length
  assert.ok(moves < path.length * 0.25, `${moves} moving samples of ${path.length}`)
  const left = path.slice(5, 45).map((p) => p.x)
  assert.ok(Math.max(...left) - Math.min(...left) <= 2, "a long hold before the move")
})

test("ET-SOL-03: the deadzone holds: jitter inside it gives a still camera", () => {
  const [{ path }] = solveReframe([{ id: "s0", samples: samples((i) => 960 + (i % 2 ? 5 : -5)) }], REFRAME)
  assert.equal(new Set(path.map((p) => p.x)).size, 1)
})

test("ET-SOL-03: a shot change resets the path", () => {
  const a = { id: "s0", samples: samples(() => 300, 40) }
  const b = { id: "s1", samples: samples(() => 1500, 40) }
  const together = solveReframe([a, b], REFRAME)
  assert.deepEqual(together[1], solveReframe([b], REFRAME)[0], "the first shot has no effect on the second")
  assert.equal(together[1].path[0].x, 1500 - 304)
  assert.deepEqual(solveReframe([{ id: "s2", samples: [] }], REFRAME), [{ shot: "s2", path: [] }])
  assert.equal(solveReframe([{ id: "s3", samples: samples(() => 960, 1) }], REFRAME)[0].path.length, 1)
})
