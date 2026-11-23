import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { call, me } from "../../src/api.js"
import { ChangesError } from "../../src/changes.js"
import { listCheckpoints, restoreTree, trackedRoot } from "../../src/checkpoints.js"
import { gateMatrix } from "../../src/doctor.js"
import { liveBuild } from "../../src/loop.js"
import { readMilestones } from "../../src/milestones.js"
import { orchestraFromEnv } from "../../src/orchestra.js"
import { kriyaHome } from "../../src/paths.js"
import { readState } from "../../src/release.js"
import { receiptFiles, verifyReceipt } from "../../src/receipts.js"
import { formatInr, liveGates, missionRows, stepChips, stripState } from "../../src/runstrip.js"
import { projectRoot } from "../../src/skill-switches.js"
import { readProgress } from "../../src/verify.js"
import { readDevice } from "../../src/store.js"
import { createRepo } from "../repo/repo.js"

// Harness 2.0 W18 (WD-23), node half: the Run strip, Mission Control and the
// four tracks' extra sections, as read-only routes inside Connection's fence
// (as plugins/progress). Two routes act, both the person's own clicks in the
// Web UI and never an agent tool: Stop (DSH's own user cancel, as the
// composer's stop button) and "Restore this point" (as `kriya undo`, which
// saves the files it replaces first). Mounted only with --runstrip.

export const name = "kriya-runstrip"
export const inject = ["connection", "sessions", "agents"]

export const ROUTES = {
  strip: "/api/kriya.runstrip",
  stop: "/api/kriya.runstrip.stop",
  missions: "/api/kriya.missions",
  track: "/api/kriya.tracks",
  restore: "/api/kriya.tracks.restore",
  verify: "/api/kriya.tracks.receipt-verify",
}

const SESSION = /^[A-Za-z0-9_-]{1,128}$/
const sessionOf = (value) => {
  if (typeof value !== "string" || !SESSION.test(value)) throw new ChangesError("Which session?")
  return value
}
const json = async (request) => {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) throw new ChangesError("Send JSON.")
  return (await request.json().catch(() => null)) ?? {}
}
const names = (env = process.env) => {
  try {
    return JSON.parse(env.KRIYA_MODEL_NAMES || "{}")
  } catch {
    return {}
  }
}

/**
 * This task's spend: the device's month total from GET /me when the task's
 * first builder starts, and again once per later builder (HARNESS_UX §3.1);
 * shown as the difference, "estimated" while Kriya has unpriced requests.
 * @param {{ account: () => Promise<any> }} host
 */
export function spendTracker({ account }) {
  const tasks = new Map() // session → { plan, since, builder, base?, used?, unpriced? }
  return {
    get(sessionId, plan, live) {
      let t = tasks.get(sessionId)
      if (!t || t.plan !== plan) tasks.set(sessionId, (t = { plan, since: live.startedAt, builder: undefined }))
      if (t.builder !== live.startedAt) {
        t.builder = live.startedAt
        account().then(
          (a) => {
            const used = Number(a?.harness?.usedMicroInr)
            if (!Number.isFinite(used)) return
            t.base ??= used
            t.used = used
            t.unpriced = Boolean(a.harness.unpriced)
          },
          () => {}
        )
      }
      return { since: t.since, spend: t.base === undefined ? null : { inr: formatInr(t.used - t.base), estimated: t.unpriced } }
    },
  }
}

/** Ledgers on this computer: ~/.kriya/progress/<project>/milestones.json, each with its project's folder from a session record beside it. */
export function ledgers(home = kriyaHome()) {
  const dir = join(home, "progress")
  const out = []
  let keys = []
  try {
    keys = readdirSync(dir)
  } catch {
    return out
  }
  for (const key of keys) {
    const folder = join(dir, key)
    if (!existsSync(join(folder, "milestones.json"))) continue
    const record = readdirSync(folder).find((f) => f.endsWith(".json") && f !== "milestones.json")
    let root
    try {
      root = JSON.parse(readFileSync(join(folder, record), "utf8")).root
    } catch {
      continue
    }
    if (typeof root === "string" && root) out.push({ root, ledger: readMilestones(root) })
  }
  return out
}

