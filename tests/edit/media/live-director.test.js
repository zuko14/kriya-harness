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
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// "Watch the Director edit" and the craft upgrades (editing.livePreview) in Chrome, against a real Host and the
// real FFmpeg: a real make's stages on the Build Strip while history stays put, the replay of its layers, the
// compare wipe, the level meter, the Look cards, the rich timeline and the Finish scorecard; then the switch
// off. 1280×860 and 360×800, light and dark, every target 44 px, no sideways scroll, a clean console. A script
// stands in for the model. LD_SHOTS=<folder> keeps screenshots.

const FLICKS = 705_600_000
const skip = chromeSkip() || (browserTarget() ? false : "no Chrome on this computer")
const shots = process.env.LD_SHOTS
const shoot = async (page, name) => shots && (mkdirSync(shots, { recursive: true }), await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }))

const until = async (check, limit = 120_000, what = "a condition") => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

// Speech enough for a 10 s cut, as tests/edit/media/studio.test.js has it
const WORDS = [
  ["Hello", "2.000", "2.400"], ["there", "2.450", "2.900"], ["friends.", "3.000", "3.500"],
  ["We", "6.000", "6.200"], ["built", "6.200", "6.500"], ["this", "6.500", "6.700"], ["in", "6.700", "6.800"], ["a", "6.800", "6.900"],
  ["Let", "7.600", "7.700"], ["me", "7.700", "7.800"], ["try", "7.800", "8.000"], ["that", "8.000", "8.200"], ["again.", "8.200", "8.600"],
  ["Um,", "9.200", "9.500"], ["we", "9.700", "9.900"], ["built", "9.900", "10.200"], ["this", "10.200", "10.400"], ["in", "10.400", "10.500"], ["a", "10.500", "10.600"], ["week.", "10.600", "11.000"],
]
function fakeRuntime(home) {
  const dir = join(home, "media", "9.9.9")
  mkdirSync(join(dir, "python", "bin"), { recursive: true })
  mkdirSync(join(dir, "models", "whisper-large-v3-turbo"), { recursive: true })
  const python = join(dir, "python", "bin", "python")
  writeFileSync(python, `#!/bin/sh\ncat <<'EOF'\n${WORDS.map(([w, s, e]) => JSON.stringify({ w, s, e, p: 0.95 })).join("\n")}\nEOF\n`)
  chmodSync(python, 0o755)
  writeFileSync(join(dir, "manifest.json"), "{}")
  writeFileSync(join(dir, ".complete"), "test")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: "9.9.9", previous: null }))
  linkMotion(home, { hyperframes: false })
}

async function world({ livePreview }) {
  await buildStudio()
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [] }) }
      return { content: JSON.stringify({ ops: [], say: "Nothing to change." }) }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-ld-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  // A colour chart, so a look visibly changes it, with a steady tone the meter can read
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=15", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=15", "-c:v", "libx264", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", "-y", source])
  fakeRuntime(home)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const asset = await call("POST", `/projects/${id}/assets`, { path: source })
  const job = await call("POST", `/projects/${id}/index`, { asset: asset.id })
  await until(async () => (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id && j.status === "done"), 120_000, "the index")
  await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: asset.id, from: { word: `${asset.id}:w0`, edge: "start" }, to: { word: `${asset.id}:w2`, edge: "end" } }] })
  return { home, host, call, id, asset, fake }
}
const end = async (w, browser) => {
  await browser?.close()
  await stopHost(w.home)
  await w.fake.close()
}
async function open(w, browser, viewport) {
  const problems = []
  const page = await browser.newPage({ viewport })
  page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
  page.on("pageerror", (error) => problems.push(String(error)))
  const { url } = await w.call("POST", "/internal/launch", {})
  await page.goto(url)
  await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
  await page.getByRole("link", { name: "Film" }).click()
  await page.waitForFunction(() => window.__studio?.pieces?.length >= 1)
  return { page, problems }
}
const smallTargets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, select, textarea, [role=option], [role=slider], summary")]
      .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
      .map((el) => ({ el: el.getAttribute("aria-label") || el.textContent || el.className, ...el.getBoundingClientRect().toJSON() }))
      .filter((r) => r.height < 44 || r.width < 44)
      .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
  )
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const seek = (page, seconds) =>
  page.evaluate(async (at) => {
    await window.__studio.monitor.seek(at)
    await window.__studio.monitor.settled
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  }, seconds * FLICKS)
// The monitor's left quarter, as a number: changes when what's drawn there changes
const leftHash = (page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas.monitor")
    const d = c.getContext("2d").getImageData(0, 0, Math.floor(c.width / 4), c.height).data
    let h = 0
    for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0
    return h
  })
