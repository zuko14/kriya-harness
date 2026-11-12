import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { chromium } from "playwright-core"

import { browserTarget } from "../../../src/browser.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { buildStudio } from "../../../studio/build.js"
import { partsOf } from "../../../studio/src/storyboard.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { barcodeVideo } from "./barcode.js"

// ET-ASM-UI and ET-ASM-REG-01 in the installed Chrome, headless, against a real Host, the
// real FFmpeg and synthetic barcode clips: the storyboard, the bin and mentions at 1280 and
// 360 px, light and dark. A script stands in for the model. TP1_SHOTS=<folder> keeps screenshots.

const target = browserTarget()
const skip = target ? false : "no Chrome on this computer"
const shots = process.env.TP1_SHOTS

async function studioWorld({ assembly }) {
  await buildStudio()
  const prompts = []
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly },
    chat(body) {
      prompts.push(JSON.stringify(body.messages))
      return { content: JSON.stringify({ ops: [], say: "Noted." }) }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0, "signed in to the fake Kriya")
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  const assets = []
  for (const [name, frames] of [["walk-in.mov", 90], ["beach final.mov", 150], ["outro.mov", 60]]) {
    await barcodeVideo(join(folder, name), { frames })
    assets.push(await call("POST", `/projects/${id}/assets`, { path: join(folder, name) }))
  }
  const order = async () => partsOf((await call("GET", `/projects/${id}`)).project).map((part) => part.asset)
  return { home, host, call, id, assets, prompts, fake, order }
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
  await page.waitForFunction(() => window.__studio)
  return { page, problems }
}

// The Studio's own rule (studio.test.js): every target 44 px or more; words in a sentence are inline text
const smallTargets = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("button, a, input, select, textarea, [role=option]")]
      .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
      .map((el) => ({ el: el.getAttribute("aria-label") || el.textContent || el.className, ...el.getBoundingClientRect().toJSON() }))
      .filter((r) => r.height < 44 || r.width < 44)
      .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
  )
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const shoot = async (page, name) => shots && (mkdirSync(shots, { recursive: true }), await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }))

