import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { offeredProjects, runDaemon } from "../src/daemon.js"
import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { appContainerArgs, bwrapArgs, BWRAP_PATHS, confine, confinement, windowsRunner } from "../src/edit/engine/confine.js"
import { confined } from "../src/edit/engine/tool.js"
import { advertisedClips } from "../src/edit/host/clips.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { editHome, hostToken, socketPath, TOKEN_HEADER, tokenPath } from "../src/edit/host/paths.js"
import { sameSecret } from "../src/edit/host/server.js"
import { createTavi, orderIn, orderLine } from "../src/edit/host/tavi.js"
import { readDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"
import { indexOf, lengthOf } from "./edit/script.js"

// TP11 (CRAFT_UPGRADE §9, TOP_TIER_PLAN §4 TP11): the platforms half, proven by the arguments each sandbox
// gets on a computer that has it and the refusal on one that doesn't (no Linux or Windows machine ran this:
// EQ-11), the Host's per-launch token on its own channel, and the Tavi order half: the clips a computer
// advertises only after Kriya says taviOrder, an order resolved by code, an order card when it isn't sure.

const F = 705_600_000
const made = []
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/* ───────────────────────────── confinement per OS ───────────────────────────── */

test("Linux: bubblewrap when it's installed, a plain refusal when it isn't; never an open Chrome called confined (ES-05)", () => {
  assert.deepEqual(confinement("linux", (p) => p === "/usr/bin/bwrap"), { kind: "bwrap", path: "/usr/bin/bwrap" })
  assert.deepEqual(confinement("linux", (p) => p === "/usr/local/bin/bwrap"), { kind: "bwrap", path: "/usr/local/bin/bwrap" })
  const none = confinement("linux", () => false)
  assert.equal(none.kind, null)
  assert.match(none.missing, /bubblewrap/)
  assert.throws(() => confine("/opt/chrome", [], { read: [], write: [] }, none), (e) => e.reason === "no_confinement")
  assert.deepEqual(BWRAP_PATHS, ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"], "fixed places, never a PATH lookup")
})

test("Linux: bubblewrap's arguments unshare everything (the network too), bind the runtime read-only and the work folder read-write, die with the parent, and never bind /home or /Users", () => {
  const runtime = temp("kt-runtime-")
  const work = temp("kt-work-")
  const args = bwrapArgs({ read: [runtime], write: [work] }, (p) => ["/usr", "/lib", "/etc/fonts"].includes(p))
  for (const flag of ["--die-with-parent", "--new-session", "--unshare-all"]) assert.ok(args.includes(flag), flag)
  assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"])
  const pairs = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))
  assert.deepEqual(pairs("--ro-bind"), ["/usr", "/lib", "/etc/fonts", runtime])
  assert.deepEqual(pairs("--bind"), [work])
  assert.equal(args.includes("--share-net"), false, "no network of this computer's")
  assert.ok(!args.some((a) => a === "/home" || a === "/Users" || a === "/"), "no home and no root bound")
  assert.ok(args.includes("--tmpfs") && args[args.indexOf("--tmpfs") + 1] === "/tmp")
  const wrapped = confine("/opt/chrome/chrome", ["--headless"], { read: [runtime], write: [work] }, { kind: "bwrap", path: "/usr/bin/bwrap" })
  assert.equal(wrapped.command, "/usr/bin/bwrap")
  assert.deepEqual(wrapped.args.slice(-3), ["--", "/opt/chrome/chrome", "--headless"])
  assert.throws(() => bwrapArgs({ read: ["relative/path"], write: [] }), /no such file|plain absolute/i)
})

