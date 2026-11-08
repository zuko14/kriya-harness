import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { test } from "node:test"

import { bootstrap, bradleyTerry, costPerAccepted, passK, signTest, winRate } from "../bench/edit/analyze.js"
import { stripArgs } from "../bench/edit/blind.js"
import { checkCorpus, freezeHash, readGoAhead } from "../bench/edit/corpus.js"
import { checkTask, defectsPerMinute } from "../bench/edit/grade/index.js"
import { ROOT } from "./helpers.js"

// KriyaEditBench's method, before any run. The grader on real files is in
// tests/edit/media/grader.test.js.

const games = (arm, against, wins, losses, ties, task = (i) => `t${i}`) => [
  ...Array.from({ length: wins }, (_, i) => ({ task: task(i), a: arm, b: against, winner: arm })),
  ...Array.from({ length: losses }, (_, i) => ({ task: task(wins + i), a: arm, b: against, winner: against })),
  ...Array.from({ length: ties }, (_, i) => ({ task: task(wins + losses + i), a: arm, b: against, winner: null })),
]

test("§6's honest size: 72 comparisons, a standard error of 5.9 points, and about 61.5 % to exclude even", () => {
  const even = winRate(games("A1", "A2", 36, 36, 0), "A1", "A2")
  assert.equal(even.n, 72)
  assert.ok(Math.abs(even.se * 100 - 5.9) < 0.05, `${even.se}`)
  assert.equal(even.excludesEven, false)
  assert.equal(winRate(games("A1", "A2", 44, 28, 0), "A1", "A2").excludesEven, false, "61.1 % doesn't")
  assert.equal(winRate(games("A1", "A2", 45, 27, 0), "A1", "A2").excludesEven, true, "62.5 % does")
  assert.equal(winRate(games("A1", "A2", 0, 0, 72), "A1", "A2").rate, 0.5, "ties split")
  assert.equal(winRate([], "A1", "A2").rate, null, "no data, no number")
})

test("Bradley-Terry finds a known order, and its interval is repeatable", () => {
  const data = [...games("A", "B", 30, 10, 0), ...games("B", "C", 30, 10, 0), ...games("A", "C", 35, 5, 0)]
  const strength = bradleyTerry(data)
  assert.ok(strength.A > strength.B && strength.B > strength.C, JSON.stringify(strength))
  assert.ok(Math.abs(Object.values(strength).reduce((s, v) => s + v, 0) - 1) < 1e-9)
  const once = bootstrap(data, { samples: 50, seed: 7 })
  assert.deepEqual(once, bootstrap(data, { samples: 50, seed: 7 }), "seeded")
  assert.ok(once.A.lower <= strength.A && strength.A <= once.A.upper)
})

test("the sign test is exact, by task, and leaves ties out", () => {
  assert.deepEqual(signTest(games("A", "B", 10, 0, 0), "A", "B"), { n: 10, wins: 10, p: 2 / 1024 })
  assert.equal(signTest(games("A", "B", 5, 5, 0), "A", "B").p, 1)
  assert.equal(signTest(games("A", "B", 0, 0, 4), "A", "B").n, 0)
})

test("cost per accepted is integers, and never made up", () => {
  assert.deepEqual(costPerAccepted([{ costMicroUsd: 100, accepted: true }, { costMicroUsd: 300, accepted: false }]), { runs: 2, accepted: 1, spentMicroUsd: 400, perAcceptedMicroUsd: 400 })
  assert.equal(costPerAccepted([{ costMicroUsd: 100, accepted: false }]).perAcceptedMicroUsd, null)
  assert.throws(() => costPerAccepted([{ costMicroUsd: 1.5, accepted: true }]), /integers/)
  assert.equal(passK([{ task: "a", accepted: true }, { task: "a", accepted: true }, { task: "b", accepted: true }, { task: "b", accepted: false }]), 0.5)
  assert.equal(passK([]), null)
})

const CHECKED = { oracle: true, empty: false, lazy: false }