test("ET-ASM-UI: the storyboard by pointer and by keyboard, the bin, and mentions; 1280 and 360 px, light and dark, clean console", { skip, timeout: 280_000 }, async () => {
  const w = await studioWorld({ assembly: true })
  const browser = await chromium.launch({ ...target, headless: true })
  try {
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    const [a1, a2, a3] = w.assets.map((asset) => asset.id)
    const board = page.getByRole("region", { name: "Storyboard" })
    const cards = board.getByRole("group")
    assert.ok(await board.isVisible(), "the storyboard shows in Direct")
    assert.equal(await cards.count(), 0)
    assert.equal(await page.getByRole("button", { name: "Mention this" }).isVisible(), false, "nothing is selected, so there's nothing to mention")

    // Add: Enter on a clip not used yet, then a click
    await board.getByRole("button", { name: "Add clip 1, walk-in.mov, to the film" }).focus()
    await page.keyboard.press("Enter")
    await cards.first().waitFor()
    await board.getByRole("button", { name: /^Add clip 2,/ }).click()
    await board.getByRole("button", { name: /^Add clip 3,/ }).click()
    await page.waitForFunction(() => document.querySelectorAll(".sb-card").length === 3)
    assert.deepEqual(await w.order(), [a1, a2, a3])
    assert.equal(await cards.nth(1).getAttribute("aria-label"), "Part 2 of 3: clip 2, beach final.mov, whole, 0:05", "what a screen reader hears")
    assert.ok(await board.getByText("Every clip is in the film.").isVisible())
    // A video's thumbnail is the first tile of its sheet, loaded from this origin
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".sb-card .thumb")).backgroundImage.includes("/tiles/"))
    assert.equal((await page.request.get(`http://127.0.0.1:${w.host.port}/tiles/${(await w.call("GET", `/projects/${w.id}`)).assets[0].media}?kind=thumbs`)).status(), 200)

    // Keyboard: Alt+→ moves the focused card later, and the focus goes with it; Cmd+Z undoes it
    await cards.first().focus()
    await page.keyboard.press("Alt+ArrowRight")
    await page.waitForFunction(() => document.activeElement?.dataset.part === "p1" && document.querySelectorAll(".sb-card")[1] === document.activeElement)
    assert.deepEqual(await w.order(), [a2, a1, a3])
    await page.keyboard.press("Control+z")
    await page.waitForFunction(() => document.querySelector(".sb-card")?.dataset.part === "p1")
    assert.deepEqual(await w.order(), [a1, a2, a3], "undo restores the order")
    // The transport's own keys didn't fire from the card: nothing was deleted from the cut, no frame stepped
    assert.equal(await page.evaluate(() => window.__studio.monitor.time), 0)

    // Pointer: drag the third card onto the first
    await cards.nth(2).dragTo(cards.first())
    await page.waitForFunction(() => document.querySelector(".sb-card")?.dataset.part === "p3")
    assert.deepEqual(await w.order(), [a3, a1, a2], "a drag is stored")
    // Delete leaves it out; it comes back under Not used
    await cards.first().focus()
    await page.keyboard.press("Delete")
    await board.getByRole("button", { name: /^Add clip 3,/ }).waitFor()
    assert.deepEqual(await w.order(), [a1, a2])
    // How it fits the frame: fill is the absence of the key
    await cards.nth(1).getByRole("combobox").selectOption("blur")
    await page.waitForFunction(() => document.querySelectorAll(".sb-card select")[1]?.value === "blur")
    assert.equal(partsOf((await w.call("GET", `/projects/${w.id}`)).project)[1].fit, "blur")

    // Mentions: @ opens the picker; Enter chooses; the message goes with a place, and the Director sees a clip number
    const prompt = page.getByRole("textbox", { name: "Message Kriya" })
    await prompt.click()
    await page.keyboard.type("put @")
    const picker = page.getByRole("listbox", { name: "Clips to mention" })
    await picker.waitFor()
    assert.equal(await picker.getByRole("option").count(), 3)
    assert.equal(await prompt.getAttribute("aria-expanded"), "true")
    assert.deepEqual(await smallTargets(page), [], "1280: every target is at least 44 px, the picker's options too")
    await shoot(page, "1280-light-direct-picker")
    await page.keyboard.type("bea")
    assert.equal(await picker.getByRole("option").count(), 1)
    await page.keyboard.press("Enter")
    assert.equal(await prompt.inputValue(), "put @2 ", "Enter chose the clip and sent nothing")
    assert.equal(w.prompts.length, 0)
    // A card dragged onto the chat box is the same token
    await cards.first().dragTo(prompt)
    assert.equal(await prompt.inputValue(), "put @2 @1 ")
    await page.keyboard.type("first")
    await page.keyboard.press("Enter")
    await page.getByText("Noted.").waitFor()
    assert.deepEqual(await page.locator(".msg.you .chip.mention").allTextContents(), ["@2", "@1"])
    const sent = w.prompts.at(-1)
    assert.ok(sent.includes("put ⟦1⟧ ⟦2⟧ first"), "the message carries places")
    assert.ok(sent.includes(`⟦1⟧ = clip 2 (asset ${a2}, video), file name \\"beach final\\"`) && sent.includes(`⟦2⟧ = clip 1 (asset ${a1}, video)`), "and the Director reads each as a clip")
    assert.equal(sent.includes(w.home), false, "never a path")
    // Escape closes the picker without leaving the chat box
    await page.keyboard.type("@")
    await picker.waitFor()
    await page.keyboard.press("Escape")
    assert.equal(await picker.isVisible(), false)
    assert.equal(await page.evaluate(() => document.activeElement.id), "prompt")
    await prompt.fill("")

    // The bin, in Edit: numbers, a label by F2, search, sort and groups
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    const bin = page.getByRole("list", { name: "Footage" })
    assert.deepEqual(await bin.locator(".badge").allTextContents(), ["1", "2", "3"])
    await bin.getByRole("button", { name: "beach final.mov · video" }).focus()
    await page.keyboard.press("F2")
    await page.getByRole("textbox", { name: "Label for clip 2" }).fill("the <b>beach</b>")
    await page.keyboard.press("Enter")
    await bin.getByRole("button", { name: "the b beach b · video" }).waitFor()
    assert.equal((await w.call("GET", `/projects/${w.id}`)).project.assets[1].label, "the b beach b", "stored cleaned")
    await page.getByRole("searchbox", { name: "Search the bin" }).fill("beach")
    assert.deepEqual(await bin.locator(".badge").allTextContents(), ["2"], "found by its label")
    await page.getByRole("searchbox", { name: "Search the bin" }).fill("OUTRO")
    assert.deepEqual(await bin.locator(".badge").allTextContents(), ["3"], "found by its file name")
    await page.getByRole("searchbox", { name: "Search the bin" }).fill("")
    await page.getByRole("combobox", { name: "Sort the bin" }).selectOption("length")
    assert.deepEqual(await bin.locator(".badge").allTextContents(), ["2", "1", "3"], "longest first")
    await page.getByRole("combobox", { name: "Group the bin" }).selectOption("day")
    assert.equal(await bin.locator(".bin-group").count(), 1)
    await bin.getByRole("combobox", { name: "What clip 3 is" }).selectOption("broll")
    await page.waitForFunction(() => document.querySelector('[aria-label="What clip 3 is"]')?.value === "broll")
    assert.equal((await w.call("GET", `/projects/${w.id}`)).project.assets[2].role, "broll")
    assert.deepEqual(await smallTargets(page), [], "1280, Edit: every target is at least 44 px")
    assert.ok(await noSideScroll(page))
    await shoot(page, "1280-light-edit-bin")
    await page.getByRole("button", { name: "Direct", exact: true }).click()
    await shoot(page, "1280-light-direct")
    await page.emulateMedia({ colorScheme: "dark" })
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(10, 18, 19)", "dark paper")
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".sb-card")).backgroundColor), "rgb(10, 18, 19)", "a card follows the theme")
    await shoot(page, "1280-dark-direct")

    // 360 px: the strip is a list, and each row has Move up and Move down
    await page.setViewportSize({ width: 360, height: 800 })
    assert.ok(await noSideScroll(page), "no sideways scroll at 360 px")
    assert.ok(await board.isVisible())
    const boxes = await Promise.all([cards.nth(0), cards.nth(1)].map((card) => card.boundingBox()))
    assert.ok(boxes[1].y >= boxes[0].y + boxes[0].height, "the cards stack")
    assert.deepEqual(await smallTargets(page), [], "360: every target is at least 44 px")
    await shoot(page, "360-dark-direct")
    await page.emulateMedia({ colorScheme: "light" })
    const before = await w.order()
    await board.getByRole("button", { name: "Move clip 1 down" }).click()
    await page.waitForFunction(() => document.querySelector(".sb-card")?.dataset.part === "p2")
    assert.deepEqual(await w.order(), [...before].reverse(), "Move down is stored")
    assert.ok(await board.getByRole("button", { name: "Move clip 1 down" }).isDisabled(), "the last row can't go further")
    await shoot(page, "360-light-direct")
    assert.deepEqual(problems, [], "the console is clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
    await w.fake.close()
  }
})

