import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { chromium } from "playwright-core"

import { browserTarget } from "../../../src/browser.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { buildStudio } from "../../../studio/build.js"
import { pieceAt, programOf, sourceAt, timelineAt, durationOf } from "../../../studio/src/program.js"
import { frameFlicks, snap } from "../../../studio/src/time.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { barcodeVideo, BITS, H, W } from "./barcode.js"
import { chromeSkip, linkMotion } from "./motion-runtime.js"

// The Studio in the installed Chrome, headless, against a real Host and the real
// FFmpeg on frame-barcoded footage; then the harness's own Web UI with the row on
// and off. A script stands in for the speech model (no runtime here, EB-09/EB-11).

const FLICKS = 705_600_000
const FPS = { n: 30, d: 1 }
const F = frameFlicks(FPS)
const target = browserTarget()
const skip = target ? false : "no Chrome on this computer"

const until = async (check, limit = 120_000, what = "a condition") => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

function fakeRuntime(home, words) {
  const dir = join(home, "media", "9.9.9")
  mkdirSync(join(dir, "python", "bin"), { recursive: true })
  mkdirSync(join(dir, "models", "whisper-large-v3-turbo"), { recursive: true })
  const python = join(dir, "python", "bin", "python")
  writeFileSync(python, `#!/bin/sh\ncat <<'EOF'\n${words.map(([w, s, e]) => JSON.stringify({ w, s, e, p: 0.95 })).join("\n")}\nEOF\n`)
  chmodSync(python, 0o755)
  writeFileSync(join(dir, "manifest.json"), "{}")
  writeFileSync(join(dir, ".complete"), "test")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: "9.9.9", previous: null }))
}

const WORDS = [
  ["Hello", "2.000", "2.400"],
  ["there", "2.450", "2.900"],
  ["friends.", "3.000", "3.500"],
  ["We", "6.000", "6.200"],
  ["built", "6.200", "6.500"],
  ["this", "6.500", "6.700"],
  ["in", "6.700", "6.800"],
  ["a", "6.800", "6.900"],
  ["Let", "7.600", "7.700"],
  ["me", "7.700", "7.800"],
  ["try", "7.800", "8.000"],
  ["that", "8.000", "8.200"],
  ["again.", "8.200", "8.600"],
  ["Um,", "9.200", "9.500"],
  ["we", "9.700", "9.900"],
  ["built", "9.900", "10.200"],
  ["this", "10.200", "10.400"],
  ["in", "10.400", "10.500"],
  ["a", "10.500", "10.600"],
  ["week.", "10.600", "11.000"],
]

// The barcode reader, run in the page on the monitor's own pixels
const READ_FRAME = `(async () => {
  await window.__studio.monitor.settled
  const canvas = document.querySelector("canvas.monitor")
  const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
  const block = Math.floor(${W} / ${BITS}) * (width / ${W})
  const y = Math.floor(height / 2)
  let n = 0
  for (let bit = 0; bit < ${BITS}; bit++) if (data[(y * width + Math.floor(bit * block + block / 2)) * 4] > 128) n |= 1 << bit
  return n
})()`

async function studioWorld({ fake } = {}) {
  await buildStudio()
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  if (fake) {
    const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
    assert.equal(await new Promise((done) => login.on("exit", done)), 0, "signed in to the fake Kriya")
  }
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const source = join(folder, "take.mov")
  await barcodeVideo(source, { frames: 450 })
  fakeRuntime(home, WORDS)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const asset = await call("POST", `/projects/${id}/assets`, { path: source })
  const job = await call("POST", `/projects/${id}/index`, { asset: asset.id })
  await until(async () => (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id && j.status === "done"), 120_000, "the index")
  await call("PATCH", `/projects/${id}`, {
    ops: [
      { op: "set_format", width: 640, height: 360 },
      { op: "keep_range", asset: asset.id, from: { word: `${asset.id}:w0`, edge: "start" }, to: { word: `${asset.id}:w2`, edge: "end" } },
      { op: "keep_range", asset: asset.id, from: 12 * FLICKS, to: 13 * FLICKS },
    ],
  })
  return { home, host, call, id, asset }
}

