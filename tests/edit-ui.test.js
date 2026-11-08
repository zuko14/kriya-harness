import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import vm from "node:vm"

import { launch, ping } from "../plugins/edit/index.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { scopesOf } from "../studio/src/finish.js"
import { durationOf, pieceAt, programOf, sourceAt, timelineAt } from "../studio/src/program.js"
import { FLICKS, frameFlicks, keyAction, snap, timecode, transport } from "../studio/src/time.js"
import { ROOT } from "./helpers.js"

// The Studio's logic without a browser, the Host's new routes, and the harness row.
// The Studio in real Chrome, and the harness's real Web UI: tests/edit/media/studio.test.js.

const FPS = { n: 30, d: 1 }
const F = frameFlicks(FPS)
const press = (state, key, shift = false, limits = { fps: FPS, duration: 10 * FLICKS }) => transport(state, keyAction(key, { shift }), limits)

test("ET-UI-02: the keyboard drives the transport: Space, J K L, arrows, Shift+arrows", () => {
  let s = { t: 0, rate: 0 }
  s = press(s, " ")
  assert.equal(s.rate, 1, "Space plays")
  s = press(s, " ")
  assert.equal(s.rate, 0, "and pauses")
  s = press(s, "l")
  assert.equal(s.rate, 1)
  s = press(s, "l")
  assert.equal(s.rate, 2, "L again is double speed")
  s = press(s, "k")
  assert.equal(s.rate, 0, "K stops")
  s = press(s, "j")
  assert.equal(s.rate, -1, "J plays backwards")
  s = press(s, "J")
  assert.equal(s.rate, -2)
  s = press(s, "L")
  assert.equal(s.rate, 1, "L from reverse plays forward")
  s = { t: 0, rate: 0 }
  for (let i = 0; i < 3; i++) s = press(s, "ArrowRight")
  assert.deepEqual(s, { t: 3 * F, rate: 0 }, "three frames on")
  s = press(s, "ArrowLeft")
  assert.equal(s.t, 2 * F)
  s = press(s, "ArrowRight", true)
  assert.equal(s.t, 2 * F + FLICKS, "Shift+→ is one second")
  s = press({ t: F, rate: 1 }, "ArrowLeft", true)
  assert.deepEqual(s, { t: 0, rate: 0 }, "clamped at the start, and a nudge pauses")
  assert.equal(press({ t: 10 * FLICKS, rate: 0 }, "ArrowRight").t, 10 * FLICKS - F, "never past the last frame")
  assert.deepEqual(transport({ t: 9 * FLICKS, rate: 2 }, { type: "tick", t: 11 * FLICKS }, { fps: FPS, duration: 10 * FLICKS }), { t: 10 * FLICKS - F, rate: 0 }, "playing off the end stops there")
  assert.deepEqual(["1", "2", "3"].map((key) => keyAction(key).mode), ["direct", "edit", "finish"])
  assert.equal(keyAction("z", { mod: true }).type, "undo")
  assert.equal(keyAction("q"), null)
})

test("frame maths in flicks: whole frames for 30, 25 and 30000/1001; timecodes for people", () => {
  for (const fps of [FPS, { n: 25, d: 1 }, { n: 30000, d: 1001 }, { n: 24000, d: 1001 }]) assert.ok(Number.isInteger(frameFlicks(fps)), JSON.stringify(fps))
  assert.equal(snap(F * 7 + 5, FPS), F * 7)
  assert.equal(timecode(12 * FLICKS + 12 * F, FPS), "00:12.12")
})

// Two pieces of one take: source 2–4 s, then 6–7 s at double speed
const TIMELINE = {
  picture: [
    { clip: "c2", asset: "a1", in: 6 * FLICKS, out: 8 * FLICKS, at: 2 * FLICKS, end: 3 * FLICKS, speed: { n: 2, d: 1 } },
    { clip: "c1", asset: "a1", in: 2 * FLICKS, out: 4 * FLICKS, at: 0, end: 2 * FLICKS, speed: { n: 1, d: 1 } },
  ],
}