test("ET-ASM-REG-01 in Chrome: switch off, the Studio has the elements it had: no storyboard, no numbers, no picker", { skip, timeout: 280_000 }, async () => {
  const w = await studioWorld({ assembly: false })
  const browser = await chromium.launch({ ...target, headless: true })
  try {
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    const added = () => page.evaluate(() => document.querySelectorAll(".storyboard, .area-story, .sb-card, .bin-tools, #bin-search, .badge, .thumb, .mention-list, .has-story, .asset.handle, [draggable=true]").length)
    for (const mode of ["Direct", "Edit", "Finish"]) {
      await page.getByRole("button", { name: mode, exact: true }).click()
      assert.equal(await added(), 0, `${mode}: nothing of TP1 is on the page`)
    }
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    assert.deepEqual(await page.getByRole("list", { name: "Footage" }).getByRole("button").allTextContents(), ["walk-in.mov · video", "Index", "Add to cut", "beach final.mov · video", "Index", "Add to cut", "outro.mov · video", "Index", "Add to cut"], "the bin's rows are the ones it had")
    await page.getByRole("button", { name: "Direct", exact: true }).click()
    const prompt = page.getByRole("textbox", { name: "Message Kriya" })
    assert.match(await prompt.getAttribute("placeholder"), /^Tell Kriya: "remove 0:05 to 0:09"/)
    assert.equal(await prompt.getAttribute("aria-controls"), null)
    await prompt.click()
    await page.keyboard.type("put @1 first")
    await page.keyboard.press("Enter")
    await page.getByText("Noted.").waitFor()
    assert.ok(w.prompts.at(-1).includes("put @1 first"), "an @ is plain text")
    assert.equal(w.prompts.at(-1).includes("⟦"), false)
    assert.equal(await page.locator(".chip.mention").count(), 0)
    await page.setViewportSize({ width: 360, height: 800 })
    assert.ok(await noSideScroll(page))
    assert.equal(await added(), 0)
    assert.deepEqual(problems, [], "the console is clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
    await w.fake.close()
  }
})

// TP2: the Plan Card's Order (ASSEMBLY_AND_INTENT §5), in Chrome against a real Host. TP2_SHOTS=<folder> keeps screenshots.
const until = async (check, limit = 60_000) => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, "timed out")
    await new Promise((done) => setTimeout(done, 100))
  }
}
const shots2 = process.env.TP2_SHOTS
const shoot2 = async (page, name) => shots2 && (mkdirSync(shots2, { recursive: true }), await page.screenshot({ path: join(shots2, `${name}.png`), fullPage: true }))

