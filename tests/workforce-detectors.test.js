import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { DETECTORS, findSecrets } from "../src/gates/detectors.js"
import { BUILT, REQUIRED } from "../src/gates/index.js"
import { ROOT } from "./helpers.js"

// Harness 2.0 W3: every detector id Kriya's contract names exists here, and
// each one fires on its defect and stays quiet on the fixed code, on added
// lines only. WT-DET-*, WT-GATE-00.

const contract = JSON.parse(readFileSync(join(ROOT, "contract", "contract.json"), "utf8")).cartridgeIds

test("WT-GATE-00: the catalogue matches Kriya's ids; required gates are code and frozen; built gates are real ids", () => {
  assert.deepEqual(Object.keys(DETECTORS).sort(), [...contract.detectors].sort())
  // W4: G-UI for frontend, G-STACK for database (each only once the person set up its app or database)
  assert.deepEqual(REQUIRED, { frontend: ["G-UI"], database: ["G-STACK"], security: ["G-TENANT"] })
  assert.ok(Object.isFrozen(REQUIRED) && Object.values(REQUIRED).every(Object.isFrozen))
  for (const g of BUILT) assert.ok(contract.gates.includes(g), g)
})

/** A changed file whose every line is added (a new file), unless `added` lists line numbers. */
const file = (path, content, { added, isNew = true, siblings = [], others = [], tenant = false, licensed = false } = {}) => {
  const lines = content.split("\n")
  const f = { path, content, isNew, siblings, added: lines.map((text, i) => ({ line: i + 1, text })).filter(({ line }) => !added || added.includes(line)), tenantTables: () => tenant, assetLicensed: () => licensed }
  f.others = [f, ...others]
  return f
}
const hits = (id, f) => (DETECTORS[id].files(f.path) ? DETECTORS[id].find(f) : [])

