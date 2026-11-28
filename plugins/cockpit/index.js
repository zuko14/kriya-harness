import { tooBroad } from "../../src/checkpoints.js"
import { CockpitError, connections, githubSignIn, health, ignoreSecrets, runner, servers, stopServer } from "../../src/cockpit.js"
import { saveSwitch, savedSwitches } from "../../src/modes.js"
import { addModel, listProviderModels, OwnModelsError, ownFile, publicView, removeKey, removeModel, saveKey, setOrchestra } from "../../src/own-models.js"
import { createRepo, RepoError } from "../repo/repo.js"

// The Developer tab, node half (Kriya-Tavi docs/kriya-harness/DEVELOPER_COCKPIT.md):
// one read route and one action route on DSH's shared /api channel, inside
// Connection's fence (as plugins/overview and plugins/remote). Actions are the
// person's own clicks in this app; nothing here is an agent tool. On only with
// the owner's harness.cockpit (KRIYA_COCKPIT=on).

export const name = "kriya-cockpit"
export const inject = ["connection", "sessions"]

export const ROUTE = "/api/kriya.cockpit"
// Settings → Models (Kriya's, in place of DSH's): the same own-model setup, with no session needed
export const MODELS_ROUTE = "/api/kriya.models"
const OWN_ACTIONS = new Set(["own.key.save", "own.key.remove", "own.models.list", "own.model.add", "own.model.remove", "own.orchestra"])
export const CACHE_MS = 60_000
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * @param {{ folderOf: (id: string) => Promise<string | undefined>, run?: any, now?: () => number, signIn?: any, switches?: { read: () => object, save: (flag: string, on: boolean) => object }, kill?: any }} host
 */
