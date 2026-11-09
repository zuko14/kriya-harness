import assert from "node:assert/strict"
import { test } from "node:test"

import { commit, createLog, checkout, parseEntry, projectAt, replay, undo, versions } from "../src/edit/core/history.js"
import { apply, OPERATIONS, validateOps } from "../src/edit/core/ops.js"
import { hashProject, validateProject } from "../src/edit/core/project.js"
import { deepFreeze, makeIndex, makeProject, ms, prng, randomOp } from "./edit/fixture.js"

const index = makeIndex()
const ctx = { index, author: "agent" }
const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
const clips = (project) => project.sequences[0].clips

/** A project with two base clips (c1: words 0 to 9, c2: words 10 to 19), a song and a caption. */
function seeded() {
  const { project, diagnostics, applied } = apply(
    makeProject(),
    [
      { op: "keep_range", asset: "a1", from: w(0), to: w(9, "end") },
      { op: "keep_range", asset: "a1", from: w(10), to: w(19, "end") },
      { op: "set_music", asset: "m1" },
      { op: "caption_style", look: "bold", words: ["a1:w0", "a1:w1"] },
    ],
    ctx,
  )
  assert.deepEqual(diagnostics, [])
  assert.equal(applied, true)
  return deepFreeze(project)
}

const byId = (project, id) => clips(project).find((c) => c.id === id)
const hasEffect = (project, id, type) => byId(project, id).effects.some((e) => e.type === type)
const effect = (project, id, type) => byId(project, id).effects.find((e) => e.type === type)
const last = (project) => clips(project).at(-1)
const roleOf = (project, clip) => project.sequences[0].tracks.find((t) => t.id === clip.track).role

