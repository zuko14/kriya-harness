import assert from "node:assert/strict"
import { test } from "node:test"

import { segmentArgs } from "../src/edit/core/ffmpeg.js"
import { apply } from "../src/edit/core/ops.js"
import { compile, wholeSegment } from "../src/edit/core/plan.js"
import { solve } from "../src/edit/core/solver.js"
import { TRANSITION_DEFAULT, transitionLength, TRANSITIONS } from "../src/edit/core/transitions.js"
import { planDiff, replayable } from "../src/edit/director/continuity.js"
import { briefOf, planCut, transitionIn } from "../src/edit/director/plan.js"
import { describe, expandGraphics } from "../src/edit/director/revise.js"
import { judgeHealth } from "../src/edit/gates/picture.js"
import { planReel } from "../src/edit/recipes/reel.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"
import { indexOf, lengthOf } from "./edit/script.js"

// Transitions (MOTION_GRAPHICS.md §6): the cut never moves, the kinds are a fixed list, the
// Director dresses only a change of moment, and with editing.motion off nothing reaches them.

const FLICKS = 705_600_000
const VERSIONS = { engineVersion: "core-1", runtimeVersion: "rt-1" }
const index = makeIndex()
const ctx = { index, author: "agent" }
const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
const io = { input: (asset) => `/media/${asset}.mov`, tile: (key) => `/tiles/${key}.mov`, output: "/out.mp4", encoder: ["-c:v", "libx264"] }

function cut(extra = []) {
  const base = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: w(0), to: w(14, "end") }, { op: "keep_range", asset: "a1", from: w(20), to: w(34, "end") }], ctx)
  assert.deepEqual(base.diagnostics, [])
  const [first, second] = base.project.sequences[0].clips.filter((c) => c.source).map((c) => c.id)
  const done = apply(base.project, extra.map((op) => ({ clip: second, ...op })), ctx)
  return { ...done, first, second, plain: base.project }
}

test("ET-TR-01: the operation takes a kind from the fixed list and a length of 0.2 to 0.8 s, on footage only", () => {
  assert.deepEqual(Object.keys(TRANSITIONS), ["fade", "dip", "flash", "wipe", "slide", "zoom"])
  assert.equal(cut([{ op: "transition", kind: "slide", duration: ms(300) }]).applied, true)
  assert.equal(cut([{ op: "transition", kind: "starwipe", duration: ms(300) }]).diagnostics[0].code, "unknown_transition")
  assert.equal(cut([{ op: "transition", kind: "xfade=transition=fade;[0:v]", duration: ms(300) }]).diagnostics[0].code, "unknown_transition")
  assert.equal(cut([{ op: "transition", kind: "fade", duration: ms(100) }]).diagnostics[0].code, "bad_duration")
  assert.equal(cut([{ op: "transition", kind: "fade", duration: ms(5000) }]).diagnostics[0].code, "bad_duration")
  assert.equal(transitionLength(undefined), TRANSITION_DEFAULT)
  assert.equal(transitionLength(ms(5000)), ms(800))
})

test("ET-TR-02: a transition changes no time: the same length, cut points, sound and tiles; one segment's picture differs", () => {
  const plain = compile(cut().project, index, VERSIONS)
  const made = cut([{ op: "transition", kind: "wipe", duration: ms(300) }])
  const dressed = compile(made.project, index, VERSIONS)
  assert.equal(dressed.duration, plain.duration)
  assert.deepEqual(dressed.segments.map((s) => [s.start, s.end]), plain.segments.map((s) => [s.start, s.end]))
  assert.equal(dressed.keys.audio, plain.keys.audio)
  assert.equal(dressed.keys.caption, plain.keys.caption)
  assert.notEqual(dressed.keys.picture, plain.keys.picture)
  assert.deepEqual(solve(made.project, index).picture.map((p) => [p.at, p.end, p.in, p.out]), solve(made.plain, index).picture.map((p) => [p.at, p.end, p.in, p.out]))
  const changed = dressed.segments.filter((s, i) => s.key !== plain.segments[i].key)
  assert.equal(changed.length, 1, "only the segment the clip starts in")
  const [item] = changed[0].node.picture
  const before = solve(made.project, index).picture[0]
  assert.equal(item.enter.kind, "wipe")
  assert.equal(item.enter.duration, ms(300))
  assert.deepEqual([item.enter.from.asset, item.enter.from.hold, item.enter.from.out], ["a1", true, before.out], "the piece before, held on its last frame")
  assert.ok(item.enter.from.in < before.out && before.out - item.enter.from.in <= FLICKS / 24, "one frame from its end")
  assert.ok(!item.effects.some((e) => e.type === "transition"), "it isn't an effect on the piece's own frames")
  assert.equal(wholeSegment(dressed).node.picture.filter((p) => p.enter).length, 1, "a master carries it too")
})

