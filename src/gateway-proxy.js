import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"
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
// How long one request waits out a network outage. Under DSH's 5-minute stream timeout, and DSH
// retries a 502 five times, so a long task survives about 20 minutes offline: its own retries alone
// run out in about 15 seconds. Connections only: nothing below can have reached Kriya
export const OUTAGE_MS = 4 * 60_000
const OUTAGE_WAIT_MS = 15_000
const NO_CONNECTION = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT"])
// A pooled connection the host had closed. The request may have reached Kriya, so once only
const DEAD_SOCKET = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])
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

// Harness 2.0: the picker's local aliases (the "orchestra" choice), turned into the
// plan tier they stand for before a request leaves this computer, so Kriya only
// ever sees its own tier names (track H rule 4). Any other body passes untouched.
export const ORCHESTRA_ALIAS = "orchestra"
export function aliased(body, path, headers, aliases) {
  if (!body || !Object.keys(aliases).length || !path.endsWith("/chat/completions") || !/^application\/json\b/i.test(headers["content-type"] ?? "")) return body
  const text = body.toString("utf8")
  if (!Object.keys(aliases).some((alias) => text.includes(`"${alias}"`))) return body
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return body
  }
  if (typeof value?.model !== "string" || !Object.hasOwn(aliases, value.model)) return body
  return Buffer.from(JSON.stringify({ ...value, model: aliases[value.model] }))
}

// S-1 and own models (src/local-model.js, src/own-models.js): a chat request
// for a routed model id (`local`, `own-N`) goes to that model's own endpoint,
// with its real model name; nothing else goes there, and Kriya never sees it
export const LOCAL_MODEL = "local"
/** { route, body } for a routed model's chat request, else null */
export function routedBody(body, path, headers, routes) {
  if (!routes || !body || !path.endsWith("/chat/completions") || !/^application\/json\b/i.test(headers["content-type"] ?? "")) return null
  const text = body.toString("utf8")
  if (!Object.keys(routes).some((id) => text.includes(`"${id}"`))) return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const route = typeof value?.model === "string" && Object.hasOwn(routes, value.model) ? routes[value.model] : null
  if (!route) return null
  // OpenAI-compatible streams carry token counts only when asked; OpenRouter adds its cost to them
  const counted = value.stream ? { stream_options: { ...(value.stream_options ?? {}), include_usage: true } } : {}
  return { route, body: Buffer.from(JSON.stringify({ ...value, ...counted, model: route.model })) }
}
/** The S-1 shape, kept for its callers */
export const localBody = (body, path, headers, local) => routedBody(body, path, headers, local ? { [LOCAL_MODEL]: local } : null)?.body ?? null