// op: a valid use and what it must have done; bad: a use refused with this code
const CASES = {
  keep_range: { op: { asset: "a1", from: w(20), to: w(24, "end") }, done: (p) => assert.deepEqual(last(p).source.in, w(20)), bad: [{ asset: "a1", from: w(9), to: w(2) }, "range_inverted"] },
  cold_open: { op: { asset: "a1", from: w(20), to: w(24, "end"), mono: true }, done: (p) => { assert.equal(clips(p)[0].echo, true); assert.equal(clips(p)[0].effects.find((e) => e.type === "grade").saturation, 0) }, bad: [{ asset: "a1", from: w(9), to: w(2) }, "range_inverted"] },
  remove_range: { op: { from: w(3), to: w(5, "end") }, done: (p) => assert.deepEqual(byId(p, "c1").source.out, w(2, "end")), bad: [{ from: w(30), to: w(31, "end") }, "range_not_on_timeline"] },
  use_take: { op: { clip: "c2", from: w(30), to: w(34, "end") }, done: (p) => assert.deepEqual(byId(p, "c2").source.in, w(30)), bad: [{ clip: "nope", from: w(30), to: w(34, "end") }, "unknown_clip"] },
  reorder: { op: { clip: "c2", after: null }, done: (p) => assert.equal(clips(p)[0].id, "c2"), bad: [{ clip: "c3", after: null }, "not_on_base"] },
  trim: { op: { clip: "c1", out: w(8, "end"), audioLag: ms(100) }, done: (p) => { assert.deepEqual(byId(p, "c1").source.out, w(8, "end")); assert.equal(byId(p, "c1").audioLag, ms(100)) }, bad: [{ clip: "c1", in: w(12) }, "range_inverted"] },
  split: { op: { clip: "c1", at: w(5) }, done: (p) => { assert.deepEqual(byId(p, "c1").source.out, { ...w(5), exact: true }); assert.equal(clips(p)[1].source.out.word, "a1:w9") }, bad: [{ clip: "c1", at: w(15) }, "outside_clip"] },
  ripple_delete: { op: { clip: "c2" }, done: (p) => assert.equal(byId(p, "c2"), undefined), bad: [{ clip: "nope" }, "unknown_clip"] },
  punch_in: { op: { at: w(2), scale: 1.12, ease: "snap" }, done: (p) => { assert.deepEqual(last(p).at, w(2)); assert.equal(last(p).effects[0].type, "zoom") }, bad: [{ at: { word: "a1:w9999", edge: "start" }, scale: 1.12 }, "unknown_word"] },
  reframe: { op: { clip: "c1", mode: "subject" }, done: (p) => assert.ok(hasEffect(p, "c1", "reframe")), bad: [{ clip: "c1", mode: "guess" }, "bad_field"] },
  place_broll: { op: { asset: "a2", at: w(2), duration: ms(2000) }, done: (p) => assert.equal(roleOf(p, last(p)), "broll"), bad: [{ asset: "a2", at: w(2), duration: ms(9000) }, "longer_than_source"] },
  speed: { op: { clip: "c1", rate: { n: 2, d: 1 } }, done: (p) => assert.deepEqual(byId(p, "c1").speed, { n: 2, d: 1 }), bad: [{ clip: "c1", rate: 1.5 }, "bad_field"] },
  freeze: { op: { clip: "c1", at: w(3), duration: ms(1000) }, done: (p) => assert.ok(hasEffect(p, "c1", "freeze")), bad: [{ clip: "c1", at: w(15), duration: ms(1000) }, "outside_clip"] },
  transition: { op: { clip: "c2", kind: "dissolve", duration: ms(500) }, done: (p) => assert.ok(hasEffect(p, "c2", "transition")), bad: [{ clip: "c2", kind: "dissolve", duration: 0.5 }, "bad_field"] },
  stabilize: { op: { clip: "c1" }, done: (p) => assert.ok(hasEffect(p, "c1", "stabilize")), bad: [{ clip: "nope" }, "unknown_clip"] },
  set_camera: { op: { clip: "c1", asset: "a2", offset: -ms(1000) }, done: (p) => assert.equal(byId(p, "c1").source.asset, "a2"), bad: [{ clip: "c2", asset: "a2" }, "longer_than_source"] },
  caption_style: { op: { look: "bold", words: ["a1:w5", "a1:w6"] }, done: (p) => assert.deepEqual(last(p).effects[0].words, ["a1:w5", "a1:w6"]), bad: [{ look: "bold", words: ["a1:w5"], placement: { x: 0, y: 5000, w: 100, h: 100 } }, "outside_frame"] },
  caption_edit: { op: { caption: "c4", text: "Corrected" }, done: (p) => assert.equal(effect(p, "c4", "caption").text, "Corrected"), bad: [{ caption: "c1", text: "x" }, "not_a_caption"] },
  caption_emphasis: { op: { caption: "c4", word: "a1:w1" }, done: (p) => assert.deepEqual(effect(p, "c4", "caption").emphasis, ["a1:w1"]), bad: [{ caption: "c4", word: "a1:w7" }, "word_not_in_caption"] },
  add_title: { op: { text: "Fifty", at: w(0), duration: ms(2000) }, done: (p) => assert.equal(last(p).effects[0].variables.text, "Fifty"), bad: [{ text: "x", at: { marker: "nope" }, duration: ms(1) }, "unknown_marker"] },
  add_lower_third: { op: { text: "A Name", subtitle: "A role", at: w(0), duration: ms(2000) }, done: (p) => assert.equal(last(p).effects[0].blockId, "lower-third"), bad: [{ text: "x", at: w(0) }, "needs_duration"] },
  add_motion: { op: { block: "stat-card", version: 1, variables: { value: 50 }, at: w(1), duration: ms(1500) }, done: (p) => assert.equal(last(p).effects[0].blockId, "stat-card"), bad: [{ block: "x", version: 0, variables: {}, at: w(1), duration: 1 }, "bad_field"] },
  add_sfx: { op: { asset: "sfx:whoosh-soft", peak_at: w(3) }, done: (p) => { assert.deepEqual(last(p).at, w(3)); assert.equal(last(p).peak, ms(200)) }, bad: [{ asset: "a9", peak_at: w(3) }, "unknown_asset"] },
  set_music: { op: { asset: "m1", in: ms(1000) }, done: (p) => { assert.equal(clips(p).filter((c) => roleOf(p, c) === "music").length, 1); assert.equal(clips(p).find((c) => roleOf(p, c) === "music").source.in, ms(1000)) }, bad: [{ asset: "a2", in: 0.5 }, "bad_field"] },
  music_shape: { op: { fadeIn: ms(500), fadeOut: ms(2000) }, done: (p) => assert.ok(hasEffect(p, "c3", "fade")), bad: [{ fadeIn: 1.5 }, "bad_field"] },
  duck: { op: { depth: -10, attack: ms(12), release: ms(250) }, done: (p) => assert.equal(effect(p, "c3", "duck").depth, -10), bad: [{ depth: "low" }, "bad_field"] },
  clean_voice: { op: { clip: "c1" }, done: (p) => assert.equal(effect(p, "c1", "eq").preset, "voice-clean"), bad: [{ clip: "c4" }, "no_audio"] },
  set_level: { op: { clip: "c3", db: -6 }, done: (p) => assert.equal(effect(p, "c3", "level").db, -6), bad: [{ clip: "c3", db: "loud" }, "bad_field"] },
  room_tone: { op: { asset: "a1", from: 0, to: ms(900) }, done: (p) => { assert.equal(roleOf(p, last(p)), "ambience"); assert.equal(last(p).loop, true) }, bad: [{ asset: "a1", from: 0, to: ms(999_000) }, "longer_than_source"] },
  grade: { op: { clip: "c1", gamma: 1.1 }, done: (p) => assert.equal(effect(p, "c1", "grade").gamma, 1.1), bad: [{ clip: "c1" }, "needs_a_value"] },
  match_color: { op: { clip: "c1", reference: "c2" }, done: (p) => assert.equal(effect(p, "c1", "grade").match, "c2"), bad: [{ clip: "c1", reference: "nope" }, "unknown_clip"] },
  apply_lut: { op: { clip: "c1", asset: "lut1" }, done: (p) => assert.equal(effect(p, "c1", "lut").asset, "lut1"), bad: [{ clip: "c1", asset: "a2" }, "wrong_asset_kind"] },
  fix_exposure: { op: { clip: "c1", ev: 0.5 }, done: (p) => assert.equal(effect(p, "c1", "grade").ev, 0.5), bad: [{ clip: "c1", ev: "up" }, "bad_field"] },
  set_format: { op: { width: 1920, height: 1080, fps: { n: 24000, d: 1001 } }, done: (p) => assert.equal(p.canvas.width, 1920), bad: [{ width: 1921 }, "bad_format"] },
  add_deliverable: { op: { preset: "reel", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true }, done: (p) => assert.equal(p.deliverables[0].preset, "reel"), bad: [{ preset: "reel" }, "bad_field"] },
  set_look: { op: { caption: { font: "Geist" } }, done: (p) => assert.equal(p.look.caption.font, "Geist"), bad: [{ colour: {} }, "bad_field"] },
  mark: { op: { name: "hook", at: w(4) }, done: (p) => assert.equal(p.sequences[0].markers[0].name, "hook"), bad: [{ name: "x", at: { clip: "nope", edge: "start" } }, "unknown_clip"] },
  name_version: { op: { name: "Cut A" }, done: () => {}, bad: [{ name: "" }, "bad_field"] },
  text_behind: {
    op: { clip: "c4" },
    done: (p) => {
      const matte = p.sequences[0].tracks.find((t) => t.role === "matte")
      const under = p.sequences[0].tracks.find((t) => t.id === clips(p).find((c) => c.id === "c4").track)
      assert.ok(under.order < matte.order, "the caption sits under the matte track")
      assert.equal(last(p).effects[0].type, "matte")
      assert.deepEqual([last(p).at, last(p).until], [clips(p).find((c) => c.id === "c4").at, clips(p).find((c) => c.id === "c4").until])
    },
    bad: [{ clip: "c1" }, "not_text"],
  },
}