const launchBrowser = () => chromium.launch({ ...target, headless: true })

test("the Studio in Chrome: right frames, word seeks, keys, modes, 360 px, dark, clean console", { skip, timeout: 280_000 }, async () => {
  const w = await studioWorld()
  const browser = await launchBrowser()
  const problems = []
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
    page.on("pageerror", (error) => problems.push(String(error)))
    const { url } = await w.call("POST", "/internal/launch", { back: "http://127.0.0.1:9" })
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
    assert.equal(await page.evaluate(() => crossOriginIsolated), true, "COOP and COEP make it cross-origin isolated")
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio?.pieces?.length === 2)
    assert.equal(await page.getByRole("link", { name: "← Kriya Harness" }).getAttribute("href"), "http://127.0.0.1:9", "Back goes to the harness that opened it")

    const plan = await w.call("GET", `/projects/${w.id}/plan`)
    const pieces = programOf(plan.timeline)
    const sourceFrame = (t) => Math.floor(sourceAt(pieceAt(pieces, t), t) / F)

    // ET-UI-03: the monitor shows the frame the plan says, read from its pixels
    const end = pieces[0].end
    for (const t of [0, 10 * F, snap(end - F, FPS), snap(end, FPS), snap(end, FPS) + 5 * F, snap(pieces[1].end - F, FPS)]) {
      await page.evaluate((at) => window.__studio.monitor.seek(at), t)
      assert.equal(await page.evaluate(READ_FRAME), sourceFrame(t), `timeline frame ${t / F}`)
    }

    // Scrub latency against the 100 ms budget (STUDIO_APP_AND_BROWSER §12): measured, not asserted
    const total = pieces.at(-1).end
    const times = await page.evaluate(async ({ total, frame }) => {
      const out = []
      for (let i = 0; i < 40; i++) {
        const at = Math.floor(((i * 7919) % 97) / 97 * (total / frame)) * frame
        const start = performance.now()
        await window.__studio.monitor.seek(at)
        out.push(performance.now() - start)
      }
      return out.sort((a, b) => a - b)
    }, { total, frame: F })
    console.log(`scrub to frame on screen: p50 ${times[19].toFixed(1)} ms, p95 ${times[37].toFixed(1)} ms, max ${times[39].toFixed(1)} ms (40 seeks, headless Chrome, 640×360 proxy)`)

    // A word click seeks to the exact flick of the word, and shows its first frame
    const index = await w.call("GET", `/projects/${w.id}/index`)
    const friends = index.words.find((word) => word.text === "friends.")
    await page.getByRole("button", { name: "friends.", exact: true }).click()
    const at = timelineAt(pieces, friends.asset, friends.start)
    await until(() => page.evaluate(() => window.__studio.monitor.time).then((t) => t === snap(at, FPS)), 10_000, "the word seek")
    assert.equal(await page.evaluate(READ_FRAME), sourceFrame(snap(at, FPS)))
    assert.equal(sourceFrame(snap(at, FPS)), 90, "friends. starts on source frame 90")
    // A word the cut leaves out opens the source at that word
    await page.getByRole("button", { name: "week.", exact: true }).click()
    await until(() => page.evaluate(READ_FRAME).then((n) => n === 318), 10_000, "the source view of week.")
    assert.match(await page.locator(".area-monitor .chip").textContent(), /Source/)
    // Fillers and the take that lost are struck through, with their reason read aloud
    assert.equal(await page.locator(".word.struck", { hasText: "Um," }).getAttribute("aria-label"), "Um, (filler)")
    assert.ok((await page.locator(".sentence.lost").count()) >= 1, "the abandoned take is struck")

    // ET-UI-02: the keyboard, on the program again
    await page.locator(".strip canvas").click({ position: { x: 1, y: 10 } })
    assert.match(await page.locator(".area-monitor .chip").textContent(), /Preview/, "the story strip brings the program back")
    await page.evaluate(() => window.__studio.monitor.seek(0))
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight")
    assert.equal(await page.evaluate(() => window.__studio.monitor.time), 3 * F, "→ ×3: three frames")
    await page.keyboard.press("Shift+ArrowRight")
    assert.equal(await page.evaluate(() => window.__studio.monitor.time), 3 * F + FLICKS, "Shift+→: one second")
    await page.keyboard.press("Space")
    assert.equal(await page.evaluate(() => window.__studio.monitor.rate), 1)
    await until(() => page.evaluate((from) => window.__studio.monitor.time > from + 5 * 23520000, 3 * F + FLICKS), 10_000, "playback")
    await page.keyboard.press("k")
    assert.equal(await page.evaluate(() => window.__studio.monitor.rate), 0)
    await page.keyboard.press("l")
    await page.keyboard.press("l")
    assert.equal(await page.evaluate(() => window.__studio.monitor.rate), 2)
    await page.keyboard.press("k")
    const before = await page.evaluate(() => window.__studio.monitor.time)
    await page.keyboard.press("j")
    assert.equal(await page.evaluate(() => window.__studio.monitor.rate), -1)
    await until(() => page.evaluate((from) => window.__studio.monitor.time < from, before), 10_000, "reverse")
    await page.keyboard.press("k")
    const paused = await page.evaluate(() => window.__studio.monitor.time)
    assert.equal(paused % F, 0, "a pause lands on a frame")
    assert.equal(await page.evaluate(READ_FRAME), sourceFrame(paused), "and shows it")

    // ET-UI-05: modes change the layout, never the playback
    await page.evaluate(() => (document.querySelector("canvas.monitor").dataset.same = "1"))
    for (const [key, mode, shown, hidden] of [
      ["2", "edit", [".area-timeline", ".area-bin"], [".area-kriya", ".area-strip"]],
      ["3", "finish", [".area-finish"], [".area-transcript", ".area-timeline"]],
      ["1", "direct", [".area-kriya", ".area-strip", ".area-transcript"], [".area-timeline", ".area-finish"]],
    ]) {
      await page.keyboard.press(key)
      assert.equal(await page.locator(".workspace").getAttribute("data-mode"), mode)
      for (const selector of shown) assert.ok(await page.locator(selector).isVisible(), `${mode}: ${selector} shown`)
      for (const selector of hidden) assert.equal(await page.locator(selector).isVisible(), false, `${mode}: ${selector} hidden`)
      assert.equal(await page.evaluate(() => window.__studio.monitor.time), paused, `${mode}: same playhead`)
      assert.equal(await page.evaluate(() => document.querySelector("canvas.monitor").dataset.same), "1", `${mode}: same monitor`)
      if (mode === "finish") {
        await until(() => page.evaluate(() => document.querySelector(".scope").getContext("2d").getImageData(0, 0, 256, 100).data.some((v) => v > 0)), 5_000, "scopes")
        // ED12: the cut leaves for another editor, and the Studio says where and what
        await page.getByRole("button", { name: "Export for another editor" }).click()
        await page.getByText(/^Written to exports\/Film-handoff, with 1 media file linked\.$/).waitFor({ timeout: 10_000 })
        for (const name of ["Film.otio", "Film.fcpxml", "Film.edl", "manifest.json"]) assert.ok(await page.getByRole("list", { name: "Handoff files" }).getByText(name, { exact: true }).isVisible(), name)
      }
      // 44 px targets; words are inline text targets (WCAG 2.5.8's inline exception)
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("button, a, input, select")]
          .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
          .map((el) => ({ el: el.textContent || el.getAttribute("aria-label") || el.className, ...el.getBoundingClientRect().toJSON() }))
          .filter((r) => r.height < 44 || r.width < 44),
      )
      assert.deepEqual(small, [], `${mode}: every target is at least 44 px`)
    }
    // Remembered per person
    await page.reload()
    await page.waitForFunction(() => window.__studio)
    assert.equal(await page.locator(".workspace").getAttribute("data-mode"), "direct")

    // Review mode at 360 px: no timeline, nothing wider than the screen
    await page.setViewportSize({ width: 360, height: 800 })
    for (const key of ["1", "2", "3"]) {
      await page.keyboard.press(key)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 361), `${key}: no sideways scroll at 360 px`)
      assert.equal(await page.locator(".area-timeline").isVisible(), false)
      assert.ok(await page.locator("canvas.monitor").isVisible())
    }
    await page.emulateMedia({ colorScheme: "dark" })
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(10, 18, 19)", "dark paper")
    await page.emulateMedia({ colorScheme: "light" })
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(243, 238, 230)", "light paper")

    // Editing by hand: cut words in the transcript, undo, split at the playhead, ripple delete
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.keyboard.press("2")
    const length = () => page.evaluate(() => Math.max(...window.__studio.pieces.map((p) => p.end)))
    const count = () => page.evaluate(() => window.__studio.pieces.length)
    const full = await length()
    await page.getByRole("button", { name: "Hello", exact: true }).click()
    await page.getByRole("button", { name: "there", exact: true }).click({ modifiers: ["Shift"] })
    await page.keyboard.press("Delete")
    await until(async () => (await length()) < full, 20_000, "the words cut")
    const cut = await page.evaluate(() => window.__studio.pieces[0].in)
    assert.ok(cut >= 2.45 * FLICKS - F, `the cut now starts at "there" or later (${cut / FLICKS} s)`)
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
    await until(async () => (await length()) === full, 20_000, "undo")
    await page.evaluate(() => window.__studio.monitor.seek(window.__studio.pieces[1].at + 705600000 / 2))
    await page.keyboard.press("s")
    await until(async () => (await count()) === 3, 20_000, "the split")
    await page.getByRole("button", { name: /^Clip c2,/ }).click()
    await page.keyboard.press("Delete")
    await until(async () => (await count()) === 2, 20_000, "the ripple delete")
    assert.ok((await length()) < full, "the deleted clip's time is gone")
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
  }
})

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

