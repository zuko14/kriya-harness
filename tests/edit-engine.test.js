import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { createEngine, guardPath } from "../src/edit/engine/index.js"
import { encoderFor, parseCapabilities } from "../src/edit/engine/capabilities.js"
import { fingerprint } from "../src/edit/engine/media.js"
import { EngineFailure, runTool } from "../src/edit/engine/tool.js"
import { openJournal } from "../src/edit/graph/journal.js"
import { makeProject, ms } from "./edit/fixture.js"

// The Engine's logic with fake tools: no FFmpeg, no media (those are in tests/edit/media/).

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "kriya-eng-")))

function tool(body) {
  const file = join(folder(), "tool")
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const failure = (check) => (error) => {
  assert.ok(error instanceof EngineFailure, String(error))
  check(error)
  return true
}

test("ET-ENG-07: a timeout, a hang and a crash each end as a typed failure", async () => {
  await assert.rejects(runTool(tool("sleep 30"), [], { timeoutMs: 100 }), failure((e) => assert.deepEqual([e.kind, e.reason], ["render", "timeout"])))
  await assert.rejects(runTool(tool("echo start >&2; sleep 30"), [], { timeoutMs: 60_000, stallMs: 150 }), failure((e) => assert.deepEqual([e.kind, e.reason], ["render", "hang"])))
  await assert.rejects(runTool(tool("kill -SEGV $$"), []), failure((e) => assert.deepEqual([e.kind, e.reason], ["render", "crash"])))
  await assert.rejects(runTool(tool("echo 'x: Invalid data found when processing input' >&2; exit 1"), []), failure((e) => assert.deepEqual([e.kind, e.reason], ["input", "unreadable"])))
  await assert.rejects(runTool(tool("echo 'No space left on device' >&2; exit 1"), []), failure((e) => assert.deepEqual([e.kind, e.reason], ["environment", "low_disk"])))
  await assert.rejects(runTool(tool("echo 'No such filter: zscale' >&2; exit 1"), []), failure((e) => assert.deepEqual([e.kind, e.reason], ["environment", "missing_feature"])))
  await assert.rejects(runTool(tool("echo oops >&2; exit 3"), []), failure((e) => assert.deepEqual([e.kind, e.reason], ["render", "failed"])))
  await assert.rejects(runTool("/no/such/tool", []), failure((e) => assert.deepEqual([e.kind, e.reason], ["environment", "missing_tool"])))
})

test("a progress line keeps a slow tool from counting as hung; a cancel kills it; a good run returns stdout", async () => {
  assert.equal((await runTool(tool("for i in 1 2 3 4; do echo p >&2; sleep 0.4; done; echo done"), [], { stallMs: 1000 })).trim(), "done")
  const stop = new AbortController()
  const running = runTool(tool("sleep 30"), [], { signal: stop.signal })
  stop.abort(new Error("cancelled"))
  await assert.rejects(running, /cancelled/)
})

test("ES-23: a tool never sees the device token, whatever the parent has", async () => {
  process.env.KRIYA_DEVICE_TOKEN = "secret-token"
  try {
    const out = await runTool(tool("env"), [])
    assert.equal(out.includes("secret-token"), false)
    assert.equal(out.includes("KRIYA_DEVICE_TOKEN"), false)
  } finally {
    delete process.env.KRIYA_DEVICE_TOKEN
  }
})

test("ET-ENG-03: a path outside the project's roots is refused, including through a symlink", () => {
  const root = folder()
  const outside = folder()
  writeFileSync(join(root, "in.mov"), "x")
  writeFileSync(join(outside, "secret.mov"), "x")
  symlinkSync(join(outside, "secret.mov"), join(root, "link.mov"))
  mkdirSync(join(root, "sub"))
  assert.equal(guardPath(join(root, "in.mov"), [root]), join(root, "in.mov"))
  const refused = failure((e) => assert.equal(e.reason, "outside_project"))
  assert.throws(() => guardPath(join(outside, "secret.mov"), [root]), refused)
  assert.throws(() => guardPath(join(root, "link.mov"), [root]), refused)
  assert.throws(() => guardPath(join(root, "sub", "..", "..", "x"), [root]), failure((e) => assert.ok(["outside_project", "missing_file"].includes(e.reason))))
  assert.throws(() => guardPath(join(root, "nope.mov"), [root]), failure((e) => assert.equal(e.reason, "missing_file")))
  // A sibling whose name starts the same isn't inside
  const twin = `${root}-twin`
  mkdirSync(twin)
  writeFileSync(join(twin, "a.mov"), "x")
  assert.throws(() => guardPath(join(twin, "a.mov"), [root]), refused)
})

function engineFor(over = {}) {
  const root = folder()
  const cache = join(root, "cache")
  const exports_ = join(root, "exports")
  writeFileSync(join(root, "a1.mov"), "x")
  const project = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: 0, to: ms(3000) }]).project
  const fixed = structuredClone(project)
  fixed.assets[0].path = "a1.mov"
  const engine = createEngine({ folder: root, roots: [root], cache, exports: exports_, journal: openJournal(":memory:"), toolVersion: "test", capabilities: { filters: new Set(), encoders: new Set(["libx264"]) }, ...over })
  engine.load(fixed, {})
  return { engine, root, cache, project: fixed }
}

