import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { chromium } from "playwright-core"

import { browserTarget } from "../../../src/browser.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { buildStudio } from "../../../studio/build.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { fakeRuntime, rawTake } from "../take.js"
import { chromeSkip, linkFonts } from "./motion-runtime.js"

// The Studio's layout (redesign 2026-11-12): the Kriya panel docked beside the picture with Brief, Chat and Activity
// as tabs that scroll on their own; the chat's empty state; badges for what's new on a closed tab; the Plan Card in
// parts, with Approve pinned at its foot and an Expand sheet; the same palette. 1280×860 and 360×800, light and dark,
// every target 44 px or more, no sideways scroll, a clean console.

const target = browserTarget()
const skip = target ? chromeSkip() : "no Chrome on this computer"
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

test("the Kriya panel's tabs, the chat's empty state, badges, the Plan Card's parts and its Expand sheet; 1280 and 360 px, light and dark", { skip, timeout: 280_000 }, async () => {
  await buildStudio()
  const ids = {}
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: true, assembly: false, livePreview: false, intent: false, craft: false, typeKit: true },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "plan") return { content: JSON.stringify({ say: "A tight cut with two graphics.", steps: ["Keep the best takes"], settings: { format: "9:16", seconds: 30, captions: "none", music: "none", cutSound: "none" } }) }
      if (task === "graphics") return { content: JSON.stringify({ graphics: [{ kind: "card", style: "quote", text: "The hardest part was the design", at: ids.hardest }, { kind: "list", style: "steps", text: "Start small", steps: ["Start small", "ship fast"], at: ids.start }] }) }
      if (task === "console") return { content: JSON.stringify({ ops: [{ op: "punch_in", at: { word: ids.start, edge: "start" }, duration: 705_600_000, scale: 1.2 }], say: "Punched in." }) }
      return { content: JSON.stringify({ graphics: [], ops: [] }) }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-layout-")))
  made.push(home)
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  fakeRuntime(home)
  linkFonts(home, { hyperframes: false })
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  rawTake(join(folder, "take.mov"))
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const browser = await chromium.launch({ ...target, headless: true })
  const shots = process.env.KRIYA_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  const problems = []
  try {
    const { id } = await call("POST", "/projects", { name: "Film", folder })
    const a = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
    const job = await call("POST", `/projects/${id}/index`, { asset: a.id })
    for (let i = 0; i < 600 && !(await call("GET", "/jobs")).jobs.some((j) => j.id === job.id && j.status === "done"); i++) await new Promise((done) => setTimeout(done, 200))
    const { words } = await call("GET", `/projects/${id}/index`)
    ids.hardest = words.find((w) => /^hardest$/i.test(w.text.replace(/\W/g, "")))?.id
    ids.start = words.find((w) => /^start$/i.test(w.text.replace(/\W/g, "")))?.id
    await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: a.id, from: 0, to: 20 * 705_600_000 }] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
    page.on("pageerror", (error) => problems.push(String(error)))
    const { url } = await call("POST", "/internal/launch", {})
    await page.goto(url)
    await page.waitForURL(`http://127.0.0.1:${host.port}/`)
    await page.getByRole("link", { name: "Film" }).click()
    await page.waitForFunction(() => window.__studio)
    const panel = page.getByRole("complementary", { name: "Kriya" })
    const tabs = panel.getByRole("tablist", { name: "Kriya" })
    const tab = (name) => tabs.getByRole("tab", { name: new RegExp(`^${name}`) })

    // Three tabs; Chat first; each shows its own panel only
    assert.deepEqual((await tabs.getByRole("tab").allInnerTexts()).map((t) => t.trim()), ["Brief", "Chat", "Activity"])
    assert.equal(await tab("Chat").getAttribute("aria-selected"), "true")
    assert.equal(await page.locator("#prompt").isVisible(), true)
    assert.equal(await page.locator("#make-format").isVisible(), false)
    // The keyboard: arrows move between tabs and show each one
    await tab("Chat").focus()
    await page.keyboard.press("ArrowLeft")
    assert.equal(await tab("Brief").getAttribute("aria-selected"), "true")
    assert.equal(await page.locator("#make-format").isVisible(), true)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "tab")
    await page.keyboard.press("End")
    assert.equal(await tab("Activity").getAttribute("aria-selected"), "true")
    assert.match(await panel.innerText(), /Nothing yet/)
    await page.keyboard.press("Home")
    // The Brief: groups, and Make it in reach without scrolling the page
    assert.deepEqual(await page.locator(".brief-group .group-title").allInnerTexts(), ["Start from", "Shape", "Look and sound", "Extras", "Brand", "References"])
    const make = await page.getByRole("button", { name: "Make it" }).boundingBox()
    assert.ok(make.y + make.height <= 860, `Make it is on screen (${Math.round(make.y)})`)
    // The panel is docked at the window's height; the picture keeps its own
    const dock = await panel.boundingBox()
    const monitor = await page.getByRole("region", { name: "Monitor" }).boundingBox()
    assert.ok(dock.height <= 860, `the panel fits the window (${Math.round(dock.height)} px)`)
    assert.ok(monitor.height < dock.height + 200, `the monitor isn't stretched (${Math.round(monitor.height)} px)`)
    if (shots) await page.screenshot({ path: join(shots, "layout-brief-1280-light.png") })

    // Chat's empty state: an idea fills the box, sending nothing
    await tab("Chat").click()
    await panel.getByRole("button", { name: "Cut the false starts" }).click()
    assert.equal(await page.locator("#prompt").inputValue(), "Cut the false starts")
    assert.equal(await page.locator(".msg").count(), 0, "nothing was sent")
    if (shots) await page.screenshot({ path: join(shots, "layout-chat-empty-1280-light.png") })

    // A change accepted from chat: What I did grows, and the closed Activity tab says so
    await page.locator("#prompt").fill("punch in on start")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByRole("button", { name: "Accept", exact: true }).click()
    await page.getByText("Applied.", { exact: true }).waitFor()
    await tab("Activity").locator(".tab-badge").waitFor()
    assert.match(await tab("Activity").innerText(), /Activity\s*1/)
    await tab("Activity").click()
    assert.equal(await tab("Activity").locator(".tab-badge").isVisible(), false, "seen")
    assert.equal(await panel.getByRole("list", { name: "What I did" }).locator("li").count(), 1)

    // A plan: its parts as tabs with counts; Approve pinned; Expand opens a sheet; Escape closes it
    await tab("Chat").click()
    await page.locator("#prompt").fill("edit this with motion graphics")
    await page.getByRole("button", { name: "Plan", exact: true }).click()
    const card = page.locator(".proposal.plan")
    const parts = card.getByRole("tablist", { name: "Parts of the plan" })
    await parts.waitFor({ timeout: 60_000 })
    assert.deepEqual((await parts.getByRole("tab").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["Plan", "Graphics 2", "Look"])
    await parts.getByRole("tab", { name: /^Graphics/ }).click()
    await page.frameLocator(".graphic-picture iframe >> nth=0").getByText("The hardest part was the design").waitFor({ timeout: 20_000 })
    assert.equal(await card.getByRole("button", { name: "Approve and make it" }).isVisible(), true)
    await card.getByRole("button", { name: "Remove" }).first().click()
    assert.match(await parts.getByRole("tab", { name: /^Graphics/ }).innerText(), /Graphics\s*1/, "the count follows a removal")
    await card.getByRole("button", { name: "Expand" }).click()
    assert.equal(await card.getAttribute("role"), "dialog")
    const sheet = await card.boundingBox()
    assert.ok(sheet.width > 800, `the sheet is wide (${Math.round(sheet.width)} px)`)
    if (shots) await page.screenshot({ path: join(shots, "layout-plan-sheet-1280-light.png") })
    await page.keyboard.press("Escape")
    assert.equal(await card.getAttribute("role"), null, "Escape closes the sheet")
    assert.equal(await card.getByRole("button", { name: "Expand" }).isVisible(), true)

    for (const [width, height] of [[1280, 860], [360, 800]]) {
      await page.setViewportSize({ width, height })
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme })
        for (const name of ["Brief", "Chat", "Activity"]) {
          await tab(name).click()
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${colorScheme} ${name}: no sideways scroll`)
          const small = await page.evaluate(() =>
            [...document.querySelectorAll(".area-kriya button, .area-kriya select, .area-kriya input, .area-kriya textarea")]
              .filter((el) => el.offsetParent && !el.closest(".inline") && el.type !== "color")
              .map((el) => ({ el: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24) || el.id, ...el.getBoundingClientRect().toJSON() }))
              .filter((r) => r.height < 44 || r.width < 44)
              .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
          )
          assert.deepEqual(small, [], `${width} ${colorScheme} ${name}: every target is 44 px or more`)
          if (shots) {
            await panel.scrollIntoViewIfNeeded()
            await page.screenshot({ path: join(shots, `layout-${name.toLowerCase()}-${width}-${colorScheme}.png`) })
          }
        }
      }
    }
    assert.deepEqual(problems, [], "console clean")
  } finally {
    await browser.close()
    await stopHost(home)
    await fake.close()
  }
})
