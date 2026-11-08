import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { cutsOf, verdictOf } from "../src/edit/gates/index.js"
import { compare, rankOf, search, STOPS } from "../src/edit/loop/loop.js"
import { makeReel, planVerdict, rebase } from "../src/edit/loop/make.js"
import { REEL_TALKING_HEAD } from "../src/edit/recipes/reel.js"
import { ROOT } from "./helpers.js"
import { indexOf, lengthOf } from "./edit/script.js"

// The Edit Loop's search and its F0 rung, with scripted attempts; the real render
// and gates run in tests/edit/media/reel.test.js.

const FLICKS = 705_600_000
const v = (blocking, briefMisses = 0, notes = 0, quality = 0) => ({ blocking, briefMisses, notes, quality })

test("ρ is lexicographic: a blocking failure outweighs any number of notes, quality only breaks ties", () => {
  assert.ok(compare(rankOf(v(0, 3, 9, 0)), rankOf(v(1))) < 0)
  assert.ok(compare(rankOf(v(0, 0, 1, 0.9)), rankOf(v(0, 1, 0, 1))) < 0)
  assert.ok(compare(rankOf(v(0, 0, 0, 0.8)), rankOf(v(0, 0, 0, 0.7))) < 0, "higher quality is better")
  assert.equal(compare(rankOf(v(0)), rankOf(v(0))), 0)
})

test("ET-LOOP-01: at every point there is a valid best version, and stopping returns it", async () => {
  const controller = new AbortController()
  const seen = []
  const attempts = [v(2), v(1, 1), v(0, 1), v(0, 0, 1)]
  let i = 0
  const result = await search({
    start: { name: "head" },
    evaluate: async (c) => {
      if (c.name === "head") return v(3)
      if (c.name === "a2") controller.abort() // the person interrupts mid-run
      return attempts[i++]
    },
    propose: async (_, round) => [{ name: `a${round * 2 - 1}` }, { name: `a${round * 2}` }],
    onBest: (best) => seen.push(best.candidate.name),
    signal: controller.signal,
  })
  assert.equal(result.stop, STOPS.interrupted)
  assert.equal(result.best.candidate.name, "a2", "the best so far, which was itself the last thing evaluated")
  assert.deepEqual(seen, ["head", "a1", "a2"], "a best existed from the very start")
})

test("ET-LOOP-02: a worse attempt is never accepted, and stays in history", async () => {
  const scores = { head: v(1), a: v(0, 0, 2), b: v(0, 0, 3), c: v(1), d: v(0, 0, 2, 0.5) }
  const result = await search({
    start: { name: "head" },
    evaluate: async (c) => scores[c.name],
    propose: async (_, round) => (round === 1 ? [{ name: "a" }, { name: "b" }, { name: "c" }] : round === 2 ? [{ name: "d" }] : []),
    patience: 5,
    floor: 0.4, // so "a" alone isn't good enough to stop on
  })
  assert.equal(result.best.candidate.name, "d")
  const record = Object.fromEntries(result.history.map((h) => [h.candidate.name, h.accepted]))
  assert.deepEqual(record, { head: true, a: true, b: false, c: false, d: true })
  assert.ok(result.history.every((h, i) => i === 0 || !h.accepted || compare(h.rank, result.history.slice(0, i).filter((x) => x.accepted).at(-1).rank) < 0), "each acceptance strictly improved")
})

test("ET-LOOP-03: every stop condition ends the loop within its bounds", async () => {
  const flat = { evaluate: async () => v(1), propose: async () => [{}] }
  assert.equal((await search({ start: {}, ...flat, patience: 2, rounds: 9 })).stop, STOPS.stalled)
  assert.equal((await search({ start: {}, evaluate: async () => v(0, 0, 0, 1), propose: async () => [] })).stop, STOPS.satisfied)
  assert.equal((await search({ start: {}, evaluate: async () => v(0, 0, 3), propose: async () => [], effort: "fast", floor: 2 })).stop, STOPS.fast)
  assert.equal((await search({ start: {}, ...flat, budget: { left: () => 0 } })).stop, STOPS.budget)
  let rounds = 0
  const capped = await search({ start: {}, evaluate: async () => v(9 - rounds), propose: async () => (rounds++, [{}]), rounds: 3, patience: 9 })
  assert.equal(capped.stop, STOPS.exhausted)
  assert.equal(rounds, 3, "never more than its rounds")
  const failing = await search({ start: {}, evaluate: async (c) => (c.bad ? Promise.reject(new Error("render failed")) : v(1)), propose: async () => [{ bad: true }], patience: 1 })
  assert.equal(failing.history[1].accepted, false, "a failed attempt is recorded, not accepted")
})

