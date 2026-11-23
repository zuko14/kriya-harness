import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import vm from "node:vm"

import { answer, handlers, ledgers, ROUTES, spendTracker } from "../plugins/runstrip/index.js"
import { checkpoint, listCheckpoints, trackedRoot } from "../src/checkpoints.js"
import { saveMilestones } from "../src/milestones.js"
import { SWITCHES } from "../src/modes.js"
import { LINKED } from "../src/profiles.js"
import { CHIP_STATES, chipOf, formatElapsed, formatInr, missionRows, stepChips, stripState, TRACKS, TRACK_ORDER } from "../src/runstrip.js"
import { projectRoot } from "../src/skill-switches.js"
import { readProgress, writeProgress } from "../src/verify.js"
import { freshHome, ROOT } from "./helpers.js"

// Harness 2.0 W18 (WD-23), WT-UX-*: the Run strip, gate chips, the four
// tracks and Mission Control. Everything shown is computed from the ledger
// (never model text); idle costs 0 px; chips never shift the layout; every
// target is 44 px; the old tab ids keep working.

/* ─────────────────────────── a tiny React ─────────────────────────── */

const over = { poll: undefined, bool: undefined }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: "f",
  useState: (v) => {
    const init = typeof v === "function" ? v() : v
    if (init && typeof init === "object" && "data" in init && over.poll) return [over.poll, () => {}]
    if (typeof init === "boolean" && over.bool !== undefined) return [over.bool, () => {}]
    return [init, () => {}]
  },
  useEffect: () => {},
  useCallback: (f) => f,
  useRef: () => ({}),
}
/** Renders function components and returns the element tree. */
const render = (node) => {
  if (Array.isArray(node)) return node.map(render)
  if (!node || typeof node !== "object") return node
  if (typeof node.type === "function") return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}
const text = (node) => (node === null || node === undefined || node === false ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node.children))
const all = (node, pred, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => all(n, pred, out))
  else if (node && typeof node === "object") {
    if (pred(node)) out.push(node)
    all(node.children, pred, out)
  }
  return out
}
const byClass = (tree, cls) => all(tree, (n) => String(n.props?.className ?? "").split(" ").includes(cls))

function loadClient(plugin) {
  let spec
  const context = { window: { __ModuleLoader__: { load: (s) => (spec = s) } }, URL, URLSearchParams, globalThis: {} }
  context.globalThis = context
  vm.runInNewContext(readFileSync(join(ROOT, "plugins", plugin, "client.js"), "utf8"), context)
  return { spec, context, exports: spec.factory((name) => (name === "react" ? react : assert.fail(`unexpected require ${name}`))) }
}
const strip = loadClient("runstrip")
const C = strip.exports

/* ─────────────────────────── records ─────────────────────────── */

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-ux-")))
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "a.js"), "1\n")
  git("add", ".")
  git("commit", "-qm", "base")
  return dir
}

const PLAN = { goal: "Orders", at: "2026-11-23T10:00:00.000Z", steps: [{ title: "Orders API", doneWhen: "tests pass", files: ["a.js"] }, { title: "Orders page", doneWhen: "page renders", files: ["b.js"] }] }
const RUNS = [
  { at: "2026-11-23T10:01:00.000Z", step: "1 Orders API", status: "fail", exitCode: 1, kind: "test", durationMs: 2000, gates: [{ id: "G-SECRETS", status: "pass" }, { id: "G-UI", status: "fail", reason: "overflow at 390 px" }] },
  { at: "2026-11-23T10:03:00.000Z", step: "1 Orders API", status: "fail", exitCode: 1, kind: "type", durationMs: 1000, gates: [{ id: "G-SECRETS", status: "pass" }, { id: "G-UI", status: "not_checked", reason: "no dev server" }] },
]
const BUILDERS = [
  { step: "1 Orders API", stopReason: "completed", steps: 5, ms: 60_000, tier: "budget", summary: "MODEL SAYS ALL GREEN" },
  { step: "1 Orders API", stopReason: "completed", steps: 7, ms: 90_000, tier: "budget", summary: "MODEL SAYS ALL GREEN" },
]
const LIVE = { n: 1, attempt: 3, startedAt: Date.parse("2026-11-23T10:04:00.000Z"), steps: 2, tier: "escalation", last: "MODEL SAYS DONE" }
const NOW = Date.parse("2026-11-23T10:10:00.000Z")
const ORCH = { head: "escalation", worker: "budget" }

