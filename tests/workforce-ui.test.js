import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { after, before, test } from "node:test"

import { browserTarget } from "../src/browser.js"
import { runGates } from "../src/gates/index.js"
import { contrast, decodePng, luminanceRange } from "../src/gates/page.js"
import { createdTables, ownsTransaction, stackGate, stackScript } from "../src/gates/stack.js"
import { judgeA11y, judgeUi, uiReports, uiRoutes } from "../src/gates/ui.js"
import { forgetStack, hostedDatabase, isLocalDatabase, readStack, shownDatabase, useStack } from "../src/stack.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W4: the local stack, G-UI and G-A11Y on the installed Chrome
// against pages served by this test on a loopback port (each mutant fails,
// the clean page passes), and G-STACK's logic with a scripted psql (no
// Postgres is needed or touched). WT-STK-*, WT-GATE-UI-*, WT-GATE-A11Y-*, WT-GATE-STK-*.

const chrome = Boolean(browserTarget())

test("WT-STK-01: kriya stack accepts only addresses on this computer, keeps them outside the project, and forgets them", () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-stk-")))
  assert.throws(() => useStack(dir, { app: "https://example.com" }), /--app/)
  assert.throws(() => useStack(dir, { db: "postgresql://u:p@db.example.supabase.co:5432/postgres" }), /on this computer/)
  assert.throws(() => useStack(dir, {}), /Give --app/)
  const e = useStack(dir, { app: "localhost:3000", db: "postgresql://postgres:secret@127.0.0.1:54322/postgres" })
  assert.equal(e.app, "http://localhost:3000/")
  assert.deepEqual(readStack(dir).app, "http://localhost:3000/")
  assert.equal(shownDatabase(readStack(dir).db), "postgresql://postgres:****@127.0.0.1:54322/postgres")
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(forgetStack(dir), true)
  assert.deepEqual(readStack(dir), {})
  for (const [url, local] of [
    ["postgresql://a@localhost/x", true],
    ["postgres://a@[::1]:5432/x", true],
    ["postgresql:///x?host=/var/run/postgresql", true],
    ["postgresql://a@10.0.0.5/x", false],
    ["mysql://a@localhost/x", false],
    ["not a url", false],
  ])
    assert.equal(isLocalDatabase(url), local, url)
})

test("WT-STK-02: a hosted database URL in the project's env files is found (the URL itself is never returned)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-env-")))
  assert.equal(hostedDatabase(dir), null)
  writeFileSync(join(dir, ".env.local"), "DATABASE_URL=postgresql://postgres:x@127.0.0.1:54322/postgres\n")
  assert.equal(hostedDatabase(dir), null)
  writeFileSync(join(dir, ".env"), 'export DIRECT_URL="postgresql://u:secret@aws-0.pooler.supabase.com:6543/postgres"\n')
  const found = hostedDatabase(dir)
  assert.deepEqual(found, { variable: "DIRECT_URL", file: ".env" })
  assert.ok(!JSON.stringify(found).includes("secret"))
})

/** A real PNG: width × height, RGB, rows with filter 0 */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3)
  const chunk = (name, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    return Buffer.concat([len, Buffer.from(name), body, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

test("WT-GATE-A11Y-00: the PNG decoder and contrast maths are right", () => {
  const p = decodePng(png(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255])))
  assert.equal(p.width, 4)
  assert.deepEqual([...p.data.subarray(0, 3)], [0, 0, 0])
  const range = luminanceRange(png(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255])))
  assert.equal(range.min, 0)
  assert.equal(range.max, 1)
  assert.equal(Math.round(contrast([0, 0, 0], 1) * 10) / 10, 21)
  assert.equal(Math.round(contrast([119, 119, 119], 1) * 100) / 100, 4.48)
  assert.equal(decodePng(Buffer.from("not a png")), null)
})

// ── pages served by this test, on a loopback port ──
const page = (body, { head = "", lang = true } = {}) =>
  `<!doctype html><html${lang ? ' lang="en"' : ""}><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px/1.5 system-ui;color:#111;background:#fff}button{min-width:48px;min-height:48px}</style>${head}</head><body>${body}</body></html>`