export function handler(host) {
  const run = host.run ?? runner()
  const log = host.log ?? (() => {})
  const now = host.now ?? Date.now
  const signIn = host.signIn ?? githubSignIn()
  const switches = host.switches ?? { read: () => savedSwitches(), save: saveSwitch }
  // Own models (OWN_MODELS.md): only with the owner's harness.ownModels; the file only through src/own-models.js
  const ownOn = host.ownOn ?? (() => process.env.KRIYA_OWN_MODELS_OFFER === "on")
  const ownPath = host.ownFile ?? ownFile()
  const fetchImpl = host.fetchImpl ?? fetch
  const standalone = host.standalone ?? (() => process.env.KRIYA_STANDALONE === "on")
  // How this app runs, for the tab's first card: connected to Kriya, or Standalone Mode and why
  const mode = () => ({
    standalone: standalone(),
    ...(standalone() && { reason: ["signed_out", "server_unreachable", "requested"].includes(process.env.KRIYA_STANDALONE_REASON) ? process.env.KRIYA_STANDALONE_REASON : "signed_out" }),
    localModel: process.env.KRIYA_LOCAL_MODEL_ID ? String(process.env.KRIYA_LOCAL_MODEL_LABEL || process.env.KRIYA_LOCAL_MODEL_ID).slice(0, 80) : null,
  })
  // What the head and worker can be: this plan's Kriya tiers, the person's own models, and the local model
  const choices = () => {
    let names = {}
    try {
      names = JSON.parse(process.env.KRIYA_MODEL_NAMES || "{}")
    } catch {
      names = {}
    }
    // Standalone Mode: no Kriya tier answers, so none is offered
    const tiers = standalone() ? [] : String(process.env.KRIYA_ALLOWED_TIERS || "balanced,budget,escalation").split(",").filter((t) => ["balanced", "budget", "escalation"].includes(t))
    return [
      // The names keep their " · <tier>" when two tiers share a model, so each choice reads differently
      ...tiers.map((t) => ({ id: t, name: `Kriya · ${String(names[t] ?? t)}` })),
      ...publicView(ownPath).models.map((m) => ({ id: m.id, name: m.name })),
      ...(process.env.KRIYA_LOCAL_MODELS_OFFER === "on" ? [{ id: "local", name: "Local model (Ollama or LM Studio, workers only)" }] : []),
    ]
  }
  const own = () => (ownOn() ? { ...publicView(ownPath), choices: choices() } : null)
  let cache = null
  const connected = async (fresh) => {
    if (!fresh && cache && now() - cache.at < CACHE_MS) return cache.list
    cache = { at: now(), list: await connections(run) }
    return cache.list
  }
  const folder = async (id) => {
    if (typeof id !== "string" || !id || id.length > 200) throw new CockpitError("Which session?")
    const cwd = await host.folderOf(id)
    if (!cwd) throw new CockpitError("That session isn't known here.")
    return cwd
  }
  const github = async (cwd) => {
    const repo = createRepo({ root: cwd, run })
    let status
    try {
      status = await repo.status()
    } catch (e) {
      return { state: "unavailable", note: e instanceof RepoError ? e.message : "git couldn't be read here." }
    }
    // Not a repository: status has no branch or remotes, and the tab offers `git init`
    if (status.state === "not a repository") return { state: status.state }
    const out = { state: status.state, branch: status.branch, changed: status.changed ?? 0, remotes: (status.remotes ?? []).filter(Boolean), exposed: status.exposed ?? [] }
    if (status.state !== "remote, signed in") return out
    const pr = await run("gh", ["pr", "view", "--json", "number,title,url,state,isDraft"], cwd)
    if (pr.code !== 0) return { ...out, pr: null }
    let view
    try {
      view = JSON.parse(pr.stdout)
    } catch {
      return { ...out, pr: null }
    }
    const checks = await run("gh", ["pr", "checks", "--json", "name,state,link"], cwd)
    let list = []
    try {
      list = checks.stdout.trim() ? JSON.parse(checks.stdout) : []
    } catch {
      list = []
    }
    const count = (states) => list.filter((c) => states.includes(String(c.state).toUpperCase())).length
    return {
      ...out,
      pr: { number: view.number, title: String(view.title ?? "").slice(0, 200), url: /^https:\/\/github\.com\//.test(view.url) ? view.url : null, state: view.state, draft: Boolean(view.isDraft) },
      checks: { total: list.length, passed: count(["SUCCESS", "SKIPPED", "NEUTRAL"]), failed: count(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]), pending: count(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "EXPECTED", "REQUESTED"]) },
    }
  }
  const saved = () => {
    const s = switches.read()
    return { repoTools: { saved: s["repo-tools"] ?? null, running: process.env.KRIYA_REPO_TOOLS === "on" }, providerTools: { saved: s["provider-tools"] ?? null, running: process.env.KRIYA_PROVIDER_TOOLS === "on" } }
  }

  async function ownAct(body) {
    if (!ownOn()) throw new CockpitError("Your own models aren't turned on for your Kriya account yet.")
    if (body.action === "own.key.save") saveKey(body.provider, body.key, body.url, ownPath)
    else if (body.action === "own.key.remove") removeKey(body.provider, ownPath)
    else if (body.action === "own.models.list") return { models: await listProviderModels(body.provider, ownPath, fetchImpl) }
    else if (body.action === "own.model.add") addModel(body.provider, body.model, body.contextWindow, ownPath)
    else if (body.action === "own.model.remove") removeModel(body.id, ownPath)
    else setOrchestra(body.orchestra ?? null, ownPath)
    // Never the key: the masked view only
    return { done: body.action, own: own() }
  }
  const parse = async (request) => {
    try {
      return JSON.parse(await request.text())
    } catch {
      throw new CockpitError("Kriya couldn't read that request.")
    }
  }

  return {
    // Settings → Models: how this app runs and the person's own models, outside any session
    async models() {
      return { mode: mode(), own: own() }
    },
    async modelsAct(request) {
      const body = await parse(request)
      if (!OWN_ACTIONS.has(body?.action)) throw new CockpitError("Kriya doesn't know that action.")
      return ownAct(body)
    },
    async read(request) {
      const url = new URL(request.url)
      const cwd = await folder(url.searchParams.get("session"))
      // Each section on its own: one that fails says so in its place, never the whole tab
      const section = (name, work, fallback) =>
        Promise.resolve()
          .then(work)
          .catch((error) => {
            log(error)
            return { ...fallback, error: `Kriya couldn't read ${name} here; see the terminal for details.` }
          })
      const [list, gh, running, checkup, ownView] = await Promise.all([
        section("the connections", () => connected(url.searchParams.get("fresh") === "1"), { items: [] }),
        section("this folder's git state", () => github(cwd), { state: "unavailable", note: "Kriya couldn't read git here; see the terminal for details." }),
        section("the running servers", () => servers(cwd, run), { available: true, list: [] }),
        section("the project's health", () => health(cwd, run), { stack: [], scripts: [], check: null, git: false, tracked: [], unignored: [] }),
        section("your models", () => own(), null),
      ])
      return { folder: cwd, mode: mode(), connections: Array.isArray(list) ? list : [], ...(list?.error && { connectionsError: list.error }), signIn: signIn.state(), github: gh, servers: running, health: checkup, switches: saved(), own: ownView?.error ? null : ownView, ...(ownView?.error && { ownError: ownView.error }) }
    },
    async act(request) {
      const body = await parse(request)
      if (OWN_ACTIONS.has(body?.action)) return ownAct(body)
      const cwd = await folder(body?.session)
      switch (body?.action) {
        case "github.signin":
          cache = null
          return signIn.start()
        case "github.signin.cancel":
          return signIn.cancel()
        case "git.init": {
          if (tooBroad(cwd)) throw new CockpitError("Kriya doesn't make a repository of your home folder or a drive.")
          const r = await run("git", ["init", "-b", "main"], cwd)
          if (r.code !== 0) throw new CockpitError(`git init failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`)
          return { done: "git.init" }
        }
        case "github.create": {
          const name = String(body.name ?? "").trim()
          if (!REPO_NAME.test(name)) throw new CockpitError("A repository name is 1 to 100 letters, digits, dots, hyphens or underscores.")
          const state = (await github(cwd)).state
          if (state !== "no remote") throw new CockpitError("This folder already has a remote, or isn't a git repository yet.")
          const r = await run("gh", ["repo", "create", name, "--private", "--source", ".", "--remote", "origin"], cwd)
          if (r.code !== 0) throw new CockpitError(`gh couldn't create it: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`)
          return { done: "github.create", url: /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(`${r.stdout}${r.stderr}`)?.[0] ?? null }
        }
        case "server.stop":
          return stopServer(cwd, Number(body.pid), run, host.kill)
        case "health.ignore":
          return ignoreSecrets(cwd, body.files, run)
        case "switch": {
          const flag = body.flag
          if (!["repo-tools", "provider-tools"].includes(flag) || typeof body.on !== "boolean") throw new CockpitError("That switch can't be set here.")
          switches.save(flag, body.on)
          return { done: "switch", switches: saved() }
        }
        default:
          throw new CockpitError("Kriya doesn't know that action.")
      }
    },
  }
}

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

export async function answer(fn, request, log = () => {}) {
  try {
    return reply(await fn(request))
  } catch (error) {
    if (error instanceof CockpitError || error instanceof RepoError || error instanceof OwnModelsError) return reply({ error: error.message }, 400)
    log(error)
    return reply({ error: "Kriya couldn't do that; see the terminal for details." }, 500)
  }
}

export function apply(ctx) {
  if (process.env.KRIYA_COCKPIT !== "on") return
  const folderOf = async (id) => {
    const live = ctx.sessions.get(id)?.header
    const stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(id) : undefined
    return (live ?? stored?.header)?.cwd
  }
  const log = (error) => ctx.logger("kriya-cockpit").warn(error)
  const routes = handler({ folderOf, log })
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: ROUTE,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request) => answer(request.method === "POST" ? routes.act : routes.read, request, log),
    })
  )
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: MODELS_ROUTE,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request) => answer(request.method === "POST" ? routes.modelsAct : routes.models, request, log),
    })
  )
}

