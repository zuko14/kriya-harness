import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { createTaste, signalsOf } from "../src/edit/host/taste.js"
import { candidateLines } from "../src/edit/recipes/reel.js"
import { ROOT } from "./helpers.js"

// ET-TST-01 (DIRECTOR_AND_AGENT §12): repeated choices propose once; only confirmed rules
// apply; nothing is written by a tool.

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "kt-taste-")))
const look = (name) => [{ op: "caption_style", look: name }]
const zoom = (scale) => [{ op: "punch_in", at: 0, scale }]

test("ET-TST-01: a choice proposes only when it repeats across projects, and only once", () => {
  const taste = createTaste({ home: temp() })
  taste.note("p1", look("karaoke"), "e1")
  assert.deepEqual(taste.list().proposed, [], "once is nothing")
  taste.note("p1", look("karaoke"), "e2")
  assert.deepEqual(taste.list().proposed, [], "twice in one project is one project's look")
  taste.note("p2", look("karaoke"), "e3")
  const [rule] = taste.list().proposed
  assert.equal(rule.key, "caption_look:karaoke")
  assert.match(rule.sentence, /karaoke captions/)
  assert.equal(taste.nextToAsk().key, rule.key)
  assert.equal(taste.nextToAsk(), null, "asked once")

  assert.equal(taste.dismiss(rule.key), true)
  taste.note("p3", look("karaoke"), "e4")
  taste.note("p4", look("karaoke"), "e5")
  assert.deepEqual(taste.list().proposed, [], "a no stays a no")
})

test("ET-TST-01: only a confirmed rule applies; one per kind; removing it stops it", () => {
  const taste = createTaste({ home: temp() })
  for (const [p, e] of [["p1", "e1"], ["p2", "e2"]]) {
    taste.note(p, look("karaoke"), e)
    taste.note(p, zoom(1.32), `${e}z`)
  }
  assert.deepEqual(taste.defaults(), {}, "proposed changes nothing")
  assert.equal(taste.confirm("caption_look:karaoke"), true)
  assert.deepEqual(taste.defaults(), { captions: "karaoke" })
  taste.confirm("zoom:1.30")
  assert.deepEqual(taste.defaults(), { captions: "karaoke", zoom: 1.3 }, "zoom rounds to the step")

  for (const [p, e] of [["p3", "e3"], ["p4", "e4"]]) taste.note(p, look("bold"), e)
  taste.confirm("caption_look:bold")
  assert.equal(taste.defaults().captions, "bold", "the newest yes")
  assert.deepEqual(taste.list().confirmed.map((r) => r.key).sort(), ["caption_look:bold", "zoom:1.30"])

  taste.remove("zoom:1.30")
  assert.equal("zoom" in taste.defaults(), false)
  assert.equal(taste.confirm("caption_look:nothing"), false)
})

test("ET-TST-01: an undone choice teaches nothing; bad values and a bad file teach nothing", () => {
  const home = temp()
  const taste = createTaste({ home })
  taste.note("p1", look("karaoke"), "e1")
  taste.forget("p1", "e1")
  taste.note("p2", look("karaoke"), "e2")
  assert.deepEqual(taste.list().proposed, [])

  assert.deepEqual(signalsOf([{ op: "punch_in", scale: 99 }, { op: "punch_in", scale: 1 }, { op: "caption_style", look: "../../etc" }, { op: "keep_range" }]), [])
  assert.deepEqual(createTaste({ home: temp() }).list(), { proposed: [], confirmed: [] }, "no file: nothing")
  assert.ok(existsSync(join(home, "edit", "taste.json")))
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(home, "edit", "taste.json"), "utf8"))).includes("brief"), false)
})

test("ET-TST-01: nothing is written by a tool: the rules' routes refuse the socket every tool and the daemon use", async () => {
  const home = temp()
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: home, KRIYA_EDIT_IDLE_MS: "60000" }
  await ensureHost({ env, home })
  try {
    await assert.rejects(hostCall(home, "POST", "/taste/caption_look:karaoke/confirm"), /Only the person/)
    await assert.rejects(hostCall(home, "GET", "/taste"), /Only the person/)
    // On the web port it needs the Studio's session too
    const { port } = await hostCall(home, "GET", "/internal/info")
    const status = await new Promise((done, fail) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/taste/caption_look:karaoke/confirm", headers: { host: `127.0.0.1:${port}` } }, (res) => (res.resume(), done(res.statusCode)))
      req.on("error", fail)
      req.end()
    })
    assert.equal(status, 401)
  } finally {
    await stopHost(home)
  }
  // Nothing in the agent's belt, the daemon or the Director names it
  for (const file of ["plugins/edit/index.js", "src/daemon.js", "src/edit/director/ask.js", "src/edit/director/revise.js", "src/edit/loop/make.js"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), "utf8"), /\/taste|taste\.(confirm|dismiss|remove)/, file)
  }
})

test("a person's chosen take replaces the index's pick, for that group alone", () => {
  const words = [
    { id: "w1", asset: "a1", flags: [] },
    { id: "w2", asset: "a1", flags: [] },
    { id: "w3", asset: "a1", flags: [] },
  ]
  const index = {
    words,
    sentences: [
      { id: "s1", asset: "a1", firstWord: "w1", lastWord: "w1", score: 1 },
      { id: "s2", asset: "a1", firstWord: "w2", lastWord: "w2", score: 1 },
      { id: "s3", asset: "a1", firstWord: "w3", lastWord: "w3", score: 1 },
    ],
    takes: [
      { group: "g1", sentence: "s1", rank: 1 },
      { group: "g1", sentence: "s2", rank: 2 },
    ],
  }
  assert.deepEqual(candidateLines(index, "a1").map((l) => l.id), ["s1", "s3"])
  assert.deepEqual(candidateLines(index, "a1", { g1: "s2" }).map((l) => l.id), ["s2", "s3"])
})