const PAGES = {
  clean: page('<main><h1>Orders</h1><p>Your orders appear here.</p><button type="button">New order</button></main>'),
  console: page('<main><h1>Orders</h1><script>console.error("boom")</script></main>'),
  overflow: page('<main><h1>Orders</h1><div style="width:2000px">wide</div></main>'),
  tiny: page('<main><h1>Orders</h1><button type="button" style="min-width:0;min-height:0;width:12px;height:12px;padding:0;border:0">x</button></main>'),
  shift: page('<main><h1>Orders</h1><p id="p">Text</p><script>setTimeout(()=>{const d=document.createElement("div");d.style.height="300px";document.querySelector("main").prepend(d)},150)</script></main>'),
  broken: page('<main><h1>Orders</h1><img src="/missing.png" alt=""></main>'),
  nolang: page("<main><h1>Orders</h1></main>", { lang: false }),
  unnamed: page('<main><h1>Orders</h1><button type="button"></button></main>'),
  faint: page('<main><h1>Orders</h1><p style="color:#bbb">Hard to read</p></main>'),
  glassBad: page(
    '<div style="background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);padding:40px"><nav style="backdrop-filter:blur(2px);background:rgba(255,255,255,.1);padding:16px"><span style="color:#fff;font-size:16px">Menu text over glass</span></nav></div><main><h1>Orders</h1></main>'
  ),
  glassGood: page(
    '<div style="background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);padding:40px"><nav style="backdrop-filter:blur(2px);background:rgba(20,20,20,.92);padding:16px"><span style="color:#fff;font-size:16px">Menu text over glass</span></nav></div><main><h1>Orders</h1></main>'
  ),
}

let server
let base
let current = "clean"
before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/preview/cart") return res.writeHead(200, { "content-type": "text/html" }).end(PAGES[current])
    res.writeHead(404).end()
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

function project() {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ui-")))
  useStack(dir, { app: base })
  return dir
}
const judge = async (name) => {
  current = name
  const ui = await uiReports({ root: project(), label: `1 ${name}` })
  return { ui: judgeUi(ui), a11y: judgeA11y(ui), reports: ui.reports }
}

test("WT-GATE-UI-01: the clean page passes G-UI and G-A11Y at every width and scheme, with screenshots as evidence", { skip: !chrome && "no Chrome on this computer" }, async () => {
  const { ui, a11y, reports } = await judge("clean")
  assert.equal(ui.status, "pass", ui.excerpt)
  assert.equal(a11y.status, "pass", a11y.excerpt)
  assert.equal(reports.length, 6)
  assert.equal(ui.evidence.length, 6)
  assert.deepEqual([...new Set(reports.map((r) => `${r.viewport}-${r.scheme}`))].sort(), ["1440-dark", "1440-light", "360-dark", "360-light", "390-dark", "390-light"])
})

for (const [name, gate, pattern] of [
  ["console", "ui", /console error: boom/],
  ["overflow", "ui", /scrolls sideways/],
  ["tiny", "ui", /under the 24 px minimum/],
  ["shift", "ui", /layout shift/],
  ["broken", "ui", /request 404 \/missing\.png/],
  ["nolang", "a11y", /has no lang/],
  ["unnamed", "a11y", /button has no accessible name/],
  ["faint", "a11y", /contrast 1\.\d+:1, needs 4\.5:1/],
  ["glassBad", "a11y", /glass surface .* needs 4\.5:1/],
])
  test(`WT-GATE-${gate === "ui" ? "UI" : "A11Y"} mutant ${name}: fails with the reason`, { skip: !chrome && "no Chrome on this computer" }, async () => {
    const result = (await judge(name))[gate]
    assert.equal(result.status, "fail", JSON.stringify(result))
    assert.match(result.excerpt, pattern)
  })

test("WT-GATE-A11Y-02: glass with a near-opaque surface passes the worst-backdrop rule", { skip: !chrome && "no Chrome on this computer" }, async () => {
  const { a11y } = await judge("glassGood")
  assert.equal(a11y.status, "pass", a11y.excerpt)
})

test("WT-GATE-UI-02: routes are / plus component previews from the contract; no app confirmed is an optional not-checked", async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ui-")))
  mkdirSync(join(dir, ".kriya", "contracts"), { recursive: true })
  writeFileSync(join(dir, ".kriya", "contracts", "component_states.json"), JSON.stringify({ Cart: { states: ["loading", "empty"], preview: "/preview/cart" }, Bad: { states: ["empty"], preview: "https://x.com" } }))
  assert.deepEqual(uiRoutes(dir), ["/", "/preview/cart"])
  const none = await uiReports({ root: dir, label: "1 x" })
  assert.equal(judgeUi(none).status, "not_checked")
  assert.equal(judgeUi(none).optional, true)
})