test("a corpus with no release, a link, or a pass list that can't fail is refused", () => {
  const good = { id: "t1", group: "talking_head", assets: [{ path: "a.mov", source: "own" }], list: {}, checked: CHECKED }
  assert.deepEqual(checkCorpus({ tasks: [good] }), [])
  assert.match(checkCorpus({ tasks: [{ ...good, assets: [{ path: "a.mov", source: "released" }] }] })[0], /no signed release/)
  assert.match(checkCorpus({ tasks: [{ ...good, assets: [{ path: "a.mov", source: "youtube" }] }] })[0], /neither shot/)
  assert.ok(checkCorpus({ tasks: [{ ...good, assets: [{ path: "https://x.example/a.mp4", source: "own" }] }] }).some((p) => /no scraped/.test(p)))
  assert.match(checkCorpus({ tasks: [{ ...good, checked: { oracle: true, empty: true, lazy: false } }] })[0], /hasn't been shown/)
  assert.match(checkCorpus({ tasks: [] })[0], /No tasks/)
  assert.ok(checkCorpus({ tasks: [good] }, { full: true }).some((p) => /talking_head: 1 of 6/.test(p)), "a full run needs §3's table")
})

test("EDD-35: without the owner's written go-ahead and a limit, a paid run refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-go-"))
  const file = (body) => {
    const path = join(dir, "go.json")
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  assert.throws(() => readGoAhead(undefined), /Nothing was run/)
  assert.throws(() => readGoAhead(file({ approvedBy: "agent", words: "yes", date: "2026-11-08", maxSpendMicroUsd: 1 })), /owner's words/)
  assert.throws(() => readGoAhead(file({ approvedBy: "owner", words: "yes", date: "2026-11-08" })), /no spending limit/)
  assert.equal(readGoAhead(file({ approvedBy: "owner", words: "Go, two tasks", date: "2026-11-08", maxSpendMicroUsd: 5_000_000 })).maxSpendMicroUsd, 5_000_000)
})

test("pre-registration freezes the method, and any change shows", () => {
  const plan = { tasks: ["t1"], arms: ["A1", "A2"], thresholds: { Q1: 0.55 }, raters: { editors: 3, viewers: 5 } }
  assert.match(freezeHash(plan), /^[0-9a-f]{64}$/)
  assert.notEqual(freezeHash(plan), freezeHash({ ...plan, thresholds: { Q1: 0.5 } }))
  assert.throws(() => freezeHash({ ...plan, raters: undefined }), /Pre-registration/)
})

test("the task check: wrong size or length fails; no transcript is not a pass", () => {
  const about = { facts: { duration: 40, width: 1080, height: 1920, video: "h264" }, defects: [{ kind: "black", at: 1 }] }
  const list = { width: 1080, height: 1920, seconds: 45, mustKeep: ["We built it"], mustCut: ["Sorry let me try"] }
  assert.deepEqual(checkTask(about, list), { pass: false, misses: [], notMeasured: ["speech"] })
  assert.equal(checkTask(about, list, "well we built it in a week").pass, true)
  assert.deepEqual(checkTask(about, list, "sorry, let me try! we built it").misses, ["must cut: Sorry let me try"])
  assert.match(checkTask({ ...about, facts: { ...about.facts, width: 1920, height: 1080 } }, list, "we built it").misses[0], /format/)
  assert.match(checkTask({ ...about, facts: { ...about.facts, duration: 90 } }, list, "we built it").misses[0], /length/)
  assert.equal(defectsPerMinute(about), 1.5)
})

test("§7: the grader and the blind package share no code with src/edit", () => {
  const importsOf = (file) => [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const target of importsOf(file)) if (target.startsWith(".")) walk(resolve(dirname(file), target))
  }
  const bench = join(ROOT, "bench", "edit")
  for (const start of [join(bench, "grade", "index.js"), join(bench, "blind.js"), join(bench, "analyze.js"), join(bench, "corpus.js")]) walk(start)
  for (const file of seen) assert.ok(relative(ROOT, file).startsWith(join("bench", "edit")), `${file} is outside the bench`)
  assert.ok(readdirSync(bench).includes("README.md"))
  assert.ok(stripArgs("a", "b").includes("-map_metadata"))
  assert.ok(!JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files.some((f) => f.startsWith("bench")), "not shipped to people")
})
