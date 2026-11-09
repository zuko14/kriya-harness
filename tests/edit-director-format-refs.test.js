import assert from "node:assert/strict"
import { test } from "node:test"

import { mapBox } from "../src/edit/core/faces.js"
import { safeZoneFor } from "../src/edit/core/layout.js"
import { apply } from "../src/edit/core/ops.js"
import { solve } from "../src/edit/core/solver.js"
import { createAsk } from "../src/edit/director/ask.js"
import { briefOf, formatAsked, formatIn, planCut } from "../src/edit/director/plan.js"
import { cleanRefs, takeFrom } from "../src/edit/engine/reference.js"
import { createGovernor } from "../src/edit/loop/governor.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"
import { indexOf, lengthOf } from "./edit/script.js"

// From use (2026-11-09): a plan approved for 16:9 came out 9:16; captions sat on the face;
// a reference should give only what the person took it for.

const FLICKS = 705_600_000

test("the format is read from the person's words, a ratio over a word, turned-away mentions skipped", () => {
  const cases = {
    "make a 16:9 aspect ratio video": "16:9",
    "16x9 please": "16:9",
    "landscape, 16 by 9": "16:9",
    "a reel in 16:9": "16:9",
    "make it 16:9 not 9:16": "16:9",
    "change it from 9:16 to 16:9": "16:9",
    "I asked 16:9 but it made 9:16": "16:9",
    "for youtube": "16:9",
    "youtube shorts": "9:16",
    "a vertical reel": "9:16",
    "square post": "1:1",
    "4:5 for the feed": "4:5",
    "remove the first 5 seconds": null,
    "make the story punchier": null,
  }
  for (const [text, format] of Object.entries(cases)) assert.equal(formatIn(text), format, text)
  // This message, then the person's earlier words (not Kriya's), then the plan being revised
  assert.equal(formatAsked("add calm music", [{ who: "you", text: "make it 16:9" }, { who: "kriya", text: "a vertical reel" }], { settings: { format: "9:16" } }), "16:9")
  assert.equal(formatAsked("add calm music", [], { settings: { format: "1:1" } }), "1:1")
  assert.equal(formatAsked("add calm music", [], null), null)
})

function talk() {
  const index = indexOf()
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  const base = apply(makeProject(), [], { author: "code" }).project
  const project = apply({ ...base, assets: [{ id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }] }, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }], { author: "person", index }).project
  return { index, project }
}

test("a plan for 16:9 is made in 16:9 even when the model leaves the format out or gets it wrong", async () => {
  const { index, project } = talk()
  const replies = [
    { say: "A vertical reel with captions.", steps: ["Captions"], settings: { captions: "clean" } },
    { say: "A vertical reel.", steps: ["Reframe"], settings: { format: "9:16", captions: "clean" } },
    { say: "Calmer now.", steps: ["Calm music"], settings: { music: "calm" } },
  ]
  let n = 0
  const asked = []
  const send = async (body) => (asked.push(body), { choices: [{ message: { content: JSON.stringify(replies[n++]) } }], usage: { completion_tokens: 40 } })
  const ask = createAsk({ governor: createGovernor({ send, windowMs: 10 }), record() {} })
  const left = await planCut({ ask, project, index, text: "edit this raw video into a 16:9 film with captions", choices: { format: "9:16" } })
  assert.equal(left.settings.format, "16:9", "left out: the person's words, not the panel's default")
  assert.equal(briefOf(left.settings).format, "16:9", "and the approved brief carries it")
  assert.match(asked[0].messages.at(-1).content, /wants the 16:9 format/, "the model is told, so its pitch agrees")
  const wrong = await planCut({ ask, project, index, text: "16:9 please, for YouTube" })
  assert.equal(wrong.settings.format, "16:9", "a wrong format from the model is overruled")
  const revised = await planCut({ ask, project, index, text: "make the music calmer", previous: left })
  assert.equal(revised.settings.format, "16:9", "a revision keeps the format the person asked for")
})