test("ET-OPS-01: the case table covers every operation in EDIT_ENGINE §4", () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...OPERATIONS].sort())
  assert.equal(OPERATIONS.length, 39) // 37 edits, text_behind from ED8, cold_open (2026-11-09)
})

for (const [name, { op, done, bad }] of Object.entries(CASES)) {
  test(`ET-OPS-01: ${name} applies, validates, inverts and is atomic`, () => {
    const start = seeded()
    const startHash = hashProject(start)

    const applied = apply(start, [{ op: name, ...op }], ctx)
    assert.deepEqual(applied.diagnostics, [])
    assert.equal(applied.applied, true)
    assert.deepEqual(validateProject(applied.project), [])
    done(applied.project)
    assert.equal(hashProject(start), startHash, "the input isn't touched")

    const [badOp, code] = bad
    const refused = apply(start, [{ op: "mark", name: "first", at: 0 }, { op: name, ...badOp }], ctx)
    assert.equal(refused.applied, false)
    assert.equal(refused.diagnostics[0].code, code, JSON.stringify(refused.diagnostics))
    assert.equal(refused.diagnostics[0].op, 1, "says which operation")
    assert.ok(refused.diagnostics[0].message.length > 10, "a reason a model can act on")
    assert.equal(refused.project, start, "all or nothing")

    const log = commit(createLog(start), { ops: [{ op: name, ...op }], author: "agent", at: "2026-11-07T00:00:00Z" }, ctx)
    assert.equal(log.ok, true)
    assert.equal(hashProject(projectAt(undo(log.log, ctx), null, ctx)), startHash, "undo restores it")
    assert.equal(undo(log.log, ctx).entries.length, 1, "nothing is deleted")
  })
}

