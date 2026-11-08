import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { KriyaError } from "../src/api.js"
import { chooseFile, closeTakes, createTavi, previewOf, secondsIn } from "../src/edit/host/tavi.js"
import { createWatcher, folderId, unwatchFolder, watchedFolders, watchFolder } from "../src/edit/host/watch.js"
import { projectId } from "../src/daemon.js"
import { hostCall, ensureHost, stopHost } from "../src/edit/host/client.js"

// A job from Kriya, in the Host (TAVI_INTEGRATION §4), ET-TV's client half: what leaves
// for Kriya is of a fixed shape, a final report survives a closed lid, and a job
// the person cancels reports canceled only after Kriya said so (EH-17).

const DISPATCH = "11111111-1111-4111-8111-111111111111"
const JOB = "22222222-2222-4222-8222-222222222222"

const temp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

function world(over = {}) {
  const home = temp("kt-")
  const folder = join(home, "Raw footage")
  mkdirSync(folder)
  writeFileSync(join(folder, "last-night-secret-client.mov"), "x")
  const posts = []
  const canceled = []
  const started = []
  const master = join(home, "master.mp4")
  writeFileSync(master, "small master")
  const state = { id: "p1", folder, log: { current: { assets: [], brief: {} } } }
  const projects = {
    list: () => [],
    get: async () => state,
    create: async ({ folder: f, offered }) => (assert.equal(offered, true), assert.equal(f, folder), state),
    addAsset: async () => ({ id: "a1", kind: "video" }),
  }
  const jobs = { start: (_s, request) => (started.push(request), { id: "p1.1", status: "pending" }), cancel: (id) => (canceled.push(id), true) }
  const put = over.put ?? (async () => new Response("{}"))
  const send =
    over.send ??
    (async (path, body) => {
      posts.push({ path, body })
      if (path.endsWith("/previews")) return { id: "33333333-3333-4333-8333-333333333333", uploadUrl: "https://storage.example/u" }
      return null
    })
  const tavi = createTavi({ home, projects, jobs: () => jobs, tools: async () => ({ capabilities: { encoders: new Set(["libx264"]) } }), log: () => {}, send, put, probeFile: async () => ({ facts: { duration: 30 * 705_600_000 } }), reportMs: 0, beatMs: 1e9, retryMs: 1e9 })
  return { home, folder, posts, tavi, started, canceled, master, state }
}
const accept = (w, over = {}) => w.tavi.accept({ dispatch: DISPATCH, folder: w.folder, job: JOB, brief: "Cut last night into a 45 second reel", effort: "best", ...over })
const finals = (w) => w.posts.filter((p) => p.path === `/dispatch/${DISPATCH}` && p.body.status !== "running")

test("the file: most words of the brief in its name, then the newest; never a hidden or other file", () => {
  const dir = temp("kt-files-")
  for (const name of ["interview.mp4", "sunday-vlog.mov", ".hidden-sunday.mp4", "sunday-notes.txt"]) writeFileSync(join(dir, name), "x")
  mkdirSync(join(dir, "sunday-folder.mp4"))
  assert.match(chooseFile(dir, "cut the Sunday vlog"), /sunday-vlog\.mov$/)
  utimesSync(join(dir, "interview.mp4"), new Date(), new Date(Date.now() + 60_000))
  assert.match(chooseFile(dir, "whatever is latest"), /interview\.mp4$/)
  assert.equal(chooseFile(temp("kt-empty-"), "x"), null)
})

test("the length, in the brief's own words", () => {
  assert.equal(secondsIn("a 45 s reel"), 45)
  assert.equal(secondsIn("make it 90 seconds"), 90)
  assert.equal(secondsIn("a 2-minute cut"), 120)
  assert.equal(secondsIn("a reel"), undefined)
  assert.equal(secondsIn("3 second teaser"), undefined)
  assert.equal(secondsIn("a 45 minute film"), undefined)
})

test("a make job starts from the brief; nothing to edit and a recipe not built fail plainly", async () => {
  const w = world()
  assert.deepEqual(await accept(w), { accepted: true })
  assert.deepEqual(w.started[0], { kind: "make", asset: "a1", brief: { effort: "best", targetDuration: 45 * 705_600_000 }, dispatch: DISPATCH, dispatchJob: JOB })
  // Handed over twice: one job
  await accept(w)
  assert.equal(w.started.length, 1)

  const empty = world()
  rmSync(join(empty.folder, "last-night-secret-client.mov"))
  assert.deepEqual(await accept(empty), { accepted: false, code: "no_media" })
  assert.deepEqual(finals(empty).map((p) => p.body), [{ status: "failed", result: { code: "no_media" } }])

  const recipe = world()
  assert.deepEqual(await accept(recipe, { recipe: "podcast" }), { accepted: false, code: "not_allowed" })
})

