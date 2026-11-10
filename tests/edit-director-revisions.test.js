import assert from "node:assert/strict"
import { test } from "node:test"

import { commit, createLog, undo } from "../src/edit/core/history.js"
import { apply } from "../src/edit/core/ops.js"
import { solve } from "../src/edit/core/solver.js"
import { editsSince, planDiff, remapIds, storyFor } from "../src/edit/director/continuity.js"
import { carryEdits } from "../src/edit/loop/make.js"
import { planReel } from "../src/edit/recipes/reel.js"
import { makeProject } from "./edit/fixture.js"
import { indexOf, lengthOf } from "./edit/script.js"

// From use (2026-11-10): a change asked for after a cut was made remade the video from the raw
// take: the story was chosen again and the person's own edits were deleted.

const FLICKS = 705_600_000

function talk() {
  const index = indexOf()
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(makeProject(), [], { author: "code" }).project
  const project = apply({ ...base, assets: [{ id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }] }, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index }).project
  return { index, project }
}

/** A model that counts its story calls and drops one candidate line. */
function storyteller(index) {
  const calls = []
  const drop = index.sentences[4].id
  const ask = async ({ task, fallback }) => {
    calls.push(task)
    return task === "story" ? { value: { hook: null, drop: [drop] }, source: "model", calls: 1 } : { value: fallback(), source: "default", calls: 0 }
  }
  return { ask, calls, drop }
}

const played = (project, index) => solve(project, index).picture.filter((p) => !p.hold).map((p) => [p.asset, p.in, p.out])

test("a first make asks for the story and says what it chose", async () => {
  const { index, project } = talk()
  const model = storyteller(index)
  const made = await planReel({ project, index, asset: "a1", ask: model.ask, brief: { captions: "clean" } })
  assert.deepEqual(model.calls.filter((t) => t === "story"), ["story"])
  assert.deepEqual([made.story.hook, made.story.drop], [null, [model.drop]])
  assert.ok(Array.isArray(made.story.emphasis.ids))
})

test("a change of dressing keeps the same cut: the kept story is used and no model is asked", async () => {
  const { index, project } = talk()
  const model = storyteller(index)
  const first = await planReel({ project, index, asset: "a1", ask: model.ask, brief: { captions: "clean" } })
  const never = async ({ task }) => assert.fail(`asked the model for ${task}`)
  const second = await planReel({ project: first.project, index, asset: "a1", ask: never, brief: { captions: "karaoke", grade: "warm", story: first.story } })
  assert.deepEqual(played(second.project, index), played(first.project, index))
  assert.equal(second.slots.story, "kept")
  assert.ok(solve(second.project, index).captions.every((c) => c.look === "karaoke"))
})

test("the story is kept only while the length and the trims are the same", () => {
  const story = { hook: null, drop: ["s2"] }
  const last = { brief: { targetDuration: 30 * FLICKS, cuts: [{ from: 1, to: 2 }], captions: "clean" }, story }
  assert.deepEqual(storyFor(last, { targetDuration: 30 * FLICKS, cuts: [{ from: 1, to: 2 }], captions: "karaoke", music: "generated:calm" }), story)
  assert.equal(storyFor(last, { targetDuration: 20 * FLICKS, cuts: [{ from: 1, to: 2 }] }), null)
  assert.equal(storyFor(last, { targetDuration: 30 * FLICKS }), null)
  assert.equal(storyFor(null, { targetDuration: 30 * FLICKS }), null)
  assert.equal(storyFor({ brief: {} }, {}), null)
})

test("a kept story with ids this footage doesn't have is cleaned, never trusted", async () => {
  const { index, project } = talk()
  const never = async ({ task }) => assert.fail(`asked the model for ${task}`)
  const made = await planReel({ project, index, asset: "a1", ask: never, brief: { story: { hook: "nope", drop: ["also-nope", index.sentences[4].id], emphasis: { most: 3, ids: ["nope"] } }, punches: 3 } })
  assert.deepEqual([made.story.hook, made.story.drop], [null, [index.sentences[4].id]])
})

test("the person's edits since the last make are found on the history, and an undone make has none", () => {
  const { index, project } = talk()
  const ctx = { index }
  let log = createLog(project)
  log = commit(log, { ops: [{ op: "mark", name: "made", at: 0 }], author: "agent", at: "t1" }, ctx).log
  const made = log.head
  const cut = { op: "remove_range", asset: "a1", from: { word: index.words[2].id, edge: "start" }, to: { word: index.words[3].id, edge: "end" } }
  log = commit(log, { ops: [cut], author: "person", at: "t2" }, ctx).log
  log = commit(log, { ops: [{ op: "set_format", width: 1920, height: 1080 }, { op: "mark", name: "note", at: 0 }], author: "agent", at: "t3" }, ctx).log
  // The frame is the plan's to set, so a format change isn't carried
  assert.deepEqual(editsSince(log, made).map((op) => op.op), ["remove_range", "mark"])
  assert.deepEqual(editsSince(log, log.head), [])
  assert.equal(editsSince(undo(undo(undo(log, ctx), ctx), ctx), made), null)
  assert.equal(editsSince(log, "no-such-version"), null)
})

