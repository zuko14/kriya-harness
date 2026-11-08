// Reaching the Host from anything else: one socket, mode 0600, no port, no cookie.
// `ensureHost` starts one, detached, so it outlives whoever asked (EH-05).

import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"

import { kriyaHome } from "../../paths.js"
import { editHome, logPath, socketPath } from "./paths.js"

const START_MS = 15_000

/** @returns {Promise<any>} the parsed answer; rejects when the Host isn't there or refuses */
export function hostCall(home, method, path, body) {
  return new Promise((done, fail) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = request({ socketPath: socketPath(home), method, path, headers: { host: "kriya-edit", ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        const json = text ? JSON.parse(text) : null
        if (res.statusCode >= 400) fail(new Error(json?.message ?? `The Edit Host answered ${res.statusCode}.`))
        else done(json)
      })
    })
    req.on("error", fail)
    if (data) req.write(data)
    req.end()
  })
}

const contact = (home) => hostCall(home, "GET", "/internal/info").catch(() => null)

/** The running Host, started if need be. @returns {Promise<{ pid: number, port: number }>} */
export async function ensureHost({ env = process.env, home = kriyaHome() } = {}) {
  const live = await contact(home)
  if (live) return live
  mkdirSync(editHome(home), { recursive: true })
  const log = openSync(logPath(home), "a")
  const main = join(import.meta.dirname, "main.js")
  spawn(process.execPath, [main], { detached: true, stdio: ["ignore", log, log], env: { ...env, KRIYA_HOME: home } }).unref()
  const started = Date.now()
  while (Date.now() - started < START_MS) {
    const answer = await contact(home)
    if (answer) return answer
    await new Promise((done) => setTimeout(done, 40))
  }
  throw new Error(`The Edit Host didn't start. See ${logPath(home)}.`)
}

/** Stops the Host and waits until it's gone. */
export async function stopHost(home = kriyaHome()) {
  await hostCall(home, "POST", "/internal/stop").catch(() => null)
  const started = Date.now()
  while ((await contact(home)) && Date.now() - started < START_MS) await new Promise((done) => setTimeout(done, 25))
}
