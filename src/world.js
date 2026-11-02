import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { call, KriyaError } from "./api.js"
import { createRunner } from "./runner.bundle.js"
import { CLIENT_VERSION } from "./paths.js"

// `kriya serve [folder]` (H10, HD-12): this machine as the execution world
// of the person's cloud tasks. One outbound WebSocket to kriya-relay; the
// worker's runner requests arrive as frames (kriya-relay/1) and go to track
// C's own runner (src/runner.bundle.js, the same protocol as a cloud
// sandbox, CD-26), one per workspace, each in its own fresh folder
// <folder>/<workspace id>-<generation>, so the agent never works in files
// the person put there. Lifecycle requests (/world/*) come from the worker;
// runner requests carry the workspace's own token, which the runner checks.

const REF = /^device-([0-9a-f-]{36})-([0-9a-f-]{36})-(\d{1,9})$/
const DIR = /^([0-9a-f-]{36})-(\d{1,9})$/
// The relay accepts frames up to 512 KiB; body chunks stay well under it
const CHUNK = 256 * 1024

const text = (value) => Buffer.from(JSON.stringify(value)).toString("base64")

/**
 * The frame handler, apart from the socket (tests drive it directly).
 * @param {{ folder: string, deviceId: string, runnerFactory?: typeof createRunner }} options
 */
export function createWorld({ folder, deviceId, runnerFactory = createRunner }) {
  /** @type {Map<string, { url: string, close: () => Promise<void> }>} */
  const runners = new Map()
  const pending = new Map()
  const aborts = new Map()

  const dirOf = (ref) => {
    const match = REF.exec(String(ref ?? ""))
    return match && match[1] === deviceId ? join(folder, `${match[2]}-${match[3]}`) : null
  }

  async function world(route, body) {
    if (route === "/world/list") {
      const names = await readdir(folder).catch(() => [])
      const refs = names
        .map((name) => DIR.exec(name))
        .filter(Boolean)
        .map(([, workspaceId, generation]) => {
          const ref = `device-${deviceId}-${workspaceId}-${generation}`
          return { ref, running: runners.has(ref) }
        })
      return [200, { refs }]
    }
    const dir = dirOf(body.ref)
    if (!dir) return [400, { error: "not a workspace of this machine" }]
    const ref = body.ref
    if (route === "/world/open") {
      const exists = await stat(dir).then(
        (found) => found.isDirectory(),
        () => false
      )
      if (body.fresh) {
        // A fresh generation never reuses a folder: the runner imports into an empty one
        if (exists) return [409, { error: "that workspace folder already exists" }]
        await mkdir(dir, { recursive: true })
      } else if (!exists) {
        return [404, { error: "this machine no longer has that workspace" }]
      }
      await runners.get(ref)?.close()
      runners.delete(ref)
      runners.set(
        ref,
        await runnerFactory({
          root: dir,
          token: String(body.token ?? ""),
          generation: Number(body.generation),
          limits: body.limits ?? {},
          // The person's own account runs the commands (no sandbox here)
          home: homedir(),
          path: process.env.PATH ?? "/usr/bin:/bin",
        })
      )
      return [200, { opened: true }]
    }
    if (route === "/world/pause" || route === "/world/destroy") {
      await runners.get(ref)?.close()
      runners.delete(ref)
      // Only the workspace's own folder, never anything else in the served one
      if (route === "/world/destroy") await rm(dir, { recursive: true, force: true })
      return [200, { ok: true }]
    }
    return [404, { error: "not found" }]
  }

  async function handle(id, send) {
    const request = pending.get(id)
    pending.delete(id)
    const body = Buffer.concat(request.chunks)
    try {
      if (request.path.startsWith("/world/")) {
        let parsed = {}
        try {
          parsed = body.length ? JSON.parse(String(body)) : {}
        } catch {
          parsed = null
        }
        const [status, answer] = parsed ? await world(request.path, parsed) : [400, { error: "not JSON" }]
        send({ t: "res", id, status, headers: { "content-type": "application/json" } })
        send({ t: "body", id, data: text(answer) })
        return send({ t: "end", id })
      }
      const runner = runners.get(request.headers["x-kriya-world-ref"] ?? "")
      if (!runner) {
        send({ t: "res", id, status: 503, headers: { "content-type": "application/json" } })
        send({ t: "body", id, data: text({ error: "that workspace isn't open on this machine" }) })
        return send({ t: "end", id })
      }
      const abort = new AbortController()
      aborts.set(id, abort)
      const headers = { ...request.headers }
      delete headers["x-kriya-world-ref"]
      const response = await fetch(runner.url + request.path, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
        signal: abort.signal,
      })
      send({ t: "res", id, status: response.status, headers: Object.fromEntries(response.headers) })
      for await (const chunk of response.body ?? []) {
        for (let at = 0; at < chunk.length; at += CHUNK) {
          send({ t: "body", id, data: Buffer.from(chunk.subarray(at, at + CHUNK)).toString("base64") })
        }
      }
      send({ t: "end", id })
    } catch (error) {
      // The message only: request bodies and file contents stay on this machine
      send({ t: "error", id, message: String(error?.message ?? error).slice(0, 200) })
    } finally {
      aborts.delete(id)
    }
  }

  return {
    runners,
    /** @param {any} frame @param {(frame: unknown) => void} send */
    onFrame(frame, send) {
      if (typeof frame?.id !== "number") return
      if (frame.t === "req") {
        pending.set(frame.id, {
          method: String(frame.method),
          path: String(frame.path),
          headers: frame.headers ?? {},
          chunks: [],
        })
      } else if (frame.t === "body") {
        pending.get(frame.id)?.chunks.push(Buffer.from(String(frame.data), "base64"))
      } else if (frame.t === "end") {
        if (pending.has(frame.id)) return handle(frame.id, send)
      } else if (frame.t === "abort") {
        pending.delete(frame.id)
        aborts.get(frame.id)?.abort()
      }
    },
    // Runners stop; every folder stays (the worker destroys what it no longer needs)
    async close() {
      for (const abort of aborts.values()) abort.abort()
      for (const runner of runners.values()) await runner.close()
      runners.clear()
    },
  }
}

