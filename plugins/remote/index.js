import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import { deviceSender, externalDaemon, offeredProjects, runDaemon } from "../../src/daemon.js"
import { liveChange } from "../../src/live.js"
import { kriyaHome } from "../../src/paths.js"
import { readDevice } from "../../src/store.js"

// Remote Control (Kriya-Tavi docs/kriya-harness/REMOTE_CONTROL.md): the switch
// in a session's Overview tab. On, this process (1) streams that session to
// the person's Kriya and (2) listens for the Control Center in that session's
// folder, the same runDaemon `kriya daemon` runs, for as long as this app
// runs. Allow serving and Allow Full access are set here, on the computer
// (CC-D3): nothing in Kriya can turn them on. Each is off until the person
// turns it on.

export const name = "kriya-remote"
export const inject = ["connection", "sessions"]
export const ROUTE = "/api/kriya.remote"

const FLUSH_MS = 2_000
const HEARTBEAT_MS = 30_000
const MAX_BACKOFF = 60_000
const BATCH = 100
const MAX_QUEUE = 2_000

// This process's Remote Control, for Delete session (plugins/sessions)
export const running = { current: null }

export const stateFile = () => join(kriyaHome(), "remote.json")

export function readState(file = stateFile()) {
  try {
    const kept = JSON.parse(readFileSync(file, "utf8"))
    return { sessions: kept.sessions ?? {}, fullAccess: kept.fullAccess === true, serve: kept.serve === true, edit: kept.edit === true }
  } catch {
    return { sessions: {}, fullAccess: false, serve: false, edit: false }
  }
}

/**
 * Remote Control's state, apart from DSH so tests drive it directly.
 * @param {{
 *   device: () => { url: string, token: string } | null,
 *   sender?: (device: any) => Promise<(method: string, path: string, body?: unknown) => Promise<unknown>>,
 *   daemon?: (options: any) => Promise<void>,
 *   external?: () => boolean,
 *   file?: string,
 *   log?: (text: string) => void,
 *   flushMs?: number,
 *   heartbeatMs?: number,
 *   refusedMs?: number,
 * }} host
 */
