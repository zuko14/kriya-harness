import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { handoffManifest, timelineMarkers, toFcpxml, toOtio } from "../src/edit/core/handoff.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { newProject } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { writeHandoff } from "../src/edit/host/deliver.js"
import { chapterList, chapters, chapterTime, sentencesOf, storyTree } from "../src/edit/index/story.js"
import { activity, PODCAST_MULTICAM, planMulticam, reactionCuts, switchShots, SYNC_RATE, syncPair } from "../src/edit/recipes/multicam.js"
import { pictureChanges, planLongform, YOUTUBE_LONGFORM } from "../src/edit/recipes/youtube.js"
import { prng } from "./edit/fixture.js"
import { longTalk } from "./edit/talk.js"

// ED12: long form. The story tree and chapters, multi-camera sync and switching, the
// long YouTube cut and the handoff package, as pure code on synthetic indexes and
// sound. The real FFmpeg renders, OTIO's own parser and the gates are in
// tests/edit/media/longform.test.js.

const FLICKS = 705_600_000
const sec = (s) => Math.round(s * FLICKS)
const FPS = { n: 30, d: 1 }
const FRAME = FLICKS / 30
const COLOR = { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false }
const video = (id, duration, extra = {}) => ({ op: "add_asset", id, kind: "video", fingerprint: `f-${id}`, path: `/footage/${id}.mov`, linked: true, rights: "own", facts: { width: 1920, height: 1080, hasAudio: true, duration, vfr: false, fps: FPS, color: COLOR }, ...extra })
const projectWith = (assets) => apply(newProject({ id: "p", name: "Long talk" }), assets, { author: "code" }).project

// ---------------------------------------------------------------- ET-IDX-06

test("ET-IDX-06: the story tree splits a 40-minute talk at its topic shifts, keeps every sentence id once and in order", () => {
  const talk = longTalk(40, 2)
  const started = Date.now()
  const tree = storyTree(talk.index, "a1")
  assert.ok(Date.now() - started < 2000, "read in well under two seconds")
  const order = sentencesOf(talk.index, "a1").map((s) => s.id)
  assert.equal(order.length, talk.index.sentences.length)
  // Every sentence in exactly one beat, beats in order, each beat inside one scene and each scene inside one act
  assert.deepEqual(tree.beats.flatMap((b) => b.sentences), order)
  assert.deepEqual(tree.scenes.flatMap((s) => s.children), tree.beats.map((b) => b.id))
  assert.deepEqual(tree.acts.flatMap((a) => a.children), tree.scenes.map((s) => s.id))
  assert.deepEqual(tree.acts.map((a) => a.title), ["Opening", "Body", "Close"])

  // Scenes follow the topic blocks the fixture was written in: one block each, no block split
  const blockOf = (id) => talk.blockOf.get(talk.index.sentences.find((s) => s.id === id).firstWord)
  const blocks = new Set(order.map(blockOf))
  assert.equal(tree.scenes.length, blocks.size, `${tree.scenes.length} scenes for ${blocks.size} topics`)
  for (const scene of tree.scenes) {
    const ids = scene.children.flatMap((id) => tree.beats.find((b) => b.id === id).sentences)
    assert.equal(new Set(ids.map(blockOf)).size, 1, `${scene.id} holds one topic`)
    assert.ok(scene.end - scene.start >= 45 * FLICKS)
  }
  // Shorter talks, where a speaker's stock phrases are as common as the topic words
  for (const [minutes, seed] of [[6, 12], [6, 1], [8, 3], [14, 6]]) {
    const other = longTalk(minutes, seed)
    const split = storyTree(other.index, "a1")
    const of = (id) => other.blockOf.get(other.index.sentences.find((s) => s.id === id).firstWord)
    assert.deepEqual(split.scenes.map((s) => [...new Set(s.children.flatMap((id) => split.beats.find((b) => b.id === id).sentences).map(of))]), [...new Set(other.index.sentences.map((s) => of(s.id)))].map((b) => [b]), `${minutes} minutes, seed ${seed}`)
  }

  // Summaries are the transcript's own sentences, by id, with their own words
  const text = new Map(sentencesOf(talk.index, "a1").map((s) => [s.id, s.text]))
  for (const node of [...tree.scenes, ...tree.acts]) for (const line of node.summary) assert.equal(line.text, text.get(line.sentence))
  for (const scene of tree.scenes) {
    assert.ok(scene.quotable.length > 0 && scene.quotable.every((q) => text.has(q.sentence) && q.standsAlone))
    assert.ok(scene.topics.length && /^[A-Z]/.test(scene.title))
  }
})

