import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { editCommand, openInBrowser } from "../src/edit/runtime/cli.js"
import { GRADES } from "../src/edit/recipes/reel.js"
import { LOOK_GRADES, lookSketch, REPLAY_STEP_MS, sheetCell, shouldAnimate, STAGES, stageStates } from "../studio/src/director.js"
import { GATE_NAMES, scorecardOf } from "../studio/src/finish.js"
import { levelOf, meterFill } from "../studio/src/live.js"
import { gradeFilter } from "../studio/src/preview.js"
import { cellAt, seamsOf } from "../studio/src/timeline.js"
import { SHORTCUTS } from "../studio/src/shortcuts.js"
import { keyAction } from "../studio/src/time.js"
import { ROOT } from "./helpers.js"

// The Studio's side of "Watch the Director edit" and the craft upgrades (editing.livePreview): the arithmetic
// and wording the page draws from, checked without a browser. tests/edit/media/live-preview.test.js drives the
// page itself in Chrome; tests/edit-live-director.test.js checks what the Host sends.

const F = 705_600_000

test("ET-LS-01: the Build Strip lights only the stages the Host has reported, the latest as active", () => {
  assert.deepEqual(STAGES.map(([id]) => id), ["story", "cuts", "broll", "look", "captions", "audio", "render", "check", "repair", "watch"])
  const none = stageStates(new Set(), null)
  assert.ok(Object.values(none).every((s) => s === "waiting"), "nothing is lit before the Host says so")
  const some = stageStates(new Set(["story", "cuts", "render"]), "render")
  assert.deepEqual([some.story, some.cuts, some.broll, some.render, some.check], ["done", "done", "waiting", "active", "waiting"], "a stage the make didn't reach stays dark")
  assert.equal(stageStates(new Set(["story", "check"]), null).check, "done", "finished: nothing active, what happened stays lit")
})

test("ET-LS-02: the replay animates only for a person who wants motion, never under reduced motion or in an automated browser", () => {
  assert.equal(shouldAnimate({}), true)
  assert.equal(shouldAnimate({ reduced: true }), false)
  assert.equal(shouldAnimate({ automated: true }), false)
  assert.equal(shouldAnimate({ reduced: true, automated: true }), false)
  assert.ok(REPLAY_STEP_MS >= 1000, "a step long enough to see")
  const main = readFileSync(join(ROOT, "studio/src/main.js"), "utf8")
  assert.match(main, /animate: shouldAnimate\(\{ reduced: matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches, automated: navigator\.webdriver === true \}\)/)
  const css = readFileSync(join(ROOT, "studio/src/styles.css"), "utf8")
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \* \{ transition: none !important; animation: none !important; \} \}/, "the pulse and fades stop too")
})

test("ET-LS-03: the Look cards use the recipe's own looks and the monitor's own filter, with the render's warmth and vignette sketched", () => {
  assert.deepEqual(LOOK_GRADES, GRADES, "the same looks the make applies")
  for (const [id, grade] of Object.entries(LOOK_GRADES)) assert.equal(lookSketch(grade).filter, gradeFilter(grade), `${id}: the monitor's filter`)
  assert.deepEqual(lookSketch(null), { filter: "none", tint: null, vignette: 0 }, "Natural is the footage as it is")
  assert.equal(lookSketch(GRADES.warm).tint.colour, "255 150 60", "below 6500 K reads warm")
  assert.equal(lookSketch(GRADES.cinematic).tint.colour, "70 140 255", "above reads cool")
  assert.equal(lookSketch(GRADES.vivid).tint, null)
  assert.equal(lookSketch(GRADES.cinematic).vignette, 0.45)
  // A thumbnail sheet is 10 × 10, a frame every ceil(d/100) s: the middle of a clip
  assert.equal(sheetCell(10), 5)
  assert.equal(sheetCell(250), 41, "every 3 s: 125 s is cell 41")
  assert.equal(sheetCell(100_000), 50, "every 1000 s: the middle cell")
  assert.equal(cellAt(7 * F, 1), 7)
  assert.equal(cellAt(500 * F, 1), 99, "never past the sheet")
  assert.equal(cellAt(-F, 2), 0)
})

test("ET-LS-04: the timeline's seam badges come from the preview plan's own transitions", () => {
  const preview = { picture: [{ at: 0, end: F }, { at: F, end: 2 * F, enter: { kind: "wipe", duration: F / 4 } }, { at: 2 * F, end: 3 * F, enter: { kind: "zoom", duration: F / 4 } }] }
  assert.deepEqual(seamsOf(preview), [{ at: F, kind: "wipe" }, { at: 2 * F, kind: "zoom" }])
  assert.deepEqual(seamsOf(null), [])
})