test("ET-UI-03 (logic): a word seeks to the exact flick where it plays in the cut, or nowhere", () => {
  const pieces = programOf(TIMELINE)
  assert.deepEqual(pieces.map((p) => p.clip), ["c1", "c2"], "in timeline order")
  assert.equal(durationOf(pieces), 3 * FLICKS)
  const word = { asset: "a1", start: 3 * FLICKS + 7 * F }
  const at = timelineAt(pieces, word.asset, word.start)
  assert.equal(at, FLICKS + 7 * F)
  assert.equal(sourceAt(pieceAt(pieces, at), at), word.start, "and the monitor shows that very source frame")
  assert.equal(timelineAt(pieces, "a1", 6 * FLICKS + 2 * F), 2 * FLICKS + F, "through double speed")
  assert.equal(sourceAt(pieceAt(pieces, 2 * FLICKS + F), 2 * FLICKS + F), 6 * FLICKS + 2 * F)
  assert.equal(timelineAt(pieces, "a1", 5 * FLICKS), null, "a word the cut leaves out has no place in it")
  assert.equal(timelineAt(pieces, "a2", 0), null)
})

test("scopes count every sampled pixel once", () => {
  const data = new Uint8ClampedArray(4 * 100 * 50)
  for (let i = 0; i < data.length; i += 4) data.set([255, 255, 255, 255], i)
  const { histogram, waveform } = scopesOf({ data, width: 100, height: 50 })
  assert.equal(histogram[255], 5000)
  assert.equal(waveform.reduce((sum, column) => sum + column[63], 0), 5000)
})

test("the Studio's palette is the harness's (UX_SPEC §11)", () => {
  const design = readFileSync(join(ROOT, "plugins", "brand", "DESIGN.md"), "utf8")
  const css = readFileSync(join(ROOT, "studio", "src", "styles.css"), "utf8")
  const [light, dark] = css.split("@media (prefers-color-scheme: dark)")
  for (const [name, token] of [["Paper", "paper"], ["Leaf-sheet", "sheet"], ["Loom", "loom"], ["Ink", "ink"], ["Teal", "teal"], ["Saffron", "saffron"]]) {
    const [, l, d] = new RegExp(`\\| ${name} \\| \`(#[0-9A-F]{6})\` \\| \`(#[0-9A-F]{6})\``, "i").exec(design)
    assert.match(light, new RegExp(`--${token}: ${l};`, "i"), `${name} light`)
    assert.match(dark, new RegExp(`--${token}: ${d};`, "i"), `${name} dark`)
  }
})

/* ───────────────────── the Host's Studio routes ───────────────────── */

function http(port, method, path, { headers = {}, body, hostHeader = `127.0.0.1:${port}` } = {}) {
  return new Promise((done, fail) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: hostHeader, ...(data ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    req.on("error", fail)
    if (data) req.write(data)
    req.end()
  })
}

async function host() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-ui-")))
  mkdirSync(join(home, "work"))
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "60000" }
  return { home, ...(await ensureHost({ env, home })) }
}

