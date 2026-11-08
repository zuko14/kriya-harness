import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"

import { audioArgs, escapeFilterValue, segmentArgs } from "../src/edit/core/ffmpeg.js"
import { handoffManifest, toEdl, toFcpxml, toOtio, toSrt, toVtt } from "../src/edit/core/handoff.js"
import { apply } from "../src/edit/core/ops.js"
import { compile, wholeSegment } from "../src/edit/core/plan.js"
import { canonical, serialize } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { FLICKS, frameFlicks } from "../src/edit/core/time.js"
import { toneMapCube } from "../src/edit/core/tonemap.js"
import { makeIndex, makeProject, ms, prng, randomOp } from "./edit/fixture.js"

const index = makeIndex()
const ctx = { index, author: "agent" }
const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
const VERSIONS = { engineVersion: "core-1", runtimeVersion: "rt-1" }
const done = (project, ops) => {
  const result = apply(project, ops, ctx)
  assert.deepEqual(result.diagnostics, [])
  return result.project
}

function reel() {
  return done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(14, "end") },
    { op: "keep_range", asset: "a1", from: w(20), to: w(34, "end") },
    { op: "caption_style", look: "bold", words: ["a1:w0", "a1:w1", "a1:w2"] },
    { op: "caption_style", look: "bold", words: ["a1:w30", "a1:w31"] },
    { op: "punch_in", at: w(5), duration: ms(1000), scale: 1.12, ease: "snap" },
    { op: "place_broll", asset: "a2", at: w(22), duration: ms(1500) },
    { op: "add_title", text: "Fifty", at: w(0), duration: ms(1000) },
    { op: "add_sfx", asset: "sfx:whoosh-soft", peak_at: w(5) },
    { op: "set_music", asset: "m1" },
    { op: "duck", depth: -10, attack: ms(12), release: ms(250) },
  ])
}

const keys = (plan) => plan.segments.map((s) => s.key)
const changed = (a, b) => keys(a).filter((key) => !keys(b).includes(key))

test("ET-CMP-01: the same project gives a byte-identical plan, pinned by a golden file", () => {
  const plan = compile(reel(), index, VERSIONS)
  assert.equal(canonical(plan), canonical(compile(reel(), index, VERSIONS)))
  const shuffled = JSON.parse(JSON.stringify(reel()), (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))
  assert.equal(canonical(plan), canonical(compile(shuffled, index, VERSIONS)))
  assert.equal(serialize(plan), readFileSync(new URL("./edit/renderplan.golden.json", import.meta.url), "utf8"))
})

test("the plan covers the timeline: no gap, no overlap, segments on frames and at most about six seconds", () => {
  const plan = compile(reel(), index, VERSIONS)
  const frame = frameFlicks({ n: 30, d: 1 })
  let cursor = 0
  for (const segment of plan.segments) {
    assert.equal(segment.start, cursor)
    assert.ok(segment.end > segment.start)
    assert.equal(segment.start % frame, 0)
    assert.ok(segment.end - segment.start <= 6 * FLICKS + frame)
    assert.ok(segment.node.picture.length > 0)
    cursor = segment.end
  }
  assert.equal(cursor, plan.duration)
  assert.ok(plan.audio.items.every((item) => item.role), "audio never lives in segments")
  assert.equal(JSON.stringify(plan.segments).includes('"audio"'), false)
})

test("a draft is 720p from proxies; a master is the deliverable from sources", () => {
  const project = done(reel(), [{ op: "add_deliverable", preset: "reel", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true }])
  const draft = compile(project, index, VERSIONS)
  const master = compile(project, index, { ...VERSIONS, quality: "master", deliverable: project.deliverables[0].id })
  assert.deepEqual([draft.output.width, draft.output.height, draft.input], [720, 1280, "proxy"])
  assert.deepEqual([master.output.width, master.output.height, master.input], [1080, 1920, "source"])
  assert.throws(() => compile(project, index, { ...VERSIONS, quality: "master", deliverable: "nope" }), /no deliverable/)
  assert.throws(() => compile(project, index, { runtimeVersion: "x" }), /engineVersion/)
})

