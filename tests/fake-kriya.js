import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

// A local fake of the Kriya Harness API for tests: the device flow, /me,
// /models, DELETE /device, an OpenAI-compatible /chat/completions that
// streams a scripted answer, and approval requests (H5) that the test
// answers with answer(), expire() or by script. It records every request so tests can check
// headers and bodies against contract/contract.json. Nothing here reaches
// a real Kriya deployment or a model provider.

const b64 = (n) => randomBytes(n).toString("base64url")

/**
 * @param {{ answer?: string, approveAfter?: number, deny?: boolean, minVersion?: string, chatError?: { status: number, error: string, message: string }, approvalsError?: { status: number, error: string, message: string }, maxWait?: number, onApproval?: (approval: { id: string, body: any }) => void, chat?: (body: any, turn: number) => ({ content: string } | { toolCall: { name: string, args: unknown } }) }} [script]
 */
export async function startFakeKriya(script = {}) {
  const state = {
    requests: [],
    codes: new Map(),
    tokens: new Set(),
    revoked: new Set(),
    /** @type {Map<string, { id: string, body: any, status: string, wake: Set<() => void> }>} */
    approvals: new Map(),
    turns: 0,
  }
  const settle = (id, status) => {
    const approval = state.approvals.get(id)
    if (!approval || approval.status !== "pending") return false
    approval.status = status
    for (const wake of approval.wake) wake()
    return true
  }
  const answer = script.answer ?? "Kriya fake gateway says hello."

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString("utf8")
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    const url = new URL(req.url, "http://fake")
    const path = url.pathname.replace(/^\/api\/harness\/v1/, "")
    const record = { method: req.method, path, headers: req.headers, body, status: 0, response: null }
    state.requests.push(record)

    const send = (status, payload) => {
      record.status = status
      record.response = payload ?? null
      if (payload === undefined) {
        res.writeHead(status).end()
        return
      }
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload))
    }
    const fail = (status, error, message, extra = {}) => send(status, { error, message, ...extra })

    if (!url.pathname.startsWith("/api/harness/v1/")) return fail(404, "not_found", "Not found.")
    const version = req.headers["x-kriya-harness"]
    if (typeof version !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version))
      return fail(426, "upgrade", "Update Kriya Harness.", { minVersion: script.minVersion ?? "0.0.0" })
    if (script.minVersion && version.localeCompare(script.minVersion, undefined, { numeric: true }) < 0)
      return fail(426, "upgrade", `Update Kriya Harness to ${script.minVersion} or later.`, {
        minVersion: script.minVersion,
      })

    if (req.method === "POST" && path === "/device/code") {
      const deviceCode = b64(32)
      state.codes.set(deviceCode, { polls: 0 })
      return send(200, {
        deviceCode,
        userCode: "ABCD-2345",
        verificationUrl: `http://127.0.0.1:${server.address().port}/connect/device`,
        expiresIn: 600,
        interval: 5,
      })
    }
    if (req.method === "POST" && path === "/device/token") {
      const code = state.codes.get(body?.deviceCode)
      if (!code) return fail(410, "expired", "This code has expired.")
      if (script.deny) return fail(403, "denied", "Sign-in was denied.")
      code.polls++
      if (code.polls <= (script.approveAfter ?? 1)) return fail(428, "pending", "Waiting for approval.")
      state.codes.delete(body.deviceCode)
      const token = b64(32)
      state.tokens.add(token)
      return send(200, { token, deviceId: "11111111-2222-4333-8444-555555555555" })
    }

    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]
    if (!auth || !state.tokens.has(auth) || state.revoked.has(auth))
      return fail(401, "unauthorized", "Sign in again with kriya login.")

    if (req.method === "GET" && path === "/me")
      return send(200, {
        displayName: "Asha",
        plan: "pro",
        harness: { enabled: true, capMicroInr: 500_000_000, usedMicroInr: 0, unpriced: 0 },
        agent: { id: "agent-1", name: "Arjun" },
        minClientVersion: script.minVersion ?? "0.0.0",
      })
    if (req.method === "DELETE" && path === "/device") {
      state.revoked.add(auth)
      return send(204)
    }
    if (req.method === "GET" && path === "/models")
      return send(200, {
        object: "list",
        data: ["budget", "balanced", "escalation"].map((id) => ({ id, object: "model", owned_by: "kriya" })),
      })
    if (req.method === "POST" && path === "/approvals") {
      if (script.approvalsError)
        return fail(script.approvalsError.status, script.approvalsError.error, script.approvalsError.message)
      const id = crypto.randomUUID()
      const approval = { id, body, status: "pending", wake: new Set() }
      state.approvals.set(id, approval)
      send(201, { id, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() })
      script.onApproval?.({ id, body })
      return
    }
    const one = /^\/approvals\/([0-9a-f-]{36})$/.exec(path)
    if (one) {
      const approval = state.approvals.get(one[1])
      if (!approval) return fail(404, "not_found", "Not found.")
      if (req.method === "DELETE") {
        settle(approval.id, "canceled")
        return send(204)
      }
      if (req.method === "GET") {
        // The real route waits up to `wait` (≤ 25) seconds; tests cap it with maxWait
        const wait = Math.min(Number(url.searchParams.get("wait") ?? 0), script.maxWait ?? 25)
        if (approval.status === "pending" && wait > 0) {
          await new Promise((done) => {
            const wake = () => {
              clearTimeout(timer)
              approval.wake.delete(wake)
              done()
            }
            const timer = setTimeout(wake, wait * 1000)
            approval.wake.add(wake)
          })
        }
        return send(200, { status: approval.status })
      }
    }
    if (req.method === "POST" && path === "/chat/completions") {
      if (script.chatError) return fail(script.chatError.status, script.chatError.error, script.chatError.message)
      if (!["budget", "balanced", "escalation"].includes(body?.model))
        return fail(400, "tier_not_allowed", "That model isn't on your plan.")
      record.status = 200
      // A scripted turn: plain text, or one tool call for the agent to run
      const reply = script.chat?.(body, ++state.turns) ?? { content: answer }
      const id = `chatcmpl-${b64(6)}`
      const base = { id, object: "chat.completion.chunk", created: 1, model: body.model }
      if (!body.stream) {
        return send(200, {
          id,
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: reply.content ?? answer }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
      event({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
      if (reply.toolCall) {
        const { name, args } = reply.toolCall
        const call = { index: 0, id: `call_${b64(6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }
        event({ ...base, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })
        event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
        event({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
        res.end("data: [DONE]\n\n")
        return
      }
      for (const word of reply.content.split(/(?<= )/))
        event({ ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })
      event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
      event({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      res.end("data: [DONE]\n\n")
      return
    }
    return fail(404, "not_found", "Not found.")
  })

  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    state,
    /** A token as if the device flow had finished */
    /** The person answers in Kriya (approved | declined), or the request expires */
    answer: (id, status) => settle(id, status),
    expire: (id) => settle(id, "expired"),
    issueToken() {
      const token = b64(32)
      state.tokens.add(token)
      return token
    },
    close: () => new Promise((done) => server.close(done)),
  }
}
