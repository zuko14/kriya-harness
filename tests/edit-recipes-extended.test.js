import assert from "node:assert/strict"
import { test } from "node:test"

import { mapBox } from "../src/edit/core/faces.js"
import { segmentArgs } from "../src/edit/core/ffmpeg.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { newProject } from "../src/edit/core/project.js"
import { solveReframe } from "../src/edit/core/reframe.js"
import { solve } from "../src/edit/core/solver.js"
import { SCREEN, screenTrack } from "../src/edit/index/layers/screen.js"
import { embed, openingStrength, planShort, SHORT_FROM_LONG, storySearch, tournament } from "../src/edit/recipes/short-from-long.js"
import { findActions, keptRanges, planTutorial, TUTORIAL, zoomFor } from "../src/edit/recipes/tutorial.js"
import { prng } from "./edit/fixture.js"
import { longTalk } from "./edit/talk.js"

// ED11: long to short, reframing, tutorial zooms. Pure code on synthetic indexes; the
// real FFmpeg renders and gates are in tests/edit/media/recipes.test.js.

const FLICKS = 705_600_000
const sec = (s) => Math.round(s * FLICKS)

// ---------------------------------------------------------------- ET-SOL-03

const REFRAME = { sourceWidth: 1920, cropWidth: 608, deadzone: 12, hold: 40, smooth: 20 }
const track = (fn, n = 150, w) => Array.from({ length: n }, (_, i) => ({ t: sec(i * 0.2), x: fn(i), ...(w ? { w } : {}) }))
const steps = (path) => path.slice(1).map((p, i) => Math.abs(p.x - path[i].x))

test("ET-SOL-03: the whole face box stays in the 9:16 crop, not just its centre", () => {
  const random = prng(11)
  const face = track((i) => 300 + i * 8 + Math.floor(random() * 50) - 25, 150, 240)
  const [{ path }] = solveReframe([{ id: "s0", samples: face }], { ...REFRAME, margin: 20, maxSpeed: 608 })
  path.forEach(({ x }, i) => {
    assert.ok(x >= 0 && x + 608 <= 1920)
    assert.ok(face[i].x - 120 - 20 >= x - 1 && face[i].x + 120 + 20 <= x + 608 + 1, `sample ${i}: face ${face[i].x}±120 outside crop ${x}..${x + 608}`)
  })
  // A sudden lean far to the side: keeping the face whole wins over the speed limit
  const lean = track((i) => (i >= 30 && i < 32 ? 1500 : 960), 60)
  const [{ path: whole }] = solveReframe([{ id: "s0", samples: lean.map((p) => ({ ...p, w: 240 })) }], { ...REFRAME, maxSpeed: 608 })
  whole.forEach(({ x }, i) => assert.ok(lean[i].x - 120 >= x && lean[i].x + 120 <= x + 608, `sample ${i}`))
})

test("ET-SOL-03: no whip: a move never beats maxSpeed while the subject can be kept in frame", () => {
  const step = track((i) => (i < 60 ? 900 : 1150), 120)
  const [{ path: free }] = solveReframe([{ id: "s0", samples: step }], REFRAME)
  assert.ok(Math.max(...steps(free)) > 122, "without the limit the solver jumps")
  const [{ path }] = solveReframe([{ id: "s0", samples: step }], { ...REFRAME, maxSpeed: 608 })
  assert.ok(Math.max(...steps(path)) <= 608 * 0.2 + 1, `largest step ${Math.max(...steps(path))} px in 0.2 s`)
  assert.ok(Math.abs(path.at(-1).x - (1150 - 304)) <= 2, "it still arrives")
  path.forEach(({ x }, i) => assert.ok(step[i].x >= x && step[i].x <= x + 608))
})