test("reframe: a subject track becomes a crop path in the plan; no track is reported", () => {
  const wide = structuredClone(
    done(makeProject(), [
      { op: "keep_range", asset: "a1", from: w(0), to: w(4, "end") },
      { op: "reframe", clip: "c1", mode: "subject" },
    ]),
  )
  wide.assets[0].facts = { ...wide.assets[0].facts, width: 1920, height: 1080 }
  const subjects = { a1: [{ shot: "a1:s0", t: ms(1000), x: 400 }, { shot: "a1:s0", t: ms(2000), x: 400 }, { shot: "a1:s0", t: ms(3000), x: 400 }] }
  const plan = compile(wide, { ...index, subjects }, VERSIONS)
  const crop = plan.segments[0].node.picture[0].crop
  assert.ok(crop.length >= 2)
  assert.ok(crop.every((point) => point.x === 400 - 304))
  assert.ok(compile(wide, index, VERSIONS).issues.some((i) => i.code === "no_subject_track"))
})

test("any project operations can reach solves, compiles and exports, with every time whole", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const random = prng(seed)
    let project = reel()
    for (let step = 0; step < 40; step++) {
      project = apply(project, [randomOp(random, project)], ctx).project
      const plan = compile(project, index, VERSIONS)
      assert.equal(canonical(plan), canonical(compile(project, index, VERSIONS)), `seed ${seed}`)
      let cursor = 0
      for (const segment of plan.segments) {
        assert.equal(segment.start, cursor)
        cursor = segment.end
      }
      assert.equal(cursor, plan.duration)
      const timeline = solve(project, index)
      for (const item of [...timeline.picture, ...timeline.audio, ...timeline.overlays, ...timeline.captions, ...timeline.zooms]) {
        assert.ok(Number.isSafeInteger(item.at) && Number.isSafeInteger(item.end) && item.at >= 0 && item.end > item.at, JSON.stringify(item))
      }
      JSON.parse(toOtio(project, timeline))
      toFcpxml(project, timeline)
      toEdl(project, timeline)
      toSrt(timeline)
    }
  }
})

test("ET-CMP-03: cache keys change when, and only when, an input changes", () => {
  const plan = compile(reel(), index, VERSIONS)
  const same = (other) => assert.deepEqual(keys(other), keys(plan))

  // Nothing that reaches a pixel changed
  const renamed = structuredClone(reel())
  renamed.name = "Another name"
  same(compile(renamed, index, VERSIONS))
  const extra = structuredClone(reel())
  extra.assets.push({ ...extra.assets[1], id: "a3", fingerprint: "fp-a3" })
  same(compile(extra, index, VERSIONS))
  const moved = structuredClone(reel())
  moved.assets[0].path = "elsewhere/same-file.mov"
  same(compile(moved, index, VERSIONS))

  // A source's content: only the segments that read it
  const newBroll = structuredClone(reel())
  newBroll.assets[1].fingerprint = "fp-a2-new"
  const after = compile(newBroll, index, VERSIONS)
  const touched = plan.segments.filter((s) => s.node.overlays.some((o) => o.asset === "a2"))
  assert.ok(touched.length > 0 && touched.length < plan.segments.length)
  assert.deepEqual(changed(plan, after).sort(), touched.map((s) => s.key).sort())

  // Engine, runtime and output settings: everything
  for (const other of [compile(reel(), index, { ...VERSIONS, engineVersion: "core-2" }), compile(reel(), index, { ...VERSIONS, runtimeVersion: "rt-2" }), compile(reel(), index, { ...VERSIONS, quality: "master" })]) {
    assert.equal(changed(plan, other).length, plan.segments.length)
  }

  // An audio-only change leaves the picture alone
  const music = reel().sequences[0].clips.find((c) => c.source?.asset === "m1")
  const louder = compile(done(reel(), [{ op: "set_level", clip: music.id, db: -3 }]), index, VERSIONS)
  same(louder)
  assert.equal(louder.keys.picture, plan.keys.picture)
  assert.notEqual(louder.keys.audio, plan.keys.audio)
})

test("ET-CMP-03: cutting a sentence keeps the keys of segments it didn't touch", () => {
  const before = compile(done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(0), to: w(4, "end") }, { op: "keep_range", asset: "a1", from: w(10), to: w(14, "end") }, { op: "keep_range", asset: "a1", from: w(20), to: w(24, "end") }]), index, VERSIONS)
  const after = compile(done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(0), to: w(4, "end") }, { op: "keep_range", asset: "a1", from: w(20), to: w(24, "end") }]), index, VERSIONS)
  assert.equal(changed(after, before).length, 0, "every remaining segment comes from the cache, wherever it moved")
  assert.equal(changed(before, after).length, 1)
})

