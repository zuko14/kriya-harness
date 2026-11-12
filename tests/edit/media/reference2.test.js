import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"

import { checkDna2, DNA2_VERSION, extractDna2, measureDna2 } from "../../../src/edit/engine/dna2.js"
import { motionRuntime } from "../../../src/edit/engine/motion.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { ROOT } from "../../helpers.js"
import { indexOf } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"
import { linkMotion, motionSkip } from "./motion-runtime.js"
import { makeReference } from "./reference-made.js"
import { hostHeaders } from "../../../src/edit/host/paths.js"

// TP6 on the real FFmpeg and Chrome (TOP_TIER_PLAN §5). ET-RF2-M1: references Kriya renders itself, with a
// known mix of its own joins, punch-ins, caption looks, graphics, effects and a code-made bed, are measured
// into an Edit DNA 2 and every trait comes back within its tolerance. ET-RF2-M2: a make through the Host and
// the Studio follows such a reference's style brief, QG-16 says how far, and no part of the reference is in
// the film (ET-SEC-08). No one else's video, no model: the Director's two slots are scripted.

const skip = motionSkip()
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-ref2-")))
const shots = process.env.TP6_SHOTS
const KINDS = ["cut", "fade", "dip", "flash", "wipe", "slide", "zoom"]
let styled = null
let hostHome = null
after(async () => hostHome && (await stopHost(hostHome).catch(() => {})))