/** `kriya` itself, signed in to a fake Kriya, on a free port. */
async function harness(home, args, fake) {
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: home, KRIYA_EDIT_IDLE_MS: "600000", KRIYA_LOOP_GUARD: "off", KRIYA_STRICT_LOOP: "off", KRIYA_DEFENSIVE: "off", KRIYA_RECON: "off", KRIYA_JIT_TOOLS: "off", KRIYA_ROUTER: "off", KRIYA_BROWSER: "off" }
  if (!existsSync(join(home, "device.json"))) {
    const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
    assert.equal(await new Promise((done) => login.on("exit", done)), 0, "signed in to the fake Kriya")
  }
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args, "--no-open", "--port", String(await freePort())], { env, cwd: home, detached: true })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", (d) => (out += d))
  const url = await until(() => /Kriya Harness: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)?.[1], 90_000, "the Web UI")
  return { url, stop: () => process.kill(-child.pid, "SIGTERM") }
}

test("ET-UI-01: the harness's own Web UI: the row only with --edit; it opens the Studio in the tab, and Back returns", { skip, timeout: 280_000 }, async () => {
  await buildStudio()
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-web-")))
  const fake = await startFakeKriya({ models: ["budget"] })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const problems = []
    page.on("pageerror", (error) => problems.push(String(error)))

    const off = await harness(home, ["--no-edit"], fake)
    try {
      await page.goto(off.url)
      await page.getByText("Projects", { exact: true }).first().waitFor({ timeout: 60_000 })
      assert.equal(await page.getByText("Editing Studio").count(), 0, "off: no row, no page")
      assert.equal(await page.locator("[data-plugin='@kriya-ai/harness-edit']").count(), 0, "and none of its DOM")
    } finally {
      off.stop()
    }

    const on = await harness(home, ["--edit"], fake)
    try {
      await page.goto(on.url)
      const harnessOrigin = new URL(on.url).origin
      const row = page.getByRole("button", { name: "Editing Studio" }).first()
      await row.waitFor({ timeout: 60_000 })
      await row.click()
      const port = await until(() => (existsSync(join(home, "edit", "port")) ? readFileSync(join(home, "edit", "port"), "utf8").trim() : null), 30_000, "the Host")
      await page.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 60_000 })
      await page.getByText("What are we making?").waitFor()
      const back = page.getByRole("link", { name: "← Kriya Harness" })
      assert.equal(await back.getAttribute("href"), harnessOrigin, "the link back carries no token")
      await back.click()
      await page.waitForURL(`${harnessOrigin}/**`, { timeout: 60_000 })
      await page.getByRole("button", { name: "Editing Studio" }).first().waitFor({ timeout: 60_000 })
      await new Promise((done) => setTimeout(done, 2_000))
      assert.equal(new URL(page.url()).origin, harnessOrigin, "back in the harness, signed in, and it doesn't bounce out again")
      assert.deepEqual(problems, [])
    } finally {
      on.stop()
    }
  } finally {
    await browser.close()
    await stopHost(home)
    await fake.close?.()
  }
})