test("ET-CMP-04: a caption change invalidates only the segments it touches", () => {
  const plan = compile(reel(), index, VERSIONS)
  const caption = plan.tiles.find((t) => t.kind === "caption" && t.at > ms(5000))
  const touched = plan.segments.filter((s) => s.start < caption.end && caption.at < s.end)
  assert.ok(touched.length >= 1 && touched.length < plan.segments.length)

  const edited = compile(done(reel(), [{ op: "caption_edit", caption: "c4", text: "Corrected words" }]), index, VERSIONS)
  assert.deepEqual(changed(plan, edited).sort(), touched.map((s) => s.key).sort())
  assert.equal(edited.keys.picture, plan.keys.picture)
  assert.equal(edited.keys.audio, plan.keys.audio)
  assert.notEqual(edited.keys.caption, plan.keys.caption)
  const tileChanges = edited.tiles.filter((t) => !plan.tiles.some((p) => p.key === t.key))
  assert.equal(tileChanges.length, 1, "one tile re-renders")
})

// A small model of FFmpeg's two escaping levels, written from its documentation
function splitTop(text, separators) {
  const parts = [""]
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "\\" && !quoted) {
      parts[parts.length - 1] += c + (text[++i] ?? "")
    } else if (c === "'") {
      quoted = !quoted
      parts[parts.length - 1] += c
    } else if (!quoted && separators.includes(c)) parts.push("")
    else parts[parts.length - 1] += c
  }
  return parts
}
function unescapeLevel(text) {
  let out = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "'") quoted = !quoted
    else if (c === "\\" && !quoted) out += text[++i] ?? ""
    else out += c
  }
  return out
}

test("ET-CMP-02: no shell or filter metacharacter reaches an argument unescaped (fuzzed text)", () => {
  const nasty = ["'", '"', "\\", ":", ";", ",", "[", "]", "=", "%", "$", "`", "|", "&", ">", "<", "\n", " ", "$(id)", "';drop", "%{pts}", "--", "-i", "\u0000", "ü", "తె"]
  const random = prng(17)
  for (let round = 0; round < 300; round++) {
    let text = ""
    for (let i = 0; i < 1 + Math.floor(random() * 12); i++) text += nasty[Math.floor(random() * nasty.length)]
    const clean = text.replaceAll("\u0000", "")

    const value = escapeFilterValue(text)
    assert.equal(unescapeLevel(unescapeLevel(value)), clean, JSON.stringify(text))
    assert.equal(splitTop(value, ",;[]").length, 1, "filtergraph level sees one value")
    assert.equal(splitTop(unescapeLevel(value), ":").length, 1, "option level sees one value")

    const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(0), to: w(4, "end") }, { op: "set_look", caption: { burn: true } }, { op: "caption_style", look: "bold", words: ["a1:w0"] }, { op: "caption_edit", caption: "c2", text }])
    const plan = compile(project, index, VERSIONS)
    const args = segmentArgs(plan, plan.segments[0], { input: () => `/media/${clean}.mov`, tile: () => "/t.mov", output: "/out/seg.mov", encoder: ["-c:v", "libx264"] })
    assert.ok(args.every((arg) => typeof arg === "string"))
    assert.ok(args.every((arg) => !arg.includes("\u0000")))
    const graph = args[args.indexOf("-filter_complex") + 1]
    assert.equal(splitTop(graph, ";").length, 2, "text can't start a new filter chain")
    assert.ok(graph.includes(`text=${escapeFilterValue(text)}`))
    assert.equal(args.filter((a) => a === "-i").length, 1, "text can't add an input")
  }
})

