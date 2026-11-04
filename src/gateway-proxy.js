import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { gzipSync } from "node:zlib"

import { BASE_PATH } from "./api.js"

// The local relay between DSH and the Kriya gateway (2026-11-04, owner
// decision in chat: "Encode bodies (I approve)"). Kriya's host (Render,
// behind Cloudflare) runs a web application firewall that reads request
// bodies, and Render offers no setting to exclude a path. An agent's
// conversation is full of what such rules match (shell commands, HTML,
// test code, paths): on a real long task the host answered a 403 "Blocked"
// page mid-turn, DSH read it as "API key is invalid", and every later turn
// re-sent the same history and was blocked again. Harness requests are
// authenticated by the device token, and their content is model input the
// server never executes; the gateway validates every decoded body with the
// same schema as before.
//
// When Kriya says it reads them (GET /models `bodyEncodings`), JSON bodies
// go as gzip then base64 (`x-kriya-body: gzip+base64`); otherwise they go
// unchanged. A firewall block page is turned into a plain 400 that says
// what happened, never a 401/403 (which DSH reports as a bad API key).
//
// Loopback only, on a random port; adds no credential (DSH sends the device
// token itself); forwards only under the harness API's path to the
// signed-in Kriya; streams answers back unchanged; stops the upstream
// request when DSH hangs up.

export const BODY_ENCODING = "gzip+base64"
// Larger requests are refused locally (a 1M-token history is about 4 MB of JSON)
export const MAX_BODY = 64 * 1024 * 1024
// While Kriya doesn't decode encoded bodies, how often it is asked again (a deploy after launch)
export const RECHECK_MS = 60_000
// Before a blocked request is sent once more, unencoded
export const RETRY_MS = 2_000
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "content-length", "transfer-encoding", "accept-encoding", "expect", "upgrade", "proxy-connection"])
const DROP_RESPONSE = new Set(["connection", "keep-alive", "content-length", "transfer-encoding", "content-encoding"])

/** The host firewall's block page, as { requestId }, or null for anything else */
export function firewallBlock(status, contentType, text) {
  if (status !== 403 || !/text\/html/i.test(contentType ?? "")) return null
  if (!/web application firewall/i.test(text)) return null
  return { requestId: /Request ID:\s*(?:<[^>]+>\s*)*([A-Za-z0-9-]{6,64})/i.exec(text)?.[1] ?? null }
}

/** What DSH is told about a block: a 400 (shown, not retried) */
export function blockedAnswer(requestId) {
  const message =
    `Kriya's host firewall blocked this request${requestId ? ` (request ID ${requestId})` : ""}. ` +
    "Your sign-in is fine. Update Kriya Harness and restart it; if it happens again, give the Kriya owner the request ID."
  return JSON.stringify({ error: { message, type: "blocked_by_host", code: "blocked_by_host" } })
}

/** A JSON body in the form the gateway decodes */
export const encodeBody = (buffer) => Buffer.from(gzipSync(buffer).toString("base64"), "ascii")

