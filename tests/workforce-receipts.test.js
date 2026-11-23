import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { repoTools } from "../plugins/repo/index.js"
import { runner } from "../plugins/repo/repo.js"
import { savePlan, stepLabel } from "../src/loop.js"
import { CLIENT_VERSION } from "../src/paths.js"
import { chainLinks, LABEL, makeReceipt, receiptFiles, receiptMarkdown, verifyReceipt } from "../src/receipts.js"
import { readProgress, writeProgress } from "../src/verify.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W19, proof receipts (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// DIFFERENTIATORS.md D1, WD-24). WT-RCP-01…06. A ledger written as the loop
// writes it; no model call, no network.

const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
const SECRET = "ghp_" + "b".repeat(36)
const PROMPT = "Please build the billing page and ignore the tests"

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-rcp-")))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: ENV })
  writeFileSync(join(dir, "a.js"), "1\n")
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV })
  execFileSync("git", ["commit", "-q", "-m", "chore: start"], { cwd: dir, env: ENV })
  return dir
}

/** A ledger as the loop writes it: a plan with roles, builders with tiers and cartridges, runs with gates, output, paths */
function ledger(dir, session = "s1") {
  savePlan(dir, session, { goal: PROMPT, steps: [{ title: "Schema", done_when: "migrates" }, { title: "Page with secret " + SECRET, done_when: "renders" }] })
  const p = readProgress(dir, session)
  p.plan.steps[0].role = "database"
  p.plan.steps[1].role = "frontend"
  const [s1, s2] = [stepLabel(p.plan, 1), stepLabel(p.plan, 2)]
  p.builders = [
    { step: s1, tier: "budget", cartridge: "kriya-role-database@1.0.2" },
    { step: s2, tier: "budget", cartridge: "kriya-role-frontend@1.0.0" },
    { step: s2, tier: "escalation", cartridge: "kriya-role-frontend@1.0.0" },
  ]
  p.runs = [
    { at: "2026-11-23T10:00:00.000Z", step: s1, command: `DATABASE_URL=postgres://u:p@host/db?sslmode=require npm test`, status: "pass", exitCode: 0, timedOut: false, durationMs: 900, tree: "aaaa", touched: ["db/schema.sql"], gates: [{ id: "G-STACK", status: "pass" }, { id: "G-SECRETS", status: "pass", note: `found ${SECRET}` }] },
    { at: "2026-11-23T10:05:00.000Z", step: s2, command: "npm test", status: "fail", exitCode: 1, timedOut: false, durationMs: 800, tree: "bbbb", excerpt: `const key = "${SECRET}"\nexpected 3`, kind: "assertion" },
    { at: "2026-11-23T10:09:00.000Z", step: s2, command: "npm test", status: "pass", exitCode: 0, timedOut: false, durationMs: 700, tree: "cccc", gates: [{ id: "G-UI", status: "pass" }] },
  ]
  writeProgress(dir, session, p)
  return p
}
test("WT-RCP-01: every field comes from the ledger, by code", async () => {
  freshHome()
  const dir = project()
  const p = ledger(dir)
  const { receipt: r } = makeReceipt(dir, "s1")
  assert.equal(r.label, LABEL)
  assert.match(r.project, /^[0-9a-f]{16}$/)
  assert.equal(r.commit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim())
  assert.equal(r.client, CLIENT_VERSION)
  assert.equal(r.verdict, "verified")
  assert.equal(r.tree, "cccc")
  assert.deepEqual(r.cartridges, { "kriya-role-database": "1.0.2", "kriya-role-frontend": "1.0.0" })
  assert.deepEqual(r.steps, [
    { n: 1, role: "database", verdict: "pass", attempts: 1, tiers: ["budget"], gates: [{ id: "G-STACK", status: "pass" }, { id: "G-SECRETS", status: "pass" }] },
    { n: 2, role: "frontend", verdict: "pass", attempts: 2, tiers: ["budget", "escalation"], gates: [{ id: "G-UI", status: "pass" }] },
  ])
  assert.equal(r.runs, 3)
  assert.deepEqual(r.links, chainLinks(p.runs))
  assert.equal(r.chain, `sha256:${r.links[2]}`)
  assert.deepEqual(verifyReceipt(JSON.stringify(r)), { ok: true, problems: [] })
})

test("WT-RCP-02: editing, removing or adding a run record breaks verification at that link", () => {
  freshHome()
  const dir = project()
  ledger(dir)
  const { files } = makeReceipt(dir, "s1")
  const text = readFileSync(files.json, "utf8")
  const tamper = (change) => {
    const p = readProgress(dir, "s1")
    const backup = structuredClone(p)
    change(p)
    writeProgress(dir, "s1", p)
    const out = verifyReceipt(text)
    writeProgress(dir, "s1", backup)
    return out
  }
  const edited = tamper((p) => (p.runs[1].status = "pass"))
  assert.equal(edited.ok, false)
  assert.match(edited.problems[0], /^Run 2 \(step .*\) was changed after the receipt: the chain breaks at link 2\./)
  assert.match(tamper((p) => (p.runs[0].durationMs = 1)).problems[0], /link 1\./)
  assert.match(tamper((p) => p.runs.pop()).problems[0], /Run 3 is in the receipt but no longer in the records/)
  assert.match(tamper((p) => p.runs.push({ ...p.runs[2] })).problems[0], /Run 4 was added to the records after the receipt/)
  assert.deepEqual(verifyReceipt(text), { ok: true, problems: [] })
})