test("ET-LS-05: the scorecard lists each gate as the make reported it, with the ladder's repairs in its own words", () => {
  assert.equal(scorecardOf(null), null)
  assert.equal(scorecardOf({ gates: [] }), null, "no gates, no card: nothing is made up")
  const card = scorecardOf({
    gates: [
      { id: "QG-01", status: "passed", severity: "block" },
      { id: "QG-06", status: "failed", severity: "block", message: "Music over the voice at 0:04." },
      { id: "QG-13", status: "failed", severity: "note", message: "The rights to m1 aren't known." },
      { id: "QG-08", status: "not_checked", severity: "block", message: "The gate has no Chrome to measure text in." },
    ],
    repairs: [{ round: 1, accepted: true, fixes: [{ why: "Brought the music down 3 dB under the speech." }] }, { round: 2, accepted: false, fixes: [{ kind: "low_contrast" }], reason: "it would cut a line the brief must keep" }],
    watch: { rounds: [{ round: 1, kept: false, fixes: ["pace"], reason: "the score fell" }] },
  })
  assert.equal(card.summary, "1 passed, 1 failed, 2 not checked or not applicable", "a note isn't a failure, and an unchecked gate isn't a pass")
  assert.equal(scorecardOf({ gates: [{ id: "QG-08", status: "not_applicable", severity: "block", message: "No text on screen." }] }).gates[0].said, "Not applicable")
  assert.deepEqual(card.gates.map((g) => [g.id, g.name, g.said]), [["QG-01", "Playable and to spec", "Passed"], ["QG-06", "Loudness", "Failed"], ["QG-13", "Rights", "Note"], ["QG-08", "Layout", "Not checked"]])
  assert.deepEqual(card.repairs, ["Repair round 1: Brought the music down 3 dB under the speech., kept.", "Repair round 2: low_contrast, not kept (it would cut a line the brief must keep).", "Watch round 1: pace, not kept (the score fell)."])
  assert.equal(Object.keys(GATE_NAMES).length, 16)
})

test("ET-LS-06: the level meter reads RMS in dBFS, −60 dB empty to 0 dB full", () => {
  assert.equal(levelOf(new Float32Array(64)), -Infinity)
  assert.ok(Math.abs(levelOf(Float32Array.from({ length: 64 }, () => 1)) - 0) < 1e-9)
  assert.ok(Math.abs(levelOf(Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.5 : -0.5))) + 6.0206) < 1e-3)
  assert.deepEqual([meterFill(-Infinity), meterFill(-60), meterFill(-30), meterFill(0), meterFill(6)], [0, 0, 0.5, 1, 1])
})

test("ET-LS-07: untrusted text (clip names, transcript words, plan and gate strings) reaches the page only as text", () => {
  const dir = join(ROOT, "studio/src")
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(join(dir, file), "utf8")
    assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/, `${file}: no markup sink`)
  }
  // h() appends strings as text nodes: the one way the Studio puts words on the page
  const dom = readFileSync(join(dir, "dom.js"), "utf8")
  assert.match(dom, /el\.append\(child instanceof Node \? child : String\(child\)\)/)
  // The new modules import nothing outside studio/src (ET-IMP-01)
  for (const file of ["director.js", "timeline.js", "finish.js", "live.js", "monitor.js", "main.js"]) {
    for (const [, target] of readFileSync(join(dir, file), "utf8").matchAll(/from\s+"([^"]+)"/g)) assert.match(target, /^\.\/[\w-]+\.js$/, `${file} imports ${target}`)
  }
})

test("ET-LS-08: typed in a terminal, `kriya edit` opens the Studio itself; piped or with --no-open it prints only the link, as before", async () => {
  const url = "http://127.0.0.1:9/launch#token"
  const host = async () => ({ ensureHost: async () => {}, hostCall: async (_home, method, path) => (assert.deepEqual([method, path], ["POST", "/internal/launch"]), { url }) })
  const run = async (args, interactive) => {
    const said = []
    const opened = []
    const code = await editCommand(args, { say: (line) => said.push(line), open: (u) => opened.push(u), interactive, host })
    return { code, said, opened }
  }
  const typed = await run([], true)
  assert.deepEqual([typed.code, typed.opened], [0, [url]], "the Studio's own link, in the browser")
  assert.match(typed.said.join("\n"), /Opening the Kriya Editing Studio/)
  assert.ok(typed.said.join("\n").endsWith(url), "and the link, in case no browser opened")
  assert.deepEqual(await run([], false), { code: 0, said: [url], opened: [] }, "a script reads one line, the link, as before")
  assert.deepEqual(await run(["--no-open"], true), { code: 0, said: [url], opened: [] })
  // The opener: the platform's own command, detached; a missing browser is never an error
  const calls = []
  const fake = (command, args) => (calls.push([command, ...args]), { on: () => ({ unref: () => {} }) })
  assert.equal(openInBrowser(url, { platform: "darwin", run: fake }), true)
  assert.equal(openInBrowser(url, { platform: "linux", run: fake }), true)
  assert.equal(openInBrowser(url, { platform: "win32", run: fake }), true)
  assert.deepEqual(calls, [["open", url], ["xdg-open", url], ["cmd", "/c", "start", "", url]])
  assert.equal(openInBrowser(url, { run: () => { throw new Error("ENOENT") } }), false)
  const bin = readFileSync(join(ROOT, "bin/kriya.js"), "utf8")
  assert.match(bin, /Editing is off\. Run kriya edit --edit to open the Editing Studio, or set KRIYA_EDIT=on\./)
})

