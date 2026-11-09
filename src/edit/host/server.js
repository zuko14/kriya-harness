// The Studio's own origin (STUDIO_APP_AND_BROWSER §3): HTTP on 127.0.0.1, fenced on
// every request, and an owner-only socket with the same routes. Typed requests only:
// no route runs a command, and every path passes guardPath.

import { createHash, createHmac, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join } from "node:path"
import { pipeline } from "node:stream/promises"

import { compile } from "../core/plan.js"
import { solve } from "../core/solver.js"
import { LOOKS } from "../engine/captions.js"
import { ENGINE_VERSION, guardPath } from "../engine/index.js"
import { EngineFailure } from "../engine/tool.js"
import { activeRuntime } from "../runtime/setup.js"
import { recogniser } from "../index/layers/words.js"
import { FORMATS, GRADES } from "../recipes/reel.js"

const HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
}
const COOKIE = "kriya_edit"
const MAX_BODY = 4 * 1024 * 1024
// The Studio app, built by `npm run build:studio` (ED6)
const STUDIO = join(import.meta.dirname, "..", "..", "..", "studio", "dist")
const STUDIO_FILES = { "/": ["index.html", "text/html; charset=utf-8"], "/studio.js": ["studio.js", "text/javascript"], "/studio.css": ["studio.css", "text/css"] }
const TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".json": "application/json" }

// An inline icon, so the browser doesn't ask for /favicon.ico (a 404 in the console)
const LAUNCH_PAGE = `<!doctype html><title>Kriya Editing Studio</title><link rel="icon" href="data:,"><p>Opening…</p><script src="/launch.js"></script>`
// The token is in the fragment, so it never reaches a log or a Referer
const LAUNCH_SCRIPT = `const token = location.hash.slice(1);
history.replaceState(null, "", "/launch");
fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).then(async (r) => {
  document.querySelector("p").textContent = r.ok ? "Signed in." : "This link has been used. Run kriya edit again.";
  if (!r.ok) return;
  const { back } = await r.json();
  try { back ? sessionStorage.setItem("kriya-edit-back", back) : sessionStorage.removeItem("kriya-edit-back"); } catch {}
  location.replace("/");
});`
const HOME_PAGE = `<!doctype html><title>Kriya Editing Studio</title><p>The Edit Host is running, but the Studio isn't built. Run npm run build:studio.</p>`

/** Where "Back to Kriya Harness" may go: the harness's own loopback page, nothing else. */
const backOf = (value, port) => {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port && Number(url.port) !== port && url.username === "" && url.password === "" ? url.origin : null
  } catch {
    return null
  }
}

function studioFile(res, pathname) {
  const [name, type] = STUDIO_FILES[pathname]
  const file = join(STUDIO, name)
  if (!existsSync(file)) return pathname === "/" ? page(res, "text/html; charset=utf-8", HOME_PAGE) : refuse(res, 404, "Not found.")
  page(res, type, readFileSync(file))
}

const sha = (text) => createHash("sha256").update(text).digest("hex")

function json(res, status, value) {
  res.writeHead(status, { ...HEADERS, "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

function page(res, type, body) {
  res.writeHead(200, { ...HEADERS, "content-type": type })
  res.end(body)
}

const refuse = (res, status, message) => json(res, status, { error: status, message })

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new EngineFailure("input", "too_large", "That request is too large.")
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new EngineFailure("input", "bad_json", "That request isn't valid JSON.")
  }
}

function sendFile(req, res, file) {
  const { size } = statSync(file)
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
  if (req.headers.range && !range) return refuse(res, 416, "Bad range.")
  if (!range) {
    res.writeHead(200, { ...HEADERS, "content-type": type, "content-length": size, "accept-ranges": "bytes" })
    return createReadStream(file).pipe(res)
  }
  const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1])
  const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start > end) {
    res.writeHead(416, { ...HEADERS, "content-range": `bytes */${size}` })
    return res.end()
  }
  res.writeHead(206, { ...HEADERS, "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" })
  createReadStream(file, { start, end }).pipe(res)
}

const statusOf = (error) => ({ outside_project: 403, missing_file: 404, exists: 409, too_large: 413, empty: 409, busy: 409, no_project: 404 })[error.reason] ?? 400