test("ET-ENG-09: low disk stops cleanly before writing anything, and the same job resumes with room", async () => {
  let free = 1000
  const { engine, cache } = engineFor({ free: () => free, run: async () => assert.fail("no tool may run") })
  await assert.rejects(engine.render({ quality: "draft" }), failure((e) => {
    assert.deepEqual([e.kind, e.reason], ["environment", "low_disk"])
    assert.match(e.message, /GB free/)
  }))
  assert.equal(existsSync(join(cache, "segments")) && readdirSync(join(cache, "segments")).length > 0, false)
  free = 1e12
  await assert.rejects(engine.render({ quality: "draft" }), /no tool may run/, "with room it goes on to work")
})

test("a source that vanished, or one outside the roots, fails before any tool runs", async () => {
  const { engine, project, root } = engineFor({ run: async () => assert.fail("no tool may run"), free: () => 1e12 })
  const moved = structuredClone(project)
  moved.assets[0].path = "/etc/hosts"
  engine.load(moved, {})
  await assert.rejects(engine.render({ quality: "master" }), failure((e) => assert.equal(e.reason, "outside_project")))
  moved.assets[0].path = join(root, "gone.mov")
  engine.load(moved, {})
  await assert.rejects(engine.render({ quality: "master" }), failure((e) => assert.equal(e.reason, "missing_file")))
})

test("an output can never be a source: the engine refuses to write over one", async () => {
  const { engine, root } = engineFor({ run: async () => "", free: () => 1e12 })
  assert.throws(() => engine.checkOutput(join(root, "a1.mov")), failure((e) => assert.equal(e.reason, "would_overwrite_source")))
  engine.checkOutput(join(root, "cache", "x.mp4"))
})

test("a killed Host's leftovers: its half files are swept, and a new Host never writes to the same name", async () => {
  const root = folder()
  const cache = join(root, "cache")
  mkdirSync(join(cache, "segments"), { recursive: true })
  writeFileSync(join(cache, "segments", "abc.123.part.mp4"), "half")
  writeFileSync(join(cache, "segments", "abc.mp4"), "whole")
  createEngine({ folder: root, roots: [root], cache, exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "t", capabilities: { filters: new Set(), encoders: new Set(["libx264"]) } })
  assert.deepEqual(readdirSync(join(cache, "segments")), ["abc.mp4"])

  const seen = []
  const { engine } = engineFor({ free: () => 1e12, run: async (_, args) => (seen.push(args.at(-1)), assert.fail("stop")) })
  await assert.rejects(engine.render({ quality: "draft" }))
  assert.ok(seen.every((output) => output.includes(`.${process.pid}.part.`)), "an orphaned FFmpeg keeps its own file; this process writes another")
})

test("capabilities: read from FFmpeg's own lists; encoders picked per use; a missing filter is refused early", () => {
  const caps = parseCapabilities(" T.. trim  V->V  x\n .S. lut3d V->V y\n", " V....D h264_videotoolbox  x\n V....D libx264  y\n")
  assert.ok(caps.filters.has("lut3d"))
  assert.equal(caps.filters.has("drawtext"), false)
  assert.equal(encoderFor(caps, "draft")[1], "h264_videotoolbox", "hardware for drafts")
  assert.equal(encoderFor(caps, "master")[1], "libx264", "quality first for masters")
  const software = { filters: new Set(), encoders: new Set(["libx264"]) }
  assert.equal(encoderFor(software, "draft")[1], "libx264")
  assert.throws(() => encoderFor({ filters: new Set(), encoders: new Set() }, "draft"), failure((e) => assert.equal(e.reason, "missing_feature")))
})

test("a burned caption on an FFmpeg with no drawtext fails plainly, before rendering", async () => {
  const { engine, project } = engineFor({ free: () => 1e12, run: async () => assert.fail("no tool may run") })
  const index = { words: [{ asset: "a1", id: "a1:w0", start: ms(100), end: ms(500), text: "hi" }] }
  const burned = apply(project, [{ op: "set_look", caption: { burn: true } }, { op: "caption_style", look: "bold", words: ["a1:w0"] }], { index }).project
  engine.load(burned, index)
  await assert.rejects(engine.render({ quality: "draft" }), failure((e) => {
    assert.deepEqual([e.kind, e.reason], ["environment", "missing_feature"])
    assert.match(e.message, /drawtext/)
  }))
})

test("fingerprint: reads samples, not the whole file, and sees a change", async () => {
  const dir = folder()
  const file = join(dir, "big.bin")
  writeFileSync(file, Buffer.alloc(5_000_000, 1))
  const first = await fingerprint(file)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(await fingerprint(file), first)
  const changed = Buffer.alloc(5_000_000, 1)
  changed[0] = 2
  writeFileSync(file, changed)
  assert.notEqual(await fingerprint(file), first)
})
