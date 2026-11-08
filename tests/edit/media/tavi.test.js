import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { offeredProjects, runDaemon } from "../../../src/daemon.js"
import { hostCall, stopHost } from "../../../src/edit/host/client.js"
import { createTaste } from "../../../src/edit/host/taste.js"
import { createTavi } from "../../../src/edit/host/tavi.js"
import { createWatcher, watchFolder } from "../../../src/edit/host/watch.js"
import { readDevice } from "../../../src/store.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf, wordId } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"

// ET-TV, end to end on the computer's side: Kriya queues an edit, the real daemon hands it
// over and is done with it, the real Host makes the cut with the real FFmpeg and a
// scripted model, uploads a preview, and reports. Nothing here is a stand-in but Kriya.

const JOB = "11111111-1111-4111-8111-111111111111"

const until = async (check, limit, what) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

test("ET-TV: a queued edit comes back as a checked preview in Storage, and the daemon holds nothing", { timeout: 400_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-tavi-")))
  process.env.KRIYA_HOME = home
  process.env.KRIYA_EDIT_ROOTS = join(home, "work")
  process.env.KRIYA_EDIT_IDLE_MS = "600000"
  const folder = join(home, "work", "Raw footage")
  mkdirSync(folder, { recursive: true })
  rawTake(join(folder, "secret-client-take.mov"))
  fakeRuntime(home)

  const index = indexOf()
  const hook = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "It").id
  const fake = await startFakeKriya({
    models: ["budget"],
    editing: true,
    review: true,
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "story") return { content: JSON.stringify({ hook, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [wordId(index, "fifty"), wordId(index, "week.")] }) }
      // The console: it can mark a moment; bigger captions aren't an operation it has
      if (task === "console") return { content: JSON.stringify(JSON.stringify(body.messages).includes("Mark this moment") ? { ops: [{ op: "mark", name: "From the note", at: { word: wordId(index, "fifty"), edge: "start" } }] } : { ops: [] }) }
      return { content: "{}" }
    },
  })
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const [project] = offeredProjects([folder])
  // ET-TST-01 on a real job: a rule the person confirmed earlier shapes this cut, and says so
  const taste = createTaste({ home })
  taste.note("earlier-1", [{ op: "punch_in", at: 0, scale: 1.3 }], "e1")
  taste.note("earlier-2", [{ op: "punch_in", at: 0, scale: 1.3 }], "e2")
  assert.equal(taste.confirm("zoom:1.30"), true)
  const options = { device: readDevice(), folders: [folder], once: true, log: () => {}, allowEdit: true, env: { KRIYA_EDIT: "on" } }
  try {
    const id = fake.queue("edit", { project: project.id, job: JOB, brief: "Cut it into a 45 second reel", effort: "best" })
    // One poll, and the daemon is done: the Host owns the job from here (EH-02, EH-05)
    await runDaemon(options)
    assert.equal(fake.state.hello.capabilities.edit, true)
    const reports = () => fake.state.reports.filter((r) => r.id === id)
    await until(() => reports().some((r) => ["done", "failed"].includes(r.status)), 270_000, "the edit")
    const final = reports().at(-1)
    assert.equal(final.status, "done", JSON.stringify(final))
    console.log(`ET-TV reports: ${reports().map((r) => r.status + (r.result?.percent !== undefined ? ` ${r.result.percent}%` : "")).join(", ")}; verdict ${final.result.outcome}`)
    assert.ok(["delivered", "delivered_with_notes"].includes(final.result.outcome), final.result.outcome)
    assert.ok(final.result.gates.some((g) => g.gate === "QG-01" && g.level === "pass"))
    assert.ok(reports().some((r) => r.status === "running" && r.result?.stage === "editing"), "progress was reported")

    // The preview is this job's, finished, and the real file
    const [preview] = fake.state.previews
    assert.equal(preview.job, JOB)
    assert.equal(preview.finished, true)
    const bytes = fake.state.uploads[preview.id]
    assert.equal(bytes.length, preview.bytes)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), preview.sha256)
    assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp")
    assert.ok(bytes.length <= 47_185_920)
    const seconds = preview.durationFlicks / 705_600_000
    assert.ok(seconds >= 30 && seconds <= 60, `${seconds} s`)
    console.log(`ET-TV preview: ${bytes.length} bytes, ${seconds.toFixed(1)} s`)

    const { projects: made } = await hostCall(home, "GET", "/projects")
    const { project: cut } = await hostCall(home, "GET", `/projects/${made[0].id}`)
    const zooms = cut.sequences.find((q) => q.id === cut.active).clips.flatMap((c) => c.effects.filter((e) => e.type === "zoom"))
    assert.ok(zooms.length > 0 && zooms.every((z) => z.scale === 1.3), `the rule's zoom: ${JSON.stringify(zooms.map((z) => z.scale))}`)

    // Nothing with a name left for Kriya, except the model's own calls through the gateway
    const sent = fake.state.requests.filter((r) => r.path !== "/chat/completions")
    assert.doesNotMatch(JSON.stringify(sent.map((r) => [r.path, r.body])), /secret-client|Raw footage\/secret/)

    // A second job, cancelled while it runs: the daemon forwards, the Host stops and reports
    const second = fake.queue("edit", { project: project.id, job: "22222222-2222-4222-8222-222222222222", brief: "Another 45 second reel", effort: "best" })
    await runDaemon(options)
    fake.state.dispatches.find((d) => d.id === second).status = "canceling"
    await runDaemon(options)
    await until(() => fake.state.reports.some((r) => r.id === second && ["canceled", "done", "failed"].includes(r.status)), 60_000, "the cancel")
    const end = fake.state.reports.filter((r) => r.id === second).at(-1)
    assert.ok(["canceled", "done"].includes(end.status), JSON.stringify(end))
    console.log(`ET-TV cancel: the Host reported ${end.status}`)

    // ET-RV-03: a revision from notes, on the same project. One note the model can do, pinned
    // to the word it was made at; one it can't, counted and left for the person
    const revision = "33333333-3333-4333-8333-333333333333"
    ;(fake.state.editNotes ??= {})[revision] = [
      { id: "44444444-4444-4444-8444-444444444444", atFlicks: 2 * 705_600_000, body: "Mark this moment" },
      { id: "55555555-5555-4555-8555-555555555555", atFlicks: 8 * 705_600_000, body: "Make the captions bigger" },
    ]
    const third = fake.queue("edit", { project: project.id, job: revision, brief: "Cut it into a 45 second reel", effort: "best", revisionOf: JOB })
    await runDaemon(options)
    await until(() => fake.state.reports.some((r) => r.id === third && ["done", "failed"].includes(r.status)), 200_000, "the revision")
    const revised = fake.state.reports.filter((r) => r.id === third).at(-1)
    assert.equal(revised.status, "done", JSON.stringify(revised))
    console.log(`ET-RV-03 revision: ${JSON.stringify({ outcome: revised.result.outcome, applied: revised.result.applied, skipped: revised.result.skipped })}`)
    assert.equal(revised.result.applied, 1)
    assert.equal(revised.result.skipped, 1)
    assert.ok(["delivered", "delivered_with_notes", "blocked"].includes(revised.result.outcome))
    const { projects } = await hostCall(home, "GET", "/projects")
    const { project: edited } = await hostCall(home, "GET", `/projects/${projects[0].id}`)
    const pins = edited.sequences.find((q) => q.id === edited.active).markers.filter((m) => m.name.startsWith("Note: "))
    assert.deepEqual(pins.map((m) => m.name), ["Note: Mark this moment", "Note: Make the captions bigger"])
    assert.ok(pins.every((m) => typeof m.at.word === "string"), "each note is anchored to a word, not a time")
    assert.ok(fake.state.previews.some((p) => p.job === revision && p.finished), "the new cut's preview went up")
  } finally {
    await stopHost(home)
    await fake.close()
  }
})