/** @param {{ folderOf: (id: string) => Promise<string | undefined>, running: () => string[], cancel: (id: string) => boolean, account: () => Promise<any>, env?: NodeJS.ProcessEnv, now?: () => number, home?: string, repoOf?: (cwd: string) => any, matrix?: () => Promise<any>, mcp?: () => Promise<any[]>, liveOf?: (id: string) => any }} host */
export function handlers(host) {
  const env = host.env ?? process.env
  const now = host.now ?? Date.now
  const liveOf = host.liveOf ?? liveBuild
  const spend = spendTracker(host)
  const folder = async (id) => {
    const cwd = await host.folderOf(id)
    if (!cwd) throw new ChangesError("That session isn't known here.")
    return cwd
  }
  const progressOf = (cwd, id) => {
    try {
      return readProgress(projectRoot(cwd), id)
    } catch {
      return { runs: [] }
    }
  }

  async function strip() {
    const runs = []
    for (const id of host.running()) {
      const live = liveOf(id)
      const cwd = live && (await host.folderOf(id))
      if (!cwd) continue
      const progress = progressOf(cwd, id)
      if (!progress.plan) continue
      const root = projectRoot(cwd)
      const { since, spend: money } = spend.get(id, progress.plan.at, live)
      const state = stripState({ sessionId: id, progress, live, ledger: readMilestones(root), orchestra: orchestraFromEnv(env), names: names(env), since, spend: money, now: now() })
      if (state.running) runs.push(state)
    }
    return { runs }
  }

  async function stop(request) {
    const id = sessionOf((await json(request)).session)
    if (!liveOf(id)) throw new ChangesError("Nothing is running in that session.")
    if (!host.cancel(id)) throw new ChangesError("That session isn't running here.")
    return { stopped: true }
  }

  async function missions() {
    const running = new Set()
    for (const id of host.running()) {
      const cwd = liveOf(id) && (await host.folderOf(id))
      if (cwd) running.add(projectRoot(cwd))
    }
    let account = null
    try {
      const a = await host.account()
      account = a?.harness ? { plan: a.plan ?? null, used: formatInr(a.harness.usedMicroInr), cap: formatInr(a.harness.capMicroInr), estimated: Boolean(a.harness.unpriced) } : null
    } catch {
      account = null
    }
    return {
      signedIn: Boolean(readDevice()),
      account,
      missions: missionRows(ledgers(host.home).map((e) => ({ ...e, running: running.has(e.root) }))),
    }
  }

  async function track(request) {
    const params = new URL(request.url).searchParams
    const id = sessionOf(params.get("session"))
    const part = params.get("part")
    const cwd = await folder(id)
    const root = projectRoot(cwd)
    const progress = progressOf(cwd, id)
    if (part === "live") return { gates: liveGates(progress) }
    if (part === "proof") {
      const ready = readState(root).records.findLast((r) => r.kind === "ready")
      let receipt = null
      try {
        const files = receiptOf(id, root)
        receipt = { ...JSON.parse(readFileSync(files.json, "utf8")), markdown: readFileSync(files.md, "utf8") }
      } catch {
        receipt = null
      }
      return {
        steps: stepChips(progress),
        release: ready ? { commit: String(ready.commit).slice(0, 12), ready: Boolean(ready.ready), at: ready.at, lines: ready.lines ?? [] } : null,
        receipt: receipt && { verdict: receipt.verdict, chain: receipt.chain, runs: receipt.runs, commit: receipt.commit ? String(receipt.commit).slice(0, 12) : null, markdown: receipt.markdown },
      }
    }
    if (part === "changes") {
      const tracked = (await trackedRoot(cwd))?.root
      if (!tracked) return { points: [] }
      const mine = (await listCheckpoints(tracked)).filter((c) => c.kind === "checkpoint" && c.session === id).reverse()
      const runs = progress.runs ?? []
      return {
        points: mine.map((c, i) => {
          const next = mine[i + 1]?.at
          const run = runs.find((r) => r.at >= c.at && (!next || r.at < next))
          return { commit: c.commit, at: c.at, label: c.label, verdict: run ? run.status : null }
        }),
      }
    }
    if (part === "project") {
      const [repo, matrix, mcp] = await Promise.all([
        (host.repoOf ?? ((dir) => createRepo({ root: dir })))(cwd)
          .status()
          .then((s) => ({ state: s.state, text: s.text }), (e) => ({ state: "unknown", text: String(e?.message ?? e).slice(0, 300) })),
        (host.matrix ?? gateMatrix)(),
        (host.mcp ?? (async () => []))().catch(() => []),
      ])
      return { repo, matrix, mcp }
    }
    throw new ChangesError("Which part?")
  }

  async function restore(request) {
    const body = await json(request)
    const id = sessionOf(body.session)
    const cwd = await folder(id)
    if (liveOf(id)) throw new ChangesError("Stop the running step before restoring a point.")
    const tracked = (await trackedRoot(cwd))?.root
    const point = tracked && (await listCheckpoints(tracked)).find((c) => c.kind === "checkpoint" && c.session === id && c.commit === body.commit)
    if (!point) throw new ChangesError("That point isn't one of this session's checkpoints.")
    const done = await restoreTree(cwd, point.tree, `before restoring ${point.label}`)
    return { restored: point.label, changed: done?.changed ?? 0 }
  }

  async function verify(request) {
    const id = sessionOf((await json(request)).session)
    const cwd = await folder(id)
    try {
      return verifyReceipt(readFileSync(receiptOf(id, projectRoot(cwd)).json, "utf8"))
    } catch {
      return { ok: false, problems: ["This session has no receipt yet: ask for one, or run kriya receipt make."] }
    }
  }

  return { strip, stop, missions, track, restore, verify }
}