test("ET-TV: a finished job uploads its preview, then reports a fixed shape with no names", async () => {
  const puts = []
  const w = world({ put: async (url, init) => (puts.push({ url, type: init.headers["content-type"] }), new Response("{}")) })
  await accept(w)
  const request = w.started[0]
  await w.tavi.onUpdate(request, { id: "p1.1", status: "running", progress: 40 })
  const output = JSON.stringify({ verdict: "delivered_with_notes", file: w.master, notes: ["QG-04: a note about last-night-secret-client"], gates: [{ id: "QG-01", status: "passed" }, { id: "QG-04", status: "not_checked", message: "last-night-secret-client" }, { id: "QG-05", status: "failed", severity: "note" }, { id: "QG-09", status: "not_applicable" }] })
  await w.tavi.onUpdate(request, { id: "p1.1", status: "done", output })
  assert.deepEqual(puts, [{ url: "https://storage.example/u", type: "video/mp4" }])
  const reserve = w.posts.find((p) => p.path === `/editing/jobs/${JOB}/previews`)
  assert.equal(reserve.body.kind, "preview")
  assert.equal(reserve.body.bytes, "small master".length)
  assert.match(reserve.body.sha256, /^[0-9a-f]{64}$/)
  assert.equal(reserve.body.durationFlicks, 30 * 705_600_000)
  assert.ok(w.posts.some((p) => p.path === `/editing/jobs/${JOB}/previews/33333333-3333-4333-8333-333333333333`), "said it finished")
  const [done] = finals(w)
  assert.deepEqual(done.body, { status: "done", result: { outcome: "delivered_with_notes", gates: [{ gate: "QG-01", level: "pass" }, { gate: "QG-04", level: "unchecked" }, { gate: "QG-05", level: "note" }, { gate: "QG-09", level: "skipped" }], notes: 1 } })
  const running = w.posts.find((p) => p.body?.status === "running")
  assert.equal(running.body.result.percent, 40)
  assert.equal(running.body.result.stage, "editing")
  assert.ok(Number.isInteger(running.body.result.beat))
  assert.doesNotMatch(JSON.stringify(w.posts), /last-night|secret-client|Raw footage/, "no file name left the computer")
  assert.equal(w.tavi.pending(), 0)
})

test("no preview (no room, or a failed upload): the verdict still goes", async () => {
  const refused = async (path) => {
    if (path.endsWith("/previews")) throw new KriyaError(403, "cap_reached", "full")
    return null
  }
  const accepted = async (path) => (path.endsWith("/previews") ? { id: "33333333-3333-4333-8333-333333333333", uploadUrl: "https://storage.example/u" } : null)
  const unsafe = async (path) => (path.endsWith("/previews") ? { id: "33333333-3333-4333-8333-333333333333", uploadUrl: "http://evil.example/u" } : null)
  const puts = []
  for (const [send, put] of [
    [refused, async () => assert.fail("no room, no upload")],
    [accepted, async () => new Response("no", { status: 500 })],
    [unsafe, async (url) => (puts.push(url), new Response("{}"))],
  ]) {
    const posts = []
    const w = world({ put, send: (path, body) => (posts.push({ path, body }), send(path, body)) })
    await accept(w)
    await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "done", output: JSON.stringify({ verdict: "delivered", file: w.master, gates: [], notes: [] }) })
    assert.equal(posts.at(-1).body.status, "done")
    assert.ok(!posts.some((p) => /previews\/[0-9a-f-]{36}$/.test(p.path)), "no finished upload was claimed")
  }
  assert.deepEqual(puts, [], "a plain-http link off this machine is refused")
})

test("a job with no checked file, and one that failed, say so by code", async () => {
  const w = world()
  await accept(w)
  await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "done", output: JSON.stringify({ verdict: "not_checked", notes: [] }) })
  assert.deepEqual(finals(w).at(-1).body, { status: "failed", result: { code: "not_checked" } })

  const failed = world()
  await accept(failed)
  const error = Object.assign(new Error("the file /Users/x/secret.mov broke"), { reason: "low_disk" })
  await failed.tavi.onUpdate(failed.started[0], { id: "p1.1", status: "failed" }, error)
  assert.deepEqual(finals(failed).at(-1).body, { status: "failed", result: { code: "disk_low" } })
  assert.doesNotMatch(JSON.stringify(failed.posts), /secret/)
})

