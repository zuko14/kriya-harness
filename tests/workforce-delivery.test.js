import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { captureUrl, deployTools, personsOnlyGuard } from "../plugins/deploy/index.js"
import { runner } from "../plugins/repo/repo.js"
import { gateMatrix, gateSelfTests, onPath } from "../src/doctor.js"
import { savePlan } from "../src/loop.js"
import { SWITCHES } from "../src/modes.js"
import { makeReceipt, makeReport } from "../src/receipts.js"
import { bundleBudget, dependencies, DEPLOYED_MAX_REQUESTS, diffChecks, envCompleteness, gDeployed, gRelease, productionAllowed, readRelease, readState, recordReady, recordSmoke, useRelease } from "../src/release.js"
import { readProgress, writeProgress } from "../src/verify.js"
import { freshHome } from "./helpers.js"

// Harness 2.0 W17 (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// DELIVERY_AND_STABILITY.md; WD-21, WD-22): G-RELEASE, deploy, G-DEPLOYED,
// the person's own commands, doctor and report. A scripted `vercel` and a fake
// fetch: nothing is deployed and nothing leaves this machine.

const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
const AWS = "AKIA" + "ZXCVBNMASDFGHJKL"

function project(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-rel-")))
  const all = { "package.json": JSON.stringify({ name: "app", dependencies: { lib: "^1.0.0" } }), "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { lib: "^1.0.0" } } } }), "node_modules/lib/package.json": JSON.stringify({ name: "lib", license: "MIT" }), ".gitignore": "node_modules\n", ...files }
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: ENV })
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV })
  execFileSync("git", ["commit", "-q", "-m", "chore: start"], { cwd: dir, env: ENV })
  return dir
}
const head = (dir) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
const ok200 = (body = "<html>Welcome to Kriya demo</html>", headers = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } })

test("WT-REL-01: kriya release use: a build command, a production server on this computer only, checked values", () => {
  freshHome()
  const dir = project()
  assert.throws(() => useRelease(dir, {}), /needs --build/)
  assert.throws(() => useRelease(dir, { build: "npm run build", app: "https://example.com" }), /--app: This browser opens apps on this computer only/)
  assert.throws(() => useRelease(dir, { build: "npm run build", routes: "/a?token=x" }), /no query strings/)
  assert.throws(() => useRelease(dir, { build: "npm run build", domain: "not a host" }), /host name/)
  assert.throws(() => useRelease(dir, { build: "npm run build", headers: "x-powered-by" }), /--headers names some of/)
  assert.throws(() => useRelease(dir, { build: "npm run build\nrm -rf /" }), /one line/)
  const entry = useRelease(dir, { build: "npm run build", app: "localhost:4000", routes: "/,/pricing", budgetKb: "300", domain: "App.Example.com", headers: "strict-transport-security", marker: "Kriya demo" })
  assert.deepEqual({ ...entry, confirmedAt: undefined }, { build: "npm run build", app: "http://localhost:4000/", routes: ["/", "/pricing"], budgetKb: 300, domain: "app.example.com", headers: ["strict-transport-security"], marker: "Kriya demo", confirmedAt: undefined })
  assert.deepEqual(readRelease(dir), entry)
})

test("WT-REL-02: every environment variable the source reads is named in .env.example (names only)", () => {
  const dir = project({ "src/a.js": "const a = process.env.API_URL\nconst b = import.meta.env.VITE_KEY\nconst n = process.env.NODE_ENV\n", "app.py": "x = os.environ['DB_NAME']\n", ".env.example": "API_URL=\n" })
  const line = envCompleteness(dir)
  assert.equal(line.status, "fail")
  assert.match(line.detail, /Read in the source but not in \.env\.example: DB_NAME, VITE_KEY\./)
  writeFileSync(join(dir, ".env.example"), "API_URL=\nVITE_KEY=\nexport DB_NAME=\n")
  assert.equal(envCompleteness(dir).status, "pass")
})