test("ET-TR-03: never longer than half the clip; the first clip has nothing to come from", () => {
  const short = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: w(0), to: w(14, "end") }, { op: "keep_range", asset: "a1", from: w(20), to: w(20, "end") }], ctx).project
  const [first, second] = short.sequences[0].clips.filter((c) => c.source)
  const piece = solve(short, index).picture[1]
  const plan = compile(apply(short, [{ op: "transition", clip: second.id, kind: "fade", duration: ms(800) }, { op: "transition", clip: first.id, kind: "fade", duration: ms(300) }], ctx).project, index, VERSIONS)
  const items = plan.segments.flatMap((s) => s.node.picture)
  assert.equal(items[0].enter, undefined)
  const enter = items.find((p) => p.enter)?.enter
  if (enter) assert.ok(enter.duration <= (piece.end - piece.at) / 2, "half the clip at most")
  else assert.ok(piece.end - piece.at < FLICKS / 5, "too short a clip to dress at all")
})

test("ET-TR-04: the builder names FFmpeg's transition from the list, holds the last frame, and keeps a plain piece as it was", () => {
  const plain = compile(cut().project, index, VERSIONS)
  for (const [kind, xfade] of Object.entries(TRANSITIONS)) {
    const plan = compile(cut([{ op: "transition", kind, duration: ms(300) }]).project, index, VERSIONS)
    const i = plan.segments.findIndex((s) => s.node.picture.some((p) => p.enter))
    const graph = segmentArgs(plan, plan.segments[i], io).at(segmentArgs(plan, plan.segments[i], io).indexOf("-filter_complex") + 1)
    assert.match(graph, new RegExp(`xfade=transition=${xfade}:duration=0\\.30*:offset=0`), kind)
    assert.match(graph, /trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=0\.30*,/, "the piece before, frozen")
    assert.match(graph, /concat=n=2:v=1:a=0/)
    // Every other segment's command is byte for byte what it was
    plan.segments.forEach((segment, n) => n !== i && assert.deepEqual(segmentArgs(plan, segment, io), segmentArgs(plain, plain.segments[n], io)))
  }
  const forged = structuredClone(compile(cut([{ op: "transition", kind: "fade", duration: ms(300) }]).project, index, VERSIONS))
  const segment = forged.segments.find((s) => s.node.picture.some((p) => p.enter))
  segment.node.picture[0].enter.kind = "fade:duration=9;movie=/etc/passwd"
  assert.throws(() => segmentArgs(forged, segment, io), /can't do a/)
})

test("ET-TR-05: the health gate allows black and a brightness jump inside a planned transition, and nowhere else", () => {
  const at = 5 * FLICKS
  const health = { black: [{ start: at + FLICKS / 10, end: at + FLICKS / 5 }, { start: 20 * FLICKS, end: 20.5 * FLICKS }], frozen: [], luma: Array.from({ length: 900 }, (_, i) => (i < 150 ? 40 : 200)) }
  const input = { duration: 30 * FLICKS, fps: { n: 30, d: 1 }, holds: [], cuts: [{ t: at, same: true }] }
  const dressed = judgeHealth(health, { ...input, transitions: [{ at, end: at + 0.3 * FLICKS }] }, { exposureJump: 40 }).failures
  assert.deepEqual(dressed.map((f) => [f.kind, f.t]), [["black", 20 * FLICKS]])
  const bare = judgeHealth(health, input, { exposureJump: 40 }).failures
  assert.deepEqual(bare.map((f) => f.kind).sort(), ["black", "black", "exposure_jump"])
})

function talk() {
  const spoken = indexOf()
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(makeProject(), [], { author: "code" }).project
  const project = apply({ ...base, assets: [{ id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }] }, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index: spoken }).project
  return { index: spoken, project }
}
const defaults = async ({ fallback }) => ({ value: fallback(), source: "default", calls: 0 })
const transitionsOf = (made) => made.ops.filter((op) => op.op === "transition")

test("ET-TR-06: the person's words choose: a kind, every cut, or none; other mentions of a kind's word don't", () => {
  assert.deepEqual(transitionIn("add smooth transitions"), { transition: "fade" })
  assert.deepEqual(transitionIn("slide transitions on every cut"), { transition: "slide", transitionAll: true })
  assert.deepEqual(transitionIn("use a dip to black transition"), { transition: "dip" })
  assert.deepEqual(transitionIn("cross fade between the parts"), { transition: "fade" })
  assert.deepEqual(transitionIn("no transitions please"), { transition: "none" })
  assert.deepEqual(transitionIn("zoom in on the price. Make it punchy"), {})
  assert.deepEqual(transitionIn("zoom in on the price. Wipe transitions"), { transition: "wipe" })
})