test("Windows: only a runner the Media Runtime ships and verified; none, and motion is refused, never run open", () => {
  assert.equal(confinement("win32", () => false, { runner: () => null }).kind, null)
  assert.match(confinement("win32", () => false, { runner: () => null }).missing, /AppContainer/)
  assert.deepEqual(confinement("win32", () => false, { runner: () => "C:\\kriya\\runner.exe" }), { kind: "appcontainer", path: "C:\\kriya\\runner.exe" })
  // The runner comes only from the active runtime's manifest, present on disk; no signed manifest has one yet
  const runtime = { dir: "/r", manifest: { platforms: { "win32-x64": { artifacts: [{ id: "appcontainer-runner", entry: "runner.exe" }] } } } }
  assert.equal(windowsRunner(runtime, (p) => p === join("/r", "appcontainer-runner", "runner.exe")), join("/r", "appcontainer-runner", "runner.exe"))
  assert.equal(windowsRunner(runtime, () => false), null)
  assert.equal(windowsRunner({ dir: "/r", manifest: { platforms: { "darwin-arm64": { artifacts: [] } } } }), null)
  assert.equal(windowsRunner(null), null)
  assert.deepEqual(appContainerArgs({ read: ["C:\\rt"], write: ["C:\\work"] }), ["--read", "C:\\rt", "--write", "C:\\work", "--network", "loopback", "--"])
  const wrapped = confine("C:\\chrome.exe", ["--headless"], { read: ["C:\\rt"], write: ["C:\\work"] }, { kind: "appcontainer", path: "C:\\runner.exe" })
  assert.deepEqual([wrapped.command, ...wrapped.args.slice(-2)], ["C:\\runner.exe", "C:\\chrome.exe", "--headless"])
  assert.throws(() => appContainerArgs({ read: ['C:\\a"b'], write: [] }), /plain absolute path/)
  // Any other system: refused
  assert.equal(confinement("freebsd", () => true).kind, null)
  assert.throws(() => confine("/x", [], { read: [], write: [] }, { kind: "something" }), (e) => e.reason === "no_confinement")
})

test("ES-03: FFmpeg and FFprobe without network: sandbox-exec on macOS, bubblewrap on Linux (refused without it), today's path on Windows", () => {
  const mac = confined("ffmpeg", ["-i", "a"], { platform: "darwin", exists: () => true })
  assert.equal(mac[0], "/usr/bin/sandbox-exec")
  const linux = confined("/usr/bin/ffprobe", ["x"], { platform: "linux", exists: (p) => p === "/usr/bin/bwrap" })
  assert.equal(linux[0], "/usr/bin/bwrap")
  assert.ok(linux[1].includes("--unshare-net") && linux[1].includes("--die-with-parent"))
  assert.deepEqual(linux[1].slice(-3), ["--", "/usr/bin/ffprobe", "x"])
  assert.throws(() => confined("ffmpeg", [], { platform: "linux", exists: () => false }), (e) => e.reason === "no_confinement")
  assert.deepEqual(confined("ffmpeg.exe", ["x"], { platform: "win32", exists: () => true }), ["ffmpeg.exe", ["x"]], "no runner yet: not wrapped, and not called confined")
  assert.deepEqual(confined("swiftc", ["x"], { platform: "linux", exists: () => false }), ["swiftc", ["x"]], "only the media tools")
})

/* ───────────────────────────── the Host's own channel ───────────────────────────── */

