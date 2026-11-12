import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { chromium } from "playwright-core"

import { browserTarget } from "../../../src/browser.js"
import { apply } from "../../../src/edit/core/ops.js"
import { newProject } from "../../../src/edit/core/project.js"
import { measureDraft, timelineOf, viewerReport } from "../../../src/edit/director/viewer.js"
import { watchAndFix } from "../../../src/edit/director/watch-fix.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { motionRuntime } from "../../../src/edit/engine/motion.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runTool } from "../../../src/edit/engine/tool.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { hostHeaders, socketPath } from "../../../src/edit/host/paths.js"
import { buildStudio } from "../../../studio/build.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { ROOT } from "../../helpers.js"
import { indexOf } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// TP8 on the real FFmpeg and Chrome (TOP_TIER_PLAN §4, §5). ET-DL-M1: a draft seeded with a still stretch, a
// crowded moment and a repeated cutaway is rendered; the Viewer's Report finds each from the file and its
// timeline, and the typed fixes, rendered again, clear them with a higher score. A fix that lowers the score is
// rendered and dropped (EH-74). Through a real Host and a fake Kriya: with no `balanced` listed nothing
// escalates; listed and refused, the budget answer stands and the make finishes (ET-DL-08). The Variations
// wall and the Director's notes in Chrome at 1280 and 360 px, light and dark. TP8_SHOTS=<folder> keeps screenshots.

const F = 705_600_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-dl-")))
const shots = process.env.TP8_SHOTS
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args])
const kinds = (report) => [...new Set(report.findings.map((f) => f.kind))].sort()

/**
 * The scripted take's voice over a still picture: colour bars with one small square drifting across the middle
 * (inside a 9:16 crop of the frame), so it
 * reads as still (measured 2026-11-11: 0.036 mean difference) and is never frozen, even after a lossy draft
 * encode; noise alone was wiped out by the draft's encoder and froze (QG-07).
 */
function stillTake(file) {
  const voice = join(dir, `voice-${Math.random().toString(36).slice(2)}.mov`)
  rawTake(voice)
  ffmpeg("-f", "lavfi", "-i", "smptebars=s=640x360:r=30", "-f", "lavfi", "-i", "color=c=white:s=40x40:r=30", "-i", voice, "-filter_complex", "[0][1]overlay=x='220+t*30-180*floor(t/6)':y=150:shortest=0,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-crf", "18", "-g", "30", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "copy", "-shortest", file)
}
/** A moving clip of the person's own, as B-roll. */
const brollClip = (file, source) => ffmpeg("-f", "lavfi", "-t", "12", "-i", `${source}=s=640x360:r=30`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", file)

let take, b1, b2
before(() => {
  take = join(dir, "take.mov")
  b1 = join(dir, "street.mov")
  b2 = join(dir, "coffee.mov")
  stillTake(take)
  brollClip(b1, "testsrc2")
  brollClip(b2, "mandelbrot")
})

async function engineWorld(ops) {
  const home = join(dir, "home")
  const runtime = motionRuntime(linkMotion(home, { hyperframes: false }))
  const root = realpathSync(mkdtempSync(join(dir, "p-")))
  const index = indexOf("a1")
  const assets = []
  for (const [id, path, role] of [["a1", take], ["b1", b1, "broll"], ["b2", b2, "broll"]]) assets.push({ op: "add_asset", id, kind: "video", fingerprint: sha(path), path, linked: true, rights: "own", facts: (await probe(path)).facts, ...(role ? { role } : {}) })
  const made = apply(apply(newProject({ id: "p", name: "Watch" }), assets, { author: "code" }).project, [{ op: "set_format", width: 640, height: 360, fps: { n: 30, d: 1 } }, { op: "keep_range", asset: "a1", from: 0, to: 20 * F }, ...ops], { index, author: "agent" })
  assert.deepEqual(made.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities: await readCapabilities(), motion: () => runtime })
  engine.load(made.project, index)
  const sources = { a1: take, b1, b2 }
  const render = (project) => engine.render({ quality: "draft", project })
  // The gates a draft can be held to: it plays whole, sound and picture line up, the cuts are clean, the picture is healthy
  const check = (file, plan, project) => runGates({ file, plan, project, index, sourcePath: (id) => sources[id], only: ["QG-02", "QG-03", "QG-05", "QG-07"], work: join(root, "gates") })
  const view = async (attempt) => {
    const timeline = timelineOf(attempt.project, index)
    return { timeline, report: viewerReport({ timeline, measured: await measureDraft(attempt.file, { run: runTool, duration: attempt.plan.duration }) }) }
  }
  const first = await render(made.project)
  const start = { project: made.project, ops: [], file: first.file, plan: first.plan, checked: await check(first.file, first.plan, made.project) }
  return { index, render, check, view, start }
}