test("ET-RV-01, -05 on real files: two takes become two real clips on a card; a real recording is told by its real length", { timeout: 120_000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-cards-")))
  const folder = join(home, "Raw footage")
  mkdirSync(folder)
  const source = join(folder, "take.mov")
  rawTake(source)

  // Two takes the index can't tell apart
  const sentences = [
    { id: "s1", asset: "a1", score: 0.9, start: 705_600_000, end: 4 * 705_600_000 },
    { id: "s2", asset: "a1", score: 0.88, start: 5 * 705_600_000, end: 8 * 705_600_000 },
  ]
  const takes = [
    { group: "g1", sentence: "s1", rank: 1 },
    { group: "g1", sentence: "s2", rank: 2 },
  ]
  const uploads = new Map()
  const cards = []
  const send = async (path, body) => {
    if (path.endsWith("/previews")) {
      const id = crypto.randomUUID()
      uploads.set(id, { ...body })
      return { id, uploadUrl: `https://storage.example/${id}` }
    }
    if (path.endsWith("/questions")) {
      cards.push(body)
      return { id: "66666666-6666-4666-8666-666666666666" }
    }
    if (path.includes("/editing/questions/")) return { status: "answered", option: 1 }
    return null
  }
  const tavi = createTavi({
    home,
    projects: {},
    jobs: () => ({}),
    tools: async () => ({ capabilities: { encoders: new Set(["libx264"]) } }),
    log: () => {},
    send,
    put: async (url, init) => {
      const chunks = []
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk))
      uploads.get(url.split("/").at(-1)).bytesSent = Buffer.concat(chunks)
      return new Response("{}")
    },
    beatMs: 1e9,
    retryMs: 1e9,
  })
  await tavi.onUpdate({ dispatch: JOB, dispatchJob: JOB }, { id: "p1.1", status: "running", progress: 0 })
  const picks = await tavi.chooseTakes({ dispatch: JOB, dispatchJob: JOB }, { index: { sentences, takes } }, "a1", { sourcePath: () => source })
  tavi.close()
  assert.deepEqual(picks, { g1: "s2" }, "the person's answer picks the take")
  assert.equal(cards[0].kind, "take")
  assert.deepEqual(cards[0].options.map((o) => o.label), ["Take 1", "Take 2"])
  for (const option of cards[0].options) {
    const clip = uploads.get(option.clip)
    assert.equal(clip.kind, "clip")
    assert.equal(clip.bytesSent.subarray(4, 8).toString("latin1"), "ftyp")
    assert.equal(clip.bytesSent.length, clip.bytes)
    assert.equal(createHash("sha256").update(clip.bytesSent).digest("hex"), clip.sha256)
    assert.ok(clip.bytes < 2 * 1024 * 1024, `${clip.bytes} bytes for a few seconds`)
    assert.equal(clip.durationFlicks, 3 * 705_600_000)
  }

  // The watcher, on the same real file, with the real probe
  const later = join(home, "Later")
  mkdirSync(later)
  watchFolder(later, { home })
  renameSync(source, join(later, "Sunday talk.mov"))
  const told = []
  const watcher = createWatcher({ home, send: async (path, body) => told.push({ path, body }), log: () => {}, tickMs: 1e9 })
  await watcher.tick()
  await watcher.tick()
  watcher.close()
  assert.deepEqual(told.map((t) => t.body.name), ["Sunday talk.mov"])
  assert.ok(told[0].body.seconds > 10, `${told[0].body.seconds} s`)
  console.log(`ET-RV-05 told: ${JSON.stringify(told[0].body)}`)
})