test("edits are replayed on the remade cut, pointed at its new clips; one that no longer fits is listed", async () => {
  const { index, project } = talk()
  const model = storyteller(index)
  const first = await planReel({ project, index, asset: "a1", ask: model.ask, brief: { captions: "clean" } })
  const caption = first.project.sequences[0].clips.find((c) => c.effects.some((e) => e.type === "caption"))
  const kept = solve(first.project, index).picture.find((p) => !p.hold)
  const inside = index.words.filter((w) => w.asset === "a1" && w.start >= kept.in && w.end <= kept.out)
  const edits = [
    { op: "caption_edit", caption: caption.id, text: "Fixed by hand" },
    { op: "remove_range", asset: "a1", from: { word: inside[0].id, edge: "start" }, to: { word: inside[0].id, edge: "end" } },
    { op: "caption_emphasis", caption: caption.id, word: "a1:w999999" },
    // Still on its own track after a remake, and aimed at a clip long gone: neither is replayed
    { op: "add_title", text: "Hello", at: { word: inside[0].id, edge: "start" }, duration: FLICKS },
    { op: "ripple_delete", clip: "c999999" },
  ]
  const second = await planReel({ project: first.project, index, asset: "a1", ask: model.ask, brief: { captions: "clean", grade: "warm", story: first.story } })
  // The remake gave every clip a new id
  assert.ok(!second.project.sequences[0].clips.some((c) => c.id === caption.id))
  const carried = carryEdits(second, edits, { before: first.project, index })
  assert.equal(carried.ops.length, second.ops.length + 2)
  assert.deepEqual(carried.dropped.map((d) => d.op.op), ["caption_emphasis"])
  assert.ok(!carried.ops.some((op) => op.op === "add_title"), "a title that survives a remake isn't added twice")
  assert.ok(solve(carried.project, index).captions.some((c) => c.text === "Fixed by hand"))
  assert.ok(!played(carried.project, index).some(([, from, to]) => inside[0].start >= from && inside[0].end <= to))
  // The whole list still applies from where the make started, so it lands as one entry
  assert.ok(apply(first.project, carried.ops, { index, author: "agent" }).applied)
  // Nothing to carry: the make is what it always was
  assert.equal(carryEdits(second, [], { before: first.project, index }), second)
})

test("old clips are matched to the remade ones: captions by their words, picture by its source", async () => {
  const { index, project } = talk()
  const model = storyteller(index)
  const first = await planReel({ project, index, asset: "a1", ask: model.ask, brief: { captions: "clean" } })
  const second = await planReel({ project: first.project, index, asset: "a1", ask: model.ask, brief: { captions: "clean", story: first.story } })
  const ids = remapIds(first.project, second.project, index)
  const clips = (p) => p.sequences[0].clips
  for (const old of clips(first.project)) {
    const next = clips(second.project).find((c) => c.id === ids.get(old.id))
    if (!next) continue
    if (old.source) assert.equal(next.source.asset, old.source.asset)
    else assert.deepEqual(next.effects[0].words, old.effects[0].words)
  }
  assert.ok(ids.size >= clips(first.project).filter((c) => c.effects.some((e) => e.type === "caption")).length)
  // Footage too: every picture clip of the first cut finds the clip that plays the same stretch (found 2026-11-10: none did)
  const footage = clips(first.project).filter((c) => c.source)
  assert.ok(footage.length > 1 && footage.every((c) => ids.has(c.id)), `${footage.filter((c) => ids.has(c.id)).length} of ${footage.length} footage clips matched`)
  const playedBy = (project) => new Map(solve(project, index).picture.filter((p) => !p.hold).map((p) => [p.clip, p.in]))
  for (const c of footage) assert.equal(playedBy(second.project).get(ids.get(c.id)), playedBy(first.project).get(c.id), "the same stretch of the take")
})

test("what a revised plan changes is said by code, from the two briefs", () => {
  const before = { format: "9:16", captions: "clean", music: "generated:calm", punches: 3 }
  const after = { format: "9:16", captions: "karaoke", grade: "warm", punches: 3 }
  assert.deepEqual(planDiff(before, after), ["Captions: clean → karaoke", "Colour look: none → warm", "Music: calm → none"])
  assert.deepEqual(planDiff(before, before), [])
})