test("ED4: every picture input seeks; output is tagged BT.709; a source's colour is normalised first", () => {
  const io = { input: () => "/a.mov", tile: () => "/t.mov", output: "/o.mov", encoder: [] }
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") }])
  const plan = compile(project, index, VERSIONS)
  const args = segmentArgs(plan, plan.segments[0], io)
  assert.equal(args[args.indexOf("-ss") + 1], (plan.segments[0].node.picture[0].in / FLICKS).toFixed(9))
  assert.deepEqual(args.slice(args.indexOf("-colorspace"), args.indexOf("-colorspace") + 2), ["-colorspace", "bt709"])

  const untagged = structuredClone(project)
  untagged.assets[0].facts.color = { primaries: "unknown", transfer: "unknown", range: "unknown", tagged: false, hdr: false }
  const master = compile(untagged, index, { ...VERSIONS, quality: "master" })
  const graph = (a) => a[a.indexOf("-filter_complex") + 1]
  const early = /setpts=PTS-STARTPTS,setparams=color_primaries=bt709/
  assert.match(graph(segmentArgs(master, master.segments[0], io)), early, "EX-10: tags come before anything reads the picture")
  assert.doesNotMatch(graph(segmentArgs(compile(untagged, index, VERSIONS), compile(untagged, index, VERSIONS).segments[0], io)), early, "a proxy is normalised already")

  const hdr = structuredClone(project)
  hdr.assets[0].facts.color = { primaries: "bt2020", transfer: "smpte2084", range: "tv", tagged: true, hdr: true }
  const hdrMaster = compile(hdr, index, { ...VERSIONS, quality: "master" })
  assert.throws(() => segmentArgs(hdrMaster, hdrMaster.segments[0], io), /tone-map/, "no LUT, no silent wrong colours")
  const mapped = graph(segmentArgs(hdrMaster, hdrMaster.segments[0], { ...io, toneMap: (transfer) => `/lut/${transfer}.cube` }))
  assert.match(mapped, /in_color_matrix=bt2020/)
  assert.match(mapped, /lut3d=file=\/lut\/smpte2084\.cube/)
})

test("ED4: add_asset is the Host's alone: code may add a probed file, an agent or a person can't", () => {
  const start = makeProject()
  const op = { op: "add_asset", id: "a9", kind: "video", fingerprint: "fp", path: "media/new.mov", linked: true, rights: "unknown", facts: { duration: ms(1000) } }
  for (const author of ["agent", "person"]) assert.equal(apply(start, [op], { author }).diagnostics[0].code, "code_only")
  const added = apply(start, [op], { author: "code" })
  assert.deepEqual(added.diagnostics, [])
  assert.equal(added.project.assets.at(-1).id, "a9")
  assert.equal(apply(added.project, [op], { author: "code" }).diagnostics[0].code, "duplicate_asset")
  assert.equal(apply(start, [{ ...op, facts: { duration: 1.5 } }], { author: "code" }).diagnostics[0].code, "bad_field")
})