const status = (w, path) =>
  new Promise((done, fail) => {
    const req = request({ socketPath: socketPath(w.home), method: "GET", path, headers: { ...hostHeaders(w.home) } }, (res) => (res.resume(), done(res.statusCode)))
    req.on("error", fail)
    req.end()
  })
// A 10 s cut: the Brief offers 30 s and up, so the test adds the choice the panel would send
const tenSeconds = (page) =>
  page.evaluate(() => {
    const length = document.querySelector("#make-length")
    length.append(Object.assign(document.createElement("option"), { value: "10", textContent: "10 seconds" }))
    length.value = "10"
  })

test("ET-LD-UI: the Build Strip follows a real make while history stays put; the replay, compare wipe, meter, Look cards, timeline and scorecard; 1280 and 360 px, light and dark", { skip, timeout: 280_000 }, async () => {
  const w = await world({ livePreview: true })
  const browser = await chromium.launch({ ...browserTarget(), headless: true })
  try {
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    await page.evaluate(() => window.__studio.setMode("direct"))
    await page.getByRole("tab", { name: "Brief" }).click()
    // The material's faces, from the Studio's own origin
    const faces = await page.evaluate(async () => { await document.fonts.load('15px "KS Geist"'); await document.fonts.load('20px "KS Fraunces"'); await document.fonts.load('13px "KS JetBrains Mono"'); return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family) })
    for (const face of ["KS Geist", "KS Fraunces", "KS JetBrains Mono"]) assert.ok(faces.includes(face), `${face} loaded`)

    // Look cards: each look on a frame of the footage; a card sets the select the make reads, and follows it
    const cards = page.getByRole("group", { name: "Colour looks, drawn on your footage" }).getByRole("button")
    assert.equal(await cards.count(), 6)
    await cards.filter({ hasText: "Warm" }).click()
    assert.equal(await page.locator("#make-grade").inputValue(), "warm")
    assert.equal(await cards.filter({ hasText: "Warm" }).getAttribute("aria-pressed"), "true")
    await page.locator("#make-grade").selectOption("vivid")
    assert.equal(await cards.filter({ hasText: "Vivid" }).getAttribute("aria-pressed"), "true", "the cards follow the select")
    assert.equal(await cards.filter({ hasText: "Warm" }).getAttribute("aria-pressed"), "false")
    await until(() => page.evaluate(() => [...document.querySelectorAll(".look-sketch")].every((c) => c.getContext("2d").getImageData(48, 27, 1, 1).data[3] === 255)), 10_000, "the sketches drawn")

    // A real make: the strip lights each stage the Host reports, the monitor follows the working cut, history doesn't move
    const head = async () => (await w.call("GET", `/projects/${w.id}`)).head
    const before = await head()
    await tenSeconds(page)
    await page.getByRole("button", { name: "Make it" }).click()
    await page.locator(".director-strip").waitFor()
    const seen = new Set()
    let mid = null
    await until(async () => {
      const now = await page.evaluate(() => ({ states: window.__studio.director.states, showing: window.__studio.director.showing, badge: document.querySelector(".director-badge").hidden ? null : document.querySelector(".director-badge").textContent }))
      for (const [stage, state] of Object.entries(now.states)) if (state !== "waiting") seen.add(stage)
      if (now.showing && !mid) {
        mid = { ...now, head: await head() }
        await shoot(page, "1280-light-director-working")
      }
      return seen.has("render") && mid
    }, 150_000, "the Director's render stage, with its working cut on the monitor")
    assert.equal(mid.badge, "Director working preview")
    assert.equal(mid.head, before, "nothing lands in history while the make runs")
    assert.ok(seen.has("story") && seen.has("cuts"), `the story and the cuts were reported: ${[...seen]}`)
    const made = await until(async () => (await w.call("GET", "/jobs")).jobs.filter((j) => j.kind === "make").find((j) => ["done", "failed"].includes(j.status)), 240_000, "the make")
    assert.equal(made.status, "done", made.error)
    const result = JSON.parse(made.output)
    assert.ok(result.gates.length > 0, "the master was rendered and checked")
    await until(() => page.evaluate(() => !window.__studio.director.showing && Object.values(window.__studio.director.states).every((s) => s !== "active") && document.querySelector(".director-badge").hidden), 20_000, "the strip finishing and the cut back")
    assert.equal((await page.evaluate(() => window.__studio.director.states)).check, "done", "the gates were reported as they ran")
    assert.notEqual(await head(), before, "the winning cut landed, as one entry")
    await shoot(page, "1280-light-director-done")

    // Replay how it was edited: layer by layer from the raw footage; no timer in an automated browser
    await page.getByRole("button", { name: "Replay how it was edited" }).click()
    const region = page.getByRole("region", { name: "Replay of how the cut was edited" })
    await region.waitFor()
    const steps = region.getByRole("group", { name: "Layers of the edit" }).getByRole("button")
    assert.ok((await steps.count()) >= 2, "raw and at least one layer")
    assert.equal(await steps.first().getAttribute("aria-pressed"), "true")
    assert.equal(await region.getByRole("button", { name: "Pause replay" }).isVisible(), false, "no timer: the steps are the person's")
    await until(() => page.evaluate(() => document.querySelector(".director-badge").textContent === "Replay: Raw footage" && !document.querySelector(".director-badge").hidden), 10_000, "the raw layer")
    await shoot(page, "1280-light-replay-raw")
    await steps.last().click()
    assert.equal(await steps.last().getAttribute("aria-pressed"), "true")
    await region.getByRole("button", { name: "Back to my cut" }).click()
    await until(() => page.evaluate(() => document.querySelector(".director-badge").hidden && !window.__studio.director.replay.open), 10_000, "back to the cut")
    assert.equal(await head(), (await w.call("GET", `/projects/${w.id}`)).head, "a replay writes nothing")

    // Compare raw: the cut has the vivid look, so left of the handle (the raw frame) differs from it; the handle drags and keys
    await page.evaluate(() => window.__studio.setMode("edit"))
    await seek(page, 0.5)
    const cutLeft = await leftHash(page)
    await page.getByRole("button", { name: "Compare raw" }).click()
    const grip = page.getByRole("slider", { name: /Compare: raw footage on the left/ })
    await grip.waitFor()
    const canvasBox = await page.locator("canvas.monitor").boundingBox()
    const gripBox = await grip.boundingBox()
    assert.ok(gripBox.width >= 44 && gripBox.height >= 44, "the handle is a 44 px target")
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.9, gripBox.y + gripBox.height / 2, { steps: 6 })
    await page.mouse.up()
    const at = await page.evaluate(() => window.__studio.monitor.wipe)
    assert.ok(Math.abs(at - 0.9) < 0.05, `the wipe followed the drag: ${at}`)
    await page.evaluate(() => window.__studio.monitor.settled)
    assert.notEqual(await leftHash(page), cutLeft, "left of the handle is the raw frame, not the graded cut")
    await shoot(page, "1280-light-compare")
    await grip.focus()
    await page.keyboard.press("Home")
    assert.equal(await page.evaluate(() => window.__studio.monitor.wipe), 0, "the keyboard moves it too")
    await page.evaluate(() => window.__studio.monitor.settled)
    assert.equal(await leftHash(page), cutLeft, "at 0, the cut as it was")
    await page.getByRole("button", { name: "Compare raw" }).click()
    assert.equal(await page.evaluate(() => window.__studio.monitor.wipe), null)

    // The level meter moves while the cut plays, and empties when it stops
    await seek(page, 0)
    await page.getByRole("button", { name: "Play (Space)" }).click()
    await page.waitForTimeout(800)
    const playing = await page.evaluate(() => parseFloat(document.querySelector(".level-fill").style.width))
    await page.getByRole("button", { name: /^Pause \(Space\)/ }).click()
    await page.waitForTimeout(150)
    const stopped = await page.evaluate(() => parseFloat(document.querySelector(".level-fill").style.width))
    console.log(`ET-LD-UI meter: ${playing}% while playing, ${stopped}% stopped`)
    assert.ok(playing > 0, "it reads the sound while playing")
    assert.equal(stopped, 0)

    // The timeline: a timecode where the pointer hovers
    const lanes = page.locator(".timeline canvas.lanes")
    await lanes.scrollIntoViewIfNeeded()
    const box = await lanes.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + 70)
    await until(() => page.evaluate(() => !document.querySelector(".tl-tip").hidden), 5_000, "the hover timecode")
    assert.match(await page.locator(".tl-time").textContent(), /^\d\d:\d\d\.\d\d$/)
    // The scrub preview: the cut's frame under the pointer, drawn from the thumbnail sheet
    await page.mouse.move(box.x + box.width / 2 + 3, box.y + 70)
    await until(() => page.evaluate(() => { const c = document.querySelector(".tl-frame"); return !c.hidden && c.getContext("2d").getImageData(48, 27, 1, 1).data[3] === 255 }), 10_000, "the frame under the pointer")
    await shoot(page, "1280-light-timeline")
    await page.mouse.move(box.x + box.width / 2, Math.max(0, box.y - 200))

    // Finish: the scorecard is the make's own gates, as it reported them
    await page.evaluate(() => window.__studio.setMode("finish"))
    const card = page.locator("details.scorecard")
    await until(async () => / passed, \d+ failed/.test(await card.locator(".score-sum").textContent()), 10_000, "the scorecard")
    await card.locator("summary").click()
    assert.equal(await card.locator(".score-row").count(), result.gates.length, "one row per gate the make ran")
    const passed = result.gates.filter((g) => g.status === "passed").length
    const failed = result.gates.filter((g) => g.status === "failed" && g.severity !== "note").length
    const rest = result.gates.length - passed - failed
    assert.equal(await card.locator(".score-sum").textContent(), `${passed} passed, ${failed} failed${rest ? `, ${rest} not checked or not applicable` : ""}`)
    assert.equal(await card.getByText("not_applicable").count(), 0, "every status in words")
    assert.equal(await page.getByRole("button", { name: "Follow on the monitor" }).isVisible(), false, "nothing to follow once the make is done")
    const expectShow = result.gates.filter((g) => g.status === "failed" && Number.isFinite(g.at) && g.at >= 0).length
    assert.equal(await card.getByRole("button", { name: /^Show QG-\d\d at / }).count(), expectShow, "a failed check with a moment can be shown")
    await shoot(page, "1280-light-finish-scorecard")

    // The shortcuts sheet: ? opens it, the button too, Escape closes it
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press("?")
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" })
    await sheet.waitFor()
    assert.ok((await sheet.locator("kbd").count()) >= 15)
    await shoot(page, "1280-light-shortcuts")
    await page.keyboard.press("Escape")
    await until(async () => !(await sheet.isVisible()), 5_000, "the sheet closing")
    await page.evaluate(() => window.__studio.setMode("edit"))
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click()
    await sheet.waitFor()
    await sheet.getByRole("button", { name: "Close" }).click()
    await until(async () => !(await sheet.isVisible()), 5_000, "Close")

    // The browser check: both widths, both themes, every target 44 px, no sideways scroll, a clean console
    for (const [width, height] of [[1280, 860], [360, 800]]) {
      await page.setViewportSize({ width, height })
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
        for (const mode of ["direct", "edit", "finish"]) {
          await page.evaluate((m) => window.__studio.setMode(m), mode)
          if (mode === "direct") await page.getByRole("tab", { name: "Brief" }).click()
          await page.waitForTimeout(150)
          assert.deepEqual(await smallTargets(page), [], `${width} ${colorScheme} ${mode}: every target is at least 44 px`)
          assert.equal(await noSideScroll(page), true, `${width} ${colorScheme} ${mode}: no sideways scroll`)
          await shoot(page, `${width}-${colorScheme}-${mode}`)
        }
      }
    }
    assert.deepEqual(problems, [], "a clean console")
  } finally {
    await end(w, browser)
  }
})