// A still stretch (no change from 5 to 10 s and 15 to 20 s), three graphics at once at 7 s, and the same B-roll's opening seconds twice
const SEEDED = [
  { op: "place_broll", asset: "b1", at: 2 * F, in: 0, duration: 2 * F },
  { op: "place_broll", asset: "b1", at: 12 * F, in: 0, duration: 2 * F },
  { op: "add_title", text: "ONE", at: 7 * F, duration: 2 * F },
  { op: "add_lower_third", text: "Two", at: Math.round(7.3 * F), duration: 2 * F },
  { op: "add_title", text: "THREE", at: Math.round(7.6 * F), duration: Math.round(1.2 * F) },
]

test("ET-DL-M1: a still stretch, a crowded moment and a repeated cutaway are each found in the rendered draft and fixed; the score rises", { skip: chromeSkip(), timeout: 600_000 }, async () => {
  const w = await engineWorld(SEEDED)
  const started = Date.now()
  const seen = await w.view(w.start)
  const took = Date.now() - started
  console.log(`ET-DL-M1 report (${took} ms to watch a ${(w.start.plan.duration / F).toFixed(1)} s draft): score ${seen.report.score}; ${seen.report.findings.map((f) => `${f.kind}@${(f.at / F).toFixed(1)}`).join(" ")}; windows ${JSON.stringify(seen.report.windows.map(({ changes, motion, text, loudness }) => ({ changes, motion, text, loudness })))}`)
  console.log(`ET-DL-M1 gates before: ${w.start.checked.gates.map((g) => `${g.id}:${g.status}`).join(" ")}`)
  for (const kind of ["crowded", "dull", "repeated_cutaway"]) assert.ok(kinds(seen.report).includes(kind), `the report finds ${kind}`)
  assert.ok(seen.report.windows.every((x) => x.motion !== null && x.motion < 1), "the take reads as still in the file itself")
  const result = await watchAndFix(w.start, { index: w.index, view: w.view, render: w.render, check: async (...args) => { const checked = await w.check(...args); console.log(`ET-DL-M1 gates of the fixed draft: ${checked.gates.map((g) => `${g.id}:${g.status}${g.status === "failed" ? ` (${g.message})` : ""}`).join(" ")}`); return checked } })
  console.log(`ET-DL-M1 rounds: ${JSON.stringify(result.rounds)}`)
  console.log(`ET-DL-M1 gates after: ${result.best.checked.gates.map((g) => `${g.id}:${g.status}`).join(" ")}`)
  assert.ok(result.rounds.length >= 1 && result.rounds.length <= 2, "two rounds at most")
  assert.equal(result.rounds[0].kept, true, result.rounds[0].reason)
  assert.ok(result.best.report.score > seen.report.score, `${seen.report.score} → ${result.best.report.score}`)
  const fixed = result.rounds[0].fixes.map((f) => f.kind)
  for (const kind of ["crowded", "dull", "repeated_cutaway"]) assert.ok(fixed.includes(kind), `a typed fix for ${kind}`)
  const after = kinds(result.best.report)
  for (const kind of ["crowded", "repeated_cutaway"]) assert.ok(!after.includes(kind), `${kind} is gone from the rendered draft`)
  assert.ok(result.best.report.findings.filter((f) => f.kind === "dull").length < seen.report.findings.filter((f) => f.kind === "dull").length, "fewer still windows")
  // Re-measured from the new file, not assumed: the punch-ins moved the picture where it was still
  assert.notEqual(result.best.file, w.start.file)
  // Gates no worse than before: a fix never trades a passing gate for a failing one
  const passed = (checked) => new Set(checked.gates.filter((g) => g.status === "passed").map((g) => g.id))
  for (const id of passed(w.start.checked)) assert.ok(passed(result.best.checked).has(id), `${id} still passes`)
})