test("ED4: a master is one continuous encode of the same picture, from sources", () => {
  const project = done(reel(), [{ op: "add_deliverable", preset: "reel", size: { width: 1080, height: 1920 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: true }])
  const plan = compile(project, index, { ...VERSIONS, quality: "master", deliverable: project.deliverables[0].id })
  const whole = wholeSegment(plan)
  assert.deepEqual([whole.start, whole.end], [0, plan.duration])
  assert.equal(whole.node.picture.length, plan.segments.reduce((sum, s) => sum + s.node.picture.length, 0))
  assert.equal(whole.node.picture[1].at, plan.segments[1].start, "times are the timeline's again")
  assert.equal(new Set(whole.node.tiles.map((t) => t.key)).size, whole.node.tiles.length, "a tile spanning segments appears once")
  const args = segmentArgs(plan, whole, { input: (asset) => `/media/${asset}.mov`, tile: (key) => `/tiles/${key}.mov`, output: "/o.mov", encoder: [] })
  assert.ok(args.includes("/media/a1.mov"))
})

test("ED4: the audio mix: one pass, 48 kHz, a short fade at every cut, placed by sample", () => {
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") }, { op: "keep_range", asset: "a1", from: w(15), to: w(19, "end") }, { op: "set_music", asset: "m1" }, { op: "set_level", clip: "c3", db: -6 }])
  const plan = compile(project, index, VERSIONS)
  const args = audioArgs(plan, { input: (asset) => `/media/${asset}.mov`, output: "/o.m4a", encoder: ["-c:a", "aac"] })
  const graph = args[args.indexOf("-filter_complex") + 1]
  assert.equal((graph.match(/afade=t=in/g) ?? []).length, 3)
  assert.match(graph, /adelay=delays=\d+S:all=1/)
  assert.match(graph, /volume=volume=-6dB/)
  assert.match(graph, /amix=inputs=3:normalize=0/)
  assert.equal(args.at(-1), "/o.m4a")
  // ED9: the duck renders, band-split, from its gain curve; without the curve it is refused, never skipped
  const ducked = compile(done(project, [{ op: "duck", depth: -10 }]), index, VERSIONS)
  assert.throws(() => audioArgs(ducked, { input: () => "/a", output: "/o", encoder: [] }), /gain curve/)
  const duckGraph = audioArgs(ducked, { input: () => "/a", output: "/o", encoder: [], envelope: "/env.f32" })
  assert.match(duckGraph[duckGraph.indexOf("-filter_complex") + 1], /acrossover=split=300\\\\\\ 3500\[lo\]\[mid\]\[hi\];\[mid\]\[env\]amultiply/)
  const silent = compile(done(makeProject(), [{ op: "keep_range", asset: "lut1", from: 0, to: ms(1000) }].slice(1)), index, VERSIONS)
  assert.ok(audioArgs(silent, { input: () => "/a", output: "/o", encoder: [] }).includes("anullsrc=r=48000:cl=stereo"))
})

test("ED4: the tone-mapping LUT is a valid .cube that keeps black, diffuse white and neutral greys", () => {
  for (const transfer of ["smpte2084", "arib-std-b67"]) {
    const lines = toneMapCube(transfer, 9).split("\n").filter(Boolean)
    assert.equal(lines[0], "LUT_3D_SIZE 9")
    const rows = lines.slice(1).map((line) => line.split(" ").map(Number))
    assert.equal(rows.length, 9 ** 3)
    assert.ok(rows.flat().every((v) => v >= 0 && v <= 1))
    assert.deepEqual(rows[0], [0, 0, 0], "black stays black")
    const neutral = rows[(9 ** 3 - 1) / 2]
    assert.ok(Math.abs(neutral[0] - neutral[1]) < 1e-6 && Math.abs(neutral[1] - neutral[2]) < 1e-6, "a neutral grey stays neutral")
    const greys = Array.from({ length: 9 }, (_, i) => rows[i * (81 + 9 + 1)][0])
    assert.deepEqual(greys, [...greys].sort((a, b) => a - b), "brightness order is kept")
  }
  assert.throws(() => toneMapCube("bt709"), /HDR transfer/)
})

test("ET-CMP-02: the fixed rules of §8.1 hold on every argument list", () => {
  const plan = compile(reel(), index, VERSIONS)
  for (const segment of plan.segments) {
    const args = segmentArgs(plan, segment, { input: (asset) => `/media/${asset}.mov`, tile: (key) => `/tiles/${key}.mov`, output: "/out/seg.mov", encoder: ["-c:v", "libx264"] })
    assert.deepEqual(args.slice(0, 2), ["-nostdin", "-hide_banner"])
    const inputs = args.flatMap((arg, i) => (arg === "-i" ? [i] : []))
    assert.ok(inputs.length > 0)
    for (const i of inputs) {
      assert.deepEqual(args.slice(i - 2, i), ["-protocol_whitelist", "file,pipe"])
      assert.ok(args[i + 1].startsWith("/"), "inputs are absolute paths")
    }
    assert.equal(args.at(-1), "/out/seg.mov")
    assert.ok(args.includes("-an"), "audio never lives in segments")
  }
  assert.throws(() => segmentArgs(plan, plan.segments[0], { input: () => "relative.mov", tile: () => "/t", output: "/o", encoder: [] }), /absolute/)
})

test("a tile that started in an earlier segment seeks into itself; an effect the builder can't render is refused", () => {
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(0), to: w(14, "end") }, { op: "add_title", text: "Long", at: 0, duration: ms(7000) }])
  const plan = compile(project, index, VERSIONS)
  const later = plan.segments.find((s) => s.start > 0 && s.node.tiles.length)
  const io = { input: () => "/a.mov", tile: () => "/t.mov", output: "/o.mov", encoder: [] }
  const graph = (args) => args[args.indexOf("-filter_complex") + 1]
  assert.match(graph(segmentArgs(plan, later, io)), new RegExp(`trim=start=${(later.start / FLICKS).toFixed(3)}`))

  const stable = compile(done(project, [{ op: "stabilize", clip: "c1" }]), index, VERSIONS)
  assert.throws(() => segmentArgs(stable, stable.segments[0], io), /stabilize/)
  const graded = compile(done(project, [{ op: "grade", clip: "c1", lift: 0.1, gain: 1.2, gamma: 1.1 }]), index, VERSIONS)
  assert.match(graph(segmentArgs(graded, graded.segments[0], io)), /eq=gamma=1\.1:brightness=0\.1:contrast=1\.2/)
  const matched = compile(done(project, [{ op: "match_color", clip: "c1", reference: "c1" }]), index, VERSIONS)
  // ED13: a colour match renders through its baked .cube, keyed by both ranges
  const match = matched.segments[0].node.picture[0].effects.find((e) => e.type === "grade").match
  assert.deepEqual([match.from.asset, match.to.asset], ["a1", "a1"])
  assert.match(graph(segmentArgs(matched, matched.segments[0], { ...io, input: (id) => `/in/${id}` })), new RegExp(`lut3d=file=/in/${match.key}`))
})