test("the Host's channel takes a command only with this launch's token: owner-only file, refused without it or with another, gone when it stops; the Studio's page is as it was", async () => {
  const home = temp("kt-token-")
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: home, KRIYA_EDIT_IDLE_MS: "60000" }
  const live = await ensureHost({ env, home })
  try {
    const token = hostToken(home)
    assert.match(token, /^[a-f0-9]{64}$/)
    assert.equal(statSync(tokenPath(home)).mode & 0o077, 0, "only its owner reads it")
    assert.deepEqual(Object.keys(await hostCall(home, "GET", "/internal/info")).sort(), ["busy", "pid", "port", "stamp"])
    const raw = (headers) =>
      new Promise((done, fail) => {
        const req = request({ socketPath: socketPath(home), method: "GET", path: "/internal/info", headers: { host: "kriya-edit", ...headers } }, (res) => (res.resume(), res.on("end", () => done(res.statusCode))))
        req.on("error", fail)
        req.end()
      })
    assert.equal(await raw({}), 401, "no token")
    assert.equal(await raw({ [TOKEN_HEADER]: "0".repeat(64) }), 401, "another token")
    assert.equal(await raw({ [TOKEN_HEADER]: token.slice(1) }), 401, "a shorter one")
    assert.equal(await raw({ [TOKEN_HEADER]: token }), 200)
    // The loopback page works as before: its own launch token and session cookie, no channel token
    const page = await fetch(`http://127.0.0.1:${live.port}/launch`)
    assert.equal(page.status, 200)
    assert.ok(sameSecret("abc", "abc") && !sameSecret("abc", "abd") && !sameSecret(undefined, "abc") && !sameSecret(["abc"], "abc"))
  } finally {
    await stopHost(home)
  }
  assert.equal(hostToken(home), null, "the token goes with the Host")
  // A new launch, a new token
  await ensureHost({ env, home })
  try {
    assert.match(hostToken(home), /^[a-f0-9]{64}$/)
  } finally {
    await stopHost(home)
  }
  assert.match(socketPath("C:\\Users\\a\\.kriya", "win32"), /^\\\\\.\\pipe\\kriya-edit-host-[0-9a-f]{16}$/)
})

/* ───────────────────────────── the Tavi order ───────────────────────────── */

const video = (id, seconds, path, more = {}) => ({ op: "add_asset", id, kind: "video", fingerprint: `f-${id}`, path, linked: true, rights: "own", facts: { width: 640, height: 360, hasAudio: true, duration: Math.round(seconds * F), vfr: false, fps: { n: 30, d: 1 } }, ...more })
function clips() {
  const base = apply(newProject({ id: "p", name: "Film" }), [video("a1", lengthOf(), "talk.mov"), video("a2", 5, "beach final.mov"), video("a3", 3, "outro.mov"), video("a7", 4, "beach walk.mov"), { op: "add_asset", id: "r1", kind: "reference", fingerprint: "f-r1", path: "ref.mov", linked: true, rights: "unknown", facts: { width: 640, height: 360, duration: 3 * F } }], { author: "code" })
  const labelled = apply(base.project, [{ op: "describe_asset", asset: "a3", label: "Outro" }], { author: "person" })
  assert.ok(labelled.applied, JSON.stringify(labelled.diagnostics))
  return { log: { current: labelled.project }, index: indexOf("a1") }
}

test("an order named by numbers and labels is resolved by code; one it can't settle offers each order; a brief that names no order is the reel it always was (ET-TP-REG-04)", async () => {
  const state = clips()
  const sure = await orderIn("Clip 3, then clip 1, as one reel", state)
  // TP2's rule, shared with the Studio: the clips named lead, in the order named; the others follow as added
  assert.deepEqual(sure.assembly.parts.filter((p) => ["story", "whole"].includes(p.use)).map((p) => p.asset).slice(0, 2), ["a3", "a1"])
  assert.match(orderLine(sure.assembly, state.log.current), /^Clip 3 \(Outro\), then clip 1/)
  const unsure = await orderIn("the beach clip, then clip 1", state)
  assert.equal(unsure.options.length, 2)
  assert.deepEqual(unsure.options.map((o) => o.label.split(", then ").slice(0, 2).join(", then ")).sort(), ["Clip 2, then clip 1", "Clip 4, then clip 1"])
  assert.ok(unsure.options.every((o) => !/beach|\.mov|talk/i.test(o.label)), "no file name ever leaves")
  // One file, or no clip named: nothing changes
  assert.equal(await orderIn("Cut last night into a 45 second reel", state), null)
  assert.equal(await orderIn("make clip 1 punchy", state), null)
  // A reference is never a clip, so it can't be ordered
  assert.equal(await orderIn("ref, then clip 1", state), null)
})