test("the console in Chrome: a selection is \"this\"; Proposal mode shows ghost clips; Accept lands it; What I did says so", { skip, timeout: 280_000 }, async () => {
  let asked = null
  const fake = await startFakeKriya({
    models: ["budget"],
    chat(body) {
      if (body.response_format?.json_schema?.name !== "console") return { content: "{}" }
      asked = body.messages[1].content
      const selected = /selected the words (a1:w\d+) to/.exec(asked)?.[1]
      return { content: JSON.stringify(selected ? { ops: [{ op: "punch_in", at: { word: selected, edge: "start" }, duration: 705_600_000 / 2, scale: 1.2 }] } : { ops: [] }) }
    },
  })
  const w = await studioWorld({ fake })
  const browser = await launchBrowser()
  const problems = []
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("pageerror", (error) => problems.push(String(error)))
    page.on("console", (message) => message.type() === "error" && problems.push(message.text()))
    const { url } = await w.call("POST", "/internal/launch")
    await page.goto(url)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio?.pieces?.length === 2)

    await page.getByRole("button", { name: "friends.", exact: true }).click()
    await page.getByText("Selected: friends.").waitFor()
    await page.locator("#prompt").fill("punch in here")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByText("Proposed, not applied yet").waitFor({ timeout: 30_000 })
    assert.match(asked, /selected the words a1:w2 to a1:w2/, "the selection reached the Director as ids")
    assert.match(asked, /<<UNTRUSTED_CONTENT/, "with the transcript fenced")
    assert.ok(await page.getByText('Punched in 1.2× at "friends."').isVisible(), "what it would do, in words made by code")
    const before = (await w.call("GET", `/projects/${w.id}`)).head
    assert.equal(before, (await w.call("GET", `/projects/${w.id}`)).head, "nothing has landed yet")
    // Ghost clips: the timeline's Picture row is drawn dashed in the agent's colour
    await page.keyboard.press("2")
    const ghost = await page.evaluate(() => {
      const canvas = document.querySelector(".timeline canvas")
      const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, Math.round(50 * devicePixelRatio))
      let saffron = 0
      for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] > 70 && data[i + 1] < 130 && data[i + 2] < 80) saffron++
      return saffron
    })
    assert.ok(ghost > 50, `ghost outline pixels: ${ghost}`)
    await page.keyboard.press("1")
    await page.getByRole("button", { name: "Accept", exact: true }).click()
    await page.getByRole("list", { name: "What I did" }).getByText('Punched in 1.2× at "friends."').waitFor()
    const after = await w.call("GET", `/projects/${w.id}`)
    assert.notEqual(after.head, before, "accepted: one new entry")
    assert.ok(after.project.sequences[0].clips.some((c) => c.effects?.some((e) => e.type === "zoom" && e.scale === 1.2)), "the punch-in is in the project")
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
    await until(async () => (await w.call("GET", `/projects/${w.id}`)).head === before, 20_000, "undo")
    // Nothing selected and nothing it can do: says so, proposes nothing
    await page.keyboard.press("Escape")
    assert.equal(await page.getByText("Selected: friends.").isVisible(), false, "Escape lets go of the selection")
    await page.locator("#prompt").fill("make it sparkle")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByText("Kriya couldn't turn that into an edit", { exact: false }).waitFor({ timeout: 30_000 })
    assert.equal(await page.getByText("Proposed, not applied yet").count(), 0)
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
    await fake.close()
  }
})