test("WT-REL-03: the bundle budget", () => {
  const dir = project({ "dist/app.js": "x".repeat(3000), "dist/app.css": "y".repeat(2000), "dist/img.png": "z".repeat(90_000) })
  assert.equal(bundleBudget(dir, {}).status, "pass")
  assert.deepEqual(bundleBudget(dir, { budgetKb: 4 }), { id: "BUNDLE", status: "fail", detail: "5 KB of JS and CSS, over the 4 KB budget" })
  assert.equal(bundleBudget(dir, { budgetKb: 10 }).status, "pass")
  assert.equal(bundleBudget(dir, { budgetKb: 10, out: "build" }).status, "not_checked")
})

test("WT-REL-04: a lockfile in step with package.json; production licences on the allow-list", () => {
  assert.equal(dependencies(project()).status, "pass")
  const noLock = project({ "package-lock.json": "" })
  execFileSync("git", ["rm", "-q", "package-lock.json"], { cwd: noLock, env: ENV })
  assert.match(dependencies(noLock).detail, /no lockfile/)
  assert.match(dependencies(project({ "package.json": JSON.stringify({ dependencies: { lib: "^2.0.0" } }) })).detail, /lib \^2\.0\.0 isn't in package-lock\.json/)
  assert.match(dependencies(project({ "node_modules/lib/package.json": JSON.stringify({ license: "GPL-3.0" }) })).detail, /lib: licence GPL-3\.0 isn't on the allow-list/)
  assert.equal(dependencies(project({ "node_modules/lib/package.json": JSON.stringify({ license: "(MIT OR GPL-3.0)" }) })).status, "pass")
})

const fileOf = (path, text) => ({ path, content: text, added: text.split("\n").map((t, i) => ({ line: i + 1, text: t })) })
test("WT-REL-05: destructive or locking migrations fail the release; secrets are named by place, never value", () => {
  const [m, s] = diffChecks([fileOf("db/002.sql", "alter table orders drop column note;\ncreate index on orders (user_id);"), fileOf("src/k.js", `const k = "${AWS}"`)])
  assert.equal(m.status, "fail")
  assert.match(m.detail, /db\/002\.sql:1 a destructive change/)
  assert.match(m.detail, /db\/002\.sql:2 an index built without CONCURRENTLY/)
  assert.equal(s.status, "fail")
  assert.match(s.detail, /src\/k\.js:1 \(an AWS access key\)/)
  assert.doesNotMatch(s.detail, /AKIA/)
  assert.deepEqual(diffChecks([fileOf("db/003.sql", "create index concurrently i on t (a);")]).map((l) => l.status), ["pass", "pass"])
})

test("WT-REL-06: ready only when every line passes; no production server, or a failed build, withholds it", async () => {
  freshHome()
  const dir = project({ "dist/a.js": "1", ".env.example": "" })
  useRelease(dir, { build: "npm run build" })
  const host = (exit, rendered) => ({ run: async () => ({ exitCode: exit, timedOut: false, output: "built" }), files: async () => [], commit: async () => "c".repeat(40), ...(rendered && { rendered }) })
  const noApp = await gRelease(dir, host(0))
  assert.equal(noApp.ready, false)
  assert.deepEqual(noApp.lines.find((l) => l.id === "RENDERED"), { id: "RENDERED", status: "not_checked", detail: "no production server is confirmed: start it and run kriya release use --app http://localhost:<port>" })
  useRelease(dir, { app: "localhost:4100" })
  const pass = async (app) => (assert.equal(app, "http://localhost:4100/"), [{ id: "G-UI", status: "pass" }, { id: "G-A11Y", status: "pass" }])
  const ready = await gRelease(dir, host(0, pass))
  assert.deepEqual(ready.lines.map((l) => [l.id, l.status]), [["BUILD", "pass"], ["G-UI", "pass"], ["G-A11Y", "pass"], ["REL-ENV", "pass"], ["BUNDLE", "pass"], ["DEPS", "pass"], ["MIGRATIONS", "pass"], ["G-SECRETS", "pass"]])
  assert.equal(ready.ready, true)
  assert.equal((await gRelease(dir, host(1, pass))).ready, false)
  assert.equal((await gRelease(dir, host(0, async () => [{ id: "G-UI", status: "fail", excerpt: "console error" }]))).ready, false)
})

const exec = { agent: { id: "s1" }, signal: new AbortController().signal }
function deployHost(dir, { approve = async () => true, readOnly = () => false, vercel, fetch: f, build = 0 } = {}) {
  const calls = { vercel: [], fetch: [], approvals: [] }
  const base = runner({ env: ENV })
  const runCli = (file, args, cwd) => {
    if (file === "vercel") {
      calls.vercel.push(args)
      return Promise.resolve(vercel ? vercel(args) : { code: 0, stdout: "https://kriya-demo-abc123.vercel.app\n", stderr: "" })
    }
    return base(file, args, cwd)
  }
  const tools = Object.fromEntries(
    deployTools({
      cwd: async () => dir,
      readOnly,
      approve: async (e, reason) => (calls.approvals.push(reason), approve(e, reason)),
      runCli,
      runCheck: async () => ({ exitCode: build, timedOut: false, output: "" }),
      rendered: async () => [{ id: "G-UI", status: "pass" }, { id: "G-A11Y", status: "pass" }],
      fetch: async (url, init) => (calls.fetch.push({ url: String(url), init }), f ? f(url, init) : ok200()),
    }).map((t) => [t.name, t])
  )
  return { t: tools, calls }
}

test("WT-REL-07: release_check runs on a committed tree only and records ready for that commit", async () => {
  freshHome()
  const dir = project({ ".env.example": "" })
  useRelease(dir, { build: "npm run build", app: "localhost:4200" })
  const { t } = deployHost(dir)
  writeFileSync(join(dir, "wip.js"), "1")
  await assert.rejects(t.release_check.execute({}, exec), /uncommitted changes/)
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV })
  execFileSync("git", ["commit", "-q", "-m", "feat: wip"], { cwd: dir, env: ENV })
  const r = await t.release_check.execute({}, exec)
  assert.equal(r.ready, true)
  assert.equal(r.commit, head(dir))
  assert.deepEqual(readState(dir).records.at(-1), { kind: "ready", commit: head(dir), ready: true, lines: r.lines.map((l) => ({ id: l.id, status: l.status })), at: readState(dir).records.at(-1).at })
})