/* ─────────────────────────── tests ─────────────────────────── */

test("WT-UX-01: a gate chip has five states, each with its words; colour is never alone", () => {
  assert.deepEqual([...CHIP_STATES], ["waiting", "running", "passed", "failed", "not-checked"])
  const cases = [
    [{ id: "G-UI" }, "waiting", "UI · waiting"],
    [{ id: "G-UI", status: "running" }, "running", "UI · checking"],
    [{ id: "G-UI", status: "pass" }, "passed", "UI · passed"],
    [{ id: "G-UI", status: "fail", reason: "overflow at   390 px" }, "failed", "UI · failed: overflow at 390 px"],
    [{ id: "G-UI", status: "not_checked", reason: "no dev server" }, "not-checked", "UI · not checked: no dev server"],
  ]
  for (const [gate, state, words] of cases) {
    const chip = chipOf(gate)
    assert.equal(chip.state, state)
    assert.equal(chip.text, words)
    const el = render(react.createElement(C.GateChip, { chip }))
    assert.equal(el.props["data-state"], state)
    assert.equal(el.props["aria-label"], words, "the words are the accessible name")
    assert.match(text(el), new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  // A recorded result during a rebuild waits to be re-checked
  assert.equal(chipOf({ id: "G-UI", status: "pass" }, { pending: true }).state, "waiting")
})

test("WT-UX-02: chip state changes never move the layout: width and height are reserved, only colours change", () => {
  const rules = [...C.CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body])
  const base = rules.find(([sel]) => sel === ".kh-chip")[1]
  assert.match(base, /width: 14\.5em/, "room for the longest state label, \"SECRETS · not checked\"")
  assert.match(base, /height: 28px/)
  assert.match(base, /box-sizing: border-box/)
  assert.match(base, /text-overflow: ellipsis/)
  assert.match(base, /transition: background-color \.16s/)
  const states = rules.filter(([sel]) => sel.includes("[data-state="))
  assert.equal(new Set(states.map(([sel]) => /data-state="([^"]+)"/.exec(sel)[1])).size, 4, "four states restyle the waiting base")
  for (const [sel, body] of states)
    for (const prop of ["width", "height", "padding", "margin", "font-size", "border-width", "border:", "line-height"]) assert.ok(!new RegExp(`(^|[;\\s])${prop}`).test(body), `${sel} must not set ${prop}`)
  // The stitch stops under reduced motion
  assert.match(C.CSS, /prefers-reduced-motion: reduce\)[^@]*\.kh-chip\[data-state="running"\] \{ animation: none; \}/)
})

test("WT-UX-03: the Run strip is 0 px when idle and 44 px (240 open) while a task runs", () => {
  assert.deepEqual(stripState({ sessionId: "s", progress: { runs: [], plan: PLAN } }), { running: false })
  assert.deepEqual(stripState({ sessionId: "s", progress: { runs: [] }, live: LIVE }), { running: false }, "no plan, nothing to show")
  over.poll = { data: { runs: [] }, error: null }
  const idle = render(react.createElement(C.Strip))
  assert.equal(idle.props.className, "kh-sr", "idle: only the visually hidden live region")
  assert.match(C.CSS, /\.kh-sr \{ position: absolute; width: 1px; height: 1px; overflow: hidden;/)
  assert.match(C.CSS, /\.kh-rs \{ box-sizing: border-box; height: 44px; overflow: hidden;/)
  assert.match(C.CSS, /\.kh-rs\[data-open="true"\] \{ height: 240px; \}/)
  over.poll = undefined
})

test("WT-UX-04: the strip's fields come from the ledger only, in reading order", () => {
  const progress = { plan: PLAN, runs: RUNS, builders: BUILDERS }
  const s = stripState({ sessionId: "s1", progress, live: LIVE, ledger: { milestones: [{ status: "done" }, { status: "active", title: "M2" }, { status: "todo" }] }, orchestra: ORCH, names: { escalation: "Head Model X" }, since: Date.parse("2026-11-23T10:00:30.000Z"), spend: { inr: "₹4.20", estimated: false }, now: NOW })
  assert.deepEqual(s.milestone, { n: 2, of: 3 })
  assert.deepEqual(s.step, { n: 1, of: 2, title: "Orders API" })
  assert.deepEqual(s.attempt, { n: 3, of: 4 })
  assert.deepEqual(s.tier, { level: "Head", model: "Head Model X" })
  assert.deepEqual(s.gates.map((g) => [g.id, g.state]), [["G-SECRETS", "waiting"], ["G-UI", "waiting"]])
  assert.equal(formatElapsed(s.elapsedMs), "9m")
  assert.deepEqual(s.attempts.map((a) => [a.n, a.tier, a.outcome]), [[1, "Worker", "test"], [2, "Worker", "type"], [3, "Head", "building"]])
  assert.equal(s.attempts[1].gates[1].text, "UI · not checked: no dev server")
  assert.ok(!JSON.stringify(s).includes("MODEL SAYS"), "no model text reaches the strip")
  // Rendered, left to right: milestone, step, attempt, tier (model on hover), chips, elapsed, spend, Stop
  over.poll = { data: { runs: [s] }, error: null }
  const tree = render(react.createElement(C.Strip))
  const row = text(byClass(tree, "kh-rs-row")[0])
  const order = ["Milestone 2/3", "Step 1", "Orders API", "try 3/4", "Head", "SECRETS · waiting", "UI · waiting", "9m", "₹4.20", "Stop"].map((t) => row.indexOf(t))
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `reading order: ${row}`)
  assert.equal(byClass(tree, "kh-rs-tier")[0].props.title, "Head Model X")
  // Expanded (click or ⌥↑): one row per attempt
  over.bool = true
  const open = render(react.createElement(C.Strip))
  assert.equal(byClass(open, "kh-rs-at").length, 3)
  over.bool = undefined
  over.poll = undefined
})

test("WT-UX-05: spend is the /me difference since the task began, read once per builder; integers to the display", async () => {
  assert.equal(formatInr(4_200_000), "₹4.20")
  assert.equal(formatInr(0), "₹0.00")
  assert.equal(formatInr(1_234_567_891), "₹1234.57")
  const reads = []
  let used = 10_000_000
  const t = spendTracker({ account: async () => (reads.push(used), { harness: { usedMicroInr: used, unpriced: 0 } }) })
  const live = { startedAt: 1 }
  assert.equal(t.get("s", "p1", live).spend, null, "nothing until the first figure arrives")
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 5; i++) t.get("s", "p1", live)
  assert.equal(reads.length, 1, "one read per builder, however often the strip polls")
  used = 14_200_000
  t.get("s", "p1", { startedAt: 2 })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(t.get("s", "p1", { startedAt: 2 }), { since: 1, spend: { inr: "₹4.20", estimated: false } })
  assert.equal(reads.length, 2)
})

test("WT-UX-06: Stop is DSH's own user cancel (queued messages kept), only for a running session", async () => {
  const cancels = []
  const r = handlers({ folderOf: async () => undefined, running: () => [], cancel: (id) => (cancels.push(id), id === "s1"), account: async () => null, liveOf: (id) => (id === "s1" || id === "s2" ? LIVE : undefined) })
  const post = (body, type = "application/json") => new Request(`http://127.0.0.1${ROUTES.stop}`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) })
  assert.deepEqual(await (await answer(r.stop, post({ session: "s1" }))).json(), { stopped: true })
  assert.equal((await answer(r.stop, post({ session: "s3" }))).status, 400, "nothing running there")
  assert.equal((await answer(r.stop, post({ session: "../x" }))).status, 400)
  assert.equal((await answer(r.stop, post({ session: "s1" }, "text/plain"))).status, 400)
  assert.equal((await answer(r.stop, post({ session: "s2" }))).status, 400, "not live here")
  assert.deepEqual(cancels, ["s1", "s2"])
  // The node half calls exactly the composer's stop
  const src = readFileSync(join(ROOT, "plugins", "runstrip", "index.js"), "utf8")
  assert.match(src, /agent\.cancel\(\{ kind: "user" \}, \{ keepInbox: true \}\)/)
})