test("ET-RV-03: a note from the Review Room shows as a pin on the Studio's timeline, at its word", { skip, timeout: 280_000 }, async () => {
  const w = await studioWorld()
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const open = async () => {
      const { url } = await w.call("POST", "/internal/launch", { back: "http://127.0.0.1:9" })
      await page.goto(url)
      await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
      await page.getByRole("link", { name: "Film" }).click()
      await page.waitForFunction(() => window.__studio?.pieces?.length === 2)
      await page.evaluate(() => window.__studio.setMode("edit"))
      await page.waitForTimeout(300)
    }
    // The columns along the top of the timeline in the playhead's colour
    const marked = () =>
      page.evaluate(() => {
        const canvas = document.querySelector(".timeline canvas.lanes")
        const ratio = window.devicePixelRatio || 1
        const probe = document.createElement("canvas").getContext("2d")
        probe.fillStyle = getComputedStyle(canvas).getPropertyValue("--playhead").trim()
        probe.fillRect(0, 0, 1, 1)
        const [r, g, b] = probe.getImageData(0, 0, 1, 1).data
        const row = canvas.getContext("2d").getImageData(0, Math.round(3 * ratio), canvas.width, 1).data
        const columns = []
        for (let x = 0; x < canvas.width; x++) if (Math.abs(row[x * 4] - r) + Math.abs(row[x * 4 + 1] - g) + Math.abs(row[x * 4 + 2] - b) < 12) columns.push(x / ratio)
        return { columns, width: canvas.clientWidth }
      })
    await open()
    const before = await marked()
    const word = (await w.call("GET", `/projects/${w.id}/index`)).words.find((item) => item.id === `${w.asset.id}:w1`)
    await w.call("PATCH", `/projects/${w.id}`, { ops: [{ op: "mark", name: "Note: Bigger captions here", at: { word: word.id, edge: "start" } }] })
    await open()
    const after = await marked()
    const plan = await w.call("GET", `/projects/${w.id}/plan`)
    const pieces = programOf(plan.timeline)
    const at = timelineAt(pieces, word.asset, word.start)
    const expected = (at / durationOf(pieces)) * after.width
    const added = after.columns.filter((x) => !before.columns.includes(x))
    console.log(`ET-RV-03 pin: expected near ${expected.toFixed(1)} px of ${after.width}; new columns ${added.join(",")}`)
    assert.ok(added.length > 0, "something new along the top")
    assert.ok(added.every((x) => Math.abs(x - expected) <= 3), `the pin is at its word: ${added} against ${expected}`)
  } finally {
    await browser.close()
    await stopHost(w.home)
  }
})