test("ET-LD-REG-01 in Chrome: switch off, none of it is on the page, the make status is the line it was, and the replay route is 404", { skip, timeout: 280_000 }, async () => {
  const w = await world({ livePreview: false })
  const browser = await chromium.launch({ ...browserTarget(), headless: true })
  try {
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    for (const mode of ["direct", "edit", "finish"]) {
      await page.evaluate((m) => window.__studio.setMode(m), mode)
      for (const selector of [".director-strip", ".director-badge", ".look-cards", ".wipe", ".level", ".replay", ".scorecard", ".timeline.rich", ".tl-tip", ".make-row"]) assert.equal(await page.locator(selector).count(), 0, `${mode}: no ${selector}`)
    }
    assert.equal(await page.getByRole("button", { name: "Compare raw" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Replay how it was edited" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "Keyboard shortcuts" }).count(), 0)
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press("?")
    assert.equal(await page.getByRole("dialog", { name: "Keyboard shortcuts" }).count(), 0, "? does nothing with the switch off, as before")
    assert.equal(await page.evaluate(() => "director" in window.__studio), false)
    assert.equal(await status(w, `/projects/${w.id}/layers`), 404)
    await page.evaluate(() => window.__studio.setMode("direct"))
    await page.getByRole("tab", { name: "Brief" }).click()
    await tenSeconds(page)
    await page.getByRole("button", { name: "Make it" }).click()
    await page.getByText(/Making the reel… \d+%/).waitFor({ timeout: 30_000 })
    assert.equal(await page.locator(".director-strip").count(), 0, "the bare percentage, as before")
    const made = await until(async () => (await w.call("GET", "/jobs")).jobs.filter((j) => j.kind === "make").find((j) => ["done", "failed"].includes(j.status)), 240_000, "the make")
    assert.equal(made.status, "done", made.error)
    assert.equal(await status(w, `/projects/${w.id}/layers`), 404, "still no replay with the switch off")
    assert.deepEqual(problems, [])
  } finally {
    await end(w, browser)
  }
})