test("ET-SOL-03: no jitter: noise gives holds, few reversals, and a shot change still resets", () => {
  const random = prng(4)
  const walk = track((i) => 500 + i * 5 + Math.floor(random() * 30) - 15, 150, 200)
  const [{ path }] = solveReframe([{ id: "s0", samples: walk }], { ...REFRAME, maxSpeed: 608 })
  const moves = steps(path).map((d, i) => Math.sign(path[i + 1].x - path[i].x)).filter(Boolean)
  const reversals = moves.slice(1).filter((m, i) => m !== moves[i]).length
  assert.ok(reversals <= 2, `${reversals} reversals: the camera doesn't wobble`)
  const still = track((i) => 960 + (i % 2 ? 5 : -5))
  assert.equal(new Set(solveReframe([{ id: "s0", samples: still }], { ...REFRAME, maxSpeed: 608 })[0].path.map((p) => p.x)).size, 1)
  const [, second] = solveReframe([{ id: "a", samples: track(() => 300, 30) }, { id: "b", samples: track(() => 1500, 30) }], { ...REFRAME, maxSpeed: 608 })
  assert.equal(second.path[0].x, 1500 - 304, "a cut lands on the new subject with no ramp")
})

test("ET-SOL-03: between samples the crop glides, in the render and in the face map alike", () => {
  const crop = [{ t: 0, x: 0 }, { t: FLICKS, x: 100 }, { t: 2 * FLICKS, x: 100 }]
  const box = { x: 300, y: 100, w: 100, h: 100 }
  const at = (t) => mapBox(box, { crop }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 }, t)
  assert.ok(Math.abs(at(0).x - at(FLICKS / 2).x - (at(0).x - at(FLICKS).x) / 2) <= 2, "half way in time is half way in space")
  const plan = { canvas: { width: 1080, height: 1920 }, output: { width: 1080, height: 1920, fps: { n: 30, d: 1 } }, tiles: [] }
  const segment = { start: 0, end: 2 * FLICKS, node: { picture: [{ asset: "a1", at: 0, end: 2 * FLICKS, in: 0, out: 2 * FLICKS, speed: { n: 1, d: 1 }, effects: [], crop }], overlays: [], tiles: [] } }
  const args = segmentArgs(plan, segment, { input: () => "/x/a.mov", tile: () => "/x/t.mov", output: "/x/o.mp4", encoder: [] })
  const graph = args[args.indexOf("-filter_complex") + 1]
  assert.ok(graph.includes("crop=w=ih*1080/1920:h=ih:x=if(lt(t\\,1.000000000)\\,0+(100)*(t-0.000000000)/1.000000000\\,100):y=0"), graph)
  // A segment that starts between points carries the one before, at a negative time
  const later = segmentArgs(plan, { ...segment, node: { ...segment.node, picture: [{ ...segment.node.picture[0], in: FLICKS / 2 }] } }, { input: () => "/x/a.mov", tile: () => "/x/t.mov", output: "/x/o.mp4", encoder: [] })
  assert.ok(later[later.indexOf("-filter_complex") + 1].includes("0+(100)*(t+0.500000000)/1.000000000"), "never 0.-5")
})

// ---------------------------------------------------------------- short-from-long

function longProject(duration) {
  return apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "talk.mov", linked: true, rights: "own", facts: { width: 1920, height: 1080, hasAudio: true, duration, vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } } }], { author: "code" }).project
}