test("ET-IDX-06: chunks are cached by content; an edited sentence reads only its own beat again; ids are stable", () => {
  const talk = longTalk(12, 4)
  const cache = new Map()
  const first = storyTree(talk.index, "a1", { cache })
  assert.equal(first.stats.computed, first.beats.length)
  const again = storyTree(talk.index, "a1", { cache })
  assert.deepEqual([again.stats.computed, again.stats.cached], [0, first.beats.length])
  assert.deepEqual({ ...again, stats: null }, { ...first, stats: null })

  // A transcript correction in one word: one beat is read again, every id stays
  const changed = structuredClone(talk.index)
  const word = changed.words.find((w) => w.id === changed.sentences[30].firstWord)
  word.text = "Corrected"
  const third = storyTree(changed, "a1", { cache })
  assert.equal(third.stats.computed, 1)
  assert.deepEqual(third.beats.map((b) => b.sentences), first.beats.map((b) => b.sentences))
  assert.equal(third.scenes.length, first.scenes.length)
})

test("chapters follow YouTube's rules: 00:00 first, at least three, ten seconds each, h:mm:ss past an hour", () => {
  assert.deepEqual([0, sec(135), sec(520), sec(3725)].map(chapterTime), ["00:00", "02:15", "08:40", "1:02:05"])
  const tree = { scenes: [0, 1, 2, 3].map((n) => ({ id: `s${n}`, title: `Topic ${n}`, children: [`b${n}`] })), beats: [0, 1, 2, 3].map((n) => ({ id: `b${n}`, sentences: [`x${n}`] })) }
  const at = { x0: sec(3), x1: sec(135), x2: sec(140), x3: sec(520) }
  const { chapters: list } = chapters(tree, (id) => at[id], { duration: sec(600) })
  // The first is moved to 00:00 and named Intro; the one five seconds after "Topic 1" folds into it
  assert.deepEqual(list.map((c) => [c.at, c.title]), [[0, "Intro"], [sec(135), "Topic 1"], [sec(520), "Topic 3"]])
  assert.equal(chapterList(list), "00:00 Intro\n02:15 Topic 1\n08:40 Topic 3")
  // A cut scene is skipped; too few left means none, said plainly
  const few = chapters(tree, (id) => (id === "x3" ? null : at[id]), { duration: sec(600) })
  assert.deepEqual(few.chapters, [])
  assert.match(few.note, /needs 3/)
})

// ---------------------------------------------------------------- ET-IDX-07

/** Speech-like sound: noise bursts a quarter-second long, on or off, as "the room" heard it. */
function room(seconds, seed = 1) {
  const random = prng(seed)
  const world = new Float64Array(seconds * SYNC_RATE)
  let on = false
  for (let i = 0; i < world.length; i++) {
    if (i % (SYNC_RATE / 4) === 0) on = random() > 0.45
    world[i] = on ? (random() - 0.5) * 0.6 : 0
  }
  return world
}

/** A recorder that started `start` seconds into the room (negative: before), with clock drift and its own hiss. */
function recorder(world, { start = 0, drift = 0, seed = 9, hiss = 0.01 }) {
  const random = prng(seed)
  const length = Math.floor((world.length / SYNC_RATE - start) * SYNC_RATE)
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const w = i / (1 + drift) + start * SYNC_RATE
    const j = Math.floor(w)
    const v = j >= 0 && j + 1 < world.length ? world[j] * (1 - (w - j)) + world[j + 1] * (w - j) : 0
    out[i] = Math.round(Math.max(-1, Math.min(1, v + (random() - 0.5) * hiss)) * 32767)
  }
  return out
}