test("EH-17: canceled only after Kriya said canceling; a job it doesn't know answers false", async () => {
  const w = world()
  await accept(w)
  assert.equal(w.tavi.cancel({ dispatch: "99999999-9999-4999-8999-999999999999" }), false)
  assert.equal(w.tavi.cancel({ dispatch: DISPATCH }), true)
  assert.deepEqual(w.canceled, ["p1.1"])
  await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "canceled" })
  assert.deepEqual(finals(w).at(-1).body.status, "canceled")

  const here = world()
  await accept(here)
  await here.tavi.onUpdate(here.started[0], { id: "p1.1", status: "canceled" })
  assert.deepEqual(finals(here).at(-1).body, { status: "failed", result: { code: "stopped_on_computer" } })
})

test("a final report survives a closed lid and a restart, and is dropped only when refused for good", async () => {
  let offline = true
  const posts = []
  const send = async (path, body) => {
    if (offline) throw new TypeError("fetch failed")
    posts.push({ path, body })
    return null
  }
  const w = world({ send })
  await accept(w)
  await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "failed" }, { reason: "low_disk" })
  assert.equal(w.tavi.pending(), 1, "kept, and the Host won't go idle before it's said")

  // A new Host, the same home
  offline = false
  const again = createTavi({ home: w.home, projects: {}, jobs: () => ({}), tools: async () => ({}), log: () => {}, send, retryMs: 1e9, beatMs: 1e9 })
  await again.flush()
  assert.deepEqual(posts.map((p) => p.body.status), ["failed"])
  assert.equal(again.pending(), 0)
  again.close()

  const refused = world({ send: async () => { throw new KriyaError(404, "not_found", "Not found.") } })
  await accept(refused, { recipe: "podcast" })
  assert.equal(refused.tavi.pending(), 0)
})

test("the preview: a master that fits as it is; a bigger one at a bitrate that fits; never too big", async () => {
  const dir = temp("kt-prev-")
  const master = join(dir, "m.mp4")
  writeFileSync(master, Buffer.alloc(100))
  const capabilities = { encoders: new Set(["libx264"]) }
  assert.equal(await previewOf(master, { durationSeconds: 30, capabilities, work: dir, maxBytes: 200, run: async () => assert.fail("no render needed") }), master)

  const seen = []
  const smaller = await previewOf(master, {
    durationSeconds: 60,
    capabilities,
    work: join(dir, "w"),
    maxBytes: 50,
    run: async (tool, args) => {
      seen.push(tool, args)
      writeFileSync(args.at(-1), Buffer.alloc(10))
    },
  })
  assert.equal(seen[0], "ffmpeg")
  assert.ok(seen[1].includes("-b:v"), "a fixed bitrate")
  assert.ok(smaller.endsWith("preview-m.mp4"))
  assert.equal(await previewOf(master, { durationSeconds: 60, capabilities, work: join(dir, "w"), maxBytes: 5, run: async (_t, args) => writeFileSync(args.at(-1), Buffer.alloc(10)) }), null)
  // Hours of footage can't be made small enough at any honest bitrate
  assert.equal(await previewOf(master, { durationSeconds: 7 * 3600, capabilities, work: dir, maxBytes: 50, run: async () => assert.fail("no render") }), null)
})