test("ET-SEC-09: the Studio's own files are fenced like every route, and served with COOP and COEP", async () => {
  const h = await host()
  try {
    for (const path of ["/", "/studio.js", "/studio.css"]) {
      const ok = await http(h.port, "GET", path)
      assert.ok([200, 404].includes(ok.status), `${path} ${ok.status}`)
      if (path === "/") assert.equal(ok.status, 200, "the shell is served without a session; what it asks for needs one")
      assert.equal(ok.headers["cross-origin-opener-policy"], "same-origin")
      assert.equal(ok.headers["cross-origin-embedder-policy"], "require-corp")
      assert.equal((await http(h.port, "GET", path, { hostHeader: `evil.example:${h.port}` })).status, 403, `${path}: DNS rebinding`)
      assert.equal((await http(h.port, "GET", path, { headers: { origin: "http://evil.example" } })).status, 403, `${path}: foreign Origin`)
      assert.equal((await http(h.port, "GET", path, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, `${path}: cross-site`)
    }
    assert.equal((await http(h.port, "GET", "/projects")).status, 401, "the API still needs the session")
    assert.equal((await http(h.port, "GET", "/studio.js/../host")).status !== 200, true)
  } finally {
    await stopHost(h.home)
  }
})

test("ET-SEC-09: the back link is kept only for a loopback harness origin, and only through the socket", async () => {
  const h = await host()
  try {
    const backFor = async (back) => {
      const { token } = await hostCall(h.home, "POST", "/internal/launch", { back })
      return JSON.parse((await http(h.port, "POST", "/session", { body: { token } })).text).back
    }
    assert.equal(await backFor("http://127.0.0.1:17391/?token=secret#x"), "http://127.0.0.1:17391", "the origin only: no token, path or fragment")
    assert.equal(await backFor("http://localhost:17391"), "http://localhost:17391")
    for (const bad of ["http://evil.example:17391", "https://127.0.0.1:17391", "javascript:alert(1)", "http://user:pw@127.0.0.1:17391", `http://127.0.0.1:${h.port}`, "http://127.0.0.1", 42, undefined]) assert.equal(await backFor(bad), null, String(bad))
    assert.equal((await http(h.port, "POST", "/internal/launch", { body: { back: "http://127.0.0.1:1" } })).status, 404, "minting stays on the owner-only socket")
  } finally {
    await stopHost(h.home)
  }
})

/* ─────────────────────────── the harness row ─────────────────────────── */

const ROW = /- id: kriya-edit\n {2}name: '@kriya-ai\/harness-edit'\n {2}disabled: !!js >-\n((?: {4}.*\n)+)/

test("ET-REG-02: the row is off unless KRIYA_EDIT is on, and only in the Web UI profile", () => {
  for (const profile of ["kriya", "kriya-run", "kriya-acp"]) {
    const dump = readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8")
    assert.equal(dump.split("- id: kriya-edit\n").length, 2, `${profile}: one row`)
    const expression = ROW.exec(dump)[1].trim().split(/\s*\n\s*/).join(" ")
    const disabled = (KRIYA_EDIT, name) => new Function("process", "ctx", `return (${expression})`)({ env: { KRIYA_EDIT } }, { get: () => ({ name }) })
    assert.equal(disabled(undefined, "kriya"), true, "unset: off")
    assert.equal(disabled("off", "kriya"), true)
    assert.equal(disabled("false", "kriya"), true)
    assert.equal(disabled("on", "kriya"), false, "on, in the Web UI: the row loads")
    assert.equal(disabled("on", profile === "kriya" ? "kriya-run" : profile), true, "never outside the Web UI")
  }
  const profiles = readFileSync(join(ROOT, "src", "profiles.js"), "utf8")
  assert.match(profiles, /"@kriya-ai\/harness-edit": join\(PACKAGE_ROOT, "plugins", "edit"\)/)
})

test("the launch route answers 404 with the switch off and loads nothing from src/edit", async () => {
  const before = process.env.KRIYA_EDIT
  process.env.KRIYA_EDIT = "off"
  try {
    let loaded = false
    const res = await launch(new Request("http://127.0.0.1:17391/api/kriya.edit.launch", { method: "POST" }), { warn() {} }, async () => (loaded = true))
    assert.equal(res.status, 404)
    assert.equal(loaded, false)
  } finally {
    if (before === undefined) delete process.env.KRIYA_EDIT
    else process.env.KRIYA_EDIT = before
  }
})

test("on, the route starts the Host without the device token and passes this page's origin back", async () => {
  const before = { edit: process.env.KRIYA_EDIT, token: process.env.KRIYA_DEVICE_TOKEN }
  Object.assign(process.env, { KRIYA_EDIT: "on", KRIYA_DEVICE_TOKEN: "device-secret" })
  try {
    const seen = {}
    const fake = async () => ({ ensureHost: async ({ env }) => (seen.env = env), hostCall: async (_home, method, path, body) => ((seen.call = { method, path, body }), { url: "http://127.0.0.1:5555/launch#t" }) })
    const res = await launch(new Request("http://127.0.0.1:17391/api/kriya.edit.launch", { method: "POST", headers: { origin: "http://127.0.0.1:17391" } }), { warn() {} }, fake)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).url, "http://127.0.0.1:5555/launch#t")
    assert.equal(seen.env.KRIYA_DEVICE_TOKEN, undefined, "the Host reads the device itself")
    assert.deepEqual(seen.call, { method: "POST", path: "/internal/launch", body: { back: "http://127.0.0.1:17391" } })
    const failing = await launch(new Request("http://127.0.0.1:17391/x", { method: "POST" }), { warn() {} }, async () => ({ ensureHost: async () => assert.fail("no"), hostCall: async () => ({}) }))
    assert.equal(failing.status, 500)
    assert.doesNotMatch(await failing.text(), /no/, "the reason stays in the terminal")
  } finally {
    for (const [key, name] of [["edit", "KRIYA_EDIT"], ["token", "KRIYA_DEVICE_TOKEN"]]) before[key] === undefined ? delete process.env[name] : (process.env[name] = before[key])
  }
})