test("ET-DL-M1 (EH-74): a fix that lowers the score is rendered, measured and dropped; the cut stays as it was", { skip: chromeSkip(), timeout: 600_000 }, async () => {
  const w = await engineWorld([{ op: "place_broll", asset: "b1", at: 2 * F, in: 0, duration: 2 * F }, { op: "place_broll", asset: "b2", at: 7 * F, in: 0, duration: 2 * F }, { op: "punch_in", at: 11 * F, duration: 2 * F, scale: 1.15 }])
  // One still window (15 to 20 s) gives the loop a finding; the "fix" offered for it is harmful: three graphics on top of each other, and the same B-roll again
  const harmful = () => ({ fixes: [{ kind: "test", at: 0, why: "Crowded it.", ops: [{ op: "add_title", text: "A", at: 3 * F, duration: 2 * F }, { op: "add_title", text: "B", at: Math.round(3.2 * F), duration: 2 * F }, { op: "add_lower_third", text: "C", at: Math.round(3.4 * F), duration: 2 * F }, { op: "place_broll", asset: "b1", at: 12 * F, in: 0, duration: 2 * F }] }], left: [] })
  let renders = 0
  const result = await watchAndFix(w.start, { index: w.index, view: w.view, render: (p) => (renders++, w.render(p)), check: w.check, fixes: harmful })
  console.log(`ET-DL-M1 (EH-74): ${JSON.stringify(result.rounds)}`)
  assert.equal(renders >= 1, true, "the fix was really rendered")
  assert.equal(result.rounds[0].kept, false)
  assert.ok(result.rounds[0].score < result.rounds[0].was, `${result.rounds[0].was} → ${result.rounds[0].score}`)
  assert.equal(result.best.file, w.start.file, "the draft that stays is the one before the fix")
  assert.equal(result.best.project, w.start.project)
})

/* Through a real Host, a fake Kriya and the Studio */

const until = async (check, limit = 600_000, what = "a condition") => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 200))
  }
}
const status = (home, method, path) =>
  new Promise((done, fail) => {
    const req = request({ socketPath: socketPath(home), method, path, headers: { ...hostHeaders(home), "content-type": "application/json" } }, (res) => (res.resume(), res.on("end", () => done(res.statusCode))))
    req.on("error", fail)
    req.end(method === "GET" ? undefined : "{}")
  })

async function hostWorld({ directorLoop }) {
  await buildStudio()
  const sent = []
  const script = {
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent: false, directorLoop },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      sent.push({ task, model: body.model })
      // A refused tier, as Kriya refuses one the plan doesn't allow (2026-11-03)
      if (body.model === "balanced") return { error: { status: 400, error: "tier_not_allowed", message: "That model tier isn't on your plan." } }
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      // Fits its schema, fails its check: words that aren't in the cut, every time
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: ["a1:w9999"] }) }
      return { content: "{}" }
    },
  }
  const fake = await startFakeKriya(script)
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-dlh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  fakeRuntime(home)
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  // One B-roll file: the reel's cutaways all come from it, back to back, which the Director's watch finds
  const files = { take: join(folder, "take.mov"), street: join(folder, "street.mov") }
  execFileSync("cp", [take, files.take])
  execFileSync("cp", [b1, files.street])
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const a = await call("POST", `/projects/${id}/assets`, { path: files.take })
  await call("POST", `/projects/${id}/assets`, { path: files.street })
  const job = async (started) => {
    const done = await until(async () => (await call("GET", "/jobs")).jobs.find((j) => j.id === started.id && ["done", "failed", "canceled"].includes(j.status)), 600_000, `job ${started.id}`)
    assert.equal(done.status, "done", done.error)
    return JSON.parse(done.output)
  }
  return { home, host, call, id, take: a.id, fake, script, sent, job }
}
const endHost = async (w, browser) => {
  await browser?.close()
  await stopHost(w.home)
  await w.fake.close()
}
const smallTargets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, select, textarea, video, [role=option]")]
      .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
      .map((el) => ({ el: el.getAttribute("aria-label") || el.id || el.textContent || el.className, ...el.getBoundingClientRect().toJSON() }))
      .filter((r) => r.height < 44 || r.width < 44)
      .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
  )
