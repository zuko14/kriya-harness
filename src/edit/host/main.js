// The Edit Host: one process per machine, detached, owning every job (EDD-03). It
// holds a lock, listens on loopback and on an owner-only socket, and exits when idle.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { delimiter } from "node:path"

import { readCapabilities, toolVersion } from "../engine/capabilities.js"
import { gatewaySend } from "../director/gateway.js"
import { createScheduler, DEFAULT_SLOTS } from "../graph/scheduler.js"
import { createGovernor } from "../loop/governor.js"
import { kriyaHome } from "../../paths.js"
import { createJobs } from "./jobs.js"
import { codeStamp, editHome, isPipe, lockPath, portPath, socketPath } from "./paths.js"
import { createProjects } from "./projects.js"
import { createHandler } from "./server.js"
import { createTavi } from "./tavi.js"
import { createWatcher } from "./watch.js"

const home = kriyaHome()
const roots = (process.env.KRIYA_EDIT_ROOTS || homedir()).split(delimiter).filter(Boolean)
const idleMs = Number(process.env.KRIYA_EDIT_IDLE_MS) || 30 * 60_000
const tokenTtlMs = Number(process.env.KRIYA_EDIT_TOKEN_TTL_MS) || 60_000
const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`)

function takeLock() {
  mkdirSync(editHome(home), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath(home), String(process.pid), { flag: "wx", mode: 0o600 })
      return true
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const holder = Number(readFileSync(lockPath(home), "utf8"))
      try {
        process.kill(holder, 0)
        return false // A live Host holds it: whoever started this attaches to that one
      } catch {
        rmSync(lockPath(home), { force: true })
      }
    }
  }
  return false
}

if (!takeLock()) process.exit(0)

let tools
const readTools = () =>
  (tools ??= Promise.all([readCapabilities(), toolVersion()])
    .then(([capabilities, version]) => ({ capabilities, version }))
    .catch(() => ({ capabilities: { filters: new Set(), encoders: new Set() }, version: "missing" })))

const scheduler = createScheduler(DEFAULT_SLOTS)
const sse = new Set()
// One Governor for every Director call on this machine (EDIT_LOOP §8). "Live" is a
// harness Web UI with the Studio row that pinged in the last minute
let liveAt = 0
const governor = createGovernor({ send: gatewaySend(), live: () => Date.now() - liveAt < 60_000 })
const projects = createProjects({ home, roots, scheduler, tools: readTools, governor })
const tavi = createTavi({ home, projects, jobs: () => jobs, tools: readTools, log })
const jobs = createJobs({
  projects,
  log,
  onDispatch: (request, view, error) => tavi.onUpdate(request, view, error),
  beforeStory: (...args) => tavi.chooseTakes(...args),
  emit: (event, data) => {
    for (const res of sse) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  },
})

// New recordings, only for folders the person added on this computer (EDD-47)
const watcher = createWatcher({ home, send: tavi.post, log })

let lastActive = Date.now()
let inFlight = 0 // a request still running isn't idle, however long it takes
let port = 0
// What code this process runs, so an outdated Host is replaced once it's idle (client.js)
const stamp = codeStamp()
const handle = createHandler({ home, roots, projects, jobs, tavi, tools: readTools, tokenTtlMs, port: () => port, stamp, busy: () => jobs.count() + tavi.pending(), onActivity: (change = 0) => ((inFlight += change), (lastActive = Date.now())), onStop: () => shutdown(), onLive: () => (liveAt = Date.now()), sse, log, pid: process.pid })
const web = createServer((req, res) => handle(req, res, false))
const local = createServer((req, res) => handle(req, res, true))

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  log("stopping")
  for (const server of [web, local]) {
    server.close()
    server.closeAllConnections()
  }
  if (!isPipe(socketPath(home))) rmSync(socketPath(home), { force: true })
  tavi.close()
  watcher.close()
  projects.close()
  rmSync(lockPath(home), { force: true })
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

function listen(wanted) {
  return new Promise((done, fail) => {
    const failed = (error) => (error.code === "EADDRINUSE" && wanted !== 0 ? listen(0).then(done, fail) : fail(error))
    web.once("error", failed)
    web.listen(wanted, "127.0.0.1", () => {
      web.off("error", failed)
      done(web.address().port)
    })
  })
}

function storedPort() {
  try {
    return Number(readFileSync(portPath(home), "utf8")) || 0
  } catch {
    return 0
  }
}

port = await listen(storedPort())
writeFileSync(portPath(home), String(port))
// A Unix socket is a file: a stale one is cleared first, and only its owner may open it.
// A Windows named pipe is neither (paths.js): it goes when the Host does, and has no mode
const socket = socketPath(home)
if (!isPipe(socket)) rmSync(socket, { force: true })
await new Promise((done) => local.listen(socket, done))
if (!isPipe(socket)) chmodSync(socket, 0o600)
log(`listening on 127.0.0.1:${port}`)

void readTools()
void tavi.flush().catch(() => {})
await jobs.resume()

setInterval(() => {
  if (jobs.count() === 0 && tavi.pending() === 0 && watcher.count() === 0 && sse.size === 0 && inFlight === 0 && Date.now() - lastActive > idleMs) shutdown()
}, Math.max(50, Math.min(idleMs / 4, 30_000)))