test("ET-OPS-01: an unknown op, an extra field and a non-object are refused", () => {
  const start = seeded()
  assert.equal(apply(start, [{ op: "rm_rf" }], ctx).diagnostics[0].code, "unknown_op")
  assert.equal(apply(start, [{ op: "stabilize", clip: "c1", shell: "x" }], ctx).diagnostics[0].code, "bad_field")
  assert.equal(apply(start, ["stabilize"], ctx).diagnostics[0].code, "unknown_op")
  assert.equal(apply(start, [{ op: "__proto__" }], ctx).diagnostics[0].code, "unknown_op")
  assert.equal(apply(start, "nope", ctx).diagnostics[0].code, "unknown_op")
  assert.deepEqual(validateOps(start, [{ op: "stabilize", clip: "c1" }], ctx), [])
})

test("a plain-time split inside a word is refused: a split is one continuous cut", () => {
  const start = seeded()
  assert.equal(apply(start, [{ op: "split", clip: "c1", at: ms(1200) }], ctx).diagnostics[0].code, "cut_inside_word")
  assert.equal(apply(start, [{ op: "split", clip: "c1", at: ms(3700) }], ctx).applied, true)
})

test("a word anchor without an index is refused, not trusted", () => {
  assert.equal(apply(seeded(), [{ op: "mark", name: "x", at: w(1) }]).diagnostics[0].code, "unknown_word")
})

test("a locked track refuses changes to its clips", () => {
  const locked = structuredClone(seeded())
  locked.sequences[0].tracks[0].locked = true
  assert.equal(apply(locked, [{ op: "ripple_delete", clip: "c1" }], ctx).diagnostics[0].code, "track_locked")
})

test("ET-SEC-08's core: a reference asset can't be placed on a track", () => {
  const start = seeded()
  assert.equal(apply(start, [{ op: "keep_range", asset: "ref1", from: 0, to: ms(1000) }], ctx).diagnostics[0].code, "wrong_asset_kind")
  assert.equal(apply(start, [{ op: "place_broll", asset: "ref1", at: 0, duration: ms(1000) }], ctx).diagnostics[0].code, "wrong_asset_kind")
})

test("remove_range cuts the middle out of a clip and keeps both sides", () => {
  const { project } = apply(seeded(), [{ op: "remove_range", from: w(3), to: w(5, "end") }], ctx)
  const base = clips(project).filter((c) => roleOf(project, c) === "base")
  assert.equal(base.length, 3)
  assert.deepEqual(base[0].source, { asset: "a1", in: w(0), out: w(2, "end") })
  assert.deepEqual(base[1].source, { asset: "a1", in: w(6), out: w(9, "end") })
})

test("a removed id is never handed out again", () => {
  const { project } = apply(seeded(), [{ op: "ripple_delete", clip: "c4" }, { op: "stabilize", clip: "c1" }, { op: "caption_style", look: "x", words: ["a1:w2"] }], ctx)
  assert.equal(last(project).id, "c5")
})