test("WT-UX-07: four tracks in a fixed order with the old tab ids kept; off, the tabs read as before", () => {
  assert.deepEqual(TRACK_ORDER, ["live", "proof", "changes", "project"])
  assert.deepEqual(TRACKS, { live: "kriya-preview", proof: "kriya-progress", changes: "kriya-changes", project: "kriya-overview" })
  assert.equal(JSON.stringify(C.TRACKS.map(([k, kind]) => [k, kind])), JSON.stringify(Object.entries(TRACKS)), "the browser half names the same kinds")
  const tabs = { preview: ["Preview", 7, "Live", 1], progress: ["Progress", 6, "Proof", 2], changes: ["Changes", 15, "Changes", 3], overview: ["Overview", 5, "Project", 4] }
  for (const [plugin, [before, order, after, place]] of Object.entries(tabs)) {
    const { exports, context } = loadClient(plugin)
    assert.equal(exports.definition.kind, `kriya-${plugin}`, "the tab's id is unchanged")
    assert.equal(exports.definition.title(), before)
    assert.equal(exports.definition.guide[0].order, order)
    context.__kriyaTracks = C.extras
    assert.equal(exports.definition.title(), after)
    assert.equal(exports.definition.guide[0].title(), after)
    assert.equal(exports.definition.guide[0].order, place)
  }
  // The switch defaults off; the plugin's row is off without it and outside the Web UI
  assert.deepEqual(SWITCHES.find(([f]) => f === "runstrip"), ["runstrip", "KRIYA_RUNSTRIP", false])
  assert.ok(LINKED["@kriya-ai/harness-runstrip"].endsWith(join("plugins", "runstrip")))
  for (const profile of ["kriya", "kriya-run", "kriya-acp"])
    assert.match(readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8"), /- id: kriya-runstrip\n {2}name: '@kriya-ai\/harness-runstrip'\n {2}disabled: !!js >-\n {4}process\.env\.KRIYA_RUNSTRIP !== 'on'/)
  // Applying the strip sets the seam and removes it on unload
  const disposers = []
  const ctx = { effect: (fn) => disposers.push(fn()), slots: { inject: (_n, fn) => fn(), register: () => {} } }
  strip.exports.apply(ctx)
  assert.equal(strip.context.__kriyaTracks, C.extras)
  disposers.forEach((d) => typeof d === "function" && d())
  assert.equal(strip.context.__kriyaTracks, undefined)
})

test("WT-UX-08: each track's section has loading, error, empty, partial and populated states", () => {
  const show = (Comp, poll, props = {}) => {
    over.poll = poll
    const out = text(render(react.createElement(Comp, { sessionId: "s1", viewport: null, setViewport: () => {}, ...props })))
    over.poll = undefined
    return out
  }
  const err = { data: null, error: "Kriya Harness isn't answering; is it still running?" }
  for (const Comp of [C.LiveExtra, C.ProofExtra, C.ChangesExtra, C.ProjectExtra, C.MissionsPage]) {
    assert.match(show(Comp, undefined), /Loading…/, `${Comp.name} loading`)
    assert.match(show(Comp, err), /isn't answering/, `${Comp.name} error`)
  }
  // Empty
  assert.match(show(C.ProofExtra, { data: { steps: [], release: null, receipt: null }, error: null }), /No plan yet\. Ask for something with more than one step/)
  assert.match(show(C.ChangesExtra, { data: { points: [] }, error: null }), /No checkpoints yet/)
  assert.match(show(C.LiveExtra, { data: { gates: [] }, error: null }), /No page gate has run/)
  assert.match(show(C.MissionsPage, { data: { signedIn: true, account: null, missions: [] }, error: null }), /No missions yet/)
  assert.match(show(C.ProjectExtra, { data: { repo: { state: "not a repository", text: "Not under version control." }, matrix: [], mcp: [] }, error: null }), /not a repository.*Not under version control.*None offered/s)
  // Partial: steps but no release check and no receipt
  const partial = show(C.ProofExtra, { data: { steps: [{ n: 1, chips: [chipOf({ id: "G-UI", status: "pass" })] }], release: null, receipt: null }, error: null })
  assert.match(partial, /UI · passed.*Not checked: no release check has run.*No receipt yet/s)
  // Populated
  const full = show(C.ProofExtra, { data: { steps: [{ n: 1, chips: [] }], release: { commit: "abc123", ready: true, lines: [{ id: "build", status: "pass" }] }, receipt: { verdict: "verified", runs: 3, commit: "abc123", chain: `sha256:${"a".repeat(64)}`, markdown: "# Receipt" } }, error: null })
  assert.match(full, /Ready at abc123.*build.*pass.*Verdict verified · 3 runs.*Copy.*Verify/s)
  assert.match(show(C.LiveExtra, { data: { gates: [chipOf({ id: "G-UI", status: "fail", reason: "overflow at 390 px" })] }, error: null }), /Fit.*360.*390.*1440.*UI · failed: overflow at 390 px/s)
  assert.match(show(C.ChangesExtra, { data: { points: [{ commit: "c1", at: "2026-11-23T10:00:00.000Z", label: "before step 1", verdict: "fail" }, { commit: "c2", at: "2026-11-23T10:05:00.000Z", label: "before step 2", verdict: null }] }, error: null }), /Time · 2 points.*before step 2.*not checked.*Restore this point/s)
  assert.match(show(C.ProjectExtra, { data: { repo: { state: "remote, gh signed out", text: "The person runs `gh auth login`." }, matrix: [{ gate: "G-UI", works: false, needs: "Google Chrome" }], mcp: [{ id: "m", name: "Docs" }] }, error: null }), /remote, gh signed out.*gh auth login.*Docs.*G-UI.*needs Google Chrome/s)
  assert.match(show(C.MissionsPage, { data: { signedIn: true, account: { used: "₹12.00", cap: "₹500.00", estimated: false }, missions: [{ root: "/p", project: "p", done: 1, of: 3, status: "blocked", current: { n: 2, title: "Orders" }, waiting: "You: milestone 2 is blocked; see its Proof track." }] }, error: null }), /₹12\.00 of ₹500\.00 this month.*1\/3 milestones · blocked.*Milestone 2: Orders.*Waiting for: You: milestone 2 is blocked/s)
})

test("WT-UX-09: the time scrubber lists this session's checkpoints and restores one, saving the present first", async () => {
  freshHome()
  const dir = project()
  writeProgress(projectRoot(dir), "s1", { version: 1, root: projectRoot(dir), sessionId: "s1", plan: PLAN, runs: [] })
  await checkpoint(dir, "s1", "before step 1")
  writeFileSync(join(dir, "a.js"), "2\n")
  await checkpoint(dir, "s1", "before step 2")
  await checkpoint(dir, "other", "someone else")
  writeFileSync(join(dir, "a.js"), "3\n")
  let live
  const r = handlers({ folderOf: async (id) => (id === "s1" ? dir : undefined), running: () => [], cancel: () => false, account: async () => null, liveOf: () => live })
  const get = (part) => new Request(`http://127.0.0.1${ROUTES.track}?session=s1&part=${part}`)
  const { points } = await (await answer(r.track, get("changes"))).json()
  assert.deepEqual(points.map((p) => p.label), ["before step 1", "before step 2"], "oldest first, this session's only")
  const post = (commit) => new Request(`http://127.0.0.1${ROUTES.restore}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: "s1", commit }) })
  const other = (await listCheckpoints((await trackedRoot(dir)).root)).find((c) => c.session === "other")
  assert.equal((await answer(r.restore, post(other.commit))).status, 400, "another session's point is refused")
  live = LIVE
  assert.equal((await answer(r.restore, post(points[0].commit))).status, 400, "not while a step runs")
  live = undefined
  const done = await (await answer(r.restore, post(points[0].commit))).json()
  assert.equal(done.restored, "before step 1")
  assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "1\n")
  assert.ok((await listCheckpoints((await trackedRoot(dir)).root)).some((c) => c.kind === "undone"), "the present was saved first")
})

test("WT-UX-10: Proof, Live, Project and Mission Control read the records, the repository state and the ledger", async () => {
  freshHome()
  const dir = project()
  const root = projectRoot(dir)
  writeProgress(root, "s1", { version: 1, root, sessionId: "s1", plan: PLAN, runs: RUNS })
  await saveMilestones(root, [{ title: "API", done_when: "a" }, { title: "Page", done_when: "b" }])
  const r = handlers({
    folderOf: async (id) => (id === "s1" ? dir : undefined),
    running: () => ["s1"],
    cancel: () => false,
    account: async () => ({ plan: "Pro", harness: { usedMicroInr: 12_000_000, capMicroInr: 500_000_000, unpriced: 0 } }),
    liveOf: (id) => (id === "s1" ? LIVE : undefined),
    repoOf: () => ({ status: async () => ({ state: "no remote", text: "Not connected to a remote." }) }),
    matrix: async () => [{ gate: "G-UI", works: true }],
    mcp: async () => [{ id: "docs", name: "Docs" }],
    now: () => NOW,
    env: { KRIYA_LOOP: "on", KRIYA_ORCHESTRA: "on", KRIYA_ALLOWED_TIERS: "budget,escalation", KRIYA_ORCHESTRA_HEAD: "escalation", KRIYA_ORCHESTRA_WORKER: "budget", KRIYA_MODEL_NAMES: JSON.stringify({ escalation: "gemini-4-neon", budget: "DeepSeek V4.1 Flash" }), KRIYA_GATES: "on" },
  })
  const get = (part) => answer(r.track, new Request(`http://127.0.0.1${ROUTES.track}?session=s1&part=${part}`)).then((x) => x.json())
  const proof = await get("proof")
  assert.deepEqual(proof.steps, stepChips(readProgress(root, "s1")))
  assert.deepEqual(proof.steps[0].chips.map((c) => c.state), ["passed", "not-checked"])
  assert.equal(proof.release, null)
  assert.equal(proof.receipt, null)
  assert.deepEqual((await get("live")).gates.map((g) => g.text), ["UI · not checked: no dev server"])
  const shown = await get("project")
  assert.deepEqual({ ...shown, workforce: undefined }, { repo: { state: "no remote", text: "Not connected to a remote." }, matrix: [{ gate: "G-UI", works: true }], mcp: [{ id: "docs", name: "Docs" }], workforce: undefined })
  // What this harness runs with: the owner's head and worker by name, and each switch
  assert.deepEqual(shown.workforce.orchestra, { head: "escalation", worker: "budget", headName: "gemini-4-neon", workerName: "DeepSeek V4.1 Flash" })
  assert.deepEqual(shown.workforce.switches.filter((x) => x.on).map((x) => x.flag), ["loop", "orchestra", "gates"])
  assert.equal((await answer(r.track, new Request(`http://127.0.0.1${ROUTES.track}?session=s1&part=nope`))).status, 400)
  // The strip route: every running session, from its records
  const { runs } = await (await answer(r.strip, new Request(`http://127.0.0.1${ROUTES.strip}`))).json()
  assert.equal(runs.length, 1)
  assert.deepEqual([runs[0].milestone, runs[0].step.n, runs[0].attempt.n], [{ n: 1, of: 2 }, 1, 3])
  // Mission Control: one row per ledger, what it waits for decided by code
  assert.deepEqual(ledgers().map((l) => l.root), [root])
  const mc = await (await answer(r.missions, new Request(`http://127.0.0.1${ROUTES.missions}`))).json()
  assert.deepEqual(mc.account, { plan: "Pro", used: "₹12.00", cap: "₹500.00", estimated: false })
  assert.equal(mc.missions[0].status, "running")
  const rows = missionRows([
    { root: "/a/done", ledger: { milestones: [{ status: "done", title: "x" }] } },
    { root: "/a/blocked", ledger: { milestones: [{ status: "done", title: "x" }, { status: "blocked", title: "y" }] } },
    { root: "/a/todo", ledger: { milestones: [{ status: "todo", title: "x" }] } },
    { root: "/a/none", ledger: undefined },
  ])
  assert.deepEqual(rows.map((m) => [m.project, m.status, m.done, m.of]), [["done", "done", 1, 1], ["blocked", "blocked", 1, 2], ["todo", "todo", 0, 1]])
  assert.match(rows[1].waiting, /^You: milestone 2 is blocked/)
})

test("WT-UX-11: the keyboard map works and the live region speaks once per verdict change, not per chip", () => {
  const src = readFileSync(join(ROOT, "plugins", "runstrip", "client.js"), "utf8")
  assert.match(src, /e\.code === "ArrowUp"/)
  assert.match(src, /e\.code === "Period"/)
  assert.match(src, /\^Digit\(\[1-4\]\)\$/)
  // ⌥1…4 open the four tracks by their tab kinds
  const listeners = []
  const opened = []
  strip.context.window.addEventListener = (type, fn) => listeners.push(fn)
  strip.context.window.removeEventListener = () => {}
  const ctx = { effect: (fn) => fn(), get: (n) => (n === "sidebarRight" ? { openTab: (k) => opened.push(k) } : undefined), slots: { inject: (_n, fn) => fn(), register: () => {} } }
  C.apply(ctx)
  for (const d of ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"]) listeners.at(-1)({ code: d, altKey: true, preventDefault() {} })
  listeners.at(-1)({ code: "Digit1", altKey: false, preventDefault() {} })
  assert.deepEqual(opened, ["kriya-preview", "kriya-progress", "kriya-changes", "kriya-overview"])
  delete strip.context.window.addEventListener
  // Announcements
  const run = (attempts) => ({ sessionId: "s1", step: { n: 1, title: "Orders API" }, attempts })
  const a1 = C.announcement(null, run([{ n: 1, outcome: "building" }]))
  assert.equal(a1.text, "Step 1 started: Orders API.")
  assert.equal(C.announcement(a1, run([{ n: 1, outcome: "building" }])), null, "chips or time changing says nothing")
  const a2 = C.announcement(a1, run([{ n: 1, outcome: "test" }, { n: 2, outcome: "building" }]))
  assert.equal(a2.text, "Step 1, attempt 1: test.")
  assert.equal(C.announcement(a2, run([{ n: 1, outcome: "test" }, { n: 2, outcome: "building" }])), null)
  assert.equal(C.announcement({ ...a2, running: true }, undefined).text, "Nothing is running.")
  assert.equal(C.announcement({ key: "idle", running: false }, undefined), null)
})

test("WT-UX-12: every target is at least 44 px, and at 360 px the strip keeps step, chips as a count and Stop", () => {
  const rule = (sel) => new RegExp(`${sel.replace(/[.[\]"=]/g, "\\$&")}[^{]*\\{[^}]*min-height: 44px`)
  for (const sel of [".kh-rs-sum", ".kh-rs-stop", ".kh-mc-btn, .kh-tx-btn", ".kh-tx-range"]) assert.match(C.CSS, rule(sel), sel)
  assert.match(C.CSS, /\.kh-rs-stop \{[^}]*min-width: 44px/)
  assert.match(C.CSS, /\.kh-mc-btn, \.kh-tx-btn \{[^}]*min-width: 44px/)
  const narrow = /@media \(max-width: 767px\) \{([^@]*)\}\n/.exec(C.CSS)[1]
  assert.match(narrow, /\.kh-rs-mid, \.kh-rs-row \.kh-chips \{ display: none; \}/)
  assert.match(narrow, /\.kh-rs-count \{ display: inline; \}/)
  assert.match(C.CSS, /@media \(max-width: 1023px\) \{ \.kh-rs-wide \{ display: none; \} \}/)
  // Every visible control in the strip and the tracks carries a focus ring in Teal
  assert.match(C.CSS, /\.kh-rs-sum:focus-visible, \.kh-rs-stop:focus-visible, \.kh-mc-btn:focus-visible, \.kh-tx-btn:focus-visible, \.kh-tx-range:focus-visible \{ outline: 2px solid var\(--dsw-alias-link\)/)
  // Brand tokens only: no raw colour except the documented fallback
  assert.deepEqual([...C.CSS.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((m) => m[0]), ["#fff"])
})