test("ET-IDX-07: sync recovers known offsets to half a millisecond, and clock drift, on 2-minute recordings", () => {
  const world = room(120)
  const master = recorder(world, { seed: 3 })
  // Truth: an event at master time t is at t·(1 + drift) − start·(1 + drift) in the other recording
  for (const { start, drift } of [{ start: 1.37, drift: 0 }, { start: -0.83, drift: 0 }, { start: 2.5, drift: 1e-4 }, { start: 0.4, drift: -2e-4 }]) {
    const other = recorder(world, { start, drift, seed: 11 })
    const found = syncPair(master, other)
    const truth = -start * (1 + drift)
    assert.ok(Math.abs(found.offset / FLICKS - truth) < 0.0005, `offset ${found.offset / FLICKS} s, truth ${truth} s`)
    assert.ok(Math.abs(found.drift - drift) < 1e-5, `drift ${found.drift * 1e6} ppm, truth ${drift * 1e6} ppm`)
    assert.ok(found.confidence >= PODCAST_MULTICAM.syncFloor, `confidence ${found.confidence}`)
    assert.ok(Number.isSafeInteger(found.offset), "the offset is whole flicks")
  }
  // A different conversation doesn't sync, and says so
  const stranger = syncPair(master, recorder(room(120, 77), { seed: 5 }))
  assert.ok(stranger.confidence < PODCAST_MULTICAM.syncFloor, `unrelated sound, confidence ${stranger.confidence}`)
})

// ---------------------------------------------------------------- switching

const STEP = PODCAST_MULTICAM.step
const steps = (s) => Math.round((s * FLICKS) / STEP)

/** Two speakers' loudness, each heard loud on its own source and as bleed on the other's. */
function conversation(script, length) {
  const a = new Float32Array(steps(length)).fill(-62)
  const b = new Float32Array(steps(length)).fill(-61)
  for (const [from, to, who] of script) {
    for (let i = steps(from); i < steps(to); i++) {
      if (i % 10 === 9 && to - from > 1) continue // the pause between words
      if (who.includes("A")) (a[i] = Math.max(a[i], -20)), (b[i] = Math.max(b[i], -32))
      if (who.includes("B")) (b[i] = Math.max(b[i], -21)), (a[i] = Math.max(a[i], -33))
    }
  }
  return [a, b]
}

const SCRIPT = [
  [0, 20, "A"],
  [20, 21, "B"], // a one-second reply: not worth a switch
  [21, 35, "A"],
  [35, 45, "B"],
  [45, 50, "AB"], // talking over each other
  [50, 80, "A"], // a 30-second answer
  [63, 63.5, "B"], // the listener laughs
]
const ANGLES = [{ speaker: null }, { speaker: 0 }, { speaker: 1 }]
const share = (shots, angle, from, to) => shots.filter((s) => s.angle === angle).reduce((sum, s) => sum + Math.max(0, Math.min(s.to, steps(to)) - Math.max(s.from, steps(from))), 0) / (steps(to) - steps(from))

test("switching: the speaker's camera, the wide for talking over each other, no switch for a short reply, no shot under 2.5 s", () => {
  const speakers = conversation(SCRIPT, 85)
  const labels = activity(speakers)
  assert.deepEqual(labels[steps(10)], [0])
  assert.deepEqual(labels[steps(40)], [1], "B's voice in A's source is bleed, not A")
  assert.deepEqual(labels[steps(47)], [0, 1])
  const shots = reactionCuts(switchShots(labels, ANGLES), ANGLES, labels, speakers)
  assert.equal(shots[0].from, 0)
  assert.equal(shots.at(-1).to, labels.length)
  shots.slice(1).forEach((s, i) => assert.equal(s.from, shots[i].to, "shots tile the programme"))
  for (const s of shots) assert.ok(s.to - s.from >= steps(2.5), `a ${(s.to - s.from) / 10} s shot`)
  assert.ok(share(shots, 1, 0, 20) > 0.8, "A's camera while A talks")
  assert.equal(share(shots, 2, 20, 21), 0, "no cut to B for a one-second reply")
  assert.ok(share(shots, 2, 35, 45) > 0.8, "B's camera while B talks")
  assert.ok(share(shots, 0, 45, 50) > 0.8, "the wide while they talk over each other")
  assert.ok(share(shots, 1, 50, 80) > 0.6, "A's camera for most of A's answer")
  // The cutaway to the listener in the long answer lands on the laugh
  const reaction = shots.find((s) => s.reaction && s.from >= steps(50))
  assert.ok(reaction, "a look at the listener in the long answer")
  assert.equal(reaction.angle, 2)
  assert.ok(Math.abs(reaction.from - steps(63)) <= 5, `the reaction at ${reaction.from / 10} s`)
  assert.equal(reaction.to - reaction.from, steps(3))
})

