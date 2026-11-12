import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { chromium } from "playwright-core"

import { browserTarget } from "../../../src/browser.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { hostHeaders, socketPath } from "../../../src/edit/host/paths.js"
import { buildStudio } from "../../../studio/build.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"

// TP4 in Chrome (ASSEMBLY_AND_INTENT §7): the Plan Card's "What I understood", "Not in this cut" and
// its questions with defaults; a change's "Not in this change"; hold to talk through a fake microphone
// to the local recogniser (a script stands in for it, EB-11) with no request off this computer; and
// the switch off. A script stands in for the model. TP4_SHOTS=<folder> keeps screenshots.

const skip = browserTarget() ? false : "no Chrome on this computer"
const shots = process.env.TP4_SHOTS
const FLICKS = 705_600_000
const HEARD = [["make", "0.1", "0.3"], ["it", "0.3", "0.4"], ["warmer", "0.4", "0.8"]]
const ASKED = "Make it 60 seconds with karaoke captions, and add a 3D spinning logo at the end"

const until = async (check, limit = 120_000, what = "a condition") => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

async function world({ intent, weights = true }) {
  await buildStudio()
  const tasks = []
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push({ task, body: JSON.stringify(body) })
      if (task === "plan") {
        const q = (field, options, chosen) => ({ field, question: field === "grade" ? "Which look?" : field === "music" ? "Which music?" : "Sound on each cut?", options, default: chosen, evidence: "Make it" })
        return { content: JSON.stringify({ say: "A minute-long cut with karaoke captions.", steps: ["Cut to a minute", "Karaoke captions"], settings: { format: "9:16", seconds: 45, captions: "clean" }, ...(intent ? { intent: { understood: [{ field: "seconds", value: 60, evidence: "60 seconds" }, { field: "captions", value: "karaoke", evidence: "karaoke captions" }], cannot: [{ evidence: "add a 3D spinning logo", nearest: "a title card at the end" }], questions: [q("grade", ["warm", "cinematic"], "warm"), q("music", ["calm", "upbeat"], "calm"), q("cutSound", ["whoosh", "none"], "none")] } } : {}) }) }
      }
      return { content: JSON.stringify({ ops: [], say: "I can't spin a logo.", ...(intent ? { cannot: [{ evidence: "spin the logo" }] } : {}) }) }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  // The Media Runtime with a scripted recogniser; without `weights` it has no speech model, so no hold to talk
  const media = join(home, "media", "9.9.9")
  mkdirSync(join(media, "python", "bin"), { recursive: true })
  if (weights) mkdirSync(join(media, "models", "whisper-large-v3-turbo"), { recursive: true })
  writeFileSync(join(media, "python", "bin", "python"), `#!/bin/sh\ncat <<'EOF'\n${HEARD.map(([w, s, e]) => JSON.stringify({ w, s, e, p: 0.95 })).join("\n")}\nEOF\n`)
  chmodSync(join(media, "python", "bin", "python"), 0o755)
  writeFileSync(join(media, "manifest.json"), "{}")
  writeFileSync(join(media, ".complete"), "test")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: "9.9.9", previous: null }))
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const take = join(folder, "take.mov")
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=f=220:r=48000:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", take])
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const a = await call("POST", `/projects/${id}/assets`, { path: take })
  await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: a.id, from: 0, to: 4 * FLICKS }] })
  return { home, host, call, id, fake, tasks }
}
const end = async (w, browser) => {
  await browser?.close()
  await stopHost(w.home)
  await w.fake.close()
}
const status = (home, method, path) =>
  new Promise((done, fail) => {
    const req = request({ socketPath: socketPath(home), method, path, headers: { ...hostHeaders(home), "content-type": "audio/webm" } }, (res) => (res.resume(), res.on("end", () => done(res.statusCode))))
    req.on("error", fail)
    req.end(Buffer.from("x"))
  })
async function open(w, browser, viewport) {
  const problems = []
  const away = []
  const page = await browser.newPage({ viewport })
  // macOS gives this test process no microphone, so Chrome's getUserMedia never answers here, fake device or not
  // (measured 2026-11-11 with Google Chrome and chrome-headless-shell). A tone from WebAudio stands in for the
  // microphone's stream; the recorder, the upload, the Host's FFmpeg and recogniser and the page are all real
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext()
      const tone = context.createOscillator()
      const out = context.createMediaStreamDestination()
      tone.connect(out)
      tone.start()
      return out.stream
    }
  })
  page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
  page.on("pageerror", (error) => problems.push(String(error)))
  page.on("request", (r) => !r.url().startsWith(`http://127.0.0.1:${w.host.port}/`) && !r.url().startsWith("data:") && away.push(r.url()))
  const { url } = await w.call("POST", "/internal/launch", {})
  await page.goto(url)
  await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
  await page.getByRole("link", { name: "Film" }).click()
  await page.waitForFunction(() => window.__studio)
  await page.evaluate(() => window.__studio.setMode("direct"))
  return { page, problems, away }
}
const smallTargets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, select, textarea, [role=option]")]
      .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
      .map((el) => ({ el: el.getAttribute("aria-label") || el.textContent || el.className, ...el.getBoundingClientRect().toJSON() }))
      .filter((r) => r.height < 44 || r.width < 44)
      .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
  )
const shoot = async (page, name) => shots && (mkdirSync(shots, { recursive: true }), await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }))
const launch = () => chromium.launch({ ...browserTarget(), headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] })

