#!/usr/bin/env node
// Does the traced blast radius find the tests that catch a real bug? In a
// throwaway copy of a real project (never one you work in): each mutant is a
// small bug put into one file; the tests chosen by direct imports, then by the
// blast radius, run with vitest; the file goes back. Also reads recent commits
// through the sentinel and the diff review, to count findings on code people
// already accepted. No model. node scripts/bench-radius.js --repo <copy> --mutants <file.json> [--commits 40] --out <file.json>
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { affectedTests, blastRadius, importGraph } from "../src/recon.js"
import { reviewDiff, sentinel } from "../src/sentinel.js"

const { values } = parseArgs({ options: { repo: { type: "string" }, mutants: { type: "string" }, commits: { type: "string", default: "40" }, out: { type: "string" } } })
const root = values.repo
const report = { mutants: [], commits: [] }

const vitest = (tests) => {
  if (!tests.length) return { caught: false, ms: 0 }
  const started = Date.now()
  const run = spawnSync("npx", ["--no-install", "vitest", "run", ...tests], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 300_000 })
  return { caught: run.status !== 0, ms: Date.now() - started }
}

for (const m of JSON.parse(readFileSync(values.mutants, "utf8"))) {
  const file = join(root, m.file)
  const before = readFileSync(file, "utf8")
  if (before.split(m.find).length !== 2) throw new Error(`${m.file}: "${m.find}" isn't there exactly once`)
  const after = before.replace(m.find, m.replace)
  writeFileSync(file, after)
  try {
    const near = affectedTests(root, [m.file])
    const radius = blastRadius(importGraph(root), [{ rel: m.file, before, after }])
    const a = vitest(near)
    const b = vitest(radius.tests)
    const row = { id: m.id, file: m.file, nearTests: near.length, nearCaught: a.caught, nearMs: a.ms, radiusTests: radius.tests.length, radiusCaught: b.caught, radiusMs: b.ms, reached: radius.direct.length + radius.transitive.length, cut: radius.cut }
    report.mutants.push(row)
    console.error(JSON.stringify(row))
  } finally {
    writeFileSync(file, before)
  }
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 })
const show = (ref, rel) => {
  try {
    return git("show", `${ref}:${rel}`)
  } catch {
    return null
  }
}
const graph = importGraph(root)
const tenancy = graph.files.some((rel) => /\bwithUser\(/.test(graph.text(rel)))
for (const sha of git("log", "--no-merges", `-${values.commits}`, "--format=%h").trim().split("\n")) {
  const files = git("show", "--name-only", "--format=", sha).trim().split("\n").filter(Boolean)
  const diffs = files.map((rel) => ({ rel, before: show(`${sha}^`, rel), after: show(sha, rel) }))
  const invariants = sentinel(diffs, { tenancy })
  const hazards = reviewDiff(graph, diffs)
  report.commits.push({ sha, files: files.length, invariants: invariants.map((f) => `${f.file}:${f.line} ${f.rule}`), hazards: hazards.map((h) => `${h.file}${h.line ? `:${h.line}` : ""} ${h.hazard}: ${h.why}`) })
}
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
const hit = report.commits.filter((c) => c.invariants.length || c.hazards.length)
console.log(JSON.stringify({ mutants: report.mutants.length, nearCaught: report.mutants.filter((m) => m.nearCaught).length, radiusCaught: report.mutants.filter((m) => m.radiusCaught).length, commits: report.commits.length, commitsFlagged: hit.length, invariants: report.commits.reduce((n, c) => n + c.invariants.length, 0), hazards: report.commits.reduce((n, c) => n + c.hazards.length, 0) }))