export function remote(host) {
  const file = host.file ?? stateFile()
  const sender = host.sender ?? deviceSender
  const daemon = host.daemon ?? runDaemon
  const external = host.external ?? externalDaemon
  const log = host.log ?? (() => {})
  const flushMs = host.flushMs ?? FLUSH_MS
  const heartbeatMs = host.heartbeatMs ?? HEARTBEAT_MS
  const state = readState(file)

  const streams = new Map() // session id → { queue, calls, state, dirty, sentAt }
  let send = null
  let timer = null
  let flushing = null
  let failures = 0
  let unavailable = false
  let listening = null // { stop, control, done }
  let closed = false
  let unsaved = false

  const save = () => {
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
    if (process.platform !== "win32") chmodSync(temporary, 0o600)
    renameSync(temporary, file)
  }

  const streamOf = (id) => {
    let stream = streams.get(id)
    if (!stream) streams.set(id, (stream = { queue: [], calls: new Map(), state: "idle", dirty: true, sentAt: 0 }))
    return stream
  }

  const folders = () => [...new Set(Object.values(state.sessions).map((s) => s.folder).filter(Boolean))]

  // Listening follows the switches; an update never stops a running task
  async function syncDaemon() {
    const wanted = folders()
    const options = { folders: wanted, allowFullAccess: state.fullAccess, allowServe: state.serve, allowEdit: state.edit }
    const device = host.device()
    if (!wanted.length || !device || external()) {
      if (listening) {
        listening.stop.abort()
        await listening.done
        listening = null
      }
      return
    }
    if (listening) return listening.control.update?.(options)
    const stop = new AbortController()
    const control = {}
    const done = daemon({ ...options, device, signal: stop.signal, control, log }).catch((error) => log(`listening stopped: ${error.message}`))
    listening = { stop, control, done }
  }

  const schedule = (ms) => {
    clearTimeout(timer)
    if (closed) return
    timer = setTimeout(flush, ms)
    timer.unref?.()
  }

  // One session's next report; false when Kriya should be asked again later
  async function report(id, meta, stream) {
    const events = stream.queue.slice(0, BATCH)
    try {
      send ??= await sender(host.device())
      await send("POST", "/live", {
        deviceSessionId: id,
        ...(meta.title && { title: meta.title }),
        ...(meta.project && { project: meta.project }),
        remote: !meta.off,
        state: meta.off ? "ended" : stream.state,
        events,
      })
    } catch (error) {
      if (error.status === 404) {
        unavailable = true
        return true
      }
      // Refused as it stands: this batch won't ever pass
      if (error.status !== 400) return false
      log(`Kriya refused a live report (${error.code}); skipped`)
    }
    unavailable = false
    stream.queue.splice(0, events.length)
    stream.dirty = stream.queue.length > 0
    stream.sentAt = Date.now()
    return true
  }

  async function flush() {
    flushing ??= (async () => {
      let ok = true
      if (host.device()) {
        for (const [id, stream] of streams) {
          const meta = state.sessions[id] ?? stream.ending
          if (!meta) {
            streams.delete(id)
            continue
          }
          if (!stream.dirty && Date.now() - stream.sentAt < heartbeatMs) continue
          ok = (await report(id, meta, stream)) && ok
          // One refusal answers for every session; events stay queued for when it's on
          if (unavailable) break
          if (stream.ending && !stream.queue.length) streams.delete(id)
        }
      }
      failures = ok ? 0 : failures + 1
      if (unsaved) save()
      unsaved = false
    })().finally(() => (flushing = null))
    await flushing
    // Refused by the server: ask rarely, these count against the device's requests per minute
    schedule(unavailable ? (host.refusedMs ?? MAX_BACKOFF) : failures ? Math.min(flushMs * 2 ** failures, MAX_BACKOFF) : flushMs)
  }

  return {
    state,
    /** A DSH session event; only switched-on sessions are read */
    onEvent(id, event) {
      const meta = state.sessions[id]
      if (!meta) return
      const stream = streamOf(id)
      const change = liveChange(event, stream.calls)
      if (!change) return
      if (change.state) stream.state = change.state
      if (change.title && !meta.title) meta.title = change.title
      if (change.line) {
        unsaved = true
        stream.queue.push({ seq: meta.seq++, at: Math.round(event.time) || Date.now(), ...change.line })
        if (stream.queue.length > MAX_QUEUE) stream.queue.splice(0, stream.queue.length - MAX_QUEUE)
      }
      stream.dirty = true
    },
    /** The person's switch: on or off for one session, or the computer's two allowances */
    async set(id, change, session) {
      if (change.on === true && !state.sessions[id]) {
        state.sessions[id] = { folder: session.folder, project: basename(session.folder ?? "").slice(0, 80), title: session.title, seq: 0 }
        streamOf(id)
      }
      if (change.on === false && state.sessions[id]) {
        const stream = streamOf(id)
        stream.ending = { ...state.sessions[id], off: true }
        stream.dirty = true
        delete state.sessions[id]
      }
      if (typeof change.serve === "boolean") state.serve = change.serve
      if (typeof change.fullAccess === "boolean") state.fullAccess = change.fullAccess
      if (typeof change.edit === "boolean") state.edit = change.edit
      // Nothing left on: no allowance stays behind for the next time
      if (!Object.keys(state.sessions).length) state.serve = state.fullAccess = state.edit = false
      save()
      await syncDaemon()
      schedule(0)
    },
    /** What the Overview tab shows for one session */
    status(id) {
      const device = host.device()
      const on = Boolean(state.sessions[id])
      let kriya
      try {
        kriya = device ? new URL(device.url).host : undefined
      } catch {
        kriya = undefined
      }
      return {
        signedIn: Boolean(device),
        on,
        unavailable,
        host: kriya,
        daemon: external() ? "external" : listening ? "listening" : "off",
        folderOffered: on && offeredProjects([state.sessions[id].folder ?? ""]).length > 0,
        serve: state.serve,
        fullAccess: state.fullAccess,
        // Only with editing on: off, this answer is what it always was (ET-REG-01)
        ...(process.env.KRIYA_EDIT === "on" && { edit: state.edit }),
      }
    },
    /** A deleted session leaves the stream */
    forget(id) {
      if (state.sessions[id]) return this.set(id, { on: false })
    },
    /** Sessions left on by the last run carry on */
    async start() {
      // Past anything the last run numbered but didn't save: Kriya keeps the first of each seq
      for (const [id, meta] of Object.entries(state.sessions)) {
        meta.seq += MAX_QUEUE
        streamOf(id)
      }
      if (streams.size) save()
      await syncDaemon()
      if (streams.size) schedule(0)
    },
    async close() {
      closed = true
      clearTimeout(timer)
      listening?.stop.abort()
      await listening?.done
      listening = null
      if (existsSync(file)) save()
    },
  }
}

export function apply(ctx) {
  const r = remote({ device: readDevice, log: (text) => ctx.logger("kriya-remote").info(text) })
  const sessionOf = async (id) => {
    const header = ctx.sessions.get(id)?.header ?? (await ctx.get("sessionPersistence")?.stat(id))?.header
    return header && { folder: header.cwd, title: header.title }
  }
  const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
  ctx.on("session/event", (session, event) => {
    if (typeof session?.id === "string") r.onEvent(session.id, event)
  })
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          const id = new URL(request.url).searchParams.get("session")
          if (!id || id.length > 100) return reply({ error: "Which session?" }, 400)
          if (request.method === "GET") return reply(r.status(id))
          const body = await request.json().catch(() => null)
          const session = await sessionOf(id)
          if (!body || !session) return reply({ error: "That session isn't known here." }, 400)
          if (body.on === true && !readDevice()) return reply({ error: "Sign in with kriya login first." }, 400)
          // The allowances exist only while Remote Control is on
          if ((body.serve === true || body.fullAccess === true || body.edit === true) && !r.state.sessions[id]) return reply({ error: "Turn on Remote Control first." }, 400)
          await r.set(id, { on: body.on, serve: body.serve, fullAccess: body.fullAccess, edit: body.edit }, session)
          return reply(r.status(id))
        },
      }),
    "kriya-remote: route"
  )
  ctx.effect(() => {
    r.start().catch((error) => ctx.logger("kriya-remote").warn(error))
    return () => r.close()
  }, "kriya-remote: run")
  running.current = r
}