test("ET-TST-01 in Chrome: the Taste screen asks, a yes applies, and it's removable; 360 px, clean console", { skip, timeout: 280_000 }, async () => {
  const w = await studioWorld()
  const browser = await launchBrowser()
  const problems = []
  try {
    // The same zoom by hand, in two projects, as the Studio sends it
    const second = await w.call("POST", "/projects", { name: "Film two", folder: join(w.home, "work", "film") })
    const other = await w.call("POST", `/projects/${second.id}/assets`, { path: join(w.home, "work", "film", "take.mov") })
    const job = await w.call("POST", `/projects/${second.id}/index`, { asset: other.id })
    await until(async () => (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id && j.status === "done"), 120_000, "the second index")
    for (const [id, asset] of [[w.id, w.asset.id], [second.id, other.id]]) {
      await w.call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset, from: { word: `${asset}:w0`, edge: "start" }, to: { word: `${asset}:w2`, edge: "end" } }] })
      await w.call("PATCH", `/projects/${id}`, { ops: [{ op: "punch_in", at: { word: `${asset}:w1`, edge: "start" }, until: { word: `${asset}:w1`, edge: "end" }, scale: 1.3 }] })
    }
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
    page.on("console", (message) => message.type() === "error" && problems.push(message.text()))
    const { url } = await w.call("POST", "/internal/launch", { back: "http://127.0.0.1:9" })
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${w.host.port}/`)
    const box = page.getByRole("region", { name: "Your taste" })
    await box.getByText("You usually zoom in to 1.30×").waitFor()
    for (const button of await box.getByRole("button").all()) assert.ok((await button.boundingBox()).height >= 44, "a 44 px target")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll")
    await box.getByRole("button", { name: "Use it" }).click()
    await box.getByText("Zoom: 1.30×").waitFor()
    await box.getByRole("button", { name: "Remove the rule Zoom: 1.30×" }).click()
    await box.getByText("Nothing yet").waitFor()
    assert.deepEqual(problems, [])
  } finally {
    await browser.close()
    await stopHost(w.home)
  }
})

test("ET-REV-UI: after a make, a whole-video request shows as a change to the current cut; 360 and 1280 px, light and dark, clean console", { skip, timeout: 280_000 }, async () => {
  const settings = { seconds: 10, captions: "none", music: "none", cutSound: "none" }
  let plans = 0
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "console") return { content: JSON.stringify({ ops: [], direct: {}, say: "That's about the whole video." }) }
      if (task === "plan") return { content: JSON.stringify(plans++ ? { say: "The same cut with a warmer look.", steps: ["Warm the colour"], settings: { ...settings, grade: "warm" } } : { say: "A plain cut.", steps: ["Cut the fillers"], settings }) }
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [] }) }
      return { content: "{}" }
    },
  })
  const w = await studioWorld({ fake })
  const browser = await launchBrowser()
  const problems = []
  const shots = process.env.KRIYA_SHOTS
  try {
    // The cut is made first, from an approved plan, as the Studio sends it
    const first = await w.call("POST", `/projects/${w.id}/plan`, { text: "Edit this", history: [], choices: {} })
    const job = await w.call("POST", `/projects/${w.id}/make`, { asset: w.asset.id, brief: first.brief, plan: { say: first.say, steps: first.steps, settings: first.settings } })
    const done = await until(async () => (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id && ["done", "failed"].includes(j.status)), 200_000, "the make")
    assert.equal(done.status, "done", done.error)

    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("pageerror", (error) => problems.push(String(error)))
    page.on("console", (message) => message.type() === "error" && problems.push(message.text()))
    const { url } = await w.call("POST", "/internal/launch")
    await page.goto(url)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio)
    await page.locator("#prompt").fill("make the whole video warmer")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByText("A change to your current cut, not made yet").waitFor({ timeout: 30_000 })
    assert.ok(await page.getByText("What changes: Colour look: none → warm. The story and your own edits stay.", { exact: false }).isVisible(), "what changes, said by code")
    assert.equal(await page.getByText("The Director's plan, not made yet").count(), 0)
    for (const [width, height] of [[1280, 860], [360, 800]]) {
      await page.setViewportSize({ width, height })
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme })
        const card = page.locator(".proposal.plan")
        await card.scrollIntoViewIfNeeded()
        assert.ok(await card.isVisible(), `${width} ${colorScheme}: the card shows`)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: no sideways scroll`)
        for (const button of await card.getByRole("button").all()) assert.ok((await button.boundingBox()).height >= 44, `${width}: a ${Math.round((await button.boundingBox()).height)} px button`)
        if (shots) await page.screenshot({ path: join(shots, `revision-card-${width}-${colorScheme}.png`) })
      }
    }
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
    await fake.close()
  }
})

