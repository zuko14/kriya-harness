import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

import { browserTarget } from "../src/browser.js"
import { budgetFor, bufferProblem, CEILINGS, threeGate } from "../src/gates/three.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W13 (WD-17), WT-GATE-3D-*: G-3D on one raw-WebGL fixture scene
// (tests/fixtures/gates/three/scene.html) with faults picked by ?mode=, in the
// installed Chrome, headless. Every mutant fails, the clean scene passes, and
// a browser without WebGL reads not_checked, never pass. Nothing leaves this
// machine: the scene is served on 127.0.0.1.

const SCENE = readFileSync(join(ROOT, "tests", "fixtures", "gates", "three", "scene.html"))
const chrome = Boolean(browserTarget())
const skip = !chrome && "no Chrome on this computer"
let server
let app
let root

before(async () => {
  freshHome()
  root = realpathSync(mkdtempSync(join(tmpdir(), "kriya-3d-")))
  server = createServer((req, res) => (req.url === "/favicon.ico" ? res.writeHead(404).end() : res.writeHead(200, { "content-type": "text/html" }).end(SCENE)))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  app = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

const direction = (mode, extra = {}) => ({ mood: "test", lighting: "data-abstract", toneMapping: "none", motion: "subtle", tiers: { low: {} }, routes: [{ path: `/scene?mode=${mode}`, unmount: "/away" }], ...extra })
const gate = (mode, extra, options = {}) => threeGate({ root, label: `3d-${mode}`, app, direction: direction(mode, extra), ...options })
const failsWith = (r, re) => {
  assert.equal(r.status, "fail", JSON.stringify(r).slice(0, 1500))
  assert.match(r.excerpt, re, r.excerpt)
}
const T = { timeout: 120_000, skip }

test("WT-GATE-3D-00: counts come from the gate's own wrapper on its own page; the app can't replace them", T, async () => {
  const src = readFileSync(join(ROOT, "src", "gates", "three.js"), "utf8")
  assert.match(src, /await page\.addInitScript\(WRAP\)/)
  assert.doesNotMatch(src, /context\.addInitScript/)
  assert.match(src, /Object\.defineProperty\(window, "\$\{READ\}", \{ configurable: false, writable: false/)
  assert.doesNotMatch(readFileSync(join(ROOT, "src", "browser.js"), "utf8"), /__kriya3d|getContext/, "the agent's browser is untouched")
  // A scene that tries to overwrite the reader with flattering numbers still has its 2,000 draws counted
  failsWith(await gate("draws,spoof"), /2000 draw calls a frame \(median\) over the low budget of 100/)
})

test("WT-GATE-3D-01: the clean scene passes, with frame time and the renderer reported, never gated", T, async () => {
  const r = await gate("clean")
  assert.equal(r.status, "pass", JSON.stringify(r).slice(0, 1500))
  assert.match(r.note, /^renderer: \S/)
  assert.match(r.note, /frame [\d.]+ ms median \/ [\d.]+ ms p95 \(reported, not gated\)/)
  assert.match(r.note, /\/scene\?mode=clean at 390px: 3 draws, 12 triangles/)
})

test("WT-GATE-3D-02: a blank, one-colour canvas fails", T, async () => {
  failsWith(await gate("blank", { motion: "none" }), /canvas is blank or one colour/)
})

test("WT-GATE-3D-03: a shader that doesn't compile fails on the console error and the GL errors", T, async () => {
  const r = await gate("shader")
  failsWith(r, /console errors .*Shader Error/)
  assert.match(r.excerpt, /WebGL errors? \(gl\.getError\)|blank or one colour/)
})

test("WT-GATE-3D-04: a scene that leaks GPU objects over unmount → mount fails", T, async () => {
  failsWith(await gate("leak"), /GPU objects leak over unmount → mount: .*textures 1 → 2/)
})

test("WT-GATE-3D-05: 2,000 draw calls a frame fail the low tier's budget", T, async () => {
  failsWith(await gate("draws"), /2000 draw calls a frame \(median\) over the low budget of 100; instance or merge/)
})

test("WT-GATE-3D-06: no context-loss handler: the canvas stays lost after a restore, and the step fails", T, async () => {
  failsWith(await gate("noloss"), /after a lost and restored WebGL context the canvas stays (lost|blank)/)
})

test("WT-GATE-3D-07: an uncapped device pixel ratio fails, at both widths", T, async () => {
  const r = await gate("dpr")
  failsWith(r, /390px: the drawing buffer is \d+px wide for \d+ CSS px at DPR 3, over \d+ \(the tier's cap of 1\.5\): the pixel ratio is uncapped/)
  assert.match(r.excerpt, /1440px: the drawing buffer/)
})

test("WT-GATE-3D-08: no WebGL in the browser reads not_checked, never pass; no app or direction is a note", { ...T, skip }, async () => {
  const { chromium } = await import("playwright-core")
  const launch = () => chromium.launch({ ...browserTarget(), headless: true, args: ["--disable-3d-apis", "--disable-webgl", "--disable-webgl2"] })
  assert.deepEqual(await gate("clean", {}, { launch }), { id: "G-3D", status: "not_checked", reason: "no WebGL in this browser" })
  const none = await threeGate({ root, label: "x", app: undefined })
  assert.equal(none.status, "not_checked")
  assert.equal(none.optional, true)
  assert.match((await threeGate({ root, label: "x", app })).reason, /no scene_direction\.json with routes/)
})

test("WT-GATE-3D-09: declared motion that doesn't move fails; motion that ignores reduced motion fails", T, async () => {
  failsWith(await gate("static"), /motion is "subtle" in the direction, but frame 30 and frame 90 are identical/)
  failsWith(await gate("ignorereduce"), /decorative motion still runs under prefers-reduced-motion/)
})

test("WT-GATE-3D-10: budgets are code ceilings the contract can only tighten; texture bytes over budget fail", T, async () => {
  assert.deepEqual(budgetFor({ low: { drawCalls: 50, triangles: 10_000_000 } }, ["low", "mid", "high"]), { tier: "low", dpr: 1.5, drawCalls: 50, triangles: 300_000, textureBytes: CEILINGS.low.textureBytes, routeBytes: CEILINGS.low.routeBytes })
  assert.equal(budgetFor({ high: {} }, ["low", "mid", "high"]).tier, "high", "the first tier the direction names")
  assert.equal(budgetFor(undefined, ["low"]).drawCalls, 100)
  assert.throws(() => (CEILINGS.low.drawCalls = 1e9))
  assert.equal(bufferProblem({ width: 585, height: 480, clientWidth: 390 }, 3, 1.5), null)
  assert.equal(bufferProblem({ width: 390, height: 320, clientWidth: 390 }, 3, 1.5), null, "a lower ratio than the cap is the app's choice")
  assert.match(bufferProblem({ width: 300, height: 320, clientWidth: 390 }, 3, 1.5), /not synced to the CSS size/)
  failsWith(await gate("bigtex"), /128\.0 MB of textures over the low budget of 64\.0 MB/)
})