test("switching: a camera that isn't rolling yet is never cut to; the wide holds until it is", () => {
  const speakers = conversation([[0, 30, "A"]], 30)
  const labels = activity(speakers)
  const late = [{ speaker: null }, { speaker: 0, available: (i) => i >= steps(4) }, { speaker: 1 }]
  const shots = switchShots(labels, late)
  assert.equal(shots[0].angle, 0)
  assert.ok(shots[0].to >= steps(4))
  assert.equal(shots[1].angle, 1)
})

test("podcast-multicam: angles go over the master, in sync with their own offsets; the sound is the master's throughout", () => {
  const speakers = conversation(SCRIPT, 85)
  const labels = activity(speakers)
  const sync = { ca: { offset: sec(-1.37), drift: 0, confidence: 0.9 }, cb: { offset: sec(0.83), drift: 50e-6, confidence: 0.8 } }
  const project = projectWith([video("w", sec(85)), video("ca", sec(84)), video("cb", sec(86))])
  const made = planMulticam({ project, index: { words: [], sentences: [] }, master: "w", angles: [{ asset: "ca", speaker: 0 }, { asset: "cb", speaker: 1 }], analysis: { sync, speakers, labels } })
  const timeline = solve(made.project, { words: [], sentences: [] })
  assert.equal(timeline.picture.length, 1)
  assert.equal(timeline.picture[0].asset, "w")
  assert.ok(timeline.audio.every((a) => a.asset === "w"), "only the master is heard")
  const angles = timeline.overlays.filter((o) => o.role === "broll")
  assert.ok(angles.length >= 4)
  for (const o of angles) {
    const { offset, drift } = sync[o.asset]
    // In sync: the angle's source time is the master's plus its offset, to the frame
    assert.ok(Math.abs(o.in - (o.at + offset + drift * o.at)) <= FRAME, `${o.asset} at ${o.at / FLICKS} s`)
    assert.ok(o.end - o.at >= sec(2.5) - FRAME)
  }
  // Camera A starts 1.37 s late, so the programme opens on the wide
  assert.ok(angles.every((o) => o.asset !== "ca" || o.at >= sec(1.37)))
  assert.match(made.notes[0], /ca -1\.370 s, drift 0 ppm/)
  const plan = compile(made.project, { words: [], sentences: [] }, { engineVersion: "t", runtimeVersion: "t", quality: "master", deliverable: made.project.deliverables[0].id })
  assert.deepEqual(plan.issues, [])
  assert.equal(plan.duration, sec(85))

  // Below the sync floor the person is asked, not guessed for
  assert.throws(() => planMulticam({ project, master: "w", angles: [{ asset: "ca", speaker: 0 }], analysis: { sync: { ca: { offset: 0, drift: 0, confidence: 0.1 } }, speakers, labels } }), (error) => error.needsYou === true)
})

// ---------------------------------------------------------------- youtube-longform

function longformProject(talk, { music = false } = {}) {
  const assets = [video("a1", talk.duration), video("b1", sec(10), { facts: { width: 1920, height: 1080, hasAudio: false, duration: sec(10), vfr: false, fps: FPS, color: COLOR } })]
  if (music) assets.push({ op: "add_asset", id: "m1", kind: "audio", fingerprint: "f-m1", path: "/footage/song.wav", linked: true, rights: "licensed", facts: { duration: sec(1200), hasAudio: true, sampleRate: 48000, channels: 2 } })
  let project = projectWith(assets)
  if (music) project = apply(project, [{ op: "set_music", asset: "m1" }], { author: "person" }).project
  return project
}