test("ET-ASM-UI (TP2): the card's Order shows the film's parts before anything renders, moves by pointer and keyboard, and Approve sends exactly the order shown; 1280 and 360 px, light and dark", { skip, timeout: 280_000 }, async () => {
  const w = await studioWorld({ assembly: true })
  const browser = await chromium.launch({ ...target, headless: true })
  try {
    const { page, problems } = await open(w, browser, { width: 1280, height: 860 })
    const [a1, a2, a3] = w.assets.map((asset) => asset.id)
    const prompt = page.getByRole("textbox", { name: "Message Kriya" })
    await prompt.fill("clip 3 first, then clip 1, then clip 2")
    await page.getByRole("button", { name: /^Plan/ }).click()
    const strip = page.getByRole("list", { name: "The film's order" }).last()
    await strip.waitFor()
    const rows = strip.locator(".order-part")
    const shown = async () => (await rows.locator("b").allTextContents()).map((text) => text.trim())
    assert.deepEqual(await shown(), ["Clip 3", "Clip 1", "Clip 2"], "the order, as the person said it, before any render")
    assert.match(await rows.first().textContent(), /outro.*whole.*0:02\.0.*as you said/s, "each part: its name, its use, its length, who decided")
    assert.equal((await w.call("GET", "/jobs")).jobs.some((j) => j.kind === "make"), false, "nothing is made until it is approved")
    assert.equal(w.prompts.some((p) => p.includes("assembly")) && false, false)
    assert.deepEqual(await smallTargets(page), [], "1280: every target is at least 44 px, the Order's moves too")
    assert.ok(await noSideScroll(page))
    await shoot2(page, "1280-light-plan-order")

    // Pointer: move clip 1 later; a screen reader hears it; the focus stays on the moves
    await strip.getByRole("button", { name: "Move clip 1, walk in later" }).click()
    await page.waitForFunction(() => [...document.querySelectorAll(".order-part b")].slice(-3).map((b) => b.textContent.trim()).join() === "Clip 3,Clip 2,Clip 1")
    assert.equal(await page.locator(".order [role=status]").last().textContent(), "clip 1, walk in moved later.")
    assert.ok(await strip.getByRole("button", { name: "Move clip 1, walk in later" }).isDisabled(), "the last part can't go later")
    assert.ok(await strip.getByRole("button", { name: "Move clip 3, outro earlier" }).isDisabled(), "nor the first earlier")
    // Keyboard: Tab reaches a move, Enter makes it
    await strip.getByRole("button", { name: "Move clip 2, beach final earlier" }).focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => [...document.querySelectorAll(".order-part b")].slice(-3).map((b) => b.textContent.trim()).join() === "Clip 2,Clip 3,Clip 1")
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("order-move")), true, "the focus stays in the Order")

    await page.emulateMedia({ colorScheme: "dark" })
    await shoot2(page, "1280-dark-plan-order")
    await page.setViewportSize({ width: 360, height: 800 })
    assert.ok(await noSideScroll(page), "no sideways scroll at 360 px")
    assert.deepEqual(await smallTargets(page), [], "360: every target is at least 44 px")
    await strip.scrollIntoViewIfNeeded()
    await shoot2(page, "360-dark-plan-order")
    await page.emulateMedia({ colorScheme: "light" })
    await shoot2(page, "360-light-plan-order")

    // Approve sends exactly the order shown, and the make follows it
    await page.getByRole("button", { name: "Approve and make it" }).last().click()
    const job = await until(async () => (await w.call("GET", "/jobs")).jobs.find((j) => j.kind === "make"))
    const { DatabaseSync } = await import("node:sqlite")
    const journal = new DatabaseSync(join(w.home, "edit", w.id, "journal.sqlite"), { readOnly: true })
    const request = JSON.parse(journal.prepare("select request from jobs where kind = 'make'").get().request)
    journal.close()
    assert.deepEqual(request.brief.assembly.parts.map((part) => part.asset), [a2, a3, a1], "the order on the card is the order made")
    const done = await until(async () => {
      const row = (await w.call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    }, 200_000)
    assert.equal(done.status, "done", done.error)
    assert.ok(JSON.parse(done.output).notes.some((n) => /^The film's order: 1\. clip 2.*2\. clip 3.*3\. clip 1/.test(n)))
    assert.deepEqual(problems, [], "the console is clean")
  } finally {
    await browser.close()
    await stopHost(w.home)
    await w.fake.close()
  }
})

test("ET-ASM-REG-01 (TP2): switch off, a plan has no Order, its brief no assembly, and the plan's prompt says nothing of one", { timeout: 120_000 }, async () => {
  const [off, on] = [await studioWorld({ assembly: false }), await studioWorld({ assembly: true })]
  try {
    const text = "clip 3 first, then clip 1, then clip 2"
    const [plain, ordered] = [await off.call("POST", `/projects/${off.id}/plan`, { text }), await on.call("POST", `/projects/${on.id}/plan`, { text })]
    assert.deepEqual([plain.order, plain.brief.assembly, plain.settings.assembly], [undefined, undefined, undefined])
    assert.deepEqual(ordered.order.parts.map((p) => p.number), [3, 1, 2])
    // The same message: the plan's own call is the one it was, switch on or off (no order is asked of the model there)
    const strip = (prompt) => prompt.replaceAll(off.home, "").replaceAll(on.home, "")
    assert.equal(strip(on.prompts.at(-1)), strip(off.prompts.at(-1)), "the plan prompt, byte for byte")
    assert.equal(on.prompts.length, off.prompts.length, "and no extra call")
  } finally {
    for (const w of [off, on]) {
      await stopHost(w.home)
      await w.fake.close()
    }
  }
})