test("ET-NL in Chrome: the card says what it understood, what isn't in this cut and asks two questions with defaults; a change says what it can't do; hold to talk stays on this computer; 1280 and 360 px, light and dark", { skip, timeout: 280_000 }, async () => {
  const w = await world({ intent: true })
  const browser = await launch()
  try {
    const view = await w.call("GET", `/projects/${w.id}`)
    assert.deepEqual([view.intent, view.dictation], [true, true])
    const { page, problems, away } = await open(w, browser, { width: 1280, height: 860 })

    // The Plan Card (ET-NL-04, -05, -06): one model call for the plan, as before (ET-NL-09)
    await page.locator("#prompt").fill(ASKED)
    await page.getByRole("button", { name: "Plan", exact: true }).click()
    await page.getByText("What I understood").waitFor({ timeout: 30_000 })
    assert.equal(w.tasks.filter((t) => t.task === "plan").length, 1, "one call made the plan and its frame")
    const card = page.locator(".proposal.plan")
    assert.match(await card.innerText(), /Length: 60 seconds \(you said "60 seconds"\)/)
    assert.match(await card.innerText(), /Captions: karaoke/)
    assert.match(await card.innerText(), /Not in this cut\s+"add a 3D spinning logo"\. Nearest I can do: a title card at the end/)
    assert.equal(await card.locator("fieldset.question").count(), 2, "two questions at most")
    assert.equal(await card.getByRole("radio", { name: /warm \(default\)/ }).isChecked(), true, "a default is already chosen")
    assert.match(await card.innerText(), /Also decided by default: Sound on each cut none/)
    await card.getByRole("radio", { name: /cinematic/ }).check()
    await until(() => card.innerText().then((t) => /cinematic/i.test(t.split("What I understood")[0])), 5_000, "the settings line follows the answer")
    await shoot(page, "1280-light-card")

    const before = w.tasks.length

    // Hold to talk (ET-NL-07): the fake microphone, the local recogniser, the text in the box, nothing off this computer
    const talk = page.getByRole("button", { name: /Hold to talk/ })
    await talk.waitFor()
    await page.locator("#prompt").fill("")
    await talk.scrollIntoViewIfNeeded()
    const box = await talk.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(1200)
    await page.mouse.up()
    await until(() => page.locator("#prompt").inputValue().then((v) => v === "make it warmer"), 30_000, "the words in the box")
    assert.equal(w.tasks.length, before, "dictation calls no model")
    assert.deepEqual(away, [], "no request left this computer")

    await page.emulateMedia({ colorScheme: "dark" })
    await shoot(page, "1280-dark")
    assert.deepEqual(await smallTargets(page), [], "1280: every target is at least 44 px")
    await page.setViewportSize({ width: 360, height: 800 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "360: no sideways scroll")
    assert.deepEqual(await smallTargets(page), [], "360: every target is at least 44 px")
    await shoot(page, "360-dark")
    await page.emulateMedia({ colorScheme: "light" })
    await shoot(page, "360-light")
    assert.deepEqual(problems, [], "a clean console")
  } finally {
    await end(w, browser)
  }
})

test("ET-NL-04 on the console: a change it can't make lists the person's words under Not in this change", { skip, timeout: 280_000 }, async () => {
  const w = await world({ intent: true })
  const browser = await launch()
  try {
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    await page.locator("#prompt").fill("spin the logo")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByText("Not in this change").waitFor({ timeout: 30_000 })
    assert.match(await page.locator(".msg.kriya").last().innerText(), /"spin the logo"/)
    assert.equal(w.tasks.filter((t) => t.task === "console").length, 1, "one call, as before")
    assert.deepEqual(problems, [])
  } finally {
    await end(w, browser)
  }
})

test("ET-NL-07 and ET-NL-REG-01: without the weights there is no Hold to talk; switch off, no frame, no button, no route, and the model's request has no intent", { skip, timeout: 280_000 }, async () => {
  const bare = await world({ intent: true, weights: false })
  try {
    const view = await bare.call("GET", `/projects/${bare.id}`)
    assert.deepEqual([view.intent, view.dictation], [true, undefined], "no weights: no hold to talk")
    assert.equal(await status(bare.home, "POST", `/projects/${bare.id}/dictate`), 404)
  } finally {
    await end(bare)
  }
  const w = await world({ intent: false })
  const browser = await launch()
  try {
    const view = await w.call("GET", `/projects/${w.id}`)
    assert.equal("intent" in view || "dictation" in view, false, "the project view is the object it was")
    assert.equal(await status(w.home, "POST", `/projects/${w.id}/dictate`), 404)
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    assert.equal(await page.getByRole("button", { name: /Hold to talk/ }).count(), 0)
    await page.locator("#prompt").fill(ASKED)
    await page.getByRole("button", { name: "Plan", exact: true }).click()
    await page.getByText("Approve and make it").waitFor({ timeout: 30_000 })
    assert.equal(await page.getByText("What I understood").count(), 0)
    assert.equal(await page.getByText("Not in this cut").count(), 0)
    const plans = w.tasks.filter((t) => t.task === "plan")
    assert.equal(plans.length, 1)
    assert.equal(plans[0].body.includes('"intent"'), false, "the model is asked what it was asked before")
    assert.deepEqual(problems, [])
  } finally {
    await end(w, browser)
  }
})