const DISPATCH = "11111111-1111-4111-8111-111111111111"
const JOB = "22222222-2222-4222-8222-222222222222"
const QUESTION = "44444444-4444-4444-8444-444444444444"
function taviWorld({ features = { assembly: true, taviOrder: true }, answer = () => ({ status: "answered", option: 1 }) } = {}) {
  const home = temp("kt-order-")
  const folder = join(home, "Raw footage")
  mkdirSync(folder)
  for (const name of ["talk.mov", "beach final.mov", "outro.mov", "beach walk.mov"]) writeFileSync(join(folder, name), "x")
  const state = { ...clips(), id: "p1", folder }
  const started = []
  const asked = []
  const posts = []
  const projects = {
    features: async () => features,
    list: () => [{ id: "p1", file: join(folder, "Film.kriya") }],
    get: async () => state,
    addAsset: async () => ({ id: "a1", kind: "video" }),
  }
  const jobs = { start: (_s, r) => (started.push(r), { id: "p1.1", status: "pending" }), cancel: () => true }
  const send = async (path, body) => {
    posts.push({ path, body })
    if (path.endsWith("/questions")) return (asked.push(body), { id: QUESTION, expiresAt: new Date().toISOString() })
    if (path.includes("/editing/questions/")) return answer()
    return null
  }
  const tavi = createTavi({ home, projects, jobs: () => jobs, tools: async () => ({ capabilities: {} }), log: () => {}, send, reportMs: 0, beatMs: 1e9, retryMs: 1e9 })
  return { home, folder, state, started, asked, posts, tavi, accept: (brief) => tavi.accept({ dispatch: DISPATCH, folder, job: JOB, brief, effort: "best" }) }
}
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((done) => setTimeout(done, 5))
  assert.ok(check(), "timed out")
}

test("a Tavi brief with a sure order starts the make with it; with an unsure one, an order card, and the make with the order picked", async () => {
  const sure = taviWorld()
  assert.deepEqual(await sure.accept("Clip 3, then clip 1, 45 seconds"), { accepted: true })
  assert.equal(sure.asked.length, 0)
  assert.equal(sure.started[0].kind, "make")
  assert.equal(sure.started[0].asset, undefined, "the make takes its first file from the order")
  assert.equal(sure.started[0].brief.targetDuration, 45 * F)
  assert.deepEqual(sure.started[0].brief.assembly.parts.filter((p) => ["story", "whole"].includes(p.use)).map((p) => p.asset).slice(0, 2), ["a3", "a1"])
  sure.tavi.close()

  const unsure = taviWorld()
  assert.deepEqual(await unsure.accept("the beach clip, then clip 1"), { accepted: true })
  await until(() => unsure.started.length)
  assert.equal(unsure.asked[0].kind, "order")
  assert.equal(unsure.asked[0].defaultOption, 0)
  assert.ok(unsure.asked[0].timeoutSeconds >= 30 && unsure.asked[0].timeoutSeconds <= 3600)
  assert.equal(unsure.asked[0].options.length, 2)
  const picked = unsure.started[0].brief.assembly.parts.find((p) => ["story", "whole"].includes(p.use)).asset
  assert.ok(unsure.asked[0].options[1].label.startsWith(`Clip ${{ a2: 2, a7: 4 }[picked]}, then clip 1`), "the second order, as the person tapped")
  unsure.tavi.close()
})

test("an order card: silence takes the default; a cancel while it waits ends the job canceled, with nothing started", async () => {
  const silent = taviWorld({ answer: () => ({ status: "defaulted", option: 0 }) })
  await silent.accept("the beach clip, then clip 1")
  await until(() => silent.started.length)
  const first = silent.started[0].brief.assembly.parts.find((p) => ["story", "whole"].includes(p.use)).asset
  assert.ok(silent.asked[0].options[0].label.startsWith(`Clip ${{ a2: 2, a7: 4 }[first]}, then clip 1`))
  silent.tavi.close()

  const waiting = taviWorld({ answer: () => ({ status: "open" }) })
  await waiting.accept("the beach clip, then clip 1")
  await until(() => waiting.asked.length)
  assert.equal(waiting.tavi.cancel({ dispatch: DISPATCH }), true)
  await until(() => waiting.posts.some((p) => p.path === `/dispatch/${DISPATCH}` && p.body.status === "canceled"))
  assert.equal(waiting.started.length, 0)
  waiting.tavi.close()
})