test("short-from-long: a 40-minute talk becomes one coherent 30–60 s vertical short, reframed on the face, in seconds", () => {
  const talk = longTalk(40)
  assert.ok(talk.duration > 40 * 60 * FLICKS, "the recording is over 40 minutes")
  const started = Date.now()
  const made = planShort({ project: longProject(talk.duration), index: talk.index, asset: "a1" })
  const ms = Date.now() - started
  assert.ok(ms < 20_000, `${ms} ms for story search and the tournament`)
  assert.equal(made.calls, 0)
  assert.deepEqual([made.project.canvas.width, made.project.canvas.height], [1080, 1920])
  const plan = compile(made.project, talk.index, { engineVersion: "t", runtimeVersion: "t" })
  const seconds = plan.duration / FLICKS
  assert.ok(seconds >= 30 && seconds <= 60, `${seconds} s`)
  assert.ok(Math.abs(seconds - 45) <= 15)

  // Coherent: every word that plays comes from one subject, and it opens on a line that stands alone
  const { picture } = solve(made.project, talk.index)
  const playing = talk.index.words.filter((w) => picture.some((p) => w.start >= p.in && w.end <= p.out))
  assert.equal(new Set(playing.map((w) => talk.blockOf.get(w.id))).size, 1, "one topic")
  const first = picture.sort((a, b) => a.at - b.at)[0]
  const opener = talk.index.sentences.find((s) => s.start <= first.in + FLICKS / 4 && first.in <= s.end)
  assert.ok(openingStrength({ words: talk.index.words.filter((w) => w.start >= opener.start && w.end <= opener.end) }) >= 0.5, "the hook doesn't lean on a cut line")
  assert.match(talk.index.words.find((w) => w.start >= opener.start).text, /^(Here|The|Most|I|There)$/)

  // 9:16 reframe on the subject track: every kept clip follows the face, and the plan has crop paths
  const sequence = made.project.sequences[0]
  const base = sequence.clips.filter((c) => sequence.tracks.find((t) => t.id === c.track).role === "base")
  assert.ok(base.length > 0 && base.every((c) => c.effects.some((e) => e.type === "reframe" && e.mode === "subject")))
  assert.ok(plan.segments.every((s) => s.node.picture.every((p) => p.crop?.length)))
  // The only note a plan may carry is running a little past the nominal 45 s, inside the recipe's tolerance
  assert.deepEqual(plan.issues.filter((i) => i.code !== "over_target"), [], "the plan compiles clean")

  // EDD-16: three ranked candidates, numbers that order them, and no forecast anywhere
  assert.deepEqual(made.candidates.map((c) => c.rank), [1, 2, 3])
  assert.ok(made.candidates.every((c) => c.plan && c.plan.seconds >= 30 && c.plan.seconds <= 60), "each candidate was compiled at F0")
  assert.doesNotMatch(JSON.stringify({ ...made, notes: [] }), /viral|predict|forecast|views/i)
  assert.ok(made.notes.some((n) => n.includes("doesn't predict views")))
})

test("short-from-long: story search keeps stories inside one topic, ends on a full stop, never overlaps", () => {
  const talk = longTalk(12, 3)
  const found = storySearch(talk.index, "a1")
  assert.equal(found.length, SHORT_FROM_LONG.candidates)
  for (const story of found) {
    const blocks = new Set(story.lines.flatMap((l) => l.words.map((w) => talk.blockOf.get(w.id))))
    assert.equal(blocks.size, 1, "embedding distance and long pauses bound a story")
    assert.match(story.lines.at(-1).words.at(-1).text, /\.$/)
    assert.ok(story.duration >= 30 * FLICKS && story.duration <= 60 * FLICKS)
    assert.ok(Object.values(story.rubric).every((v) => v >= 0 && v <= 1))
  }
  for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) assert.ok(found[i].lines.at(-1).end < found[j].lines[0].start || found[j].lines.at(-1).end < found[i].lines[0].start)
  assert.ok(embed("garlic0 pricing0 garlic0").some((x) => x > 0) && embed("the and so").every((x) => x === 0), "stop words carry no topic")
})

test("tournament: candidates are ranked by pairwise rubric wins at F0 and F1, with nothing rendered", () => {
  const r = (hook, cohesion, density, fit, ending, references) => ({ hook, cohesion, density, fit, ending, references })
  const candidates = [
    { rubric: r(0.5, 0.4, 0.6, 0.7, 1, 1), f0: { issues: 0, duration: 1 } },
    { rubric: r(1, 0.6, 0.7, 0.9, 1, 1), f0: { issues: 0, duration: 1 } },
    { rubric: r(1, 0.6, 0.7, 0.9, 1, 1) }, // the same text, but its plan didn't compile
  ]
  const ranked = tournament(candidates)
  assert.deepEqual(ranked.order, [1, 2, 0])
  assert.deepEqual(ranked.wins, [0, 2, 1])
  assert.equal(ranked.pairs.length, 3, "every pair meets once")
  assert.deepEqual(ranked.pairs.find((p) => p.a === 1 && p.b === 2).ahead, ["plan"], "F0 decides between equal texts")
  assert.deepEqual(tournament(candidates), ranked, "deterministic")
  // F0 and F1 only: planShort takes no renderer, and each candidate carries its compiled length
  assert.equal(planShort.length, 1)
})