test("a held frame seeks first, then keeps one frame: FFmpeg counts end_frame from the input's start", () => {
  const project = done(makeProject(), [{ op: "keep_range", asset: "a1", from: w(5), to: w(9, "end") }, { op: "freeze", clip: "c1", at: w(7), duration: ms(1000) }])
  const plan = compile(project, index, VERSIONS)
  const held = plan.segments.find((s) => s.node.picture.some((p) => p.hold))
  const args = segmentArgs(plan, held, { input: () => "/a.mov", tile: () => "/t.mov", output: "/o.mov", encoder: [] })
  assert.match(args[args.indexOf("-filter_complex") + 1], /\[0:v\]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1\.0/)
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "it seeks at the input, so a long file isn't decoded from its start")
})

// Each format read back by a parser written from its specification

function parseOtio(text) {
  const doc = JSON.parse(text)
  assert.equal(doc.OTIO_SCHEMA, "Timeline.1")
  assert.equal(doc.tracks.OTIO_SCHEMA, "Stack.1")
  const flicks = ({ value, rate }) => Math.round((value * FLICKS) / rate)
  return doc.tracks.children.map((track) => {
    assert.equal(track.OTIO_SCHEMA, "Track.1")
    let cursor = 0
    const clips = []
    for (const item of track.children) {
      const duration = flicks(item.source_range.duration)
      if (item.OTIO_SCHEMA === "Clip.2") {
        const media = item.media_references[item.active_media_reference_key]
        assert.equal(media.OTIO_SCHEMA, "ExternalReference.1")
        clips.push({ name: item.name, at: cursor, in: flicks(item.source_range.start_time), duration, url: media.target_url, effects: item.effects.map((e) => e.OTIO_SCHEMA) })
      } else assert.equal(item.OTIO_SCHEMA, "Gap.1")
      cursor += duration
    }
    return { name: track.name, kind: track.kind, clips }
  })
}

function parseFcpxml(text) {
  const seconds = (value) => {
    const [n, d = "1"] = value.replace(/s$/, "").split("/")
    return (Number(n) * FLICKS) / Number(d)
  }
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))
  const assets = [...text.matchAll(/<asset [^>]*>/g)].map(([tag]) => attrs(tag))
  const spine = text.slice(text.indexOf("<spine>"), text.indexOf("</spine>"))
  const clips = [...spine.matchAll(/<asset-clip [^>]*>/g)]
    .map(([tag]) => attrs(tag))
    .filter((clip) => clip.lane === undefined)
    .map((clip) => ({ ...clip, offsetF: seconds(clip.offset), startF: seconds(clip.start), durationF: seconds(clip.duration) }))
  return { version: attrs(text.match(/<fcpxml [^>]*>/)[0]).version, assets, clips, sequence: attrs(text.match(/<sequence [^>]*>/)[0]) }
}

function parseEdl(text) {
  const lines = text.split("\n")
  const frames = (tc) => {
    const [h, m, s, f] = tc.split(":").map(Number)
    return ((h * 60 + m) * 60 + s) * 30 + f
  }
  const events = []
  for (const line of lines) {
    const match = line.match(/^(\d{3})\s+(\S{1,8})\s+(\S+)\s+C\s+(\S+) (\S+) (\S+) (\S+)$/)
    if (match) events.push({ number: match[1], reel: match[2], channels: match[3], srcIn: frames(match[4]), srcOut: frames(match[5]), recIn: frames(match[6]), recOut: frames(match[7]) })
    else if (line.startsWith("* FROM CLIP NAME: ")) events.at(-1).name = line.slice(18)
  }
  return { title: lines[0].replace("TITLE: ", ""), fcm: lines[1], events }
}