const shoot = async (page, name, target = null) => shots && (mkdirSync(shots, { recursive: true }), await (target ?? page).screenshot({ path: join(shots, `${name}.png`), ...(target ? {} : { fullPage: true }) }))

test("ET-DL-08 and the Variations wall: no balanced listed, nothing escalates; listed and refused, the budget answer stands; three openings in Chrome, one picked, the Director's notes; 1280 and 360 px, light and dark", { skip: browserTarget() ? false : "no Chrome on this computer", timeout: 1_500_000 }, async () => {
  const w = await hostWorld({ directorLoop: true })
  let browser = null
  try {
    const view = await w.call("GET", `/projects/${w.id}`)
    assert.equal(view.directorLoop, true)

    // 1. The plan lists only budget: the emphasis slot fails its check twice and takes its default; balanced is never sent
    const first = await w.job(await w.call("POST", `/projects/${w.id}/make`, { asset: w.take, brief: { broll: "own" } }))
    console.log(`ET-DL-08 (budget only): verdict ${first.verdict}; attempts ${JSON.stringify(first.attempts)}; notes ${JSON.stringify(first.notes)}; watch ${JSON.stringify(first.watch)}; sent ${JSON.stringify(w.sent)}`)
    assert.ok(!w.sent.some((s) => s.model === "balanced"), "no tier the plan doesn't list")
    const asked = w.sent.filter((s) => s.task === "emphasis")
    assert.ok(asked.length >= 2 && asked.length % 2 === 0 && asked.every((s) => s.model === "budget"), "each attempt's slot asked twice on budget, as before")
    assert.ok(first.watch, "the Director watched the cut")
    assert.ok(first.changes.some((c) => c.startsWith("Director:")) || first.notes.some((n) => n.startsWith("Director:")), "and says what it did")

    // 2. The plan now lists balanced, but Kriya refuses it: one escalation per failing slot, refused, and the make ends as
    // it would have. Started over, so its story and emphasis are asked again rather than kept from the last cut
    w.script.models = ["budget", "balanced"]
    w.sent.length = 0
    const second = await w.job(await w.call("POST", `/projects/${w.id}/make`, { asset: w.take, brief: { broll: "own", fresh: true } }))
    console.log(`ET-DL-08 (balanced listed, refused): verdict ${second.verdict}; watch ${JSON.stringify(second.watch)}; sent ${JSON.stringify(w.sent)}`)
    const emphasis = w.sent.filter((s) => s.task === "emphasis")
    // Per attempt of the make: two on budget, then one on the listed tier, refused
    assert.ok(emphasis.length >= 3 && emphasis.length % 3 === 0, JSON.stringify(emphasis))
    for (let i = 0; i < emphasis.length; i += 3) assert.deepEqual(emphasis.slice(i, i + 3).map((s) => s.model), ["budget", "budget", "balanced"])
    assert.ok(w.sent.filter((s) => s.model === "balanced").every((s) => s.task === "emphasis"), "only the slot that failed its check twice")
    assert.ok(second.notes.some((n) => /Emphasis: The model's answer didn't fit, twice/.test(n)), "the budget answer and its reason, as without escalation")
    assert.notEqual(second.verdict, "not_checked", "the make finished")
    w.sent.length = 0

    browser = await chromium.launch({ ...browserTarget(), headless: true })
    const problems = []
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
    page.on("pageerror", (error) => problems.push(String(error)))
    const { url } = await w.call("POST", "/internal/launch", {})
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio)
    await page.evaluate(() => window.__studio.setMode("direct"))
    // The redesign's Kriya panel: openings and the make are on its Brief tab
    await page.getByRole("tab", { name: /^Brief/ }).click()

    // Three openings, drawn by code and rendered as drafts; no model call for them
    await page.getByRole("button", { name: "Give me three openings" }).click()
    await page.locator("#openings-wall").waitFor({ timeout: 600_000 })
    assert.equal(w.sent.length, 0, "the openings asked no model")
    const cards = page.locator(".opening")
    assert.equal(await cards.count(), 3)
    const films = await page.locator(".opening-film").evaluateAll((els) => els.map((v) => v.getAttribute("src")))
    for (const src of films) {
      const durations = await page.evaluate(async (s) => {
        const v = document.createElement("video")
        v.src = s
        await new Promise((ok, no) => ((v.onloadedmetadata = ok), (v.onerror = no)))
        return v.duration
      }, src)
      assert.ok(durations > 3 && durations <= 9.5, `${src}: ${durations} s`)
    }
    const words = await page.locator(".opening-words").allInnerTexts()
    assert.equal(new Set(words).size, 3, "three different openings")
    await page.locator("#opening-use-1").click()
    assert.equal(await page.locator("#opening-use-1").getAttribute("aria-pressed"), "true")
    assert.equal(await page.locator("#opening-use-0").getAttribute("aria-pressed"), "false")
    await page.waitForFunction(() => [...document.querySelectorAll(".opening-film")].every((v) => v.readyState >= 2), null, { timeout: 30_000 })
    await shoot(page, "1280-light-wall")
    // A film is only ever streamed by its job's record
    const number = films[0].split("/")[4]
    assert.equal(await status(w.home, "GET", `/projects/${w.id}/openings/${number}/7`), 404)
    assert.equal(await status(w.home, "GET", `/projects/${w.id}/openings/1/0`), 404, "a job that isn't an openings job")

    // The make, from the Studio, opening on the line picked: the Director's notes land in What I did
    await page.locator("#make-broll").check()
    await page.getByRole("button", { name: "Make it" }).click()
    await page.locator(".did li", { hasText: /^Director:/ }).first().waitFor({ state: "attached", timeout: 900_000 })
    // What I did is on the Activity tab, with a badge while it's closed
    await page.getByRole("tab", { name: /^Activity/ }).click()
    await page.locator(".did li", { hasText: /^Director:/ }).first().waitFor()
    const last = (await w.call("GET", "/jobs")).jobs.filter((j) => j.kind === "make" && j.status === "done").sort((a, b) => Number(b.id.split(".").at(-1)) - Number(a.id.split(".").at(-1)))[0]
    const third = JSON.parse(last.output)
    // What I did is what is in the cut: one cutaway stays, so one is listed (the four taken out aren't)
    const timeline = (await w.call("GET", `/projects/${w.id}/plan`)).timeline
    const laid = third.changes.filter((c) => c.startsWith("Laid B-roll"))
    assert.equal(laid.length, timeline.overlays.filter((o) => o.role === "broll").length, JSON.stringify(third.changes))
    console.log(`Studio make: verdict ${third.verdict}; watch ${JSON.stringify(third.watch)}; Director lines ${JSON.stringify(await page.locator(".did li", { hasText: /^Director:/ }).allInnerTexts())}`)
    await shoot(page, "1280-light-notes")
    assert.deepEqual(await smallTargets(page), [], "1280: every target is at least 44 px")
    await page.emulateMedia({ colorScheme: "dark" })
    await shoot(page, "1280-dark")
    await page.setViewportSize({ width: 360, height: 800 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "360: no sideways scroll")
    assert.deepEqual(await smallTargets(page), [], "360: every target is at least 44 px")
    await page.getByRole("tab", { name: /^Brief/ }).click()
    await page.locator("#openings-wall").scrollIntoViewIfNeeded()
    await shoot(page, "360-dark-wall", page.locator(".openings"))
    await page.emulateMedia({ colorScheme: "light" })
    await shoot(page, "360-light-wall", page.locator(".openings"))
    assert.deepEqual(problems, [], "a clean console")
  } finally {
    await endHost(w, browser)
  }
})

test("ET-DL-REG-01 on a real Host: switch off, no wall, no route, no flag in the project view", { skip: browserTarget() ? false : "no Chrome on this computer", timeout: 280_000 }, async () => {
  const w = await hostWorld({ directorLoop: false })
  const browser = await chromium.launch({ ...browserTarget(), headless: true })
  try {
    const view = await w.call("GET", `/projects/${w.id}`)
    assert.equal("directorLoop" in view, false, "the project view is the object it was")
    assert.equal(await status(w.home, "POST", `/projects/${w.id}/openings`), 404)
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const { url } = await w.call("POST", "/internal/launch", {})
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio)
    assert.equal(await page.getByRole("button", { name: "Give me three openings" }).count(), 0)
  } finally {
    await endHost(w, browser)
  }
})