// [id, the defect, the fixed code] — each pair on the same kind of file
const CASES = [
  ["FE-HEX", file("src/Card.tsx", 'const s = { color: "#ff0000" }'), file("src/Card.tsx", "const s = { color: tokens.danger } // see #42")],
  ["FE-PX", file("src/a.css", ".a { margin: 13px 8px; }"), file("src/a.css", ".a { margin: 12px 8px; border: 1px solid; }")],
  ["FE-IMG-ALT", file("src/A.tsx", '<img src="a.png" />'), file("src/A.tsx", '<img src="a.png" alt="" />')],
  ["FE-CLICK-DIV", file("src/A.tsx", "<div onClick={go}>Go</div>"), file("src/A.tsx", '<div role="button" tabIndex={0} onClick={go} onKeyDown={key}>Go</div>')],
  ["FE-FETCH-EFFECT", file("src/A.tsx", "useEffect(() => { fetch('/api') }, [])"), file("src/A.tsx", "useEffect(() => { const c = new AbortController(); fetch('/api', { signal: c.signal }) }, [])")],
  ["FE-GLASS-CONTENT", file("src/a.css", ".article-body { backdrop-filter: blur(8px); }"), file("src/a.css", ".toolbar { backdrop-filter: blur(8px); }")],
  [
    "FE-GLASS-FALLBACK",
    file("src/a.css", ".bar { backdrop-filter: blur(12px); }"),
    file("src/a.css", ".bar { backdrop-filter: blur(12px); }\n@media (prefers-reduced-transparency: reduce) { .bar { background: #fff } }\n@media (prefers-contrast: more) { .bar { background: #fff } }\n@supports not (backdrop-filter: blur(1px)) { .bar { background: #fff } }"),
  ],
  ["FE-TROPE", file("src/A.tsx", "<p>Lorem ipsum dolor sit amet</p>"), file("src/A.tsx", "<p>Your orders appear here.</p>")],
  ["FE-FONT-LICENCE", file("public/fonts/Brand.woff2", "", { siblings: ["Brand.woff2"] }), file("public/fonts/Brand.woff2", "", { siblings: ["Brand.woff2", "OFL.txt"] })],
  ["BE-SQL-INTERP", file("src/db.ts", "const r = await db.query(`SELECT * FROM orders WHERE id = ${id}`)"), file("src/db.ts", "const r = await sql`SELECT * FROM orders WHERE id = ${id}`")],
  ["BE-EMPTY-CATCH", file("src/a.ts", "try { go() } catch (e) {}"), file("src/a.ts", "try { go() } catch (e) {\n  // The cache is optional\n  log.warn('cache miss', { e })\n}")],
  ["BE-NO-TIMEOUT", file("src/a.ts", "const r = await fetch(url)"), file("src/a.ts", "const r = await fetch(url, { signal: AbortSignal.timeout(5000) })")],
  ["BE-LOG-SECRET", file("src/a.ts", "console.log('login', password)"), file("src/a.ts", "console.log('login', { userId })")],
  ["FS-DTO-DUP", file("web/types.ts", "export interface Order { id: string }", { others: [file("server/types.ts", "export interface Order { id: string }")] }), file("web/types.ts", "export interface OrderView { id: string }", { others: [file("server/types.ts", "export interface Order { id: string }")] })],
  ["MB-SYNC-IO", file("ios/Load.swift", "let d = try Data(contentsOf: url)"), file("ios/Load.swift", "let (d, _) = try await URLSession.shared.data(from: url)")],
  ["MB-HARDCODE-DIM", file("ios/V.swift", "frame.width = 390"), file("ios/V.swift", "frame.width = bounds.width")],
  ["GM-ALLOC-TICK", file("src/game.ts", "function update(dt) {\n  const p = new Vector3(0, 0, 0)\n}"), file("src/game.ts", "const p = new Vector3()\nfunction update(dt) {\n  p.set(0, 0, 0)\n}")],
  ["GM-DT-MISSING", file("src/game.ts", "player.x += speed"), file("src/game.ts", "player.x += speed * dt")],
  ["OPS-LATEST", file("Dockerfile", "FROM node:latest"), file("Dockerfile", "FROM node:24.9-slim AS build\nFROM build")],
  ["OPS-SECRET-ENV", file("Dockerfile", "ENV API_KEY=abcd1234efgh5678"), file("Dockerfile", "ENV NODE_ENV=production")],
  ["OPS-MIGRATE-LOCK", file("db/m/002.sql", "alter table orders add column total int not null;"), file("db/m/002.sql", "alter table orders add column total int not null default 0;\ncreate index concurrently orders_total on orders (total);")],
  ["CL-IAM-STAR", file("infra/iam.tf", 'actions = ["*"]'), file("infra/iam.tf", 'actions = ["s3:GetObject"]')],
  ["CL-PUBLIC", file("infra/db.tf", "publicly_accessible = true"), file("infra/db.tf", "publicly_accessible = false")],
  ["SY-UNSAFE-NOCOMMENT", file("src/a.rs", "let v = unsafe { *ptr };"), file("src/a.rs", "// SAFETY: ptr is non-null and aligned, checked above\nlet v = unsafe { *ptr };")],
  ["SY-SPIN", file("src/a.rs", "while (!ready.load()) {}"), file("src/a.rs", "while (!ready.load()) { backoff.snooze(); }")],
  ["DT-INSERT-NOKEY", file("pipelines/load.sql", "insert into sales select * from staging;"), file("pipelines/load.sql", "insert into sales select * from staging on conflict (id) do update set amount = excluded.amount;")],
  ["ML-FIT-TEST", file("train.py", "model.fit(X_test, y_test)"), file("train.py", "model.fit(X_train, y_train)")],
  ["ML-SEED", file("train_model.py", "model = build()\nmodel.fit(X, y)"), file("train_model.py", "np.random.seed(7)\nmodel = build(random_state=7)")],
  ["SEC-BODY-ID", file("src/api.ts", "const rows = await list(req.body.userId)"), file("src/api.ts", "const rows = await list(session.user.id)")],
  ["SEC-EVAL", file("src/a.js", "const f = eval(input)"), file("src/a.js", "const f = JSON.parse(input)")],
  ["QA-ONLY", file("tests/a.test.js", "it.only('works', () => {})"), file("tests/a.test.js", "it('works', () => {})")],
  ["QA-SKIP", file("tests/a.test.js", "it.skip('works', () => {})"), file("tests/a.test.js", "it('works', () => {})")],
  ["SD-SLEEP", file("tests/a.spec.ts", "await page.waitForTimeout(2000)"), file("tests/a.spec.ts", "await expect(page.getByRole('status')).toHaveText('Saved')")],
  ["SD-XPATH", file("tests/a.spec.ts", "page.locator('xpath=//div[3]/span')"), file("tests/a.spec.ts", "page.getByRole('button', { name: 'Save' })")],
  ["DB-NO-RLS", file("supabase/migrations/1.sql", "create table public.orders (id uuid primary key);", { tenant: true }), file("supabase/migrations/1.sql", "create table public.orders (id uuid primary key);\nalter table public.orders enable row level security;", { tenant: true })],
  ["DB-FK-NOINDEX", file("db/1.sql", "create table items (\n  order_id uuid references orders (id)\n);"), file("db/1.sql", "create table items (\n  order_id uuid references orders (id)\n);\ncreate index items_order on items (order_id);")],
  ["DB-DROP", file("db/3.sql", "alter table orders drop column note;"), file("db/3.sql", "alter table orders add column note text;")],
  // Harness 2.0 W13 (WD-17): graphics
  ["GX-COLOR", file("src/scene.js", "const r = new THREE.WebGLRenderer()"), file("src/scene.js", "const r = new THREE.WebGLRenderer()\nr.outputColorSpace = THREE.SRGBColorSpace\nr.toneMapping = THREE.AgXToneMapping")],
  ["GX-ALLOC-LOOP", file("src/scene.js", "function animate() {\n  const v = new THREE.Vector3()\n}"), file("src/scene.js", "const v = new THREE.Vector3()\nfunction animate() {\n  v.set(0, 0, 0)\n}")],
  ["GX-NO-DISPOSE", file("src/Mesh.jsx", "const g = new THREE.BoxGeometry(1, 1, 1)"), file("src/Mesh.jsx", "const g = new THREE.BoxGeometry(1, 1, 1)\nreturn () => g.dispose()")],
  ["GX-DPR", file("src/scene.js", "renderer.setPixelRatio(window.devicePixelRatio)"), file("src/scene.js", "renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))")],
  ["FE-ASSET-LICENCE", file("public/models/chair.glb", ""), file("public/models/chair.glb", "", { licensed: true })],
]