function parseSrt(text) {
  const time = (t) => {
    const [h, m, rest] = t.split(":")
    const [s, milli] = rest.split(/[,.]/)
    return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(milli)
  }
  return text
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n")
      const [from, to] = lines[1].split(" --> ")
      return { number: Number(lines[0]), from: time(from), to: time(to), text: lines.slice(2).join("\n") }
    })
}

test("ET-INT-01: OTIO round-trips: every clip, track and frame comes back", () => {
  const project = reel()
  const timeline = solve(project, index)
  const tracks = parseOtio(toOtio(project, timeline))
  const video = tracks.find((t) => t.name === "base")
  assert.equal(video.kind, "Video")
  assert.deepEqual(video.clips.map(({ at, in: start, duration }) => ({ at, in: start, duration })), timeline.picture.map((p) => ({ at: p.at, in: p.in, duration: p.end - p.at })))
  assert.equal(video.clips[0].url, "media/a1.mov")
  const broll = tracks.find((t) => t.name === "broll")
  assert.equal(broll.clips[0].at, timeline.overlays.find((o) => o.asset === "a2").at, "a gap keeps it in place")
  const audio = tracks.filter((t) => t.kind === "Audio").flatMap((t) => t.clips)
  assert.equal(audio.length, timeline.audio.length)
})

test("ET-INT-01: OTIO is exact at 23.976, where a frame isn't a round number", () => {
  const project = done(makeProject(), [{ op: "set_format", fps: { n: 24000, d: 1001 } }, { op: "keep_range", asset: "a1", from: w(0), to: w(9, "end") }])
  const timeline = solve(project, index)
  const [track] = parseOtio(toOtio(project, timeline))
  assert.equal(track.clips[0].duration, timeline.picture[0].end - timeline.picture[0].at)
})

test("ET-INT-01: speed and freeze reach OTIO as its own effects; FCPXML and EDL list them as not carried", () => {
  const project = done(makeProject(), [
    { op: "keep_range", asset: "a1", from: w(0), to: w(9, "end") },
    { op: "speed", clip: "c1", rate: { n: 2, d: 1 } },
    { op: "freeze", clip: "c1", at: w(5), duration: ms(1000) },
  ])
  const timeline = solve(project, index)
  const video = parseOtio(toOtio(project, timeline)).find((t) => t.name === "base")
  assert.deepEqual(video.clips.map((c) => c.effects), [["LinearTimeWarp.1"], ["FreezeFrame.1"], ["LinearTimeWarp.1"]])
  for (const { omitted } of [toFcpxml(project, timeline), toEdl(project, timeline)]) {
    assert.ok(omitted.some((item) => item.clip === "c1" && /speed/.test(item.reason)))
    assert.ok(omitted.some((item) => item.clip === "c1" && /freeze/.test(item.reason)))
  }
})