test("the Host's socket routes: a whole job only; a cancel it doesn't know says so", async () => {
  const home = temp("kt-host-")
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: home, KRIYA_EDIT_IDLE_MS: "60000" }
  await ensureHost({ env, home })
  try {
    await assert.rejects(hostCall(home, "POST", "/internal/job", { dispatch: "x", folder: home, job: JOB, brief: "b", effort: "best" }), /isn't complete/)
    await assert.rejects(hostCall(home, "POST", "/internal/job", { dispatch: DISPATCH, folder: home, job: JOB, brief: "b", effort: "turbo" }), /isn't complete/)
    assert.deepEqual(await hostCall(home, "POST", "/internal/cancel", { dispatch: DISPATCH }), { known: false })
    assert.deepEqual(await hostCall(home, "POST", "/internal/cancel", { dispatch: "not-a-uuid" }), { known: false })
  } finally {
    await stopHost(home)
  }
})

/* ─────────────────────────── ED15: cards, notes, watch folders ──────────────────── */

const QUESTION = "44444444-4444-4444-8444-444444444444"

/** A Kriya whose card answers are set by the test. */
function reviewWorld(answers, { folderFiles = ["a.mp4", "b.mp4"], notes = [], cardRefused = false } = {}) {
  const asked = []
  const posts = []
  const w = world({
    send: async (path, body, { method = "POST" } = {}) => {
      posts.push({ path, method, body })
      if (path.endsWith("/questions")) {
        if (cardRefused) throw new KriyaError(404, "not_found", "Not found.")
        asked.push(body)
        return { id: QUESTION, expiresAt: new Date().toISOString() }
      }
      if (path.includes("/editing/questions/")) return answers()
      if (path.endsWith("/notes")) return { notes }
      return null
    },
  })
  rmSync(join(w.folder, "last-night-secret-client.mov"))
  for (const name of folderFiles) writeFileSync(join(w.folder, name), "x")
  return { ...w, asked, posts }
}
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((done) => setTimeout(done, 5))
  assert.ok(check(), "timed out")
}

test("ET-RV-01: two files that fit equally: a card; the answer starts the job on that file", async () => {
  const w = reviewWorld(() => ({ status: "answered", option: 1 }))
  const first = await accept(w, { brief: "cut the recording" })
  assert.deepEqual(first, { accepted: true }, "the daemon isn't kept waiting")
  await until(() => w.started.length === 1)
  assert.equal(w.asked[0].kind, "file")
  assert.equal(w.asked[0].defaultOption, 0)
  assert.equal(w.asked[0].options.length, 2)
  assert.ok(w.asked[0].timeoutSeconds > 0)
  assert.ok(w.asked[0].options[1].label.endsWith(".mp4"))
})

test("ET-RV-01: nobody answers: the default stands, and the report counts it", async () => {
  const w = reviewWorld(() => ({ status: "defaulted", option: 0 }))
  await accept(w, { brief: "cut the recording" })
  await until(() => w.started.length === 1)
  await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "done", output: JSON.stringify({ verdict: "delivered", file: w.master, gates: [], notes: [] }) })
  assert.equal(w.posts.findLast((p) => p.body?.status === "done").body.result.defaulted, 1)
})

test("cards off on this Kriya: the default at once, and no count, since nobody was asked", async () => {
  const w = reviewWorld(() => assert.fail("no card to wait on"), { cardRefused: true })
  await accept(w, { brief: "cut the recording" })
  await until(() => w.started.length === 1)
  await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "done", output: JSON.stringify({ verdict: "delivered", file: w.master, gates: [], notes: [] }) })
  assert.equal("defaulted" in w.posts.findLast((p) => p.body?.status === "done").body.result, false)
})

test("a brief that names a file asks nothing; one file asks nothing", async () => {
  const named = reviewWorld(() => assert.fail("no question"), { folderFiles: ["interview.mp4", "vlog.mp4"] })
  await accept(named, { brief: "cut the interview" })
  assert.equal(named.started.length, 1)
  assert.equal(named.asked.length, 0)
  const single = reviewWorld(() => assert.fail("no question"), { folderFiles: ["only.mp4"] })
  await accept(single, { brief: "cut it" })
  assert.equal(single.asked.length, 0)
})

test("cancelling while a card waits ends canceled, and starts nothing", async () => {
  const w = reviewWorld(() => ({ status: "open" }))
  await accept(w, { brief: "cut the recording" })
  await until(() => w.asked.length === 1)
  assert.equal(w.tavi.cancel({ dispatch: DISPATCH }), true)
  await until(() => w.posts.some((p) => p.body?.status === "canceled"))
  assert.equal(w.started.length, 0)
})

