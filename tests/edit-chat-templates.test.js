import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { clock, timesIn, timesView } from "../src/edit/director/revise.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { FORMATS, GRADES, recipeFor } from "../src/edit/recipes/reel.js"
import { indexOf, lengthOf } from "./edit/script.js"

// Chat with Kriya by time, templates, and the home screen's delete and folder picker
// (2026-11-09, from use): the person says "remove 0:05 to 0:09" and code, not the model,
// works out which words and captions that is.

const FLICKS = 705_600_000

test("times in the person's words: m:ss, seconds, and ranges joined by to, -, until or and", () => {
  const at = (s) => Math.round(s * FLICKS)
  assert.deepEqual(timesIn("remove 0:05 to 0:09"), [{ at: at(5), to: at(9) }])
  assert.deepEqual(timesIn("from 5 to 9 seconds, please"), [{ at: at(5), to: at(9) }], "a bare first half of a range")
  assert.deepEqual(timesIn("between 0:05 and 0:09.5"), [{ at: at(5), to: at(9.5) }])
  assert.deepEqual(timesIn("change the caption at 12s and 1:02"), [{ at: at(12), to: at(62) }], "two times joined by 'and' read as a range")
  assert.deepEqual(timesIn("the title at 3.5 sec"), [{ at: at(3.5) }])
  assert.deepEqual(timesIn("make it punchier, 3 times"), [], "a number that isn't a time")
  assert.equal(clock(at(62.5)), "1:02.5")
  assert.equal(clock(at(5)), "0:05.0")
})

test("code says what a time points at: the clip, the words with ids, the captions", () => {
  const index = indexOf()
  const facts = { width: 1920, height: 1080, hasAudio: true, duration: Math.round(lengthOf() * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  let project = apply(newProject({ id: "p", name: "Talk" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "own", facts }], { author: "code" }).project
  project = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: facts.duration }, { op: "caption_style", look: "karaoke", words: [index.words[0].id, index.words[1].id] }], { author: "person", index }).project
  const one = timesView("what's at 0:01.2?", project, index)
  assert.match(one, /0:01\.2: clip c\d+, word a1:w0 "Okay"/)
  assert.match(one, /caption c\d+/, "the caption on screen then")
  const range = timesView("remove 0:01 to 0:03", project, index)
  assert.match(range, /0:01\.0-0:03\.0: clip c\d+, words a1:w0 to a1:w\d+: "Okay so um/)
  assert.match(timesView("cut 9:00", project, index), /past the end of the cut/)
  assert.equal(timesView("no times here", project, index), "")
})

test("templates: each format sets the frame and its own export; colour looks are FFmpeg-renderable grades", () => {
  for (const [format, size] of Object.entries(FORMATS)) {
    const recipe = recipeFor({ format })
    assert.deepEqual(recipe.canvas, { width: size.width, height: size.height })
    assert.deepEqual(recipe.deliverable.size, { width: size.width, height: size.height })
    assert.equal(recipe.deliverable.preset, size.preset)
  }
  assert.deepEqual(recipeFor({}).canvas, { width: 1080, height: 1920 }, "the reel's 9:16 by default")
  assert.deepEqual(recipeFor({ format: "nonsense" }).canvas, { width: 1080, height: 1920 })
  for (const grade of Object.values(GRADES)) for (const key of Object.keys(grade)) assert.ok(["lift", "gamma", "gain", "saturation"].includes(key), key)
})

/* ─────────────── the home screen: delete a project, choose and make a folder ─────────────── */

test("deleting a project removes only Kriya's own data; the person's folder stays; folders can be browsed and made", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "khome-")))
  const root = join(home, "work")
  const bin = join(home, "bin")
  mkdirSync(join(root, "film"), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. lut3d V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) echo failed >&2; exit 1;;\nesac\n`)
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"audio","sample_rate":"48000","channels":2,"duration_ts":48000,"time_base":"1/48000"}],"format":{"format_name":"wav","duration":"1.0"}}'\n`)
  chmodSync(join(bin, "ffmpeg"), 0o755)
  chmodSync(join(bin, "ffprobe"), 0o755)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: root, KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  try {
    // The folder picker: the allowed folders, a new folder inside them, never outside
    const top = await call("GET", "/browse")
    assert.equal(top.root, root)
    assert.equal(top.parent, null, "no way above the allowed folders")
    assert.deepEqual(top.entries.map((e) => e.name), ["film"])
    const { folder } = await call("POST", "/browse/folder", { parent: root, name: "Pricing reel" })
    assert.equal(folder, join(root, "Pricing reel"))
    assert.equal((await call("GET", `/browse?root=${encodeURIComponent(folder)}`)).parent, root)
    await assert.rejects(call("POST", "/browse/folder", { parent: "/etc", name: "x" }), /folders|403/)
    await assert.rejects(call("POST", "/browse/folder", { parent: root, name: "Pricing reel" }), /already/)

    writeFileSync(join(root, "film", "take.wav"), "x")
    const { id } = await call("POST", "/projects", { name: "Film", folder: join(root, "film") })
    await call("POST", `/projects/${id}/assets`, { path: join(root, "film", "take.wav") })
    assert.ok(existsSync(join(home, "edit", id)))
    const gone = await call("DELETE", `/projects/${id}`)
    assert.equal(gone.removed, id)
    assert.equal((await call("GET", "/projects")).projects.length, 0)
    assert.equal(existsSync(join(home, "edit", id)), false, "its history, cache and index are gone")
    assert.ok(existsSync(join(root, "film", "Film.kriya-edit")) && existsSync(join(root, "film", "take.wav")), "the person's folder is untouched")
    await assert.rejects(call("DELETE", `/projects/${id}`), /no such project/)
  } finally {
    await stopHost(home)
  }
})