test("youtube-longform: a 14-minute talk becomes a chaptered cut whose picture changes at the recipe's rate, faster in the intro", () => {
  const talk = longTalk(14, 5)
  const project = longformProject(talk, { music: true })
  const made = planLongform({ project, index: talk.index, asset: "a1", broll: ["b1"] })
  const timeline = solve(made.project, talk.index)
  assert.ok(timeline.duration > 10 * 60 * FLICKS, `${timeline.duration / FLICKS} s`)

  // Chapters: one per scene, 00:00 Intro first, in order, each at least ten seconds, on the timeline's frames
  assert.equal(made.chapters.length, made.tree.scenes.length)
  assert.deepEqual([made.chapters[0].at, made.chapters[0].title], [0, "Intro"])
  made.chapters.slice(1).forEach((c, i) => assert.ok(c.at - made.chapters[i].at >= 10 * FLICKS))
  assert.match(made.chapterList, /^00:00 Intro\n0\d:\d\d \S/)
  const { markers } = timelineMarkers(made.project, talk.index, timeline)
  assert.deepEqual(markers.map((m) => m.name), made.chapters.map((c) => c.title))
  markers.forEach((m, i) => assert.ok(Math.abs(m.at - made.chapters[i].at) <= FRAME))

  // Pacing: no stretch over the recipe's rate without a change of picture; the intro at half that
  const every = YOUTUBE_LONGFORM.pace.every
  assert.deepEqual(made.pace.flat, [])
  const changes = pictureChanges(timeline)
  const gaps = changes.slice(1).map((t, i) => [changes[i], t - changes[i]])
  assert.ok(gaps.every(([, g]) => g <= every + 2 * FLICKS), `longest ${Math.max(...gaps.map(([, g]) => g)) / FLICKS} s`)
  const introEnd = made.chapters[1].at
  // A stretch that ends inside the intro (the next scene's first shot opens a pad before its chapter)
  const intro = gaps.filter(([at, g]) => at + g <= introEnd + FLICKS)
  assert.ok(intro.length > 5 && intro.every(([, g]) => g <= every * 0.5 + 2 * FLICKS), "the intro moves faster")
  assert.ok(timeline.zooms.length > 10 && timeline.overlays.some((o) => o.asset === "b1"))

  // Captions go out as a sidecar, not burned; the music stays on its own bus
  assert.ok(timeline.captions.length > 100)
  assert.equal(made.project.deliverables[0].burnCaptions, false)
  assert.deepEqual([made.project.deliverables[0].size.width, made.project.deliverables[0].size.height], [1920, 1080])
  assert.ok(timeline.audio.some((a) => a.role === "music" && a.asset === "m1"), "the music track is kept")
  const tracks = JSON.parse(toOtio(made.project, timeline, markers)).tracks
  assert.deepEqual(tracks.children.filter((t) => t.kind === "Audio").map((t) => t.name), ["dialogue", "music"])
  assert.equal(tracks.markers.length, markers.length)
  assert.ok(made.endScreen && made.endScreen.end === timeline.duration)

  const plan = compile(made.project, talk.index, { engineVersion: "t", runtimeVersion: "t", quality: "master", deliverable: made.project.deliverables[0].id })
  assert.deepEqual(plan.issues, [])
})

test("youtube-longform: over the asked length, lines go but every scene keeps its opener and its chapter", () => {
  const talk = longTalk(14, 6)
  const made = planLongform({ project: longformProject(talk), index: talk.index, asset: "a1", brief: { targetDuration: 8 * 60 * FLICKS } })
  const timeline = solve(made.project, talk.index)
  assert.ok(timeline.duration <= 8 * 60 * FLICKS * 1.1, `${timeline.duration / FLICKS} s`)
  assert.match(made.notes.join("\n"), /Left out \d+ of \d+ lines/)
  const played = new Set(timeline.picture.flatMap((p) => talk.index.words.filter((w) => w.start >= p.in && w.end <= p.out).map((w) => w.id)))
  for (const scene of made.tree.scenes) {
    const opener = talk.index.sentences.find((s) => s.id === scene.from)
    assert.ok(played.has(opener.firstWord) || talk.index.takes.some((k) => k.sentence === opener.id && k.rank !== 1), `${scene.id} opens on its first line`)
  }
  assert.equal(made.chapters.length, made.tree.scenes.length)
})

// ---------------------------------------------------------------- handoff (EG-6, ET-INT-01)