async function readAll(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Starts the relay in front of `target` (the signed-in Kriya's address).
 * `encode`: whether Kriya decodes encoded bodies, as known at launch.
 * `checkSupport` asks Kriya again (GET /models): while encoding is off it
 * is asked at most every RECHECK_MS, and at once after a firewall block,
 * so a Kriya deployed after launch is picked up without a restart.
 * A request the firewall blocked never reached Kriya, so it is sent once
 * more: encoded if Kriya now decodes it, else after RETRY_MS. Only then is
 * the block reported.
 * @param {{ target: string, encode: boolean, checkSupport?: () => Promise<boolean>, fetchImpl?: typeof fetch, log?: (text: string) => void, now?: () => number, retryMs?: number }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, encoding: () => boolean }>} url stands in for device.url inside DSH
 */
export async function startGatewayProxy({ target, encode, checkSupport, fetchImpl = fetch, log = () => {}, now = Date.now, retryMs = RETRY_MS }) {
  const origin = new URL(target).origin
  const support = { on: Boolean(encode), checked: now(), pending: null }
  // One question at a time; a failed question changes nothing
  const recheck = () => {
    if (support.on || !checkSupport) return Promise.resolve(support.on)
    support.pending ??= checkSupport()
      .then((on) => {
        if (on && !support.on) log("Kriya now decodes encoded request bodies; using them")
        support.on = Boolean(on)
      })
      .catch(() => {})
      .finally(() => {
        support.checked = now()
        support.pending = null
      })
    return support.pending.then(() => support.on)
  }
  const server = createServer(async (req, res) => {
    const upstream = new AbortController()
    res.on("close", () => upstream.abort())
    const reply = (status, body) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(body)
    }
    const error = (status, message) => reply(status, JSON.stringify({ error: { message } }))
    try {
      const path = new URL(req.url ?? "/", "http://relay").pathname
      if (path !== BASE_PATH && !path.startsWith(`${BASE_PATH}/`)) return error(404, "Not a Kriya Harness route.")
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readAll(req)
      if (body === null) return error(413, "This request is larger than Kriya Harness sends (64 MB).")
      const headers = {}
      for (const [name, value] of Object.entries(req.headers)) if (!DROP_REQUEST.has(name) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value
      const plain = body?.length ? body : undefined
      const encodable = Boolean(plain) && /^application\/json\b/i.test(headers["content-type"] ?? "")
      if (encodable && !support.on && now() - support.checked >= RECHECK_MS) await recheck()
      const send = (encoded) => {
        const h = { ...headers }
        let sent = plain
        if (encoded) {
          sent = encodeBody(plain)
          h["content-type"] = "text/plain; charset=us-ascii"
          h["x-kriya-body"] = BODY_ENCODING
        }
        return fetchImpl(`${origin}${req.url}`, { method: req.method, headers: h, body: sent, signal: upstream.signal, redirect: "manual" })
      }
      /** The firewall's block, or null; a 403 web page's body is read here (it is never passed on) */
      const blockOf = async (answer) => {
        const type = answer.headers.get("content-type") ?? ""
        if (answer.status !== 403 || !/text\/html/i.test(type)) return null
        return firewallBlock(answer.status, type, await answer.text().catch(() => "")) ?? null
      }
      let encoded = encodable && support.on
      let answer = await send(encoded)
      let block = await blockOf(answer)
      if (block) {
        log(`the host firewall blocked ${req.method} ${path}${encoded ? " (encoded)" : ""}${block.requestId ? ` (request ID ${block.requestId})` : ""}; sending it once more`)
        // It never reached Kriya, so sending it again repeats nothing
        if (encodable && !encoded && (await recheck())) encoded = true
        else await new Promise((done) => setTimeout(done, retryMs))
        answer = await send(encoded)
        block = await blockOf(answer)
        if (block) {
          log(`the host firewall blocked ${req.method} ${path} again${block.requestId ? ` (request ID ${block.requestId})` : ""}`)
          return reply(400, blockedAnswer(block.requestId))
        }
      }
      if (answer.status === 403 && /text\/html/i.test(answer.headers.get("content-type") ?? ""))
        return error(502, "Kriya answered with a web page instead of an answer; try again in a minute.")
      const out = {}
      answer.headers.forEach((value, name) => {
        if (!DROP_RESPONSE.has(name)) out[name] = value
      })
      res.writeHead(answer.status, out)
      if (!answer.body) return res.end()
      await pipeline(Readable.fromWeb(answer.body), res)
    } catch (e) {
      if (upstream.signal.aborted) return
      log(`relay: ${e?.name ?? "error"}`)
      error(502, `Couldn't reach Kriya (${e?.cause?.code ?? e?.name ?? "network error"}).`)
    }
  })
  await new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", done)
  })
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address())
  return {
    url: `http://127.0.0.1:${port}`,
    encoding: () => support.on,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  }
}