test("WT-GATE-UI-03: required for a frontend step: an app confirmed but not answering fails as not checked; no app at all is a note", { skip: !chrome && "no Chrome on this computer" }, async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ui-")))
  const frontend = { role: "frontend", gates: ["G-UI"], detectors: [], owns: [] }
  const run = () => runGates({ root: dir, changed: [], output: "", rerun: async () => ({ exitCode: 0 }), label: "1 ui", cartridge: frontend })
  const note = await run()
  assert.equal(note.failure, undefined)
  assert.equal(note.results.find((r) => r.id === "G-UI").status, "not_checked")
  useStack(dir, { app: "http://127.0.0.1:9" })
  const required = await run()
  assert.equal(required.failure?.id, "G-UI")
  assert.equal(required.failure.kind, "not checked")
  assert.match(required.failure.excerpt, /doesn't answer/)
})

// ── G-STACK with a scripted psql ──
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })

function migrationProject(sql, { env } = {}) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-db-")))
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true })
  writeFileSync(join(dir, "supabase", "migrations", "20271201_orders.sql"), sql)
  if (env) writeFileSync(join(dir, ".env"), env)
  return dir
}
const CHANGED = ["supabase/migrations/20271201_orders.sql"]

test("WT-GATE-STK-01: G-STACK's script applies the work's migrations in one transaction that is always rolled back", () => {
  const script = stackScript(["/p/it's.sql"], ["public.orders"])
  const lines = script.split("\n")
  assert.equal(lines.find((l) => /^(BEGIN|ROLLBACK);$/.test(l)), "BEGIN;")
  assert.equal(lines.filter((l) => l === "ROLLBACK;").length, 1)
  assert.ok(lines.indexOf("ROLLBACK;") > lines.indexOf("\\i '/p/it''s.sql'"))
  assert.ok(!/COMMIT/i.test(script))
  assert.deepEqual(createdTables('create table orders (id int); CREATE TABLE IF NOT EXISTS "app"."items" (x int);'), ["public.orders", "app.items"])
  assert.equal(ownsTransaction("create table a(id int);"), false)
  assert.equal(ownsTransaction("begin;\ncreate table a(id int);\ncommit;"), true)
})

test("WT-GATE-STK-02: G-STACK refuses before running anything: no database, a hosted one in .env, no psql, a migration with its own COMMIT", async () => {
  const calls = []
  const psql = async (args) => (calls.push(args), ok())
  let dir = migrationProject("create table orders (id int);")
  let r = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: psql })
  assert.equal(r.status, "not_checked")
  assert.equal(r.optional, true)
  dir = migrationProject("create table orders (id int);", { env: "DATABASE_URL=postgresql://u:p@db.example.com:5432/x\n" })
  useStack(dir, { db: "postgresql://postgres:p@127.0.0.1:54322/postgres" })
  r = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: psql })
  assert.match(r.reason, /DATABASE_URL in \.env points off this computer/)
  dir = migrationProject("begin;\ncreate table orders (id int);\ncommit;")
  useStack(dir, { db: "postgresql://postgres:p@127.0.0.1:54322/postgres" })
  r = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: psql })
  assert.match(r.reason, /manages its own transaction/)
  assert.equal(calls.filter((a) => a[0] !== "--version").length, 0, "no SQL was sent in any refusal")
  r = await stackGate({ root: migrationProject("create table t (id int);"), changed: CHANGED, tenantTables: () => true, run: async () => ({ code: 127, missing: true }) })
  assert.equal(r.status, "not_checked")
})

test("WT-GATE-STK-03: G-STACK fails on a migration error (URL redacted) and on tenant tables without RLS or policy; passes when both hold", async () => {
  const dir = migrationProject("create table orders (id int);")
  const db = "postgresql://postgres:secret@127.0.0.1:54322/postgres"
  useStack(dir, { db })
  const err = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: async (a) => (a[0] === "--version" ? ok("psql 17") : { code: 3, stdout: "", stderr: `psql:${db} ERROR: relation "users" does not exist` }) })
  assert.equal(err.status, "fail")
  assert.match(err.excerpt, /relation "users" does not exist/)
  assert.ok(!err.excerpt.includes("secret"))
  const rls = (line) => async (a) => (a[0] === "--version" ? ok("psql 17") : ok(`KRIYA-RLS-BEGIN\n${line}\nKRIYA-RLS-END\n`))
  const off = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: rls("public.orders|false|0") })
  assert.match(off.excerpt, /public\.orders: row-level security is off/)
  const noPolicy = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: rls("public.orders|true|0") })
  assert.match(noPolicy.excerpt, /no policy/)
  const good = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => true, run: rls("public.orders|true|2") })
  assert.equal(good.status, "pass")
  const notTenant = await stackGate({ root: dir, changed: CHANGED, tenantTables: () => false, run: rls("public.orders|false|0") })
  assert.equal(notTenant.status, "pass")
  assert.equal((await stackGate({ root: dir, changed: ["src/a.ts"], tenantTables: () => true })).status, "pass")
})