test("ET-INT-01: FCPXML round-trips, is well formed, and escapes names", () => {
  const project = structuredClone(reel())
  project.name = `Cut "A" <final> & more`
  const timeline = solve(project, index)
  const { text, omitted } = toFcpxml(project, timeline)
  assert.ok(omitted.every((item) => item.clip && item.reason))
  const parsed = parseFcpxml(text)
  assert.equal(parsed.version, "1.10")
  assert.equal(parsed.clips.length, timeline.picture.length)
  parsed.clips.forEach((clip, i) => {
    assert.equal(clip.offsetF, timeline.picture[i].at)
    assert.equal(clip.startF, timeline.picture[i].in)
    assert.equal(clip.durationF, timeline.picture[i].end - timeline.picture[i].at)
  })
  assert.equal(parsed.sequence.tcFormat, "NDF")
  assert.ok(text.includes("Cut &quot;A&quot; &lt;final&gt; &amp; more"))
  assert.match(text, /<asset-clip [^>]*lane="1"/, "B-roll is connected above the spine")
  assert.match(text, /<asset-clip [^>]*lane="-1"/, "music and sound below it")

  try {
    execFileSync("xmllint", ["--noout", "-"], { input: text, stdio: ["pipe", "pipe", "pipe"] })
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
})

test("ET-INT-01: EDL round-trips the cuts, and lists what it can't carry", () => {
  const project = reel()
  const timeline = solve(project, index)
  const { text, omitted } = toEdl(project, timeline)
  const parsed = parseEdl(text)
  assert.equal(parsed.fcm, "FCM: NON-DROP FRAME")
  assert.equal(parsed.events.length, timeline.picture.length)
  const frame = frameFlicks({ n: 30, d: 1 })
  parsed.events.forEach((event, i) => {
    const piece = timeline.picture[i]
    assert.equal(event.number, String(i + 1).padStart(3, "0"))
    assert.equal(event.reel, "A1")
    assert.equal(event.srcIn, piece.in / frame)
    assert.equal(event.recIn - 30 * 3600, piece.at / frame)
    assert.equal(event.recOut - event.recIn, event.srcOut - event.srcIn)
    assert.equal(event.name, "a1.mov")
  })
  assert.ok(omitted.length >= 3, "B-roll, titles and music don't fit an EDL, and are listed")
  assert.ok(omitted.every((item) => item.clip && item.reason))
})

test("ET-INT-01: SRT and VTT round-trip, on the output timeline", () => {
  const project = done(reel(), [{ op: "caption_edit", caption: "c3", text: "A <b>corrected</b> line\n\nwith a gap --> here" }])
  const timeline = solve(project, index)
  const cues = parseSrt(toSrt(timeline))
  assert.equal(cues.length, timeline.captions.length)
  cues.forEach((cue, i) => {
    assert.equal(cue.number, i + 1)
    assert.equal(cue.from, Math.round(timeline.captions[i].at / 705_600))
    assert.equal(cue.to, Math.round(timeline.captions[i].end / 705_600))
  })
  assert.equal(cues[0].text, "A <b>corrected</b> line\nwith a gap --> here", "a blank line would end the cue")
  assert.equal(cues[1].text, "word30 word31")

  const vtt = toVtt(timeline)
  assert.ok(vtt.startsWith("WEBVTT\n\n"))
  assert.equal(vtt.match(/ --> \d/g).length, cues.length)
  assert.ok(vtt.includes("A &lt;b&gt;corrected&lt;/b&gt; line\nwith a gap --&gt; here"))
})

test("handoff paths are relative, and a manifest lists what to relink", () => {
  const project = structuredClone(reel())
  project.assets[0].path = "/Users/someone/Footage/take one.mov"
  const timeline = solve(project, index)
  const [track] = parseOtio(toOtio(project, timeline))
  assert.equal(track.clips[0].url, "media/take one.mov")
  assert.ok(!toFcpxml(project, timeline).text.includes("/Users/"))
  const manifest = handoffManifest(project, timeline)
  assert.deepEqual(manifest.find((m) => m.asset === "a1"), { asset: "a1", path: "media/take one.mov", fingerprint: "fp-a1" })
  assert.ok(manifest.every((m) => !m.path.startsWith("/")))
  assert.equal(manifest.some((m) => m.asset === "ref1"), false, "only what the timeline uses")
})

test("ET-IMP-01: Edit Core imports nothing but itself and node:crypto, and nothing outside src/edit imports it", () => {
  const root = new URL("../", import.meta.url)
  const IMPORT = /\b(?:import|export)\s[^"'`]*?from\s*["'`]([^"'`]+)|\bimport\s*\(\s*["'`]([^"'`]+)|\bimport\s*["'`]([^"'`]+)|\brequire\s*\(\s*["'`]([^"'`]+)/g
  const walk = (dir) => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "node_modules" ? [] : walk(`${dir}${entry.name}/`)) : [`${dir}${entry.name}`]))
  const core = walk("src/edit/core/").filter((file) => file.endsWith(".js"))
  assert.ok(core.length >= 10)
  for (const file of core) {
    const source = readFileSync(new URL(file, root), "utf8")
    for (const match of source.matchAll(IMPORT)) {
      const target = match[1] ?? match[2] ?? match[3] ?? match[4]
      assert.ok(target.startsWith("./") || target === "node:crypto", `${file} imports ${target}`)
    }
    assert.doesNotMatch(source, /\b(process\.|Date\.now|new Date|Math\.random|fetch\(|setTimeout|performance\.)/, `${file} reaches outside pure code`)
  }
  for (const dir of ["src/", "bin/", "plugins/", "scripts/"]) {
    for (const file of walk(dir).filter((f) => /\.(js|mjs|cjs)$/.test(f) && !f.startsWith("src/edit/") && !f.endsWith(".bundle.js"))) {
      assert.doesNotMatch(readFileSync(new URL(file, root), "utf8"), /["'`][^"'`]*\/edit\/core[^"'`]*["'`]/, `${file} must not import Edit Core`)
    }
  }
})