/** Token counts (and a provider's own cost, in micro-USD) from the end of an answer: JSON or an SSE stream */
export function usageOf(tail) {
  const candidates = []
  for (const line of String(tail).split("\n").reverse()) {
    const text = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (text.startsWith("{") && /"usage"\s*:\s*\{/.test(text)) candidates.push(text)
  }
  if (!candidates.length && String(tail).trim().startsWith("{")) candidates.push(String(tail).trim())
  for (const text of candidates) {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    // Groq puts a stream's figures under x_groq
    const u = value?.usage ?? value?.x_groq?.usage
    if (!u || typeof u !== "object") continue
    const int = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
    const cost = typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0 ? Math.round(u.cost * 1_000_000) : undefined
    return { inputTokens: int(u.prompt_tokens), outputTokens: int(u.completion_tokens), ...(cost !== undefined && { reportedCostMicroUsd: cost }) }
  }
  return null
}

const TAIL = 256 * 1024
/** Passes an answer through untouched, keeping its tail to read the usage when it ends */
function counting(onEnd) {
  const decoder = new TextDecoder()
  let tail = ""
  return new TransformStream({
    transform(chunk, controller) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-TAIL)
      controller.enqueue(chunk)
    },
    flush() {
      onEnd(usageOf(tail + decoder.decode()))
    },
  })
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
export async function startGatewayProxy({ target, encode, checkSupport, aliases = {}, local = null, routes = null, onUsage = () => {}, fetchImpl = fetch, log = () => {}, now = Date.now, retryMs = RETRY_MS, outageMs = OUTAGE_MS, outageWaitMs = OUTAGE_WAIT_MS }) {
  const origin = new URL(target).origin
  const support = { on: Boolean(encode), checked: now(), pending: null }
  // Routed models: the person's own (with their key) and S-1's local model (without one)
  const table = { ...(routes ?? {}), ...(local && { [LOCAL_MODEL]: { ...local, provider: "local" } }) }
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
      // The picker's Orchestration alias first: its head may itself be a routed model
      const plain = aliased(body?.length ? body : undefined, path, headers, aliases)
      const routed = routedBody(plain, path, headers, Object.keys(table).length ? table : null)
      if (routed) {
        const { route } = routed
        const local = route.provider === "local"
        // Only the body, its type and the person's own key for that provider: never the device token or Kriya's headers
        let answer
        const send = (payload) =>
          fetchImpl(`${route.url}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: headers.accept ?? "*/*", ...(route.key && { authorization: `Bearer ${route.key}` }) },
            body: payload,
            signal: upstream.signal,
            redirect: "error",
          })
        try {
          answer = await send(routed.body)
          // A provider that refuses stream_options: once more without it (a refused request generated nothing)
          if ((answer.status === 400 || answer.status === 422) && routed.body.includes('"stream_options"')) {
            const value = JSON.parse(routed.body.toString("utf8"))
            delete value.stream_options
            await answer.body?.cancel().catch(() => {})
            answer = await send(Buffer.from(JSON.stringify(value)))
          }
        } catch (e) {
          if (e?.name === "AbortError") return
          log(`relay: ${local ? "the local model server" : route.provider} didn't answer (${e?.cause?.code ?? e?.name ?? "error"})`)
          return error(502, local ? `Your local model server at ${route.url} isn't answering; start it again, or restart kriya without --local-model.` : `${new URL(route.url).host} isn't answering; try again, or choose another model.`)
        }
        const out = {}
        answer.headers.forEach((value, name) => {
          if (!DROP_RESPONSE.has(name)) out[name] = value
        })
        res.writeHead(answer.status, out)
        if (!answer.body) return res.end()
        // Counts only, from the answer's own usage figures: never its text
        const counted = answer.ok ? answer.body.pipeThrough(counting((u) => onUsage({ provider: route.provider, model: route.model, requests: 1, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, ...(u?.reportedCostMicroUsd !== undefined && { reportedCostMicroUsd: u.reportedCostMicroUsd }) }))) : answer.body
        return await pipeline(Readable.fromWeb(counted), res)
      }
      const encodable = Boolean(plain) && /^application\/json\b/i.test(headers["content-type"] ?? "")
      if (encodable && !support.on && now() - support.checked >= RECHECK_MS) await recheck()
      const once = (encoded) => {
        const h = { ...headers }
        let sent = plain
        if (encoded) {
          sent = encodeBody(plain)
          h["content-type"] = "text/plain; charset=us-ascii"
          h["x-kriya-body"] = BODY_ENCODING
        }
        return fetchImpl(`${origin}${req.url}`, { method: req.method, headers: h, body: sent, signal: upstream.signal, redirect: "manual" })
      }
      /** One request through an outage: waits while nothing can connect, and tries a dead pooled connection once more */
      const send = async (encoded) => {
        const began = now()
        let waiting = false
        let retried = false
        for (let wait = Math.min(1000, outageWaitMs); ; wait = Math.min(wait * 2, outageWaitMs)) {
          try {
            const answer = await once(encoded)
            if (waiting) log("relay: Kriya is reachable again")
            return answer
          } catch (e) {
            const code = e?.cause?.code
            if (upstream.signal.aborted) throw e
            if (DEAD_SOCKET.has(code) && !retried) {
              retried = true
              continue
            }
            if (!NO_CONNECTION.has(code) || now() - began >= outageMs) throw e
            if (!waiting) log(`relay: can't reach Kriya (${code}); waiting for the network`)
            waiting = true
            await sleep(wait, undefined, { signal: upstream.signal })
          }
        }
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
      // DSH hung up: before an answer it's an abort, during one the stream closes early
      if (e?.name === "AbortError" || e?.code === "ERR_STREAM_PREMATURE_CLOSE") return
      // The code only: a fetch TypeError's message can quote a header. DSH retries on the 502 below
      log(`relay: connection to Kriya dropped (${e?.cause?.code ?? e?.name ?? "error"}); retrying`)
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