// ---------------------------------------------------------------- tutorial

const FRAME = { width: 1920, height: 1080 }
const ACTION = { x: 1400, y: 150, w: 200, h: 80 }

/** A screen recording's L9 track at 5 a second: a cursor glides, someone types, then a long wait. */
function screencast() {
  const samples = []
  for (let k = 1; k <= 100; k++) {
    const t = k * 0.2
    samples.push({ t: sec(t), change: t >= 3 && t <= 5 ? { ...ACTION, w: Math.round(ACTION.w * (t - 2.8) / 2.2) } : null, cursor: t >= 0.4 && t <= 1.6 ? { x: 200 + k * 40, y: 600 } : null })
  }
  const say = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `a1:w${from * 10 + i}`, asset: "a1", text: "word", start: sec(from + i * 0.5), end: sec(from + i * 0.5 + 0.4), flags: [], conf: 0.95 }))
  return { samples, words: [...say(0.5, 4), ...say(14, 6)] }
}

function screenProject() {
  return apply(newProject({ id: "t", name: "Tutorial" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "screen.mov", linked: true, rights: "own", facts: { width: 1920, height: 1080, hasAudio: true, duration: sec(20), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } } }], { author: "code" }).project
}

test("tutorial: a smooth zoom lands on the coordinates of the action on screen", () => {
  const { samples, words } = screencast()
  const actions = findActions(samples, FRAME)
  assert.equal(actions.length, 1, "the cursor's glide isn't an action; the typing is")
  assert.deepEqual(actions[0].box, { ...ACTION, w: 200 })
  assert.deepEqual(zoomFor(actions[0].box, FRAME), { scale: 2, x: Math.round((1500 / 1920) * 1000), y: Math.round((190 / 1080) * 1000) })
  assert.equal(zoomFor({ x: 0, y: 0, w: 1500, h: 900 }, FRAME), null, "a change nearly the whole screen isn't zoomed")

  const index = { words, sentences: [], takes: [], shots: [], faces: [], silences: [], timestamps: {}, subjects: {} }
  const made = planTutorial({ project: screenProject(), index, asset: "a1", track: samples })
  const punch = made.ops.find((op) => op.op === "punch_in")
  assert.deepEqual([punch.scale, punch.x, punch.y, punch.ease], [2, 781, 176, "smooth"])
  // The zoom starts before the typing (lead) and plays where the typing plays
  const timeline = solve(made.project, index)
  assert.equal(timeline.zooms.length, 1)
  const zoom = timeline.zooms[0]
  assert.deepEqual([zoom.x, zoom.y, zoom.ease], [781, 176, "smooth"])
  const piece = timeline.picture.find((p) => p.in <= sec(3) && sec(3) < p.out)
  const typingAt = piece.at + sec(3) - piece.in
  assert.ok(zoom.at <= typingAt - sec(0.3) && zoom.end >= typingAt + sec(1.9), `${zoom.at / FLICKS}–${zoom.end / FLICKS} s around ${typingAt / FLICKS} s`)

  // In the render: the zoom is animated (zoompan) and centred on the action
  const plan = compile(made.project, index, { engineVersion: "t", runtimeVersion: "t", quality: "master", deliverable: made.project.deliverables[0].id })
  const zoomed = plan.segments.find((s) => s.node.picture.some((p) => p.zoom))
  const item = zoomed.node.picture.find((p) => p.zoom)
  assert.deepEqual([item.zoom.x, item.zoom.y, item.zoom.ease], [781, 176, "smooth"])
  const args = segmentArgs(plan, zoomed, { input: () => "/x/a.mov", tile: () => "/x/t.mov", output: "/x/o.mp4", encoder: [] })
  assert.match(args[args.indexOf("-filter_complex") + 1], /zoompan=z=.*:x=.*0\.781.*:y=.*0\.176.*:d=1:s=1920x1080:fps=30\/1/)
})