test("ET-RV-03: a revision takes the person's notes and the agent's change, in order", async () => {
  const notes = [{ id: "n1", atFlicks: 705_600_000, body: "Bigger here" }]
  const w = reviewWorld(() => assert.fail("no question"), { notes })
  w.state.log.current.deliverables = [{ id: "d1" }]
  await accept(w, { revisionOf: "55555555-5555-4555-8555-555555555555", change: "Tighter" })
  assert.deepEqual(w.started[0], { kind: "revise", notes: [{ at: 705_600_000, text: "Bigger here" }, { text: "Tighter" }], dispatch: DISPATCH, dispatchJob: JOB })
  await w.tavi.onUpdate(w.started[0], { id: "p1.1", status: "done", output: JSON.stringify({ verdict: "delivered", file: w.master, gates: [], notes: [], applied: 1, skipped: 1 }) })
  const { result } = w.posts.findLast((p) => p.body?.status === "done").body
  assert.equal(result.applied, 1)
  assert.equal(result.skipped, 1)
  assert.doesNotMatch(JSON.stringify(w.posts.filter((p) => p.path.includes("/dispatch/"))), /Bigger here|Tighter/, "the words aren't reported back")
})

test("two takes the index can't tell apart are a choice; clear winners and silence aren't", () => {
  const sentences = [
    { id: "s1", asset: "a1", score: 0.9, start: 0, end: 10 },
    { id: "s2", asset: "a1", score: 0.86, start: 20, end: 30 },
    { id: "s3", asset: "a1", score: 0.9, start: 40, end: 50 },
    { id: "s4", asset: "a1", score: 0.2, start: 60, end: 70 },
  ]
  const takes = [
    { group: "g1", sentence: "s1", rank: 1 },
    { group: "g1", sentence: "s2", rank: 2 },
    { group: "g2", sentence: "s3", rank: 1 },
    { group: "g2", sentence: "s4", rank: 2 },
  ]
  assert.deepEqual(closeTakes({ sentences, takes }, "a1").map((c) => c.group), ["g1"])
  assert.deepEqual(closeTakes({ sentences, takes }, "a9"), [])
})

test("ET-RV-05: adding a folder sends nothing; a new file is told once it settles, name and duration only", async () => {
  const home = temp("kt-watch-")
  const folder = join(home, "Raw")
  mkdirSync(folder)
  writeFileSync(join(folder, "old.mp4"), "x")
  assert.equal(watchFolder(folder, { home }), folder)
  assert.deepEqual(watchedFolders({ home }), [folder])
  const sent = []
  const watcher = createWatcher({ home, send: async (path, body) => sent.push({ path, body }), log: () => {}, probeFile: async () => ({ facts: { duration: 90 * 705_600_000 } }), tickMs: 1e9 })
  await watcher.tick()
  assert.deepEqual(sent, [], "what was there counts as old")

  writeFileSync(join(folder, "new talk.mp4"), "still being written")
  await watcher.tick()
  assert.deepEqual(sent, [], "not settled yet")
  writeFileSync(join(folder, "new talk.mp4"), "still being written, and longer")
  await watcher.tick()
  assert.deepEqual(sent, [], "it grew")
  await watcher.tick()
  assert.deepEqual(sent, [{ path: "/editing/found", body: { project: projectId(folder), name: "new talk.mp4", seconds: 90 } }])
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["name", "project", "seconds"], "nothing else leaves")
  await watcher.tick()
  assert.equal(sent.length, 1, "told once")
  assert.equal(folderId(folder), projectId(folder), "the same id the daemon offers")
  assert.equal(watcher.count(), 1, "the Host stays up for it")

  assert.equal(unwatchFolder(folder, { home }), true)
  assert.equal(watcher.count(), 0)
  writeFileSync(join(folder, "later.mp4"), "x")
  await watcher.tick()
  await watcher.tick()
  assert.equal(sent.length, 1, "off means off")
  watcher.close()
})

test("ET-RV-05: Kriya off: nothing is lost, and it's told when it comes back; never a whole home", async () => {
  const home = temp("kt-watch-off-")
  const folder = join(home, "Raw")
  mkdirSync(folder)
  watchFolder(realpathSync(folder), { home })
  let off = true
  const sent = []
  const watcher = createWatcher({
    home,
    send: async (_path, body) => {
      if (off) throw new KriyaError(404, "not_found", "Not found.")
      sent.push(body)
    },
    log: () => assert.fail("a 404 isn't worth a log line"),
    probeFile: async () => ({ facts: { duration: 705_600_000 } }),
    tickMs: 1e9,
  })
  writeFileSync(join(folder, "a.mov"), "x")
  await watcher.tick()
  await watcher.tick()
  off = false
  await watcher.tick()
  assert.equal(sent.length, 1)
  watcher.close()
  assert.throws(() => watchFolder(home, { home, personal: home }), /whole home/)
  assert.throws(() => watchFolder(join(home, "missing"), { home }), /ENOENT/)
})
