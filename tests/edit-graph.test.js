import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createGraph, Interrupted } from "../src/edit/graph/index.js"
import { openJournal } from "../src/edit/graph/journal.js"
import { createScheduler } from "../src/edit/graph/scheduler.js"
import { ROOT } from "./helpers.js"

// The graph runtime (EDIT_LOOP §4): demand-driven, verifying traces, early
// cutoff. Nodes here do arithmetic, so what ran is the whole story.

function counting(nodes) {
  const runs = {}
  const wrapped = {}
  for (const [name, node] of Object.entries(nodes)) {
    wrapped[name] = {
      version: 1,
      ...node,
      run: async (ctx) => {
        runs[name] = (runs[name] ?? 0) + 1
        return node.run(ctx)
      },
    }
  }
  return { runs, nodes: wrapped, clear: () => Object.keys(runs).forEach((key) => delete runs[key]) }
}

const graphOf = (nodes, options = {}) => createGraph({ journal: openJournal(":memory:"), nodes, ...options })

// EDIT_LOOP §4's shape: a timeline feeding picture, audio and caption plans
const pipeline = () =>
  counting({
    timeline: { run: async ({ input }) => ({ cuts: await input("cuts") }) },
    picture: { run: async ({ need }) => ({ picture: (await need("timeline")).cuts }) },
    audio: { run: async ({ need }) => ({ audio: (await need("timeline")).cuts }) },
    captions: { run: async ({ need, input }) => ({ cuts: (await need("timeline")).cuts, colour: await input("colour") }) },
    segment: { run: async ({ need }) => ({ segment: await need("picture") }) },
    mix: { run: async ({ need }) => ({ mix: await need("audio") }) },
    tile: { run: async ({ need }) => ({ tile: await need("captions") }) },
    deliverable: { run: async ({ need }) => [await need("segment"), await need("mix"), await need("tile")] },
  })

test("demand-driven: nothing runs until asked, and only what's needed", async () => {
  const p = pipeline()
  const graph = graphOf(p.nodes)
  graph.set("cuts", [1, 2])
  graph.set("colour", "white")
  assert.deepEqual(p.runs, {})
  await graph.demand("segment")
  assert.deepEqual(Object.keys(p.runs).sort(), ["picture", "segment", "timeline"])
})

test("ET-GR-01: change one input, and exactly the dependent nodes re-run", async () => {
  const p = pipeline()
  const graph = graphOf(p.nodes)
  graph.set("cuts", [1, 2])
  graph.set("colour", "white")
  await graph.demand("deliverable")
  assert.equal(Object.keys(p.runs).length, 8)

  p.clear()
  await graph.demand("deliverable")
  assert.deepEqual(p.runs, {}, "nothing changed, nothing ran")

  graph.set("cuts", [1, 2, 3])
  await graph.demand("deliverable")
  assert.equal(Object.keys(p.runs).length, 8)
  assert.ok(Object.values(p.runs).every((count) => count === 1), "each once, however many paths lead to it")
})

test("ET-GR-03: a caption colour change re-runs no picture or audio node", async () => {
  const p = pipeline()
  const graph = graphOf(p.nodes)
  graph.set("cuts", [1, 2])
  graph.set("colour", "white")
  await graph.demand("deliverable")
  p.clear()
  graph.set("colour", "yellow")
  const result = await graph.demand("deliverable")
  assert.deepEqual(Object.keys(p.runs).sort(), ["captions", "deliverable", "tile"])
  assert.equal(result[2].tile.colour, "yellow")
})

test("ET-GR-02: early cutoff: an unchanged output stops downstream work", async () => {
  const p = counting({
    rounded: { run: async ({ input }) => Math.round(await input("n")) },
    doubled: { run: async ({ need }) => (await need("rounded")) * 2 },
  })
  const graph = graphOf(p.nodes)
  graph.set("n", 1.2)
  await graph.demand("doubled")
  p.clear()
  graph.set("n", 1.4)
  assert.equal(await graph.demand("doubled"), 2)
  assert.deepEqual(p.runs, { rounded: 1 }, "rounded re-ran, its hash held, doubled didn't")
})

test("setting an input to an equal value changes nothing, whatever its key order", async () => {
  const p = counting({ a: { run: async ({ input }) => (await input("v")).x } })
  const graph = graphOf(p.nodes)
  graph.set("v", { x: 1, y: 2 })
  await graph.demand("a")
  p.clear()
  graph.set("v", { y: 2, x: 1 })
  await graph.demand("a")
  assert.deepEqual(p.runs, {})
})