// The receipt's project key: the root's hash, as src/receipts.js and src/verify.js name it
const projectKey = (root) => createHash("sha256").update(root).digest("hex").slice(0, 16)
const receiptOf = (id, root) => receiptFiles(projectKey(root), id)

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

export async function answer(route, request, log = () => {}) {
  try {
    return reply(await route(request))
  } catch (error) {
    if (error instanceof ChangesError) return reply({ error: error.message }, 400)
    log(error)
    return reply({ error: "Kriya couldn't read this; see the terminal for details." }, 500)
  }
}

export function apply(ctx) {
  const folderOf = async (id) => {
    const live = ctx.sessions.get(id)?.header
    const stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(id) : undefined
    return (live ?? stored?.header)?.cwd
  }
  const account = () => {
    const device = readDevice()
    return device ? me(device.url, device.token) : Promise.resolve(null)
  }
  const routes = handlers({
    folderOf,
    running: () => [...(ctx.agents.list?.() ?? [])].map((a) => String(a.id)),
    // DSH's own stop: the turn ends, queued messages stay (the composer's stop button)
    cancel: (id) => {
      const agent = ctx.agents.get?.(id)
      if (!agent) return false
      agent.cancel({ kind: "user" }, { keepInbox: true })
      return true
    },
    account,
    mcp: async () => {
      if (process.env.KRIYA_MCP !== "on") return []
      const device = readDevice()
      if (!device) return []
      const servers = (await call(device.url, "GET", "/mcp", { token: device.token })).servers ?? []
      return servers.map((s) => ({ id: String(s.id ?? ""), name: String(s.name ?? s.id ?? "").slice(0, 80) }))
    },
  })
  const log = (error) => ctx.logger("kriya-runstrip").warn(error)
  const register = (path, method, route) => ctx.effect(() => ctx.connection.fetch.register({ path, methods: [method], requestBody: "buffered", fetch: (request) => answer(route, request, log) }))
  register(ROUTES.strip, "GET", routes.strip)
  register(ROUTES.stop, "POST", routes.stop)
  register(ROUTES.missions, "GET", routes.missions)
  register(ROUTES.track, "GET", routes.track)
  register(ROUTES.restore, "POST", routes.restore)
  register(ROUTES.verify, "POST", routes.verify)
}