test("ET-LS-09: the shortcuts sheet lists only keys the Studio answers, each with the action it really does", () => {
  for (const row of SHORTCUTS) {
    const wanted = Array.isArray(row.action) ? row.action : row.press.map(() => row.action)
    row.press.forEach((key, i) => assert.equal(keyAction(key, { shift: row.shift === true, mod: row.mod === true })?.type, wanted[i], `${row.keys.join("+")}: ${key}`))
  }
  assert.equal(keyAction("ArrowLeft", { shift: true }).seconds, -1, "Shift+arrow is a second")
  // Every action the key map has is on the sheet
  const listed = new Set(SHORTCUTS.flatMap((row) => (Array.isArray(row.action) ? row.action : [row.action])))
  for (const key of [" ", "k", "l", "j", "ArrowRight", "Home", "1", "/", "s", "Delete", "i"]) assert.ok(listed.has(keyAction(key).type), key)
  const main = readFileSync(join(ROOT, "studio/src/main.js"), "utf8")
  assert.match(main, /const shortcuts = liveOn \? createShortcuts\(\) : null/)
  assert.match(main, /if \(shortcuts && event\.key === "\?"/, "? opens it only with the switch on")
})

test("ET-LS-10: a failed check's moment is kept for \"show me\"; a passed one's isn't, and the Studio offers it only while the cut is the one that was checked", () => {
  const card = scorecardOf({ gates: [{ id: "QG-05", status: "failed", severity: "block", message: "A pop at 2.1 s.", at: 2 * F }, { id: "QG-01", status: "passed", severity: "block", at: 0 }, { id: "QG-07", status: "failed", severity: "block", at: -5 }] })
  assert.deepEqual(card.gates.map((g) => g.at), [2 * F, undefined, undefined])
  const finish = readFileSync(join(ROOT, "studio/src/finish.js"), "utf8")
  assert.match(finish, /const current = result\?\.head != null && result\.head === head\(\)/)
  assert.match(finish, /current && g\.at !== undefined \?/)
})

test("ET-LS-REG-01: off, the Studio makes none of it: no strip, replay, wipe, meter, cards, rich timeline or scorecard", () => {
  const main = readFileSync(join(ROOT, "studio/src/main.js"), "utf8")
  for (const made of [
    /const levelFill = liveOn \?/,
    /const directorBadge = liveOn \?/,
    /const buildStrip = liveOn \? createDirectorStrip/,
    /const replay = liveOn\n\s+\? createReplay/,
    /const replayButton = liveOn \?/,
    /const lookCards = liveOn\n\s+\? createLookCards/,
    /const wipe = liveOn \?/,
    /const compareButton = liveOn \?/,
    /\.\.\.\(liveOn \? \{ onTrim: trimClip, rich: \{ thumbs: sheetOf \} \} : \{\}\)/,
    /scorecard: liveOn, \.\.\.\(liveOn \? \{ head: \(\) => headNow, onShow: /,
    /if \(liveOn\) events\.addEventListener\("live", onLiveEvent\)/,
  ]) assert.match(main, made)
  // The make's status off is the line it always was
  assert.match(main, /else if \(job\) makeStatus\.append\(h\("p", \{ class: "note" \}, `Making the reel… \$\{job\.progress \?\? 0\}%`\), progressBar\(job\.progress \?\? 0, "Making the reel"\)\)/)
  assert.match(main, /\.\.\.\(liveOn \? \[h\("div", \{ class: "make-row" \}, makeButton, replayButton\)\] : \[makeButton\]\)/)
  // Off, the monitor makes no meter and the wipe does nothing: its live branch never runs without tileUrl
  const monitor = readFileSync(join(ROOT, "studio/src/monitor.js"), "utf8")
  assert.match(monitor, /const meter = tileUrl \? createMeter\(\) : null/)
  assert.match(monitor, /setWipe\(next\) \{\n\s+if \(!tiles\) return Promise\.resolve\(\)/)
  const timeline = readFileSync(join(ROOT, "studio/src/timeline.js"), "utf8")
  assert.match(timeline, /const fancy = Boolean\(rich\) && !compact/)
})