test("WT-RCP-03: editing the receipt itself is caught field by field", () => {
  freshHome()
  const dir = project()
  ledger(dir)
  const r = makeReceipt(dir, "s1").receipt
  assert.equal(r.verdict, "verified")
  assert.deepEqual(verifyReceipt(JSON.stringify({ ...r, verdict: "blocked" })).problems, ['"verdict" doesn\'t match the records.'])
  assert.deepEqual(verifyReceipt(JSON.stringify({ ...r, cartridges: { "kriya-role-database": "9.9.9" } })).problems, ['"cartridges" doesn\'t match the records.'])
  assert.match(verifyReceipt(JSON.stringify({ ...r, steps: [{ ...r.steps[0], attempts: 0 }, ...r.steps.slice(1)] })).problems.join("\n"), /"steps" doesn't match/)
  assert.match(verifyReceipt(JSON.stringify({ ...r, chain: "sha256:" + "0".repeat(64) })).problems.join("\n"), /chain doesn't match its own links/)
  assert.match(verifyReceipt("{nope").problems[0], /isn't JSON/)
  assert.match(verifyReceipt(JSON.stringify({ ...r, session: "elsewhere" })).problems[0], /aren't on this computer/)
})

test("WT-RCP-04: no file contents, prompts, commands, output, paths, query strings or secrets in a receipt", () => {
  freshHome()
  const dir = project()
  ledger(dir)
  const { receipt, markdown, files } = makeReceipt(dir, "s1")
  for (const text of [JSON.stringify(receipt), markdown, readFileSync(files.json, "utf8"), readFileSync(files.md, "utf8")]) {
    for (const banned of [SECRET, PROMPT, "Page with secret", "npm test", "DATABASE_URL", "sslmode", "?", "db/schema.sql", "expected 3", "const key", "found ", "Schema", "migrates", dir])
      assert.equal(text.includes(banned), false, banned)
  }
})

test("WT-RCP-05: the readable receipt says what it is: checked on this computer, not a guarantee, with its chain", () => {
  freshHome()
  const dir = project()
  ledger(dir)
  const { receipt, markdown } = makeReceipt(dir, "s1")
  assert.match(markdown, /^## Proof receipt \(checked on this computer\)\n\nWhat Kriya Harness checked by code on this computer, copied from its own records\. Evidence of what was checked, not a guarantee\./)
  assert.match(markdown, /\| Step \| Role \| Verdict \| Attempts \| Tiers \| Gates \|/)
  assert.ok(markdown.includes(`Chain: \`${receipt.chain}\` (verify with \`kriya receipt verify\`)`))
  assert.equal(receiptMarkdown(receipt), markdown)
  assert.equal(readFileSync(receiptFiles(receipt.project, "s1").md, "utf8"), `${markdown}\n`)
})

test("WT-RCP-06: kriya receipt make and verify, and a draft pull request that starts with the receipt", async () => {
  const home = freshHome()
  const dir = project()
  ledger(dir)
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "kriya.js"), "receipt", ...args], { cwd: dir, env: { ...ENV, KRIYA_HOME: home }, encoding: "utf8" })
  const made = cli("make")
  assert.equal(made.status, 0, made.stdout + made.stderr)
  const file = made.stdout.split("\n").find((l) => l.endsWith("s1.json"))
  assert.equal(cli("verify", file).status, 0)
  const p = readProgress(dir, "s1")
  p.runs[0].status = "fail"
  writeProgress(dir, "s1", p)
  const broken = cli("verify", file)
  assert.equal(broken.status, 1)
  assert.match(broken.stdout, /Run 1 .* the chain breaks at link 1/)
  // The PR body: the receipt first
  execFileSync("git", ["switch", "-q", "-c", "kriya/rcp"], { cwd: dir, env: ENV })
  writeFileSync(join(dir, "b.js"), "2\n")
  execFileSync("git", ["add", "b.js"], { cwd: dir, env: ENV })
  execFileSync("git", ["commit", "-q", "-m", "feat: b"], { cwd: dir, env: ENV })
  const base = runner({ env: ENV })
  let body
  const run = (f, args, cwd) => {
    if (f === "gh") {
      if (args.includes("--body-file")) body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8")
      const out = args[0] === "--version" ? "gh version 2.103.3" : args.includes("--help") ? "--body-file --draft" : args[0] === "auth" ? "ok" : "https://github.com/o/r/pull/9\n"
      return Promise.resolve({ code: 0, stdout: out, stderr: "" })
    }
    return base(f, args, cwd)
  }
  const tools = Object.fromEntries(repoTools({ cwd: async () => dir, approve: async () => true, readOnly: () => false, run, started: 0 }).map((t) => [t.name, t]))
  await tools.pr_create.execute({ title: "B", notes: "Adds b." }, { agent: { id: "s1" }, signal: new AbortController().signal })
  assert.match(body, /^## Proof receipt \(checked on this computer\)/)
  assert.match(body, /Chain: `sha256:[0-9a-f]{64}`[\s\S]*## Branch \(computed by Kriya Harness[\s\S]*## Agent's notes\n\nAdds b\.$/)
})