test("handoff: FCPXML times sit on frames, chapter markers inside their clips; two files of one name don't collide", () => {
  const talk = longTalk(10, 8)
  const project = longformProject(talk, { music: true })
  const made = planLongform({ project, index: talk.index, asset: "a1", broll: ["b1"] })
  const timeline = solve(made.project, talk.index)
  const { markers } = timelineMarkers(made.project, talk.index, timeline)
  const { text } = toFcpxml(made.project, timeline, markers)
  execFileSync("xmllint", ["--noout", "-"], { input: text })
  // Every time is a whole number of 1/30 s frames (Final Cut refuses edits between frames)
  const times = [...text.matchAll(/ (offset|start|duration)="([^"]+)"/g)].filter((m) => !m[0].includes("frameDuration"))
  assert.ok(times.length > 200)
  for (const [, attr, value] of times) {
    const [, n, d = "1"] = /^(\d+)(?:\/(\d+))?s$/.exec(value)
    if (attr === "duration" && value === "1/30s") continue
    assert.equal((BigInt(n) * 30n) % BigInt(d), 0n, `${attr}="${value}" is between frames`)
  }
  // Each chapter marker sits inside the source range of the spine clip that holds it
  const seconds = (value) => {
    const [, n, d = "1"] = /^(\d+)(?:\/(\d+))?s$/.exec(value)
    return Number(n) / Number(d)
  }
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  const stack = []
  let found = 0
  for (const [, close, name, body, self] of text.matchAll(/<(\/?)(asset-clip|chapter-marker)\b([^>]*?)(\/?)>/g)) {
    if (close) stack.pop()
    else if (name === "chapter-marker") {
      const clip = stack.at(-1)
      const at = seconds(attrs(body).start)
      assert.ok(clip && at >= seconds(clip.start) - 1e-9 && at < seconds(clip.start) + seconds(clip.duration), "a chapter marker inside its clip")
      found++
    } else if (!self) stack.push(attrs(body))
  }
  assert.equal(found, markers.length)

  // Two sources called take.mov in different folders get different names in the package
  const twins = projectWith([{ ...video("x1", sec(5)), path: "/day1/take.mov" }, { ...video("x2", sec(5)), path: "/day2/take.mov" }])
  const cut = apply(twins, [{ op: "keep_range", asset: "x1", from: 0, to: sec(2) }, { op: "keep_range", asset: "x2", from: 0, to: sec(2) }], { author: "person" }).project
  const paths = handoffManifest(cut, solve(cut, {})).map((m) => m.path)
  assert.equal(new Set(paths).size, 2, paths.join(", "))
})

test("handoff package: OTIO, FCPXML, EDL, SRT, chapters and a manifest in a new folder, media linked at the paths the files name", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-handoff-")))
  const talk = longTalk(10, 9)
  const sources = { a1: join(dir, "talk.mov"), b1: join(dir, "broll.mov") }
  for (const file of Object.values(sources)) writeFileSync(file, "")
  const base = longformProject(talk)
  const project = { ...base, assets: base.assets.map((a) => ({ ...a, path: sources[a.id] })) }
  const made = planLongform({ project, index: talk.index, asset: "a1", broll: ["b1"] })
  const exportsDir = join(dir, "exports")
  const out = writeHandoff({ project: made.project, index: talk.index, exportsDir, sourcePath: (id) => sources[id] })
  assert.equal(out.folder, join(exportsDir, "Long-talk-handoff"))
  assert.deepEqual(out.files.sort(), ["Long-talk.edl", "Long-talk.fcpxml", "Long-talk.otio", "Long-talk.srt", "chapters.txt", "manifest.json"])
  assert.equal(out.media, 2)
  const manifest = JSON.parse(readFileSync(join(out.folder, "manifest.json"), "utf8"))
  for (const entry of manifest.media) {
    const link = join(out.folder, entry.path)
    assert.ok(lstatSync(link).isSymbolicLink())
    assert.equal(readlinkSync(link), sources[entry.asset], "linked to the source, never a copy")
  }
  const otio = readFileSync(join(out.folder, "Long-talk.otio"), "utf8")
  assert.ok(!otio.includes(dir), "no absolute path in the timeline")
  for (const ref of otio.matchAll(/"target_url": "([^"]+)"/g)) assert.ok(manifest.media.some((m) => m.path === ref[1]), `${ref[1]} is linked`)
  assert.equal(readFileSync(join(out.folder, "chapters.txt"), "utf8").trim(), made.chapterList)
  assert.match(readFileSync(join(out.folder, "Long-talk.srt"), "utf8"), /^1\n00:00:0\d,\d{3} --> /)
  assert.ok(manifest.omitted.some((o) => o.format === "edl"), "what the EDL can't carry is listed")
  // A second export never overwrites the first
  assert.equal(writeHandoff({ project: made.project, index: talk.index, exportsDir, sourcePath: (id) => sources[id] }).folder, join(exportsDir, "Long-talk-handoff-2"))
  // Nothing on the timeline: refused, nothing written
  assert.throws(() => writeHandoff({ project: projectWith([video("a1", sec(5))]), index: {}, exportsDir, sourcePath: () => dir }), /nothing on the timeline/)
})