test("WT-REL-08: production needs a passing release check and a passing preview smoke for the same commit", () => {
  freshHome()
  const dir = project()
  const c = head(dir)
  assert.match(productionAllowed(dir, c).why, /G-RELEASE hasn't passed/)
  recordReady(dir, "0".repeat(40), true, [])
  assert.match(productionAllowed(dir, c).why, /G-RELEASE hasn't passed on this commit/)
  recordReady(dir, c, false, [])
  assert.match(productionAllowed(dir, c).why, /G-RELEASE hasn't passed/)
  recordReady(dir, c, true, [])
  assert.match(productionAllowed(dir, c).why, /No preview of this commit/)
  recordSmoke(dir, { target: "preview", commit: "0".repeat(40), ok: true })
  recordSmoke(dir, { target: "preview", commit: c, ok: false })
  assert.match(productionAllowed(dir, c).why, /No preview of this commit/)
  recordSmoke(dir, { target: "preview", commit: c, ok: true })
  assert.deepEqual(productionAllowed(dir, c), { ok: true })
})

test("WT-DEP-01: the deployment URL is taken from the CLI's output by code, on the provider's host or the confirmed domain only", () => {
  const vercel = { host: /^[a-z0-9-]+\.vercel\.app$/ }
  assert.equal(captureUrl("Inspect: https://vercel.com/team/p/abc\nhttps://kriya-demo-abc123.vercel.app\n", vercel), "https://kriya-demo-abc123.vercel.app/")
  assert.equal(captureUrl('{"url":"https://kriya-demo-x.vercel.app","inspect":"https://vercel.com/x"}', vercel), "https://kriya-demo-x.vercel.app/")
  assert.equal(captureUrl("see https://evil.example.com and https://a.vercel.app.evil.com", vercel), undefined)
  assert.equal(captureUrl("https://user:pw@kriya.vercel.app", vercel), undefined)
  assert.equal(captureUrl("http://kriya.vercel.app", vercel), undefined)
  assert.equal(captureUrl("https://app.example.com/path?x=1", vercel, "app.example.com"), "https://app.example.com/")
})

test("WT-DEP-02: no URL on the right host ⇒ no smoke, and nothing is fetched", async () => {
  freshHome()
  const dir = project()
  useRelease(dir, { build: "npm run build" })
  const { t, calls } = deployHost(dir, { vercel: () => ({ code: 0, stdout: "Deployed to https://kriya.evil.example\n", stderr: "" }) })
  const r = await t.deploy_preview.execute({}, exec)
  assert.equal(r.url, null)
  assert.match(r.smoke, /not run/)
  assert.deepEqual(calls.fetch, [])
  assert.deepEqual(calls.vercel, [["deploy", "--yes"]])
  assert.equal(readState(dir).records.at(-1).ok, false)
})

test("WT-DEP-03: G-DEPLOYED uses GET, the captured host only, and sends no credentials, cookies or body", async () => {
  const seen = []
  const r = await gDeployed("https://kriya.vercel.app/", { routes: ["/", "/pricing"] }, { fetchImpl: async (url, init) => (seen.push({ url: String(url), init }), ok200()) })
  assert.equal(r.status, "pass")
  assert.deepEqual(seen.map((s) => s.url), ["https://kriya.vercel.app/", "https://kriya.vercel.app/pricing"])
  for (const s of seen) {
    assert.equal(s.init.method, "GET")
    assert.equal(s.init.credentials, "omit")
    assert.equal(s.init.body, undefined)
    assert.equal(s.init.redirect, "manual")
    assert.deepEqual(Object.keys(s.init.headers), ["accept"])
  }
  assert.equal(typeof r.medianMs, "number")
})

test("WT-DEP-04: at most 20 requests per run", async () => {
  let n = 0
  const routes = Array.from({ length: 25 }, (_, i) => `/r${i}`)
  const r = await gDeployed("https://kriya.vercel.app/", { routes }, { fetchImpl: async () => (n++, ok200()) })
  assert.equal(n, DEPLOYED_MAX_REQUESTS)
  assert.equal(r.status, "fail")
  assert.match(r.problems.at(-1), /20-request limit/)
})

test("WT-DEP-05: redirects are followed only within the host", async () => {
  const hop = (location) => new Response(null, { status: 302, headers: { location } })
  const same = await gDeployed("https://kriya.vercel.app/", {}, { fetchImpl: async (url) => (new URL(url).pathname === "/" ? hop("/home") : ok200()) })
  assert.equal(same.status, "pass")
  assert.equal(same.requests, 2)
  let off = 0
  const away = await gDeployed("https://kriya.vercel.app/", {}, { fetchImpl: async () => (off++, hop("https://evil.example.com/")) })
  assert.equal(off, 1)
  assert.match(away.problems[0], /a redirect left kriya\.vercel\.app/)
})

test("WT-DEP-06: status, content type, marker and the listed security headers", async () => {
  const release = { routes: ["/"], marker: "Kriya demo", headers: ["strict-transport-security", "x-frame-options"] }
  const good = await gDeployed("https://kriya.vercel.app/", release, { fetchImpl: async () => ok200(undefined, { "strict-transport-security": "max-age=63072000", "content-security-policy": "frame-ancestors 'none'" }) })
  assert.equal(good.status, "pass")
  const bad = await gDeployed("https://kriya.vercel.app/", release, { fetchImpl: async () => new Response("<html>other</html>", { status: 200, headers: { "content-type": "text/plain" } }) })
  assert.deepEqual(bad.problems, ["/ answered text/plain", "/ doesn't contain the marker text", "the Strict-Transport-Security header is missing", "the X-Frame-Options header is missing"])
  const down = await gDeployed("https://kriya.vercel.app/", {}, { fetchImpl: async () => new Response("", { status: 503 }) })
  assert.deepEqual(down.problems, ["/ answered 503"])
})

test("WT-DEP-07: only https, without credentials", async () => {
  let called = 0
  const f = async () => (called++, ok200())
  assert.match((await gDeployed("http://kriya.vercel.app/", {}, { fetchImpl: f })).problems[0], /only an https URL/)
  assert.match((await gDeployed("https://u:p@kriya.vercel.app/", {}, { fetchImpl: f })).problems[0], /only an https URL/)
  assert.equal(called, 0)
})

test("WT-DEP-08: the person's own commands are refused in the agent's shell and written down for them", () => {
  const recorded = []
  const guard = personsOnlyGuard((command, why) => recorded.push({ command, why }))
  const bash = (command) => guard({ name: "bash", arguments: { command } })
  for (const c of ["supabase db push", "npx prisma migrate deploy", "vercel env add STRIPE_KEY production", "wrangler secret put KEY", "fly secrets set A=1", "gh pr merge 12 --squash", "git push origin main", "git push --force origin kriya/x", "vercel domains add app.example.com", "netlify sites:delete"])
    assert.match(bash(c), /^Kriya never runs this: it /, c)
  assert.equal(recorded.length, 10)
  assert.match(recorded[0].why, /hosted database/)
  for (const c of ["npm test", "npx prisma generate", "git push -u origin kriya/feature", "vercel deploy --yes", "supabase start"]) assert.equal(bash(c), undefined, c)
  assert.equal(guard({ name: "read", arguments: { path: "supabase db push" } }), undefined)
})

test("WT-DEP-09: deploys need the person's approval; Auto and Read only deploy nothing", async () => {
  freshHome()
  const dir = project()
  useRelease(dir, { build: "npm run build" })
  const refused = deployHost(dir, { approve: async () => false })
  await assert.rejects(refused.t.deploy_preview.execute({}, exec), /didn't approve/)
  assert.deepEqual(refused.calls.vercel, [])
  assert.match(refused.calls.approvals[0], new RegExp(`^Deploy preview with vercel: \`vercel deploy --yes\` of commit ${head(dir).slice(0, 12)} in this project$`))
  const ro = deployHost(dir, { readOnly: () => true })
  await assert.rejects(ro.t.deploy_preview.execute({}, exec), /Read only mode deploys nothing/)
  assert.deepEqual(ro.calls.approvals, [])
  // Production without the records is refused before anyone is asked
  const early = deployHost(dir)
  await assert.rejects(early.t.deploy_production.execute({}, exec), /G-RELEASE hasn't passed/)
  assert.deepEqual(early.calls.approvals, [])
})

test("WT-DEP-10: release check → preview smoked → production; a failed production smoke offers the rollback and leaves it in the receipt", async () => {
  freshHome()
  const dir = project({ ".env.example": "" })
  useRelease(dir, { build: "npm run build", app: "localhost:4300", marker: "Kriya demo" })
  savePlan(dir, "s1", { goal: "Ship", steps: [{ title: "Ship", done_when: "live" }] })
  const p = readProgress(dir, "s1")
  p.runs = [{ at: "2026-11-23T10:00:00.000Z", step: "1", command: "npm test", status: "pass", exitCode: 0, timedOut: false, durationMs: 1 }]
  writeProgress(dir, "s1", p)
  let live = true
  const { t, calls } = deployHost(dir, {
    vercel: (args) => ({ code: 0, stdout: args.includes("--prod") ? "https://kriya-demo.vercel.app\n" : "https://kriya-demo-git-x.vercel.app\n", stderr: "" }),
    fetch: async () => (live ? ok200("<html>Welcome to Kriya demo</html>") : new Response("", { status: 500 })),
  })
  assert.equal((await t.release_check.execute({}, exec)).ready, true)
  const preview = await t.deploy_preview.execute({}, exec)
  assert.equal(preview.smoke.status, "pass")
  assert.equal(preview.url, "https://kriya-demo-git-x.vercel.app/")
  live = false
  const prod = await t.deploy_production.execute({}, exec)
  assert.equal(prod.smoke.status, "fail")
  assert.equal(prod.rollback, "rolled back")
  assert.deepEqual(calls.vercel, [["deploy", "--yes"], ["deploy", "--prod", "--yes"], ["rollback"]])
  assert.match(calls.approvals.at(-1), /The production smoke check failed\. Roll back with `vercel rollback`\?/)
  assert.deepEqual((await t.release_status.execute({}, exec)).forPerson.map((f) => f.command), ["vercel rollback"])
  assert.match(makeReceipt(dir, "s1").markdown, /### For you to run \(Kriya never runs these\)\n\n- `vercel rollback`: it rolls production back after a failed smoke check/)
  assert.deepEqual(SWITCHES.find(([f]) => f === "deploy"), ["deploy", "KRIYA_DEPLOY", false])
})

test("WT-DOC-01: the gates' self-tests catch their planted problems and pass clean code", async () => {
  const results = await gateSelfTests()
  assert.ok(results.length >= 3)
  for (const r of results) assert.deepEqual([r.name, r.clean, r.mutant, r.ok], [r.name, true, true, true])
})

test("WT-DOC-02: the capability matrix says what each gate needs here, found without running anything", async () => {
  const none = await gateMatrix({ has: () => false, chrome: false })
  assert.deepEqual(none.filter((r) => !r.works).map((r) => r.gate), ["G-UI", "G-A11Y", "G-STACK", "G-SAST", "G-SAN", "G-IAC", "G-SIM", "G-DEPLOYED", "G-3D"])
  assert.match(none.find((r) => r.gate === "G-STACK").needs, /psql/)
  assert.ok((await gateMatrix({ has: () => true, chrome: true })).every((r) => r.works))
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "kriya-bin-")))
  writeFileSync(join(bin, "psql"), "#!/bin/sh\nexit 1\n")
  assert.equal(onPath("psql", { PATH: bin }), true)
  assert.equal(onPath("semgrep", { PATH: bin }), false)
})

test("WT-DOC-03: kriya report holds versions, the matrix and receipts, and no file contents, prompts, secrets or query strings", async () => {
  freshHome()
  const dir = project()
  savePlan(dir, "s9", { goal: "SECRET PROMPT build billing", steps: [{ title: "Billing", done_when: "works" }] })
  const p = readProgress(dir, "s9")
  p.runs = [{ at: "2026-11-23T10:00:00.000Z", step: "1", command: `TOKEN=${AWS} npm test`, status: "fail", exitCode: 1, timedOut: false, durationMs: 1, excerpt: `const x = "${AWS}"` }]
  writeProgress(dir, "s9", p)
  const { forPerson } = await import("../src/release.js")
  forPerson(dir, `vercel env add KEY https://api.example.com/x?token=${AWS}`, "changes a deployment's environment variables")
  const { report, file } = await makeReport(dir, { gates: { matrix: [], selfTests: [] } })
  const text = readFileSync(file, "utf8")
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(report.receipts.length, 1)
  assert.equal(report.receipts[0].session, "s9")
  assert.match(report.forPerson[0].command, /^vercel env add KEY https:\/\/api\.example\.com\/x$/)
  for (const banned of [AWS, "SECRET PROMPT", "Billing", "npm test", "token=", "const x", dir]) assert.equal(text.includes(banned), false, banned)
})
