// `npm run bench:m`: KriyaEditBench-M (EVALUATION_PLAN §1, §4). A scripted model and real FFmpeg,
// so it costs nothing and could fail. It runs each part as it stands, keeps the numbers those
// parts print, and writes them down. Exit 1 if any part fails. A run of this suite says what
// the harness does around a model, and says nothing about how good an edit is.

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..", "..", "..")

const PARTS = [
  { name: "Seeded defects, file and brief gates (EG-4)", files: ["tests/edit/media/seeded.test.js"], limit: 1_500_000 },
  { name: "Seeded defects, text and motion gates (EG-4)", files: ["tests/edit/media/seeded-text.test.js"], limit: 2_000_000 },
  { name: "Every job ends in a verdict; a change moves nothing else (F1, R1, R2)", files: ["tests/edit/bench-m/chaos.test.js"], limit: 1_700_000 },
  { name: "The independent grader against labels", files: ["tests/edit/media/grader.test.js"], limit: 300_000 },
  { name: "Jobs resume; plans compile the same; budgets hold; live chat keeps room (G1)", files: ["tests/edit-graph.test.js", "tests/edit-core-compile.test.js", "tests/edit-governor.test.js"], limit: 300_000 },
]

function runPart({ files, limit }) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", `--test-timeout=${limit}`, ...files], { cwd: ROOT, env: process.env })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("close", (code) => done({ code, out, seconds: Math.round((Date.now() - started) / 1000) }))
  })
}

// The lines a part prints on purpose, and the suite's own counts
const numbersIn = (out) => {
  const lines = out.split("\n")
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    if (/^(EG-4|BENCH-M|Grader against)/.test(lines[i])) {
      kept.push(lines[i])
      while (lines[i + 1] && !/^(✔|✖|ℹ|▶|EG-4|BENCH-M|Grader)/.test(lines[i + 1])) kept.push(lines[++i])
    }
  }
  return kept
}
const count = (out, word) => Number(new RegExp(`^ℹ ${word} (\\d+)`, "m").exec(out)?.[1] ?? 0)

const date = new Date().toISOString().slice(0, 10)
const report = [`# KriyaEditBench-M, ${date}`, "", `Node ${process.version}, ${process.platform}-${process.arch}. A scripted model on synthetic media: this says what the harness does around a model, not how good an edit is.`, ""]
let failed = 0
for (const part of PARTS) {
  process.stdout.write(`${part.name} ... `)
  const { code, out, seconds } = await runPart(part)
  process.stdout.write(`${code === 0 ? "pass" : "FAIL"} (${seconds} s)\n`)
  if (code !== 0) failed++
  report.push(`## ${part.name}`, "", `${code === 0 ? "Pass" : "**Fail**"}: ${count(out, "pass")} of ${count(out, "tests")} tests, ${seconds} s.`, "", ...(numbersIn(out).length ? ["```text", ...numbersIn(out), "```", ""] : []))
  if (code !== 0) report.push("```text", ...out.split("\n").filter((line) => /^✖|AssertionError/.test(line)).slice(0, 20), "```", "")
}
const dir = join(ROOT, "bench", "edit", "results")
mkdirSync(dir, { recursive: true })
const file = join(dir, `bench-m-${date}.md`)
writeFileSync(file, `${report.join("\n")}\n`)
console.log(`${failed ? `${failed} part(s) failed` : "All parts passed"}. Written to ${file}`)
process.exit(failed ? 1 : 0)