test("ET-TP-REG-04: without taviOrder or editing.assembly, and for a brief naming one file, the job is the one it always was; a stored storyboard is never read (EH-63)", async () => {
  for (const features of [{ assembly: true, taviOrder: false }, { assembly: false, taviOrder: true }, {}]) {
    const w = taviWorld({ features })
    w.state.log.current.storyboard = { parts: [{ asset: "a3", use: "whole" }, { asset: "a1", use: "story" }] }
    await w.accept("Clip 3, then clip 1")
    await until(() => w.started.length)
    assert.equal(w.started[0].brief.assembly, undefined, JSON.stringify(features))
    assert.equal(w.asked.some((a) => a.kind === "order"), false)
    w.tavi.close()
  }
  const one = taviWorld()
  await one.accept("Cut talk into a reel")
  assert.deepEqual(one.started[0], { kind: "make", asset: "a1", brief: { effort: "best" }, dispatch: DISPATCH, dispatchJob: JOB })
  one.tavi.close()
})

/* ───────────────────────────── the daemon's clips ───────────────────────────── */

test("the computer reads only numbers and the person's labels for its clips: no path, no file name, no reference", () => {
  const home = temp("kt-clips-")
  const folder = join(home, "Film")
  mkdirSync(folder)
  mkdirSync(editHome(home), { recursive: true })
  const project = clips().log.current
  writeFileSync(join(folder, "Film.kriya"), JSON.stringify(project))
  writeFileSync(join(editHome(home), "projects.json"), JSON.stringify([{ id: "p", name: "Film", file: join(folder, "Film.kriya") }]))
  assert.deepEqual(advertisedClips(folder, { home }), [{ n: 1 }, { n: 2 }, { n: 3, label: "Outro" }, { n: 4 }])
  assert.deepEqual(advertisedClips(join(home, "elsewhere"), { home }), [])
  writeFileSync(join(folder, "Film.kriya"), "{ not json")
  assert.deepEqual(advertisedClips(folder, { home }), [])
})

test("ET-DMN (rule 17): clips go in the hello only after Kriya said taviOrder, only with KRIYA_EDIT on and editing allowed", async () => {
  freshHome()
  const dir = temp("kt-daemon-")
  const fake = await startFakeKriya({ approveAfter: 0, editing: true })
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const editHost = { hand: async () => {}, cancel: async () => ({ known: false }) }
  const [project] = offeredProjects([dir])
  const clipsOf = async (folder) => (assert.equal(folder, project.path), [{ n: 1, label: "Intro" }, { n: 2 }])
  const asked = []
  const once = (taviOrder, over = {}) => runDaemon({ device: readDevice(), folders: [dir], once: true, log: () => {}, env: { KRIYA_EDIT: "on" }, allowEdit: true, editHost, clipsOf, featuresOf: async () => (asked.push(1), { taviOrder }), ...over })
  try {
    await once(false)
    assert.equal(fake.state.hello.projects[0].clips, undefined, "an older server, or the switch off: no new field")
    await once(true)
    assert.deepEqual(fake.state.hello.projects[0].clips, [{ n: 1, label: "Intro" }, { n: 2 }])
    asked.length = 0
    await once(true, { env: {} })
    assert.equal(fake.state.hello.projects[0].clips, undefined, "KRIYA_EDIT off")
    assert.equal(asked.length, 0, "and nothing asked")
    await once(true, { allowEdit: false })
    assert.equal(fake.state.hello.projects[0].clips, undefined, "editing not allowed on this computer")
  } finally {
    await fake.close()
  }
})