test("ET-MG-UI: the Plan Card shows the plan's motion graphics playing, restyles and removes them; 360 and 1280 px, light and dark, clean console", { skip: skip || chromeSkip(), timeout: 280_000 }, async () => {
  const graphics = [
    { kind: "intro", text: "Hello there friends" },
    { kind: "title", style: "slam", text: "built this", at: "a1:w15" },
    { kind: "title", text: "An invented claim", at: "a1:w16" },
  ]
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "plan") return { content: JSON.stringify({ say: "A clean cut with a title.", steps: ["Cut the fillers"], settings: { seconds: 10, captions: "none", music: "none", cutSound: "none" } }) }
      if (task === "graphics") return { content: JSON.stringify({ graphics }) }
      return { content: "{}" }
    },
  })
  const w = await studioWorld({ fake })
  linkMotion(w.home, { hyperframes: false }) // graphics need the runtime's Chrome to be made, so the plan offers them only with it
  const browser = await launchBrowser()
  const problems = []
  const shots = process.env.KRIYA_SHOTS
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("pageerror", (error) => problems.push(String(error)))
    page.on("console", (message) => message.type() === "error" && problems.push(message.text()))
    const { url } = await w.call("POST", "/internal/launch")
    await page.goto(url)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio)
    await page.locator("#prompt").fill("edit this with motion graphics")
    await page.getByRole("button", { name: "Plan", exact: true }).click()
    const card = page.locator(".proposal.plan")
    await card.getByText("Motion graphics", { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(await card.locator(".graphic-picture").count(), 2, "the graphic the speaker never said isn't offered")
    assert.ok(await card.getByText("2 motion graphics", { exact: false }).first().isVisible())
    // Each preview is the kit's own document, playing in a sandboxed frame
    const frame = card.locator(".graphic-picture iframe").first()
    assert.equal(await frame.getAttribute("sandbox"), "allow-scripts")
    await page.frameLocator(".graphic-picture iframe >> nth=0").getByText("Hello there friends").waitFor({ timeout: 20_000 })
    // Restyle the second, recolour them all, then remove the first
    await card.getByLabel("Style of the title").selectOption("words")
    await card.getByLabel("Colour", { exact: true }).selectOption("yellow")
    await page.waitForFunction(() => [...document.querySelectorAll(".graphic-picture iframe")].every((f) => /yellow/.test(decodeURIComponent(f.src))))
    assert.match(decodeURIComponent(await card.locator(".graphic-picture iframe").nth(1).getAttribute("src")), /"style":"words"/)
    for (const [width, height] of [[1280, 860], [360, 800]]) {
      await page.setViewportSize({ width, height })
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme })
        await card.scrollIntoViewIfNeeded()
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: no sideways scroll`)
        const edge = await card.boundingBox()
        assert.ok(edge.x >= 0 && edge.x + edge.width <= width + 1, `${width}: the card is ${Math.round(edge.width)} px wide at ${Math.round(edge.x)}`)
        for (const control of await card.locator("button, select").all()) {
          const box = await control.boundingBox()
          assert.ok(box.height >= 44, `${width}: a ${Math.round(box.height)} px control`)
          assert.ok(box.x + box.width <= edge.x + edge.width + 1, `${width}: a control runs off the card`)
        }
        if (shots) await card.screenshot({ path: join(shots, `graphics-card-${width}-${colorScheme}.png`) })
      }
    }
    await card.getByRole("button", { name: "Remove" }).first().click()
    assert.equal(await card.locator(".graphic-picture").count(), 1)
    assert.ok(await card.getByText("1 motion graphic", { exact: false }).first().isVisible())
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
    await fake.close()
  }
})
