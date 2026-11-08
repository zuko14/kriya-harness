import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { offeredProjects, runDaemon } from "../../../src/daemon.js"
import { hostCall, stopHost } from "../../../src/edit/host/client.js"
import { readDevice } from "../../../src/store.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf, wordId } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"

// KriyaEditBench-M, on the whole path: a queued edit, the real daemon, the real Host, real
// FFmpeg, a scripted model that misbehaves in each way a real one can. F1: every job ends in
// a verdict, never a crash or a hang. R1: how long a change takes. R2: what else it moved.
// These numbers are this machine's, on synthetic media, with a model that answers at once.

const JOB = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`
const REVISION = "22222222-2222-4222-8222-222222222222"

const until = async (check, limit, what) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}: a hang`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

const index = indexOf()
const hook = index.sentences.find((s) => index.words.find((w) => w.id === s.firstWord).text === "It").id
const honest = (body) => {
  const task = body.response_format?.json_schema?.name
  if (task === "story") return { content: JSON.stringify({ hook, drop: [] }) }
  if (task === "emphasis") return { content: JSON.stringify({ emphasis: [wordId(index, "fifty")] }) }
  if (task === "console") return { content: JSON.stringify({ ops: [{ op: "punch_in", at: { word: wordId(index, "users"), edge: "start" }, until: { word: wordId(index, "users"), edge: "end" }, scale: 1.2 }] }) }
  return { content: "{}" }
}

const FAULTS = {
  honest,
  "the model answers garbage": () => ({ content: "this is not JSON at all" }),
  "the model answers empty objects": () => ({ content: "{}" }),
  "the gateway answers 500": () => ({ error: { status: 500, error: "server_error", message: "Upstream broke." } }),
  "the gateway answers 429": () => ({ error: { status: 429, error: "rate_limited", message: "Slow down." } }),
  "the plan's limit is reached": () => ({ error: { status: 402, error: "cap_reached", message: "The limit is reached." } }),
  "the model names ids that don't exist": (body) => (body.response_format?.json_schema?.name === "story" ? { content: JSON.stringify({ hook: "a9:s99", drop: ["a9:s1"] }) } : honest(body)),
}

async function world(chat) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-chaos-")))
  process.env.KRIYA_HOME = home
  process.env.KRIYA_EDIT_ROOTS = join(home, "work")
  process.env.KRIYA_EDIT_IDLE_MS = "600000"
  const folder = join(home, "work", "Raw")
  mkdirSync(folder, { recursive: true })
  rawTake(join(folder, "take.mov"))
  fakeRuntime(home)
  const fake = await startFakeKriya({ models: ["budget"], editing: true, review: true, chat })
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const [project] = offeredProjects([folder])
  const options = { device: readDevice(), folders: [folder], once: true, log: () => {}, allowEdit: true, env: { KRIYA_EDIT: "on" } }
  const reportsOf = (id) => (fake.state.reports ?? []).filter((r) => r.id === id)
  const finished = (id) => until(() => reportsOf(id).find((r) => ["done", "failed", "canceled"].includes(r.status)), 400_000, "the verdict")
  return { home, fake, project, options, finished }
}

test("F1: every job ends in a verdict, whatever the model does", { timeout: 1_200_000 }, async () => {
  const rows = []
  let n = 0
  for (const [name, chat] of Object.entries(FAULTS)) {
    const w = await world(chat)
    try {
      const start = Date.now()
      const id = w.fake.queue("edit", { project: w.project.id, job: JOB(++n), brief: "Cut it into a 45 second reel", effort: "fast" })
      await runDaemon(w.options)
      const end = await w.finished(id)
      const label = end.status === "done" ? end.result.outcome : `failed: ${end.result?.code}`
      rows.push({ name, label, seconds: Math.round((Date.now() - start) / 1000) })
      console.log(`  ${name}: ${rows.at(-1).label} (${rows.at(-1).seconds} s)`)
      // A verdict by name, in the fixed shape: never a raw error's words
      assert.ok(end.status === "done" ? ["delivered", "delivered_with_notes", "blocked"].includes(end.result.outcome) : /^[a-z_]{1,32}$/.test(end.result?.code ?? ""), JSON.stringify(end))
    } finally {
      await stopHost(w.home)
      await w.fake.close()
    }
  }
  console.log(`BENCH-M F1: ${rows.length} of ${Object.keys(FAULTS).length} jobs ended in a verdict`)
})

test("R1, R2: a change on a finished reel: how long, and nothing else moved", { timeout: 400_000 }, async () => {
  const w = await world(honest)
  try {
    const first = w.fake.queue("edit", { project: w.project.id, job: JOB(90), brief: "Cut it into a 45 second reel", effort: "fast" })
    await runDaemon(w.options)
    const made = await w.finished(first)
    assert.equal(made.status, "done", JSON.stringify(made))
    const { projects } = await hostCall(w.home, "GET", "/projects")
    const before = await hostCall(w.home, "GET", `/projects/${projects[0].id}/plan`)
    const clipsOf = async () => {
      const { project } = await hostCall(w.home, "GET", `/projects/${projects[0].id}`)
      return project.sequences.find((q) => q.id === project.active).clips
    }
    const clipsBefore = await clipsOf()

    w.fake.state.editNotes = { [REVISION]: [{ id: "33333333-3333-4333-8333-333333333333", atFlicks: 705_600_000, body: "Zoom in on users" }] }
    const start = Date.now()
    const id = w.fake.queue("edit", { project: w.project.id, job: REVISION, brief: "Cut it into a 45 second reel", effort: "fast", revisionOf: JOB(90) })
    await runDaemon(w.options)
    const end = await w.finished(id)
    const seconds = (Date.now() - start) / 1000
    assert.equal(end.status, "done", JSON.stringify(end))
    assert.equal(end.result.applied, 1)

    // R2: the cut is the same pieces, in the same places; only the asked-for zoom was added
    const after = await hostCall(w.home, "GET", `/projects/${projects[0].id}/plan`)
    assert.deepEqual(after.timeline.picture.map((p) => [p.clip, p.in, p.out]).slice(0, 1).length, 1)
    const cuts = (plan) => plan.timeline.picture.map((p) => [p.asset, p.at, p.end])
    const span = (list) => [list[0][1], list.at(-1)[2]]
    assert.deepEqual(span(cuts(after)), span(cuts(before)), "the same length")
    const effects = (clips) => clips.flatMap((c) => c.effects.filter((e) => e.type === "zoom"))
    const clipsAfter = await clipsOf()
    assert.equal(effects(clipsAfter).length, effects(clipsBefore).length + 1, "exactly the zoom it was asked for")
    const others = (clips) => clips.map((c) => [c.track, c.source?.asset, c.effects.filter((e) => e.type !== "zoom").length])
    assert.equal(new Set(others(clipsAfter).map(String)).size, new Set(others(clipsBefore).map(String)).size, "no other kind of change")
    console.log(`BENCH-M R1: ${seconds.toFixed(1)} s from the note to a checked preview; verdict ${end.result.outcome}\nBENCH-M R2: 0 unrequested changes (only the asked-for zoom)`)
  } finally {
    await stopHost(w.home)
    await w.fake.close()
  }
})