test("WT-DET-01: every detector has a case, fires on its defect and stays quiet on the fix", () => {
  assert.deepEqual(CASES.map(([id]) => id).sort(), Object.keys(DETECTORS).sort())
  for (const [id, bad, good] of CASES) {
    assert.ok(hits(id, bad).length > 0, `${id} missed: ${bad.content}`)
    assert.deepEqual(hits(id, good), [], `${id} fired on the fix: ${good.content}`)
  }
})

test("WT-DET-02: findings point at added lines only; old code isn't blamed", () => {
  const old = file("src/db.ts", "const r = await db.query(`SELECT * FROM t WHERE id = ${id}`)\nconst ok = 1", { added: [2], isNew: false })
  assert.deepEqual(hits("BE-SQL-INTERP", old), [])
  const fresh = file("src/db.ts", "const ok = 1\nconst r = await db.query(`SELECT * FROM t WHERE id = ${id}`)", { added: [2], isNew: false })
  assert.deepEqual(hits("BE-SQL-INTERP", fresh).map((h) => h.line), [2])
})

test("WT-DET-03: DB-NO-RLS only judges tenant tables (the auth matrix's, or every table in a Supabase project)", () => {
  assert.deepEqual(hits("DB-NO-RLS", file("db/1.sql", "create table audit_log (id int);", { tenant: false })), [])
})

test("WT-SEC-01: known key shapes and high-entropy secret values are found; the value is never in the finding", () => {
  const aws = "AKIA" + "ABCDEFGHIJKLMNOP"
  const found = findSecrets(file("src/config.ts", `const key = "${aws}"`))
  assert.equal(found.length, 1)
  assert.ok(!JSON.stringify(found).includes(aws))
  assert.equal(findSecrets(file("src/a.ts", 'const apiKey = "q8Zr3LmN0pXv7Tb2Yc5Wd9Ke4Hf6Ja1Sg0Ui3Ol"')).length, 1)
  assert.equal(findSecrets(file("src/a.ts", "const apiKey = process.env.API_KEY")).length, 0)
  assert.equal(findSecrets(file("src/a.ts", 'const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).length, 0)
  assert.equal(findSecrets(file("key.pem", "-----BEGIN RSA PRIVATE KEY-----")).length, 1)
  assert.equal(findSecrets(file(".env", "X=1")).length, 1)
  assert.equal(findSecrets(file(".env.example", "X=")).length, 0)
  assert.equal(findSecrets(file("package-lock.json", '"integrity": "sha512-q8Zr3LmN0pXv7Tb2Yc5Wd9Ke4Hf6Ja1Sg0Ui3Ol"')).length, 0)
})