test("the operation log: entries, branches and versions", () => {
  const start = seeded()
  const at = "2026-11-07T00:00:00Z"
  const a = commit(createLog(start), { ops: [{ op: "stabilize", clip: "c1" }, { op: "name_version", name: "Cut A" }], author: "person", at, promptRef: "p1" }, ctx)
  const b = commit(a.log, { ops: [{ op: "stabilize", clip: "c2" }], author: "agent", at }, ctx)
  assert.equal(b.log.entries[1].parent, a.log.entries[0].id)

  const undone = undo(b.log, ctx)
  assert.equal(undone.head, a.log.entries[0].id)
  const branch = commit(undone, { ops: [{ op: "reframe", clip: "c2", mode: "subject" }], author: "person", at }, ctx)
  assert.equal(branch.log.entries.length, 3, "new work after undo branches; nothing is lost")
  assert.equal(branch.log.entries[2].parent, a.log.entries[0].id)
  assert.equal(hashProject(projectAt(checkout(branch.log, b.log.entries[1].id, ctx), b.log.entries[1].id, ctx)), b.log.entries[1].hash)

  const list = versions(branch.log)
  assert.equal(list[0].name, "Cut A")
  assert.deepEqual(list[0].opsRange, [0, 2])
  assert.deepEqual(list[1].opsRange, [2, 3])

  const refused = commit(a.log, { ops: [{ op: "ripple_delete", clip: "nope" }], author: "agent", at }, ctx)
  assert.equal(refused.ok, false)
  assert.equal(refused.log, a.log)
  assert.throws(() => checkout(a.log, "nope", ctx), /no version/)
})

test("ops.jsonl lines are validated when read back", () => {
  const { log } = commit(createLog(seeded()), { ops: [{ op: "stabilize", clip: "c1" }], author: "agent", at: "2026-11-07T00:00:00Z" }, ctx)
  const line = JSON.stringify(log.entries[0])
  assert.deepEqual(parseEntry(line).entry, log.entries[0])
  assert.equal(parseEntry("{").ok, false)
  assert.equal(parseEntry(line.replace("stabilize", "rm_rf")).ok, false)
  assert.equal(parseEntry(line.replace('"clip":"c1"', '"clip":"c1","shell":"x"')).ok, false)
  assert.equal(parseEntry(line.replace('"author":"agent"', '"author":"model"')).ok, false)
})

test("ET-OPS-02: any operation sequence keeps the project valid, and undo reaches every version's hash", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const random = prng(seed)
    let log = createLog(seeded())
    let accepted = 0
    for (let step = 0; step < 40; step++) {
      const result = commit(log, { ops: [randomOp(random, log.current), randomOp(random, log.current)], author: "agent", at: `t${step}` }, ctx)
      assert.deepEqual(validateProject(result.project), [], `seed ${seed} step ${step}`)
      if (result.ok) accepted++
      log = result.log
    }
    assert.ok(accepted > 5, `seed ${seed} barely exercised anything`)
    for (const entry of log.entries) assert.equal(hashProject(projectAt(log, entry.id, ctx)), entry.hash, `seed ${seed}`)
    while (log.head) {
      const entry = log.entries.find((e) => e.id === log.head)
      assert.equal(hashProject(log.current), entry.hash)
      log = undo(log, ctx)
    }
    assert.equal(hashProject(log.current), hashProject(log.root))
  }
})

test("ET-OPS-03: replaying the log gives the same hash, and a tampered log is caught", () => {
  const random = prng(7)
  let log = createLog(seeded())
  for (let step = 0; step < 60; step++) log = commit(log, { ops: [randomOp(random, log.current)], author: "code", at: `t${step}` }, ctx).log
  assert.ok(log.entries.length > 10)
  assert.deepEqual(replay(log, ctx), { ok: true, mismatches: [] })

  const entries = structuredClone(log.entries)
  entries[3].hash = "0".repeat(64)
  assert.deepEqual(replay({ ...log, entries }, ctx), { ok: false, mismatches: [entries[3].id] })
})