/**
 * @param {{ home: string, roots: string[], projects: object, jobs: object, tools: () => Promise<object>, tokenTtlMs: number, port: () => number, onActivity: (inFlight?: number) => void, onStop: () => void, sse: Set<object>, log: (line: string) => void, pid: number }} options
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createHandler({ home, roots, projects, jobs, tavi, tools, tokenTtlMs, port, onActivity, onStop, onLive = () => {}, sse, log, pid, stamp = null, busy = () => 0 }) {
  const tokens = new Map() // sha256 of a launch token → { expires, back }
  const sessions = new Set()
  const mediaSecret = randomBytes(32)
  const media = new Map() // opaque id → { project, asset }

  const mediaId = (projectId, assetId) => {
    const id = createHmac("sha256", mediaSecret).update(`${projectId}:${assetId}`).digest("hex").slice(0, 32)
    media.set(id, { project: projectId, asset: assetId })
    return id
  }

  // offline: the file isn't where the project says, so the Studio asks to relink it (EG-3)
  const withMedia = (state, asset) => ({ ...asset, media: mediaId(state.id, asset.id), ...(existsSync(isAbsolute(asset.path) ? asset.path : join(state.folder, asset.path)) ? {} : { offline: true }) })
  const NOTICES = { index: "This project's index was damaged and set aside. Index the footage again.", journal: "This project's job record was damaged and set aside. Finished renders will be made again." }
  const projectView = (state) => ({ project: state.log.current, head: state.log.head, assets: state.log.current.assets.map((asset) => withMedia(state, asset)), ...(state.damaged?.length ? { notices: state.damaged.map((part) => ({ kind: part === "index" ? "reindex" : "rerender", message: NOTICES[part] })) } : {}) })

  // The Media Runtime, installed from the Studio with its progress shown (the same signed
  // manifest and checks as `kriya edit setup`): a first Index no longer looks like nothing happening
  let setup = null
  const runtimeView = () => {
    const runtime = activeRuntime(home)
    return { version: runtime?.version ?? null, speech: recogniser(runtime).missing ?? null, setup }
  }
  function startSetup() {
    if (setup && !setup.finished) return runtimeView()
    setup = { step: null, done: null, total: null, line: "Asking Kriya for the Media Runtime", error: null, finished: false }
    const tell = () => {
      for (const res of sse) res.write(`event: setup\ndata: ${JSON.stringify(setup)}\n\n`)
    }
    let told = 0
    const run = async () => {
      const [{ readDevice }, { fetchManifest }, { install }] = await Promise.all([import("../../store.js"), import("../runtime/fetch.js"), import("../runtime/setup.js")])
      const device = readDevice()
      if (!device) throw new Error("This computer isn't signed in to Kriya. Run kriya login, then try again.")
      const say = (line) => ((setup.line = line), tell())
      const progress = (at) => {
        Object.assign(setup, at)
        if (Date.now() - told > 250 || at.done === at.total) ((told = Date.now()), tell())
      }
      await install(await fetchManifest(device), { home, say, progress })
    }
    onActivity(1)
    run().then(
      () => Object.assign(setup, { finished: true, step: null, line: "The Media Runtime is ready." }),
      (error) => Object.assign(setup, { finished: true, error: error.message }),
    ).finally(() => (tell(), onActivity(-1)))
    return runtimeView()
  }

  function fenced(req) {
    const allowed = [`127.0.0.1:${port()}`, `localhost:${port()}`]
    if (!allowed.includes(req.headers.host)) return false
    const { origin } = req.headers
    if (origin && !allowed.some((host) => origin === `http://${host}`)) return false
    const site = req.headers["sec-fetch-site"]
    // Another port on 127.0.0.1 is the same site, so the Strict cookie would go with it:
    // from there only a navigation (the harness's link) is let through (ES-11, ED17)
    return site !== "cross-site" && (site !== "same-site" || req.headers["sec-fetch-mode"] === "navigate")
  }

  const hasSession = (req) => {
    const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))
    return !!cookie && sessions.has(sha(cookie.slice(COOKIE.length + 1)))
  }

  function openSession(req, res, { token }) {
    const key = sha(String(token ?? ""))
    const minted = tokens.get(key)
    tokens.delete(key)
    if (!minted || minted.expires < Date.now()) return refuse(res, 401, "This link has been used or has expired. Run kriya edit again.")
    const session = randomBytes(32).toString("base64url")
    sessions.add(sha(session))
    log("a session opened")
    res.writeHead(200, { ...HEADERS, "content-type": "application/json", "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` })
    res.end(JSON.stringify({ back: minted.back }))
  }

  async function needProject(res, id) {
    const state = /^[0-9a-f]{16}$/.test(id) ? await projects.get(id) : null
    if (!state) refuse(res, 404, "There is no such project.")
    return state
  }

  async function upload(req, res, state, url) {
    const name = basename(url.searchParams.get("name") ?? "").replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    if (!name || name.startsWith(".")) return refuse(res, 400, "That file name can't be used.")
    const dir = join(state.folder, "media")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    if (existsSync(file)) return refuse(res, 409, "A file with that name is already in this project.")
    await pipeline(req, createWriteStream(file, { flags: "wx" }))
    // ?as=reference: the person confirmed in the Studio they may use it as a style reference
    json(res, 200, withMedia(state, await projects.addAsset(state, file, { reference: url.searchParams.get("as") === "reference" })))
  }

  function events(res) {
    res.writeHead(200, { ...HEADERS, "content-type": "text/event-stream" })
    res.write(": connected\n\n")
    sse.add(res)
    res.on("close", () => {
      sse.delete(res)
      onActivity()
    })
  }

  async function assetFile(state, asset, kind) {
    const { engine, log: history } = state
    const found = history.current.assets.find((item) => item.id === asset)
    if (kind === "peaks") return engine.peaks(asset)
    if (kind === "thumbs") return engine.thumbs(asset)
    if (found.kind === "video") return engine.proxy(asset)
    return guardPath(isAbsolute(found.path) ? found.path : join(state.folder, found.path), [...roots, state.folder])
  }

  async function route(req, res, url) {
    const { method } = req
    const { pathname } = url
    const parts = pathname.split("/").filter(Boolean)
    const say = (status, value) => json(res, status, value)

    if (method === "GET" && pathname === "/host") {
      const { version } = await tools()
      const runtime = activeRuntime(home)
      return say(200, { engine: ENGINE_VERSION, ffmpeg: version, runtime: runtime?.version ?? null, projects: projects.list().length })
    }
    if (method === "GET" && pathname === "/events") return events(res)

    if (method === "GET" && pathname === "/browse") {
      const root = guardPath(url.searchParams.get("root") ?? roots[0], roots)
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((item) => !item.name.startsWith("."))
        .map((item) => ({ name: item.name, kind: item.isDirectory() ? "folder" : item.isFile() ? "file" : "other" }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1))
      // The Studio's folder picker: up, while still inside the allowed folders
      let parent = null
      try {
        if (dirname(root) !== root) parent = guardPath(dirname(root), roots)
      } catch {
        // Above the allowed folders: no way up
      }
      return say(200, { root, parent, roots, entries })
    }
    // A new folder for a project, inside the allowed folders only
    if (method === "POST" && pathname === "/browse/folder") {
      const { parent, name } = await readJson(req)
      const clean = typeof name === "string" ? name.trim().replace(/[^\p{L}\p{N} _.-]+/gu, "-").replace(/^\.+/, "") : ""
      if (!clean || clean.length > 80 || typeof parent !== "string") return refuse(res, 400, "Give the new folder a name.")
      const at = join(guardPath(parent, roots), clean)
      if (existsSync(at)) return refuse(res, 409, "A folder with that name is already there.")
      mkdirSync(at)
      return say(200, { folder: guardPath(at, roots) })
    }

    // The person's own screen. Never on the socket, so nothing but a Studio session can
    // say yes to a rule (ET-TST-01): no tool, no daemon, no job
    if (parts[0] === "runtime" && parts.length === 1 && method === "GET") return say(200, runtimeView())
    if (parts[0] === "runtime" && parts[1] === "setup" && parts.length === 2 && method === "POST") return say(202, startSetup())
    if (parts[0] === "taste" && parts.length === 1 && method === "GET") return say(200, projects.taste.list())
    if (parts[0] === "taste" && parts.length === 3 && method === "POST") {
      const key = decodeURIComponent(parts[1])
      const act = { confirm: projects.taste.confirm, dismiss: projects.taste.dismiss, remove: projects.taste.remove }[parts[2]]
      if (!act || !act(key)) return refuse(res, 404, "That rule isn't there.")
      return say(200, projects.taste.list())
    }
    if (parts[0] === "media" && parts.length === 2 && method === "GET") {
      const found = media.get(parts[1])
      if (!found) return refuse(res, 404, "Not found.")
      return sendFile(req, res, await assetFile(await projects.get(found.project), found.asset))
    }
    if (parts[0] === "tiles" && parts.length === 2 && method === "GET") {
      const found = media.get(parts[1])
      const kind = url.searchParams.get("kind")
      if (!found || !["peaks", "thumbs"].includes(kind)) return refuse(res, 404, "Not found.")
      return sendFile(req, res, await assetFile(await projects.get(found.project), found.asset, kind))
    }

    if (parts[0] === "projects") {
      if (parts.length === 1 && method === "GET") return say(200, { projects: projects.list().map(({ id, name }) => ({ id, name })) })
      if (parts.length === 1 && method === "POST") {
        const { name, folder } = await readJson(req)
        if (typeof name !== "string" || !name.trim() || typeof folder !== "string") return refuse(res, 400, "A project needs a name and a folder.")
        const state = await projects.create({ name, folder })
        return say(200, { id: state.id })
      }
      const state = await needProject(res, parts[1])
      if (!state) return
      if (parts.length === 2 && method === "GET") return say(200, projectView(state))
      if (parts.length === 2 && method === "DELETE") return say(200, projects.remove(state.id, { running: (id) => jobs.runningIn(id) }))
      if (parts.length === 2 && method === "PATCH") {
        const { ops, undo } = await readJson(req)
        if (undo === true) {
          projects.undo(state)
          return say(200, { ...projectView(state), diagnostics: [] })
        }
        const result = projects.change(state, { ops, author: "person" })
        return say(result.ok ? 200 : 422, { ...projectView(state), diagnostics: result.diagnostics })
      }
      if (parts[2] === "assets" && method === "POST") {
        const { path } = await readJson(req)
        if (typeof path !== "string") return refuse(res, 400, "Give the file's path.")
        return say(200, withMedia(state, await projects.addAsset(state, path)))
      }
      if (parts[2] === "upload" && method === "POST") return upload(req, res, state, url)
      if (parts[2] === "plan" && method === "GET") {
        const { version } = await tools()
        // The solver's timeline too: the Studio's monitor and timeline place clips from it
        const { picture, audio, overlays, captions, duration } = solve(state.log.current, state.index)
        return say(200, { ...compile(state.log.current, state.index, { engineVersion: ENGINE_VERSION, runtimeVersion: version }), timeline: { picture, audio, overlays, captions, duration } })
      }
      if (parts[2] === "ask" && parts.length === 3 && method === "POST") {
        const { text, selection, history } = await readJson(req)
        if (typeof text !== "string" || !text.trim() || text.length > 2000) return refuse(res, 400, "Say what you want changed, in up to 2,000 characters.")
        // The chat's last turns, short and text only: nothing else of the browser's reaches the model
        const turns = Array.isArray(history) ? history.filter((h) => h && (h.who === "you" || h.who === "kriya") && typeof h.text === "string").slice(-6).map((h) => ({ who: h.who, text: h.text.slice(0, 400) })) : []
        return say(200, await projects.ask(state, { text, selection, history: turns }))
      }
      if (parts[2] === "proposals" && parts.length === 4 && method === "POST") {
        const { accept, only } = await readJson(req)
        if (typeof accept !== "boolean" || (only !== undefined && !(Array.isArray(only) && only.every(Number.isInteger)))) return refuse(res, 400, "Accept or reject the proposal.")
        const result = projects.decide(state, parts[3], { accept, only })
        return say(200, { ...result, ...projectView(state) })
      }
      if (parts[2] === "make" && parts.length === 3 && method === "POST") {
        const { asset, brief } = await readJson(req)
        const clean = {}
        if (brief && typeof brief === "object") {
          if (Number.isFinite(brief.seconds) && brief.seconds >= 5 && brief.seconds <= 600) clean.targetDuration = Math.round(brief.seconds * 705_600_000)
          if (Array.isArray(brief.mustKeep) && brief.mustKeep.every((id) => typeof id === "string" && id.length < 64)) clean.mustKeep = brief.mustKeep.slice(0, 20)
          if (brief.effort === "fast" || brief.effort === "best") clean.effort = brief.effort
          if (typeof brief.captions === "string" && Object.hasOwn(LOOKS, brief.captions)) clean.captions = brief.captions
          if (typeof brief.music === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(brief.music)) clean.music = brief.music
          if (typeof brief.reference === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(brief.reference)) clean.reference = brief.reference
          if (Object.hasOwn(FORMATS, brief.format)) clean.format = brief.format
          if (Object.hasOwn(GRADES, brief.grade)) clean.grade = brief.grade
          if (brief.cleanVoice === true) clean.cleanVoice = true
          // From the Director's approved plan: checked again in the recipe against the index
          const safeId = (v) => typeof v === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(v)
          if (Array.isArray(brief.references)) clean.references = brief.references.filter(safeId).slice(0, 6)
          if (safeId(brief.hook)) clean.hook = brief.hook
          if (brief.coldOpen && safeId(brief.coldOpen.from) && safeId(brief.coldOpen.to)) clean.coldOpen = { from: brief.coldOpen.from, to: brief.coldOpen.to, mono: brief.coldOpen.mono !== false }
          if (["whoosh", "pop"].includes(brief.cutSound)) clean.cutSound = brief.cutSound
          if (["riser", "hit"].includes(brief.introSound)) clean.introSound = brief.introSound
          if (Number.isInteger(brief.punches) && brief.punches >= 0 && brief.punches <= 8) clean.punches = brief.punches
          for (const flag of ["angles", "titles", "ramps"]) if (brief[flag] === true) clean[flag] = true
          if (brief.broll === "own") clean.broll = "own"
        }
        if (asset !== undefined && typeof asset !== "string") return refuse(res, 400, "Name the take.")
        return say(200, jobs.start(state, { kind: "make", ...(asset ? { asset } : {}), brief: clean }))
      }
      // The person fixes a word the recogniser misheard (UX_SPEC §5)
      if (parts[2] === "words" && parts.length === 4 && method === "POST") {
        const { text } = await readJson(req)
        if (typeof text !== "string" || text.length > 60 || /[\n\r<>]/.test(text)) return refuse(res, 400, "Give the word as it should read, in up to 60 characters.")
        return say(200, { word: projects.correctWord(state, decodeURIComponent(parts[3]), text) })
      }
      // The Director's plan: proposed in words with its settings; nothing is made here
      if (parts[2] === "plan" && parts.length === 3 && method === "POST") {
        const { text, history, previous, choices } = await readJson(req)
        if (typeof text !== "string" || !text.trim() || text.length > 2000) return refuse(res, 400, "Say what you want, in up to 2,000 characters.")
        const turns = Array.isArray(history) ? history.filter((h) => h && (h.who === "you" || h.who === "kriya") && typeof h.text === "string").slice(-6).map((h) => ({ who: h.who, text: h.text.slice(0, 400) })) : []
        const prior = previous && typeof previous === "object" ? { say: String(previous.say ?? "").slice(0, 900), steps: Array.isArray(previous.steps) ? previous.steps.slice(0, 10).map((s) => String(s).slice(0, 240)) : [], settings: previous.settings && typeof previous.settings === "object" ? previous.settings : {} } : null
        return say(200, await projects.plan(state, { text, history: turns, previous: prior, choices: choices && typeof choices === "object" ? choices : {} }))
      }
      // A reference's classified analysis, measured once and kept
      if (parts[2] === "references" && parts.length === 4 && method === "GET") return say(200, await projects.referenceAnalysis(state, decodeURIComponent(parts[3])))
      if (parts[2] === "export" && parts[3] === "handoff" && parts.length === 4 && method === "POST") return say(200, projects.handoff(state))
      if (parts[2] === "index" && parts.length === 3 && method === "GET") {
        const { words, sentences, takes, shots } = state.index
        return say(200, { assets: projects.indexStatus(state), words, sentences, takes, shots })
      }
      if (parts[2] === "index" && parts.length === 3 && method === "POST") {
        const { asset } = await readJson(req)
        if (typeof asset !== "string" || !state.log.current.assets.some((item) => item.id === asset)) return refuse(res, 400, "Name an asset in this project.")
        return say(200, jobs.start(state, { kind: "index", asset }))
      }
    }

    if (parts[0] === "jobs") {
      if (method === "GET" && parts.length === 1) return say(200, { jobs: await jobs.list() })
      if (method === "POST" && parts.length === 1) {
        const { project, quality, deliverable } = await readJson(req)
        if (!["draft", "master"].includes(quality)) return refuse(res, 400, "A job's quality is draft or master.")
        const state = await needProject(res, project)
        if (!state) return
        return say(200, jobs.start(state, { quality, ...(deliverable ? { deliverable } : {}) }))
      }
      if (method === "DELETE" && parts.length === 2) return jobs.cancel(parts[1]) ? say(200, {}) : refuse(res, 404, "That job isn't running.")
      // `kriya edit replay <job>`: a new job that repeats a finished make from its recording
      if (method === "POST" && parts.length === 3 && parts[2] === "replay") {
        const match = /^([0-9a-f]{16})\.(\d+)$/.exec(parts[1])
        if (!match) return refuse(res, 400, "A job id looks like <project>.<number>.")
        const state = await needProject(res, match[1])
        if (!state) return
        return say(200, jobs.start(state, { kind: "replay", of: Number(match[2]) }))
      }
    }
    refuse(res, 404, "Not found.")
  }

  function mintToken(back = null) {
    const token = randomBytes(32).toString("base64url")
    tokens.set(sha(token), { expires: Date.now() + tokenTtlMs, back: backOf(back, port()) })
    return token
  }

  /** @param {boolean} overSocket the socket is owner-only, so it needs no fence or session */
  return async function handle(req, res, overSocket) {
    onActivity(1)
    const url = new URL(req.url, "http://host")
    try {
      if (overSocket) {
        if (url.pathname === "/internal/info") return json(res, 200, { pid, port: port(), stamp, busy: busy() })
        if (url.pathname === "/internal/launch" && req.method === "POST") {
          const token = mintToken((await readJson(req)).back)
          return json(res, 200, { token, url: `http://127.0.0.1:${port()}/launch#${token}` })
        }
        // The harness says a person is working there: the Governor leaves room (EDIT_LOOP §8)
        if (url.pathname === "/internal/live" && req.method === "POST") {
          onLive()
          return json(res, 200, {})
        }
        // The daemon's handover of a job from Kriya, and Kriya's cancel (EH-02, EH-03)
        if (url.pathname === "/internal/job" && req.method === "POST") {
          const body = await readJson(req)
          const valid = UUID.test(body.dispatch) && UUID.test(body.job) && typeof body.folder === "string" && typeof body.brief === "string" && body.brief.length > 0 && body.brief.length <= 4000 && ["fast", "best"].includes(body.effort)
          if (!valid) return refuse(res, 400, "That job isn't complete.")
          return json(res, 200, await tavi.accept(body))
        }
        if (url.pathname === "/internal/cancel" && req.method === "POST") {
          const { dispatch } = await readJson(req)
          return json(res, 200, { known: UUID.test(dispatch) && tavi.cancel({ dispatch }) })
        }
        if (url.pathname === "/internal/stop" && req.method === "POST") {
          json(res, 200, {})
          return onStop()
        }
        if (url.pathname.startsWith("/taste")) return refuse(res, 403, "Only the person can change their rules, in the Studio.")
        return await route(req, res, url)
      }
      if (!fenced(req)) return refuse(res, 403, "Not from here.")
      // The app's own files carry nothing private; what they ask for needs the session
      if (req.method === "GET" && Object.hasOwn(STUDIO_FILES, url.pathname)) return studioFile(res, url.pathname)
      if (req.method === "GET" && url.pathname === "/launch") return page(res, "text/html; charset=utf-8", LAUNCH_PAGE)
      if (req.method === "GET" && url.pathname === "/launch.js") return page(res, "text/javascript", LAUNCH_SCRIPT)
      if (req.method === "POST" && url.pathname === "/session") return openSession(req, res, await readJson(req))
      if (url.pathname.startsWith("/internal/")) return refuse(res, 404, "Not found.")
      if (!hasSession(req)) return refuse(res, 401, "Open the Studio from Kriya.")
      await route(req, res, url)
    } catch (error) {
      if (res.headersSent) return res.destroy()
      if (error instanceof EngineFailure) return refuse(res, statusOf(error), error.message)
      log(`request failed: ${error.name}`)
      refuse(res, 500, "Something went wrong.")
    } finally {
      onActivity(-1)
    }
  }
}