function rawProject() {
  const seconds = lengthOf()
  const made = apply(newProject({ id: "p", name: "Pricing" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f", path: "take.mov", linked: true, rights: "unknown", facts: { width: 640, height: 360, hasAudio: true, duration: Math.round(seconds * FLICKS), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } } }], { author: "code" })
  assert.ok(made.applied)
  return made.project
}

test("ET-LOOP-04: an attempt that fails at F0 renders nothing", async () => {
  const index = indexOf()
  let renders = 0
  const ask = async ({ fallback }) => ({ value: fallback(), source: "default", calls: 0 })
  // A brief no cut of this footage can meet: F0 sees it from the plan alone
  const result = await makeReel({ project: rawProject(), head: null, index, asset: "a1", brief: { targetDuration: 300 * FLICKS }, ask, render: async () => (renders++, assert.fail("no render")), sourcePath: () => "/nope" })
  assert.equal(renders, 0)
  assert.ok(result.outcome.history.slice(1).every((h) => h.verdict.level === "F0" && h.verdict.briefMisses > 0))
  const verdict = planVerdict(result.outcome.history[1].candidate.project, index, REEL_TALKING_HEAD)
  assert.equal(verdict.briefMisses, 1)
})

test("ET-LOOP-07: rebase keeps the person's edit and drops only what conflicts with it, listed", () => {
  const index = indexOf()
  let project = rawProject()
  project = apply(project, [{ op: "keep_range", asset: "a1", from: 0, to: 4 * FLICKS }, { op: "keep_range", asset: "a1", from: 5 * FLICKS, to: 8 * FLICKS }], { index, author: "person" }).project
  const agent = [{ op: "punch_in", at: 1 * FLICKS, duration: FLICKS / 2, scale: 1.2 }, { op: "ripple_delete", clip: "c2" }]
  // Meanwhile the person deleted c2 themselves
  const theirs = apply(project, [{ op: "ripple_delete", clip: "c2" }], { index, author: "person" }).project
  const { ops, dropped } = rebase(theirs, agent, index)
  assert.deepEqual(ops, [agent[0]])
  assert.equal(dropped.length, 1)
  assert.match(dropped[0].reason, /c2/)
  assert.equal(apply(theirs, ops, { index, author: "agent" }).project.sequences[0].clips.filter((c) => c.source).length, 1, "the person's deletion stands")
})

test("gate verdicts: words from results only; a gate that couldn't run is never a pass", () => {
  const r = (id, status, severity = "block") => ({ id, status, severity })
  assert.equal(verdictOf([r("QG-01", "passed"), r("QG-02", "passed")]).verdict, "delivered")
  assert.equal(verdictOf([r("QG-01", "passed"), r("QG-03", "not_checked")]).verdict, "delivered_with_notes")
  assert.equal(verdictOf([r("QG-01", "failed"), r("QG-02", "passed")]).verdict, "blocked")
  assert.equal(verdictOf([r("QG-03", "not_checked")]).verdict, "not_checked")
  const misses = verdictOf([{ ...r("QG-12", "failed"), misses: [{}, {}] }])
  assert.deepEqual([misses.blocking, misses.briefMisses], [0, 2], "brief misses rank on their own")
  assert.deepEqual(cutsOf([{ asset: "a1", in: 0, out: 10, at: 0, end: 10 }, { asset: "a1", in: 10, out: 20, at: 10, end: 20 }, { asset: "a1", in: 30, out: 40, at: 20, end: 30 }]).map((c) => c.at), [20], "a continuous join isn't a cut")
})

test("the Edit Loop shares nothing with the coding loop (EDIT_LOOP §1)", () => {
  const IMPORT = /\b(?:import|export)\s[^"'`]*?from\s*["'`]([^"'`]+)|\bimport\s*\(\s*["'`]([^"'`]+)/g
  for (const dir of ["loop", "director", "recipes", "gates"]) {
    for (const name of readdirSync(join(ROOT, "src", "edit", dir))) {
      for (const match of readFileSync(join(ROOT, "src", "edit", dir, name), "utf8").matchAll(IMPORT)) {
        const target = match[1] ?? match[2]
        assert.doesNotMatch(target, /\.\.\/\.\.\/(loop|verify|checkpoints|failure|world|daemon)\.js$/, `${dir}/${name} imports ${target}`)
      }
    }
  }
  for (const file of ["loop.js", "verify.js", "checkpoints.js"]) assert.doesNotMatch(readFileSync(join(ROOT, "src", file), "utf8"), /src\/edit|\.\/edit\//, `${file} reaches src/edit`)
})