test("tutorial: long waiting is trimmed to a snappy beat; speech and on-screen action are never cut", () => {
  const { samples, words } = screencast()
  const ranges = keptRanges(samples, words, sec(20))
  const removed = []
  for (let i = 0; i <= ranges.length; i++) removed.push([i === 0 ? 0 : ranges[i - 1].to, i === ranges.length ? sec(20) : ranges[i].from])
  const gaps = removed.filter(([a, b]) => b > a)
  assert.ok(gaps.length >= 1)
  const wait = gaps.find(([a]) => a > sec(5) && a < sec(6))
  assert.ok(wait, JSON.stringify(gaps.map((g) => g.map((v) => v / FLICKS))))
  assert.ok(wait[1] - wait[0] > sec(7), "the 8.6 s wait loses all but half a second")
  for (const [a, b] of gaps) {
    assert.ok(!words.some((w) => w.start < b && a < w.end), "no word is cut")
    assert.ok(!samples.some((s) => (s.change || s.cursor) && s.t > a && s.t < b), "no action is cut")
  }
  const made = planTutorial({ project: screenProject(), index: { words, sentences: [], takes: [], shots: [], faces: [], silences: [], timestamps: {}, subjects: {} }, asset: "a1", track: samples })
  assert.ok(made.notes.some((n) => /waiting cut/.test(n)))
  const kept = ranges.reduce((sum, r) => sum + r.to - r.from, 0)
  assert.ok(Math.abs(compile(made.project, {}, { engineVersion: "t", runtimeVersion: "t" }).duration - kept) <= sec(0.1))
  assert.deepEqual(TUTORIAL.deliverable.size, FRAME)
})

test("L9: frame difference finds the cursor and where the screen changed, in source pixels", () => {
  const { width, height } = SCREEN
  const frame = (draw) => {
    const f = Buffer.alloc(width * height, 30)
    draw((x, y, v) => (f[y * width + x] = v))
    return f
  }
  const square = (x0, y0, w, h, v) => (set) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, v)
  }
  const cursorAt = (x) => square(x, 20, 2, 2, 255)
  const typed = (w) => square(120, 10, w, 8, 200)
  const both = (...draws) => (set) => draws.forEach((draw) => draw(set))
  // A cursor appears and moves on; then someone types where it isn't, two pixels a frame
  const frames = Buffer.concat([frame(() => {}), frame(cursorAt(20)), frame(cursorAt(24)), frame(both(cursorAt(24), typed(20))), frame(both(cursorAt(24), typed(22))), frame(both(cursorAt(24), typed(24)))])
  const samples = screenTrack(frames, { sourceWidth: 1920, sourceHeight: 1080 })
  assert.equal(samples.length, 5)
  assert.deepEqual(samples[0], { t: FLICKS / 5, change: null, cursor: { x: 270, y: 270 } }, "it appeared, then moved: the cursor")
  assert.deepEqual(samples[1], { t: (2 * FLICKS) / 5, change: null, cursor: { x: 270, y: 270 } }, "a short move stays in one cell")
  assert.deepEqual(samples[2].change, { x: 1440, y: 120, w: 240, h: 120 })
  assert.equal(samples[2].cursor, null)
  for (const s of samples.slice(3)) {
    assert.equal(s.cursor, null, "slow typing is never taken for the cursor")
    assert.deepEqual(s.change, { x: 1440, y: 120, w: 300, h: 120 }, "the typed line, as it grows")
  }
  assert.equal(findActions(samples, { width: 1920, height: 1080 }).length, 1)
})