function loadClient() {
  let loaded
  const react = { createElement: () => ({}), useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {}, useCallback: (f) => f }
  const storage = new Map()
  const sessionStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) }
  vm.runInNewContext(readFileSync(join(ROOT, "plugins", "edit", "client.js"), "utf8"), { window: { __ModuleLoader__: { load: (spec) => (loaded = spec) } }, sessionStorage })
  return { loaded, exports: loaded.factory((name) => (name === "react" ? react : assert.fail(`unexpected require ${name}`))), storage }
}

test("ET-UI-01 (row): one Editing Studio row in the panel list, and its page asks for a link and goes there", async () => {
  const { loaded, exports, storage } = loadClient()
  assert.equal(loaded.id, "@kriya-ai/harness-edit")
  const slots = []
  exports.apply({ slots: { inject: (name, fn) => fn(), register: (spec) => slots.push(spec) }, effect: () => {} })
  assert.deepEqual(JSON.parse(JSON.stringify(slots)), [
    { name: "main", key: "kriya-edit" },
    { name: "sidebar.panellist", id: "kriya-edit", order: 5, label: "Editing Studio" },
  ])
  let went = null
  const problem = await exports.open(async (path, init) => {
    assert.equal(path, "api/kriya.edit.launch")
    assert.equal(init.method, "POST")
    return { ok: true, json: async () => ({ url: "http://127.0.0.1:5555/launch#t" }) }
  }, (url) => (went = url))
  assert.equal(problem, null)
  assert.equal(went, "http://127.0.0.1:5555/launch#t", "the whole tab goes to the Studio")
  assert.equal(storage.get("kriya-edit-left"), "1", "so coming back doesn't bounce straight out again")
  assert.equal(await exports.open(async () => ({ ok: false, json: async () => ({ error: "The Editing Studio is off." }) }), () => assert.fail("no navigation")), "The Editing Studio is off.")
  assert.equal(await exports.open(async () => assert.fail("offline")), "Kriya Harness couldn't reach the Editing Studio.")
})

test("the harness tells a running Host it's live, over the socket only, and never starts one", async () => {
  const before = process.env.KRIYA_EDIT
  try {
    process.env.KRIYA_EDIT = "off"
    assert.equal(await ping(async () => assert.fail("no import with the switch off")), false)
    process.env.KRIYA_EDIT = "on"
    const calls = []
    assert.equal(await ping(async () => ({ hostCall: async (_home, method, path) => calls.push(`${method} ${path}`) })), true)
    assert.deepEqual(calls, ["POST /internal/live"])
    assert.equal(await ping(async () => ({ hostCall: async () => Promise.reject(new Error("no Host")) })), false, "no Host: nothing happens")
  } finally {
    if (before === undefined) delete process.env.KRIYA_EDIT
    else process.env.KRIYA_EDIT = before
  }
  const h = await host()
  try {
    assert.deepEqual(await hostCall(h.home, "POST", "/internal/live"), {})
    assert.equal((await http(h.port, "POST", "/internal/live")).status, 404, "not over TCP")
  } finally {
    await stopHost(h.home)
  }
})