const per = (list, kind, seconds) => (list.filter((k) => k === kind).length / seconds) * 60
const close = (a, b, tolerance, what) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} against ${b} (±${tolerance})`)

test("ET-RF2-M1: Kriya-made references: every join's kind and time, punch-ins, captions, graphics, grain, corners, bars, a bed and its tempo come back within tolerance, as numbers and fixed words", { skip, timeout: 280_000 }, async () => {
  const motion = motionRuntime(linkMotion(join(dir, "home")))
  // A: wide, every kind of join Kriya makes at 0.4 s, under bars, a vignette and grain
  const joins = ["cut", "fade", "dip", "flash", "wipe", "slide", "zoom", "cut", "fade"]
  const mixed = await makeReference(dir, { name: "mixed", width: 960, height: 540, shots: [{ seconds: 3.4 }, ...joins.map((k) => ({ seconds: 3.4, ...(k === "cut" ? {} : { enter: k }) }))], effects: [{ effect: "letterbox", params: { ratio: 2.39 } }, { effect: "vignette", params: { strength: 0.8 } }, { effect: "grain", params: { amount: 20 } }] })
  // B: tall, word-by-word captions on a plate, a name strap and a title, two punch-ins, slides on three joins, an upbeat bed
  styled = await makeReference(dir, { name: "styled", motion, shots: Array.from({ length: 8 }, (_, i) => ({ seconds: 3.4, ...(i % 3 === 1 ? { enter: "slide" } : {}) })), captions: { look: "karaoke", words: 2 }, graphics: [{ shot: 1, graphic: { kind: "lower", text: "Asha Rao", subtitle: "Founder" } }, { shot: 5, graphic: { kind: "title", text: "Start small" } }], punches: [{ shot: 2, scale: 1.25 }, { shot: 6, scale: 1.25 }], music: "upbeat" })

  /* A: joins, and the look */
  const started = Date.now()
  const a = await measureDna2(mixed.file)
  const took = Date.now() - started
  const found = a.motion.joins
  console.log(`ET-RF2-M1 mixed (${mixed.truth.seconds.toFixed(1)} s, measured in ${took} ms): ${found.map((j) => `${j.t.toFixed(2)}:${j.kind}`).join(" ")}`)
  assert.deepEqual(found.map((j) => j.kind), mixed.truth.joins.map((j) => j.kind), "every join, by kind, none missed and none made up")
  // Within two samples of where the plan put it (a gradual join is found as it starts to show)
  found.forEach((j, i) => close(j.t, mixed.truth.joins[i].t, 0.15, `join ${i} (${j.kind})`))
  const dnaA = await extractDna2(mixed.file)
  assert.equal(checkDna2(dnaA).version, DNA2_VERSION)
  for (const kind of KINDS) close(dnaA.transitions.perMinute[kind], per(joins, kind, mixed.truth.seconds), 0.05, `${kind} a minute`)
  assert.deepEqual([dnaA.transitions.read, dnaA.transitions.unread, dnaA.rhythm.shots, dnaA.format.shape], ["yes", 0, 10, "landscape"])
  close(dnaA.rhythm.median, 3.4, 0.15, "the median shot")
  close(dnaA.transitions.seconds, 0.4, 0.14, "a join's length")
  close(dnaA.colour.letterbox, 1 - 960 / 2.39 / 540, 0.02, "bars")
  assert.ok(dnaA.colour.grain > 0.8 && dnaA.colour.vignette > 0.2, `grain ${dnaA.colour.grain}, corners ${dnaA.colour.vignette}`)
  assert.deepEqual([dnaA.captions.present, dnaA.graphics.perMinute, dnaA.moves.zoomsPerMinute], [false, 0, 0], "no text and no zoom where there is none")
  assert.equal(dnaA.sound.bpm, null, "a voice alone gives no tempo")
  assert.ok(dnaA.sound.bed < -30, `no bed: ${dnaA.sound.bed}`)

  /* B: captions, graphics, punch-ins, sound */
  const dna = await extractDna2(styled.file)
  console.log(`ET-RF2-M1 styled (${JSON.stringify(dna).length} bytes): ${JSON.stringify(dna)}`)
  assert.equal(checkDna2(dna), dna)
  const seconds = styled.truth.seconds
  close(dna.transitions.perMinute.slide, (3 / seconds) * 60, 0.05, "slides a minute")
  close(dna.transitions.perMinute.cut, (4 / seconds) * 60, 0.05, "cuts a minute")
  close(dna.moves.zoomsPerMinute, (2 / seconds) * 60, 0.05, "punch-ins a minute")
  close(dna.moves.scale, 1.25, 0.05, "the punch-in's scale")
  assert.deepEqual([dna.captions.present, dna.captions.plate, dna.captions.highlight, dna.captions.lines], [true, "box", true, 1])
  close(dna.captions.pagesPerMinute, (styled.truth.pages / seconds) * 60, 5, "caption pages a minute")
  close(dna.captions.height, 0.046 * 0.93, 0.008, "the caption's height (karaoke is 4.6% of the height)")
  assert.ok(dna.captions.top > 0.75 && dna.captions.bottom < 0.95 && dna.captions.contrast > 4.5, JSON.stringify(dna.captions))
  close(dna.graphics.perMinute, (2 / seconds) * 60, 0.5, "graphics a minute")
  assert.equal(dna.graphics.lowerBand, true, "the name strap, lower left")
  close(dna.sound.bpm, 112, 4, "the bed's tempo")
  assert.ok(dna.sound.bed > -30, `a bed under the voice: ${dna.sound.bed}`)
  close(dna.sound.lufs, -14, 1, "loudness")
  assert.deepEqual([dna.format.shape, dna.format.fps, dna.colour.letterbox], ["vertical", 30, 0])
  assert.ok(dna.colour.grain < 0.8 && Math.abs(dna.colour.vignette) < 0.2, "no grain or dark corners where none were put")
  // Numbers and fixed words only: no name, path or word of the reference (the captions said "Start", "small", …)
  assert.doesNotMatch(JSON.stringify(dna), /styled|Reference|\.mp4|\/|Start|small|Asha|Founder/)
  assert.ok(JSON.stringify(dna).length < 2400)
  // The same file, the same numbers
  assert.deepEqual(await extractDna2(styled.file), dna)
})

test("ET-RF2-M2, ET-RF2-08, ET-SEC-08, operator rule 7: through the Host and the Studio, a reference's style is read as a job (cancelled once), an older cached analysis is measured again, the brief is shown and unticked, the make follows it, QG-16 says how far, and nothing of the reference is in the film", { skip, timeout: 560_000 }, async () => {
  assert.ok(styled, "ET-RF2-M1 made the reference")
  const home = (hostHome = realpathSync(mkdtempSync(join(tmpdir(), "kh-ref2-host-"))))
  const folder = join(home, "work", "reel")
  mkdirSync(folder, { recursive: true })
  // The usual take's voice (the stand-in recogniser knows its words) under a nearly still, detailed picture, as a locked-off
  // talking head is (a small box drifts, so it isn't frozen): its own jump cuts don't show, so the reference's pace has to come from punch-ins, which do
  const source = join(folder, "take.mov")
  rawTake(join(home, "voice.mov"))
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(home, "voice.mov"), "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30,geq=lum='128+55*sin(X/9)*cos(Y/7)+35*sin((X+Y)/23)':cb=118:cr=140,drawbox=x='280+40*sin(t)':y=140:w=80:h=80:color=0xd8d8d0:t=fill,noise=alls=4:allf=t", "-map", "1:v", "-map", "0:a", "-c:v", "libx264", "-crf", "18", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "copy", "-shortest", source])
  fakeRuntime(home)
  linkMotion(home)
  const index = indexOf()
  const tasks = []
  // Six words a few sentences apart, for the punch-ins the reference's pace asks for
  const emphasis = ["today", "week.", "fifty", "total.", "design.", "friends.", "year.", "small.", "users.", "time."].map((text) => index.words.find((w) => w.text === text)?.id).filter(Boolean)
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion: false, assembly: false, livePreview: false, intent: false, craft: true, typeKit: false, referenceIntent: true },
    chat(body) {
      const task = body.response_format?.json_schema?.name
      tasks.push(task)
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      // Words the cut didn't keep are named in the retry: answered again without them, as a model would
      if (task === "emphasis") {
        const refused = new Set([...JSON.stringify(body.messages).matchAll(/(a1:w\d+)\\*" isn't a kept word/g)].map((m) => m[1]))
        return { content: JSON.stringify({ emphasis: emphasis.filter((id) => !refused.has(id)).slice(0, 8) }) }
      }
      return { content: "{}" }
    },
  })
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const host = await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const upload = (path, bytes) =>
    new Promise((done, fail) => {
      const req = request({ socketPath: join(home, "edit", "host.sock"), method: "POST", path, headers: hostHeaders(home) }, (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => (res.statusCode === 200 ? done(JSON.parse(Buffer.concat(chunks).toString())) : fail(new Error(Buffer.concat(chunks).toString()))))
      })
      req.on("error", fail)
      req.end(bytes)
    })
  const jobOf = async (id) => (await call("GET", "/jobs")).jobs.find((j) => j.id === id)
  const until = async (id, limit = 480_000) => {
    for (const start = Date.now(); ; ) {
      const row = await jobOf(id)
      if (["done", "failed", "canceled"].includes(row.status)) return row
      assert.ok(Date.now() - start < limit, "timed out waiting for a job")
      await new Promise((done) => setTimeout(done, 150))
    }
  }
  try {
    const { id } = await call("POST", "/projects", { name: "Like this", folder })
    const asset = await call("POST", `/projects/${id}/assets`, { path: source })
    const ref = await upload(`/projects/${id}/upload?name=style.mp4&as=reference`, readFileSync(styled.file))
    assert.equal(ref.kind, "reference")
    const refs = join(home, "edit", id, "cache", "refs")
    const kept = () => (existsSync(refs) ? readdirSync(refs).filter((name) => name.endsWith(".dna2.json")) : [])
    const briefOf = () => call("GET", `/projects/${id}/references/${ref.id}/brief?format=9:16`)

    /* ET-RF2-08: asking for a brief measures nothing; the measure is a job, and a cancelled one keeps nothing */
    assert.deepEqual([(await briefOf()).status, kept()], ["none", []])
    const first = await call("POST", `/projects/${id}/references/${ref.id}/measure`)
    assert.deepEqual([first.kind, first.asset], ["reference", ref.id])
    await call("DELETE", `/jobs/${first.id}`)
    assert.equal((await until(first.id)).status, "canceled")
    assert.deepEqual([kept(), (await briefOf()).status], [[], "none"], "cancelled: nothing kept, still not measured")
    // An older analysis under the new name (an Edit DNA 1, as ED13 wrote them) is never read as the new shape
    mkdirSync(refs, { recursive: true })
    const stale = join(refs, `${ref.fingerprint}.dna2.json`)
    writeFileSync(stale, JSON.stringify({ kind: "edit-dna", version: "dna-1", seconds: 27, pace: { shots: 8, cutsPerMinute: 15, median: 3.4, p10: 3, p90: 3.5, curve: new Array(10).fill(3.4) }, structure: { firstCut: 3.4, lastShot: 3.4 }, colour: null, captions: null, sound: null }))
    assert.equal((await briefOf()).status, "none", "an Edit DNA 1 counts as not measured")
    const measuring = await call("POST", `/projects/${id}/references/${ref.id}/measure`)
    let progressed = false
    for (let row = await jobOf(measuring.id); !["done", "failed", "canceled"].includes(row.status); row = await jobOf(measuring.id)) {
      progressed ||= row.progress > 0 && row.progress < 100
      await new Promise((done) => setTimeout(done, 40))
    }
    const measuredJob = await jobOf(measuring.id)
    assert.equal(measuredJob.status, "done", measuredJob.error)
    assert.equal(progressed, true, "it reported progress on the way")
    const dna = JSON.parse(readFileSync(stale, "utf8"))
    assert.equal(checkDna2(dna).version, DNA2_VERSION, "measured again, and kept as an Edit DNA 2")
    // The older ED13 analysis lives on under its own name, untouched by any of this
    await call("GET", `/projects/${id}/references/${ref.id}`)
    assert.ok(readdirSync(refs).some((name) => name.endsWith(".2.json") && !name.endsWith(".dna2.json")))

    /* The brief */
    const { status, brief } = await briefOf()
    assert.equal(status, "ready")
    console.log(`ET-RF2-M2 the brief:\n${brief.lines.map((l) => `  ${{ matched: "✓", nearest: "≈", cannot: "✗" }[l.state]} ${l.text}${l.why ? `  (${l.why})` : ""}${l.gate ? `  [gate: ${l.gate}]` : ""}`).join("\n")}\n  couldn't read: ${brief.unread.join(", ") || "nothing"}`)
    const state = Object.fromEntries(brief.lines.map((l) => [l.id, l.state]))
    assert.deepEqual([state.pace, state.joins, state.zooms, state.captions, state.graphics, state.colour, state.music, state.format], ["matched", "nearest", "matched", "nearest", "matched", "matched", "nearest", "matched"])
    const captions = brief.lines.find((l) => l.id === "captions")
    assert.deepEqual([captions.set.captions, captions.gate], ["karaoke", "safe zones"], "Kriya's nearest look, kept clear of the app's buttons")
    assert.match(captions.why, /I kept mine clear of them/)

    /* The Studio (operator rule 7), then the make from it */
    const { chromium } = await import("playwright-core")
    const { browserTarget } = await import("../../../src/browser.js")
    const { buildStudio } = await import("../../../studio/build.js")
    await buildStudio()
    assert.ok(browserTarget(), "a Chrome for the Studio check")
    const browser = await chromium.launch({ ...browserTarget(), headless: true })
    let result
    try {
      const problems = []
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
      page.on("console", (message) => message.type() === "error" && problems.push(`${message.text()} ${message.location().url}`))
      page.on("pageerror", (error) => problems.push(String(error)))
      const shoot = async (name, target = null) => shots && (mkdirSync(shots, { recursive: true }), await (target ?? page).screenshot({ path: join(shots, `${name}.png`), ...(target ? {} : { fullPage: true }) }))
      // Every control at least 44 px; a brief's tick is its whole row
      const smallTargets = () =>
        page.evaluate(() =>
          [...document.querySelectorAll("button, a, input, select, textarea, [role=option]")]
            .filter((el) => el.offsetParent && !el.classList.contains("word") && !el.closest(".inline"))
            .map((el) => el.closest("label.style-label") ?? el)
            .map((el) => ({ el: el.getAttribute("aria-label") || el.id || el.textContent || el.className, ...el.getBoundingClientRect().toJSON() }))
            .filter((r) => r.height < 44 || r.width < 44)
            .map((r) => `${r.el}: ${Math.round(r.width)}×${Math.round(r.height)}`),
        )
      const { url } = await call("POST", "/internal/launch", {})
      await page.goto(url)
      await page.waitForURL(`http://127.0.0.1:${host.port}/`)
      await page.getByRole("link", { name: "Like this" }).click()
      await page.waitForFunction(() => window.__studio)
      await page.evaluate(() => window.__studio.setMode("direct"))
      // The redesign's Kriya panel: the references and the make are on its Brief tab
      await page.getByRole("tab", { name: /^Brief/ }).click()
      const card = page.locator(`#style-rows-direct-${ref.id}`)
      await card.waitFor({ timeout: 20_000 })
      const rows = await card.locator("li").allInnerTexts()
      assert.equal(rows.length, brief.lines.length)
      assert.ok(rows.some((r) => /✓\s*matched: A change of picture about every \d\.\d s/.test(r.replace(/\n/g, " "))), rows.join(" | "))
      assert.ok(rows.some((r) => /≈/.test(r) && /nearest: Karaoke/.test(r)), "the nearest look is named")
      assert.match(await page.locator(".refs-direct").innerText(), /From this reference/i)
      await card.scrollIntoViewIfNeeded()
      await shoot("1280-light-brief")
      // Unticked: the bed. The row stays, the next cut leaves it out
      const music = page.locator(`#style-direct-${ref.id}-music`)
      await music.uncheck()
      assert.equal(await page.locator(`#style-direct-${ref.id}-music`).isChecked(), false)
      assert.equal(await page.locator(`#style-direct-${ref.id}-loudness`).count(), 0, "the loudness line is said, not offered")
      assert.deepEqual(await smallTargets(), [], "1280: every target is at least 44 px")
      await page.emulateMedia({ colorScheme: "dark" })
      await shoot("1280-dark-brief")
      await page.setViewportSize({ width: 360, height: 800 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "360: no sideways scroll")
      assert.deepEqual(await smallTargets(), [], "360: every target is at least 44 px")
      await page.locator(`#style-rows-direct-${ref.id}`).scrollIntoViewIfNeeded()
      await shoot("360-dark-brief")
      await page.emulateMedia({ colorScheme: "light" })
      await shoot("360-light-brief")
      await page.setViewportSize({ width: 1280, height: 860 })
      // Read again from the page: a job with its progress on the card, then the same brief
      const jobsBefore = (await call("GET", "/jobs")).jobs.length
      await page.locator(`#style-read-direct-${ref.id}`).click()
      let again = null
      for (let i = 0; i < 100 && !again; i++) {
        again = (await call("GET", "/jobs")).jobs.slice(jobsBefore).find((j) => j.kind === "reference") ?? null
        if (!again) await new Promise((done) => setTimeout(done, 100))
      }
      assert.equal((await until(again.id)).status, "done")
      await page.locator(`#style-rows-direct-${ref.id}`).waitFor({ timeout: 30_000 })
      await page.waitForFunction((rid) => !document.getElementById(`style-cancel-direct-${rid}`), ref.id)
      assert.equal(await page.locator(`#style-direct-${ref.id}-music`).isChecked(), false, "what was unticked stays unticked")

      /* ET-RF2-M2: the make */
      await page.locator("#make-length").selectOption({ index: 0 }).catch(() => {})
      const before = (await call("GET", "/jobs")).jobs.length
      const startedAt = Date.now()
      await page.locator(".make").getByRole("button", { name: "Make it" }).click()
      let makeJob = null
      for (let i = 0; i < 100 && !makeJob; i++) {
        makeJob = (await call("GET", "/jobs")).jobs.slice(before).find((j) => j.kind === "make") ?? null
        if (!makeJob) await new Promise((done) => setTimeout(done, 100))
      }
      assert.ok(makeJob, "the Studio started the make")
      const db = new DatabaseSync(join(home, "edit", id, "journal.sqlite"), { readOnly: true })
      const sent = JSON.parse(db.prepare("select request from jobs where kind = 'make' order by id desc limit 1").get().request).brief
      db.close()
      assert.deepEqual(sent.styleBrief, { ref: ref.id, off: ["music"] }, "the brief carries the reference and what was unticked, nothing else of it")
      const done = await until(makeJob.id)
      assert.equal(done.status, "done", done.error)
      result = JSON.parse(done.output)
      console.log(`ET-RF2-M2 the make: ${result.verdict} in ${Math.round((Date.now() - startedAt) / 1000)} s\n${result.gates.map((g) => `  ${g.id} ${g.status} (${g.severity})${g.message ? `: ${g.message}` : ""}`).join("\n")}\n  notes:\n${result.notes.map((n) => `    ${n}`).join("\n")}\n  changes:\n${result.changes.map((n) => `    ${n}`).join("\n")}`)
      // The page says what QG-16 found
      await page.waitForFunction(() => /Followed \d+ of \d+ things from your reference/.test(document.body.innerText), null, { timeout: 30_000 })
      await shoot("1280-light-made")
      await page.setViewportSize({ width: 360, height: 800 })
      await page.emulateMedia({ colorScheme: "dark" })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "360, after the make: no sideways scroll")
      await shoot("360-dark-made")
      assert.deepEqual(problems, [], "the console is clean")
    } finally {
      await browser.close()
    }

    /* QG-16: a note that says how far the cut followed the reference */
    const fit = result.gates.find((g) => g.id === "QG-16")
    assert.ok(fit, "QG-16 ran on a make that followed a style brief")
    assert.equal(fit.severity, "note")
    assert.match(fit.message, /^Followed \d+ of \d+ things from your reference/)
    assert.ok(fit.numbers.of >= 5 && fit.numbers.followed >= 3 && fit.numbers.followed <= fit.numbers.of, JSON.stringify(fit.numbers))
    assert.ok(result.notes.includes(fit.message), "the note reaches the person")
    for (const failure of fit.failures ?? []) assert.deepEqual([failure.kind, typeof failure.hint.rung, ["more", "fewer", "larger", "smaller"].includes(failure.hint.change)], ["reference_trait", "string", true])
    assert.notEqual(result.verdict, "blocked", `a note never blocks: ${result.gates.filter((g) => g.status === "failed" && g.severity === "block").map((g) => `${g.id} ${g.message}`).join("; ")}`)
    assert.ok(result.file && existsSync(result.file))
    // What the brief asked for is in the cut: its captions, punch-ins, joins and colour, and no bed (unticked)
    const project = (await call("GET", `/projects/${id}`)).project
    const clips = project.sequences.find((q) => q.id === project.active).clips
    const effects = clips.flatMap((c) => c.effects.map((e) => e.type === "fx" ? `fx:${e.id}` : e.type === "grade" ? Object.keys(e).filter((k) => k !== "type").map((k) => `grade:${k}`).join(",") : e.type))
    assert.ok(clips.some((c) => c.effects.some((e) => e.type === "caption" && e.look === "karaoke")), "the nearest caption look")
    assert.ok(clips.filter((c) => c.effects.some((e) => e.type === "zoom")).length >= 3, "punch-ins toward the reference's pace")
    assert.ok(clips.some((c) => c.effects.some((e) => e.type === "transition" && e.kind === "slide")) || result.notes.some((n) => /No slide transition/.test(n)), "slides where the story changes moment, or it says there was none")
    const lut = project.assets.find((a) => a.kind === "lut")
    assert.ok(lut && /kriya-look-[0-9a-f]{12}\.cube$/.test(lut.path), "the colour match is a LUT Kriya wrote")
    assert.ok(effects.some((e) => /lut/.test(e)) || clips.some((c) => JSON.stringify(c.effects).includes(lut.id)), "and it is on the cut")
    assert.equal(clips.some((c) => /kriya-music-/.test(project.assets.find((a) => a.id === c.source?.asset)?.path ?? "")), false, "no bed: the person unticked it")
    assert.ok(result.changes.some((n) => /^From your reference: /.test(n)) && result.changes.includes("Your reference's captions run under the app's buttons. I kept mine clear of them."), "what was taken, and where a gate outranked it")
    assert.equal(result.changes.includes("apply_lut"), false, "the colour match is said once, in words")

    /* ET-SEC-08: nothing of the reference is in the film, however the make went */
    assert.equal(clips.some((c) => c.source?.asset === ref.id), false, "the reference is on no track")
    assert.notEqual(result.gates.find((g) => g.id === "QG-13")?.failures?.some((f) => f.kind !== "rights_unknown"), true, "QG-13 found no reference in the output")
    const cube = readFileSync(join(folder, lut.path.startsWith("/") ? lut.path : lut.path), "utf8")
    assert.match(cube, /^TITLE "Kriya reference match"\nLUT_3D_SIZE 33\n/, "a LUT of numbers computed here")
    assert.equal(cube.split("\n").length, 33 ** 3 + 3)
    // The Director was asked only what a single take is asked today: no slot for the reference, no extra call (EH-64)
    assert.deepEqual([...new Set(tasks)].sort(), ["emphasis", "story"])
    // The made cut, measured by hand here as QG-16 measured it: the same DNA shape
    assert.equal(checkDna2(await extractDna2(result.file)).version, DNA2_VERSION)
  } finally {
    await fake.close()
  }
})