export class ServeError extends Error {}

/** The served folder: an existing directory, as its real path */
export async function servedFolder(given) {
  let folder
  try {
    folder = await realpath(given)
  } catch {
    throw new ServeError(`${given} doesn't exist; create the folder first.`)
  }
  if (!(await stat(folder)).isDirectory()) throw new ServeError(`${given} isn't a folder.`)
  return folder
}

/**
 * Serves `folder` until stopped: connects, reconnects with back-off, stops for
 * good when Kriya signs this device out or another `kriya serve` replaces it.
 * @param {{ device: { url: string, token: string }, folder: string, say?: (line: string) => void,
 *   signal?: AbortSignal, WebSocketImpl?: typeof WebSocket, runnerFactory?: typeof createRunner,
 *   backoffMs?: number }} options
 */
export async function serve({ device, folder, say = () => {}, signal, WebSocketImpl = WebSocket, runnerFactory, backoffMs = 1000 }) {
  if (process.platform === "win32") throw new ServeError("kriya serve needs macOS or Linux (the runner uses bash).")
  const where = async () => {
    try {
      return await call(device.url, "GET", "/world", { token: device.token })
    } catch (error) {
      if (error instanceof KriyaError && error.status === 404)
        throw new ServeError("Your Kriya doesn't have the device world turned on.")
      if (error instanceof KriyaError && error.status === 401)
        throw new ServeError("This device is signed out; run kriya login.")
      throw error
    }
  }
  const { deviceId, relayUrl } = await where()
  const world = createWorld({ folder, deviceId, runnerFactory })
  const url = `${relayUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/device/${deviceId}`
  let delay = backoffMs
  try {
    while (!signal?.aborted) {
      const outcome = await new Promise((done) => {
        const socket = new WebSocketImpl(url, {
          headers: { Authorization: `Bearer ${device.token}`, "X-Kriya-Harness": CLIENT_VERSION },
        })
        const send = (frame) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(frame))
        }
        const stop = () => socket.close()
        signal?.addEventListener("abort", stop, { once: true })
        let opened = false
        socket.addEventListener("open", () => {
          opened = true
          delay = backoffMs
          say(`Serving ${folder} to your Kriya agents. Stop with Ctrl-C.`)
        })
        socket.addEventListener("message", (event) => {
          let frame
          try {
            frame = JSON.parse(String(event.data))
          } catch {
            return
          }
          void world.onFrame(frame, send)
        })
        socket.addEventListener("close", (event) => {
          signal?.removeEventListener("abort", stop)
          done({ opened, code: event.code })
        })
      })
      if (signal?.aborted) break
      if (outcome.code === 4000) throw new ServeError("Another kriya serve took over for this device.")
      if (outcome.code === 4001) throw new ServeError("This device was signed out; run kriya login.")
      // Refused at the door: find out why (signed out, switched off) before
      // retrying. Kriya being unreachable is no answer: try again later
      if (!outcome.opened) {
        try {
          await where()
        } catch (error) {
          if (error instanceof ServeError) throw error
        }
      } else say("Lost the connection to Kriya; reconnecting…")
      await new Promise((resume) => {
        const wake = () => {
          clearTimeout(timer)
          resume()
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", wake)
          resume()
        }, delay)
        signal?.addEventListener("abort", wake, { once: true })
      })
      delay = Math.min(delay * 2, 30_000)
    }
  } finally {
    await world.close()
  }
}