test("keys: one node, many instances, each with its own trace", async () => {
  const p = counting({ square: { run: async ({ key, input }) => Number(key) ** 2 + (await input("base")) } })
  const graph = graphOf(p.nodes)
  graph.set("base", 0)
  assert.equal(await graph.demand("square", "3"), 9)
  assert.equal(await graph.demand("square", "4"), 16)
  assert.equal(p.runs.square, 2)
  await graph.demand("square", "3")
  assert.equal(p.runs.square, 2)
})

test("dynamic dependencies: a node that stops reading an input stops depending on it", async () => {
  const p = counting({ pick: { run: async ({ input }) => ((await input("left")) ? await input("a") : await input("b")) } })
  const graph = graphOf(p.nodes)
  graph.set("left", true)
  graph.set("a", 1)
  graph.set("b", 2)
  await graph.demand("pick")
  p.clear()
  graph.set("b", 3)
  await graph.demand("pick")
  assert.deepEqual(p.runs, {}, "b wasn't read")
})

test("two demands at once share one run; a failed node is retried by the next demand, and leaves no trace", async () => {
  let release
  const gate = new Promise((done) => (release = done))
  const p = counting({
    slow: { run: async () => (await gate, 7) },
    flaky: {
      run: async ({ input }) => {
        if (await input("broken")) throw new Error("boom")
        return 1
      },
    },
  })
  const graph = graphOf(p.nodes)
  const both = Promise.all([graph.demand("slow"), graph.demand("slow")])
  release()
  assert.deepEqual(await both, [7, 7])
  assert.equal(p.runs.slow, 1)

  graph.set("broken", true)
  await assert.rejects(graph.demand("flaky"), /boom/)
  graph.set("broken", false)
  assert.equal(await graph.demand("flaky"), 1)
})

test("a cycle is refused, not a hang", async () => {
  const graph = graphOf({
    a: { version: 1, run: async ({ need }) => need("b") },
    b: { version: 1, run: async ({ need }) => need("a") },
  })
  await assert.rejects(graph.demand("a"), /cycle/i)
})

test("an output whose file was evicted is rebuilt", async () => {
  let there = true
  const p = counting({ file: { valid: () => there, run: async () => "cache/x" } })
  const graph = graphOf(p.nodes)
  await graph.demand("file")
  await graph.demand("file")
  assert.equal(p.runs.file, 1)
  there = false
  graph.touch()
  await graph.demand("file")
  assert.equal(p.runs.file, 2)
})

test("ET-GR-06: traces survive a restart, and a version bump only when the node's version matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kriya-graph-"))
  const file = join(dir, "journal.sqlite")
  const start = (version) => {
    const journal = openJournal(file)
    const p = counting({ base: { run: async () => 1 }, top: { version, run: async ({ need }) => (await need("base")) + 1 } })
    return { journal, p, graph: createGraph({ journal, nodes: p.nodes }) }
  }
  const first = start(1)
  await first.graph.demand("top")
  first.journal.close()

  const same = start(1)
  await same.graph.demand("top")
  assert.deepEqual(same.p.runs, {}, "a restart redoes nothing")
  same.journal.close()

  const bumped = start(2)
  await bumped.graph.demand("top")
  assert.deepEqual(bumped.p.runs, { top: 1 }, "only the node whose version moved")
  bumped.journal.close()
})

function child(file, log, mode) {
  return spawn(process.execPath, [join(ROOT, "tests", "edit", "graph-crash-child.js"), file, log, mode], { stdio: ["ignore", "pipe", "inherit"] })
}

test("ET-GR-04: kill mid-run, and a restart redoes no completed node", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kriya-graph-"))
  const [file, log] = [join(dir, "journal.sqlite"), join(dir, "ran.log")]
  const victim = child(file, log, "hang")
  await new Promise((done) => {
    const timer = setInterval(() => {
      if (existsSync(log) && readFileSync(log, "utf8").includes("c")) {
        clearInterval(timer)
        done()
      }
    }, 20)
  })
  const exit = new Promise((done) => victim.on("exit", done))
  victim.kill("SIGKILL")
  await exit

  const journal = openJournal(file)
  assert.deepEqual(journal.steps().map((s) => [s.id, s.status]).sort(), [["a", "done"], ["b", "done"], ["c", "pending"]], "running became pending on restart")
  journal.close()

  const again = child(file, log, "finish")
  let out = ""
  again.stdout.on("data", (d) => (out += d))
  await new Promise((done) => again.on("exit", done))
  assert.equal(out.trim(), "3")
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["a", "b", "c", "c"], "a and b ran once; only the killed node ran again")
})

