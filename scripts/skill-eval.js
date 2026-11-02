import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Automatic skill selection, measured on the real client: each job runs as
// `kriya run --mode read --json` (nothing is changed) in an empty folder, and
// is graded on the skills the agent loaded with the `skill` tool before its
// first other action. Spends the signed-in account's Kriya allowance: run it
// only when the person agrees. Expects skills linked in the Kriya home
// (kriya skills link …); `good` names any skill that fits the job.
//
//   node scripts/skill-eval.js [--only id,id] [--out report.json]

export const CASES = [
  {
    id: "debug",
    job: "The checkout form submits twice when someone double-clicks Pay. Work out why that happens and how to fix it.",
    good: ["systematic-debugging", "agent-introspection-debugging", "click-path-audit"],
  },
  {
    id: "design-doc",
    job: "Write a short design document for adding a dark mode toggle to our settings page.",
    good: ["brainstorming", "writing-plans", "architecture-decision-records", "documentation-lookup", "intent-driven-development"],
  },
  {
    id: "plan",
    job: "Plan the steps to add a phone number column to a large users table in production without downtime.",
    // task-planning: a Kriya account skill (the agent's own, through the kriya bundle)
    good: ["writing-plans", "task-planning", "brainstorming", "intent-driven-development", "production-audit"],
  },
  {
    id: "tests-first",
    job: "I need a parseIndianDate(text) function. Write its tests first, then tell me what the implementation must do.",
    good: ["test-driven-development", "tdd-workflow"],
  },
  {
    id: "review",
    job: "Review this function and tell me what's wrong:\n\nfunction total(items) { let t = 0; for (var i = 0; i <= items.length; i++) t += items[i].price; return t }",
    good: ["ponytail-review", "requesting-code-review", "receiving-code-review", "security-review", "codehealth-mcp"],
  },
  {
    id: "security",
    job: "Check this Express route for security problems:\n\napp.get('/file', (req, res) => res.sendFile(__dirname + '/uploads/' + req.query.name))",
    good: ["security-review", "security-scan", "security-bounty-hunter", "agent-security-hardening"],
  },
  {
    id: "commit",
    job: "Write a commit message for this change: getUserName was renamed to displayName across five files, with the old name kept as an alias.",
    good: ["conventional-commit-review", "git-workflow"],
  },
  {
    // A control: nothing should be loaded for a plain question
    id: "trivial",
    job: "What is 17 times 23? Answer with just the number.",
    good: [],
  },
]

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")

function run(job) {
  const cwd = mkdtempSync(join(tmpdir(), "kriya-skill-eval-"))
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "run", "--mode", "read", "--json", job], {
      cwd,
      env: process.env,
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", () => {})
    const timer = setTimeout(() => child.kill("SIGKILL"), 8 * 60_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      const events = out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      done({ code, events })
    })
  })
}

/** Which skills were loaded, and whether that happened before any other tool. */
export function grade(testCase, events) {
  const calls = events.filter((e) => e.type === "tool_call")
  const loaded = calls.filter((c) => c.tool === "skill").map((c) => c.input?.name)
  const firstOther = calls.findIndex((c) => c.tool !== "skill")
  const lastSkill = calls.map((c) => c.tool).lastIndexOf("skill")
  const fits = loaded.filter((name) => testCase.good.includes(name))
  const pass = testCase.good.length === 0 ? loaded.length === 0 : fits.length > 0
  return {
    id: testCase.id,
    pass,
    loaded,
    fitting: fits,
    // Loaded before acting, as the catalog asks
    beforeActing: loaded.length === 0 || firstOther === -1 || lastSkill < firstOther,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null
  const results = []
  for (const testCase of CASES.filter((c) => !only || only.includes(c.id))) {
    const { code, events } = await run(testCase.job)
    const result = { ...grade(testCase, events), exit: code }
    results.push(result)
    console.log(`${result.pass ? "pass" : "FAIL"}  ${testCase.id.padEnd(12)} loaded: ${result.loaded.join(", ") || "none"}`)
  }
  const passed = results.filter((r) => r.pass).length
  console.log(`\n${passed}/${results.length} chose a fitting skill (or none for the control)`)
  if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n")
}
