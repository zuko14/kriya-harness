import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { router } from "../plugins/router/index.js"
import { brief, classify, MAX_BRIEF, rankSkills, tokens } from "../src/intent.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The intent router (src/intent.js, plugins/router), IR-*: which skills of
// the live catalog and which tools a request points at, by code.

const CATALOG = [
  { name: "kriya-debug", description: "Use when something fails (a test, a build, a crash, wrong output): reproduce it, read the real error, fix the root cause." },
  { name: "systematic-debugging", description: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes" },
  { name: "kriya-browser-test", description: "Use when building or fixing a web app: run it locally and check it in the agent's browser." },
  { name: "kriya-plan", description: "Use for a task with several parts: split it into small steps with kriya_plan." },
  { name: "gst-invoices", description: "Indian GST invoices: rates, HSN codes, place of supply." },
  { name: "kriya-git", description: "Use when committing, branching or handing work over." },
  { name: "hidden-one", description: "Use for bugs.", invocation: { modelInvocable: false } },
]
const TOOLS = ["bash", "read", "grep", "glob", "edit", "write", "skill", "kriya_verify", "kriya_plan"]

test("IR-01: tokens drop stop words and simple endings", () => {
  assert.deepEqual(tokens("The tests are failing in checkout"), ["test", "fail", "checkout"])
  assert.deepEqual(tokens("dependencies"), ["dependency"])
  assert.deepEqual(tokens("debugging running called spelled"), ["debug", "run", "call", "spell"])
  assert.deepEqual(tokens(""), [])
})

test("IR-02: BM25 ranks the catalog by the request; names count; nothing matching is nothing", () => {
  const ranked = rankSkills("the checkout test fails with a TypeError, debug it", CATALOG).map((r) => r.name)
  assert.deepEqual(ranked.slice(0, 2).sort(), ["kriya-debug", "systematic-debugging"])
  assert.equal(rankSkills("the signup page button does nothing in the web app", CATALOG)[0].name, "kriya-browser-test")
  assert.equal(rankSkills("calculate GST on this invoice", CATALOG)[0].name, "gst-invoices")
  assert.deepEqual(rankSkills("zzz qqq", CATALOG), [])
  assert.deepEqual(rankSkills("anything", []), [])
})

test("IR-03: intent classes by whole words for short ones; at most two, strongest first", () => {
  assert.deepEqual(classify("The tests fail with an error").map((i) => i.id), ["fix", "test"])
  assert.deepEqual(classify("print the project name").map((i) => i.id), [], "pr isn't print, new isn't news")
  assert.deepEqual(classify("Review my PR").map((i) => i.id), ["review"])
  assert.deepEqual(classify("Make the login form's button work on the page").map((i) => i.id).sort(), ["build", "web"].sort())
})

test("IR-04: the brief names ranked skills and only tools the agent has; deterministic; capped", () => {
  const b = brief("The checkout test is failing with a TypeError", CATALOG, TOOLS)
  assert.match(b, /^Routing for this request/)
  assert.match(b, /Intent: fix a failure; tests\./)
  assert.match(b, /Skills likely to help: (kriya-debug|systematic-debugging), /)
  assert.doesNotMatch(b, /hidden-one/, "a skill the model can't invoke isn't named")
  assert.match(b, /Start with: kriya_verify \(reproduce the failure first\)/)
  assert.match(b, /Finish with kriya_verify/)
  assert.equal(b, brief("The checkout test is failing with a TypeError", CATALOG, TOOLS))
  // A web request without browser tools: no browser tool named
  const web = brief("the page layout is broken", CATALOG, TOOLS)
  assert.doesNotMatch(web, /browser_/)
  assert.match(brief("the page layout is broken", CATALOG, [...TOOLS, "browser_open", "browser_read"]), /browser_open \(open the running app\)/)
  assert.equal(brief("hello there", [], []), "")
  assert.ok(brief("x ".repeat(5000) + "fix the bug", CATALOG.concat(Array.from({ length: 50 }, (_, i) => ({ name: `fix-bug-${i}`, description: "fix bug ".repeat(30) }))), TOOLS).length <= MAX_BRIEF)
})

test("IR-05: the router keeps each agent's newest message from the person, never tool output", async () => {
  const agent = {}
  const r = router({ listSkills: async () => CATALOG, toolNames: () => TOOLS })
  assert.equal(r.text(agent), "")
  await r.onMessage({ agent, message: { source: { kind: "tool" }, content: [{ type: "text", text: "fix the crash" }] } })
  assert.equal(r.text(agent), "")
  await r.onMessage({ agent, message: { source: { kind: "user" }, content: [{ type: "text", text: "fix the crash in checkout" }] } })
  assert.match(r.text(agent), /kriya-debug/)
  // A catalog that can't be read leaves the tools part; no tool list leaves the skills part
  const noSkills = router({ listSkills: async () => Promise.reject(new Error("down")), toolNames: () => TOOLS })
  await noSkills.onMessage({ agent, message: { source: { kind: "user" }, content: [{ type: "text", text: "fix the failing test" }] } })
  assert.match(noSkills.text(agent), /Start with: kriya_verify/)
  assert.doesNotMatch(noSkills.text(agent), /Skills likely/)
  const noTools = router({ listSkills: async () => CATALOG, toolNames: () => { throw new Error("no tools") } })
  await noTools.onMessage({ agent, message: { source: { kind: "user" }, content: [{ type: "text", text: "fix the failing test" }] } })
  assert.match(noTools.text(agent), /Skills likely to help: /)
  assert.doesNotMatch(noTools.text(agent), /Start with/)
})

function kriya(args, cwd, home) {
  return new Promise((done) => {
    // A throwaway HOME too: ~/.agents/skills would otherwise bring this machine's skills into the catalog
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_ROUTER: "off", ...(home && { HOME: home }) } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

test("IR-RUN-01: kriya run --router puts the brief in the real prompt, from the real catalog; off, nothing", { timeout: 300_000 }, async () => {
  freshHome()
  // The project's own skills: a catalog this test controls
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-router-")))
  for (const [name, description] of [
    ["kriya-debug", "Use when something fails (a test, a build, a crash): reproduce it, read the real error, fix the root cause."],
    ["gst-invoices", "Indian GST invoices: rates, HSN codes and place of supply."],
  ]) {
    mkdirSync(join(dir, ".agents", "skills", name), { recursive: true })
    writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`)
  }
  const prompts = []
  const fake = await startFakeKriya({ approveAfter: 0, chat: (body) => (body.tools?.length && prompts.push(JSON.stringify(body.messages)), { content: "Done." }) })
  try {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "kriya-router-home-")))
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT, userHome)).code, 0)
    const on = await kriya(["run", "--router", "The checkout test is failing with a TypeError"], dir, userHome)
    assert.equal(on.code, 0, on.stderr.slice(-1200))
    const withRouter = prompts.at(-1)
    assert.match(withRouter, /Routing for this request/)
    assert.match(withRouter, /Skills likely to help: kriya-debug/)
    assert.doesNotMatch(withRouter, /Skills likely to help:[^.]*gst-invoices/)
    assert.match(withRouter, /Start with: kriya_verify/)
    const off = await kriya(["run", "The checkout test is failing with a TypeError"], dir, userHome)
    assert.equal(off.code, 0, off.stderr.slice(-1200))
    assert.doesNotMatch(prompts.at(-1), /Routing for this request/)
  } finally {
    await fake.close()
  }
})

test("IR-06: the brief names a way of working for the request's kind of work", () => {
  const tools = ["kriya_plan", "kriya_verify", "browser_open", "read", "bash", "grep"]
  assert.match(brief("The checkout page's layout looks wrong on phones", [], tools), /Way of working: render it, look at it/)
  assert.match(brief("Fix the failing date test", [], tools), /Way of working: reproduce/)
  assert.deepEqual(classify("Research and compare the retry libraries").map((i) => i.id)[0], "research")
  assert.deepEqual(classify("Analyze this csv of orders").map((i) => i.id)[0], "data")
  assert.match(brief("Research and compare the retry libraries", [], tools), /cross-check each claim/)
})

test("IR-07: a short one-line request isn't told to plan; a long one, or one with no kriya_plan, says nothing", () => {
  const tools = ["kriya_plan", "kriya_verify", "read"]
  assert.match(brief("Fix the failing date test", [], tools), /do it directly/)
  assert.doesNotMatch(brief(`Fix the failing date test. ${"Then more of it. ".repeat(20)}`, [], tools), /do it directly/)
  assert.doesNotMatch(brief("Fix the date test\nand the parser\nand the docs", [], tools), /do it directly/)
  assert.doesNotMatch(brief("Fix the failing date test", [], ["read"]), /do it directly/)
})