test("journal: steps, jobs and measurements are recorded, and a step's failure is kept", async () => {
  const journal = openJournal(":memory:")
  const id = journal.addJob({ kind: "render", projectVersion: "v1" })
  const graph = createGraph({ journal, nodes: { ok: { version: 1, resources: ["cpu"], run: async () => 1 }, bad: { version: 1, run: async () => Promise.reject(new Error("no")) } } })
  await graph.demand("ok", "", { job: id })
  await assert.rejects(graph.demand("bad", "", { job: id }))
  const steps = journal.steps(id)
  assert.equal(steps.find((s) => s.id === "ok").status, "done")
  assert.equal(steps.find((s) => s.id === "ok").resources, "cpu")
  assert.equal(steps.find((s) => s.id === "bad").status, "failed")
  assert.match(steps.find((s) => s.id === "bad").log, /no/)
  journal.setJob(id, { status: "done", progress: 100 })
  assert.equal(journal.job(id).status, "done")
  journal.measure(id, { gate: "QG-05", key: "gap", value: 0 })
  assert.equal(journal.measurements(id).length, 1)
})

const tick = () => new Promise((done) => setImmediate(done))

test("the scheduler: a slot is held once, and FIFO shares a slot between two jobs", async () => {
  const scheduler = createScheduler({ encoder: 1 })
  const order = []
  const work = async (name) => {
    const release = await scheduler.acquire(["encoder"])
    order.push(name)
    await tick()
    release()
  }
  // Two jobs of three steps each, queued as they'd arrive
  const job = async (name) => {
    for (let i = 0; i < 3; i++) await work(`${name}${i}`)
  }
  await Promise.all([job("a"), job("b")])
  assert.deepEqual(order, ["a0", "b0", "a1", "b1", "a2", "b2"], "neither starves")
})

test("ET-ENG-06's core: a long job queued first can't starve a short one", async () => {
  const scheduler = createScheduler({ encoder: 1 })
  const order = []
  const step = async (owner, name) => {
    const release = await scheduler.acquire(["encoder"], { owner })
    order.push(name)
    await tick()
    release()
  }
  // The long job queues all its work at once, before the short job asks
  await Promise.all([step("long", "L0"), step("long", "L1"), step("long", "L2"), step("long", "L3"), step("short", "S0"), step("short", "S1")])
  assert.deepEqual(order, ["L0", "S0", "L1", "S1", "L2", "L3"])
})

test("the scheduler: several resources are taken together or not at all, so no deadlock", async () => {
  const scheduler = createScheduler({ cpu: 1, disk: 1 })
  const one = await scheduler.acquire(["cpu"])
  let got = false
  const both = scheduler.acquire(["cpu", "disk"]).then((release) => ((got = true), release))
  const other = await scheduler.acquire(["disk"])
  await tick()
  assert.equal(got, false)
  other()
  one()
  ;(await both)()
  assert.equal(scheduler.busy("cpu"), 0)
})

test("ET-GR-05: demand beats speculation: real work pre-empts it", async () => {
  const seen = []
  const nodes = {
    ahead: {
      version: 1,
      resources: ["encoder"],
      run: ({ signal, key }) =>
        new Promise((done, fail) => {
          seen.push(`start ${key}`)
          signal.addEventListener("abort", () => fail(signal.reason))
          if (key === "fast") done("ok")
        }),
    },
    now: { version: 1, resources: ["encoder"], run: async () => (seen.push("now"), "real") },
  }
  const graph = graphOf(nodes, { slots: { encoder: 1 } })
  const speculative = graph.demand("ahead", "slow", { speculate: true })
  await tick()
  await tick()
  assert.equal(await graph.demand("now"), "real")
  await assert.rejects(speculative, (error) => error instanceof Interrupted)
  assert.deepEqual(seen, ["start slow", "now"])

  // Interrupted work leaves no trace, so demand can do it properly later
  assert.equal(await graph.demand("ahead", "fast"), "ok")
})

test("ET-GR-05: speculation never spends model tokens, and waits behind real work", async () => {
  let called = 0
  const graph = graphOf(
    {
      ask: { version: 1, resources: ["model"], run: async () => (called++, "answer") },
      wrapper: { version: 1, run: async ({ need }) => need("ask") },
      real: { version: 1, resources: ["cpu"], run: async () => "real" },
      spare: { version: 1, resources: ["cpu"], run: async () => "spare" },
    },
    { slots: { cpu: 1, model: 2 } },
  )
  await assert.rejects(graph.demand("ask", "", { speculate: true }), (error) => error instanceof Interrupted)
  await assert.rejects(graph.demand("wrapper", "", { speculate: true }), (error) => error instanceof Interrupted, "not through another node either")
  assert.equal(called, 0)
  assert.equal(await graph.demand("ask"), "answer")
})