test("captions clear the face as the render draws it, between face samples, in a new frame shape", () => {
  const index = makeIndex()
  const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
  // A vertical take (1080×1920) made into a 16:9 film, after an earlier 9:16 export
  const project = apply(makeProject(), [{ op: "set_format", width: 1920, height: 1080 }, { op: "keep_range", asset: "a1", from: w(0), to: w(49, "end") }, { op: "caption_style", look: "bold", words: ["a1:w30", "a1:w31"] }], { index, author: "agent" }).project
  project.deliverables = [{ id: "d0", preset: "reel-9x16", size: { width: 1080, height: 1920 } }]
  assert.deepEqual(safeZoneFor(project), {}, "a 9:16 export's margins don't squeeze the 16:9 frame")
  const word = index.words.find((x) => x.id === "a1:w31")
  // One sample, half a second after the caption: faces are sampled once a second
  const face = { asset: "a1", shot: null, t: word.end + ms(500), box: { x: 340, y: 900, w: 400, h: 400 } }
  const timeline = solve(project, { ...index, faces: [face] })
  const caption = timeline.captions[0]
  assert.ok(caption.placement, "placed")
  const onScreen = mapBox(face.box, {}, { width: 1080, height: 1920 }, project.canvas, project.canvas, face.t)
  const overlaps = (a, b) => a.y < b.y + b.h && b.y < a.y + a.h
  assert.equal(overlaps(caption.placement, onScreen), false, `caption at ${caption.placement.y}, face ${onScreen.y} to ${onScreen.y + onScreen.h}`)
})

test("references: each gives only what the person took it for", () => {
  assert.deepEqual(cleanRefs(["r1", { id: "r2", aspect: "sound" }, { id: "r3", aspect: "made-up" }, { id: "../x" }, 5, "r1"]), [
    { id: "r1", aspect: "all" },
    { id: "r2", aspect: "sound" },
    { id: "r3", aspect: "all" },
  ])
  const video = { kind: "video", pace: { every: 1.2, shots: 30 }, captions: true, colour: { grade: { temperature: 5200 }, words: ["warm"] }, music: { bpm: 120, mood: "upbeat", lufs: -9 }, lines: ["Colour: warm", "Pace: 1.2 s", "Captions: yes", "Music: 120 bpm"], parts: { colour: "Colour: warm", editing: "Pace: 1.2 s", graphics: "Captions: yes", sound: "Music: 120 bpm" } }
  const sound = takeFrom(video, "sound")
  assert.deepEqual([sound.music?.bpm, sound.pace, sound.colour, sound.captions, sound.lines], [120, undefined, undefined, undefined, ["Music: 120 bpm"]], "its song, nothing else")
  const editing = takeFrom(video, "editing")
  assert.deepEqual([editing.pace?.every, editing.music, editing.lines], [1.2, undefined, ["Pace: 1.2 s"]])
  assert.deepEqual(Object.keys(takeFrom(video, "colour")).sort(), ["colour", "kind", "lines"])
  assert.equal(takeFrom(video, "graphics").captions, true)
  // Everything, as before: a cut video's soundtrack is usually speech, so its music isn't used
  const all = takeFrom(video, "all")
  assert.deepEqual([all.pace?.every, all.colour?.words[0], all.captions, all.music], [1.2, "warm", true, undefined])
  assert.equal(takeFrom({ kind: "audio", music: { bpm: 90, mood: "warm" }, lines: ["Music"], parts: { sound: "Music" } }, "all").music.bpm, 90)
  assert.deepEqual(takeFrom({ kind: "image", colour: { grade: {}, words: [] }, lines: ["Colour"], parts: { colour: "Colour" } }, "sound").lines, [], "an image has no sound to give")
  // An analysis kept from before aspects: whole, for everything
  assert.deepEqual(takeFrom({ kind: "video", lines: ["Colour: warm"], colour: { grade: {}, words: ["warm"] } }, "all").lines, ["Colour: warm"])
})