test("ET-TR-07: a plan carries its transition to the brief; the recipe dresses a change of moment, or every cut when asked", async () => {
  const { index: spoken, project } = talk()
  const plan = await planCut({ ask: defaults, project, index: spoken, text: "edit this with slide transitions", motion: true })
  assert.equal(plan.settings.transition, "slide")
  assert.deepEqual([briefOf(plan.settings).transition, briefOf(plan.settings).transitionAll], ["slide", undefined])
  assert.deepEqual(planDiff({}, briefOf(plan.settings)).filter((l) => /Transitions/.test(l)), ["Transitions: none → slide"])
  // A revision that says nothing keeps it; "no transitions" removes it; the Director's own choice is taken when the person says nothing
  assert.equal((await planCut({ ask: defaults, project, index: spoken, text: "make it warmer", previous: plan, motion: true })).settings.transition, "slide")
  assert.equal((await planCut({ ask: defaults, project, index: spoken, text: "no transitions", previous: plan, motion: true })).settings.transition, undefined)
  const pitched = async ({ task, schema, fallback }) => (task === "plan" ? (assert.deepEqual(schema.properties.settings.properties.transition.enum, ["none", ...Object.keys(TRANSITIONS)]), { value: { say: "A cut.", steps: [], settings: { transition: "dip" } }, source: "model", calls: 1 }) : { value: fallback(), source: "default", calls: 0 })
  assert.equal((await planCut({ ask: pitched, project, index: spoken, text: "edit this", motion: true })).settings.transition, "dip")

  // The hook moved to the front is a change of moment; the lines after it follow on
  const hook = spoken.sentences.find((s) => s.id === "a1:s8").id
  const story = { hook, drop: [], emphasis: { most: 3, ids: [] } }
  const moved = await planReel({ project, index: spoken, asset: "a1", ask: defaults, brief: { transition: "slide", story, punches: 3 } })
  const joins = transitionsOf(moved)
  assert.ok(joins.length >= 1, "the join after the hook is dressed")
  const clips = moved.project.sequences[0].clips.filter((c) => c.source && moved.project.sequences[0].tracks.find((t) => t.id === c.track).role === "base")
  assert.ok(joins.length < clips.length - 1, "but not every cut")
  assert.ok(joins.every((op) => op.kind === "slide" && op.duration === TRANSITION_DEFAULT && op.clip !== clips[0].id))
  const every = await planReel({ project, index: spoken, asset: "a1", ask: defaults, brief: { transition: "slide", transitionAll: true, story, punches: 3 } })
  assert.equal(transitionsOf(every).length, clips.length - 1)
  // The timeline is the same with and without them
  const plain = await planReel({ project, index: spoken, asset: "a1", ask: defaults, brief: { story, punches: 3 } })
  assert.deepEqual(solve(every.project, spoken).picture.map((p) => [p.at, p.end]), solve(plain.project, spoken).picture.map((p) => [p.at, p.end]))
  assert.equal(transitionsOf(plain).length, 0)
})

test("ET-TR-08: chat dresses one cut, with code's length; a remake replays it onto the new clip", () => {
  const made = expandGraphics([{ op: "transition", clip: "c7", kind: "zoom" }, { op: "transition", clip: "c7", kind: "spin" }], { index, person: "" })
  assert.deepEqual(made.ops[0], { op: "transition", clip: "c7", kind: "zoom", duration: TRANSITION_DEFAULT })
  assert.match(made.problems[0], /kind is one of fade, dip/)
  assert.equal(describe(made.ops[0], index), "Added a zoom transition into c7")
  const { project, second } = cut()
  assert.deepEqual(replayable([{ op: "transition", clip: second, kind: "fade", duration: ms(300) }, { op: "transition", clip: "c999", kind: "fade", duration: ms(300) }], project).map((op) => op.clip), [second])
})

test("ET-TR-REG-01: with editing.motion off the plan has no transition, the schema is the object it was, and a make draws none", async () => {
  const { index: spoken, project } = talk()
  const seen = []
  const ask = async ({ task, schema, request, fallback }) => (seen.push({ task, schema, request }), { value: fallback(), source: "default", calls: 0 })
  const plan = await planCut({ ask, project, index: spoken, text: "edit this with slide transitions on every cut" })
  assert.equal(plan.settings.transition, undefined)
  assert.equal(briefOf(plan.settings).transition, undefined)
  const { PLAN_SCHEMA } = await import("../src/edit/director/plan.js")
  assert.equal(seen.find((s) => s.task === "plan").schema, PLAN_SCHEMA)
  assert.doesNotMatch(seen.find((s) => s.task === "plan").request, /You may also set/)
  assert.equal(transitionsOf(await planReel({ project, index: spoken, asset: "a1", ask: defaults, brief: {} })).length, 0)
})
