import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"

// A local fake of the Kriya Harness API for tests: the device flow, /me,
// /models, DELETE /device, an OpenAI-compatible /chat/completions that
// streams a scripted answer, approval requests (H5) that the test
// answers with answer(), expire() or by script, the session mirror (H6)
// with a mode and an outage the test sets, and the device agent's skills
// and memory (H7) from state the test fills, and handoff and pull (H8):
// uploads land in `workspaces`, where a test can also put a later
// checkpoint. It records every request so tests can check
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
    /** H6: the device's mirror mode, and whether Kriya is "down" for the mirror */
    mirror: script.mirror ?? "summary",
    mirrorDown: false,
    /** @type {Map<string, { id: string, threadId: string, body: any, turns: Map<number, any> }>} */
    sessions: new Map(),
    /** H7: the device agent's skills (with their bodies) and notes; saves land in `saved` */
    skills: [],
    skillBodies: new Map(),
    notes: [],
    saved: [],
    skillsDown: false,
    /** H8: workspaces by id: the handoff's meta, the latest checkpoint and its base */
    /** @type {Map<string, { meta: any, patch: Buffer, baseSha: string }>} */
    workspaces: new Map(),
    /** H8: a refusal the next handoffs get, e.g. { status: 403, error: "not_connected", message } */
    handoffError: null,
    /** H8: serve checkpoints with a wrong X-Kriya-Sha256 */
    corruptCheckpoint: false,
    /** H10: the device world's relay address; null answers 404 (switched off) */
    relayUrl: null,
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
    const bytes = Buffer.concat(chunks)
    const raw = bytes.toString("utf8")
    let body = null
    let form = null
    if (String(req.headers["content-type"]).startsWith("multipart/form-data")) {
      // Parsed the way a route handler does; the record's body is the meta part
      form = await new Request("http://fake", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] },
        body: bytes,
      })
        .formData()
        .catch(() => null)
      try {
        body = JSON.parse(String(form?.get("meta")))
      } catch {
        body = null
      }
    } else {
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
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
    if (req.method === "GET" && path === "/world")
      return state.relayUrl
        ? send(200, { deviceId: "11111111-2222-4333-8444-555555555555", relayUrl: state.relayUrl })
        : fail(404, "not_found", "Not found.")
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
    if (path === "/skills" || path.startsWith("/skills/") || path.startsWith("/memory")) {
      if (state.skillsDown) return fail(503, "server_error", "Something went wrong. Try again.")
      if (req.method === "GET" && path === "/skills") {
        const etag = `"${createHash("sha256").update(JSON.stringify(state.skills)).digest("hex").slice(0, 32)}"`
        if (req.headers["if-none-match"] === etag) {
          record.status = 304
          res.writeHead(304, { etag }).end()
          return
        }
        record.status = 200
        record.response = { skills: state.skills }
        res.writeHead(200, { "Content-Type": "application/json", etag }).end(JSON.stringify({ skills: state.skills }))
        return
      }
      const skill = /^\/skills\/([a-z0-9-]+)\/(\d+\.\d+\.\d+)$/.exec(path)
      if (req.method === "GET" && skill) {
        const text = state.skills.some((s) => s.id === skill[1] && s.version === skill[2]) && state.skillBodies.get(skill[1])
        if (!text) return fail(404, "not_found", "Not found.")
        record.status = 200
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(text)
        return
      }
      if (req.method === "POST" && path === "/memory/search")
        return send(200, { notes: state.notes.filter((n) => n.content.includes(body?.query ?? "")).slice(0, body?.limit ?? 8) })
      if (req.method === "POST" && path === "/memory") {
        if (/\d{4} \d{4} \d{4} \d{4}/.test(body?.content ?? ""))
          return fail(400, "bad_request", "Not saved: this looks like a card number. Never keep such values in memory.")
        const id = `note-${state.saved.length + 1}`
        state.saved.push({ id, content: body.content })
        return send(201, { id, confirmed: false })
      }
      return fail(404, "not_found", "Not found.")
    }
    if (req.method === "POST" && path === "/handoff") {
      if (state.handoffError)
        return fail(state.handoffError.status, state.handoffError.error, state.handoffError.message)
      const part = form?.get("patch")
      if (!body || !(part instanceof Blob)) return fail(400, "bad_request", "That request isn't what this API expects.")
      const patch = Buffer.from(await part.arrayBuffer())
      if (patch.length !== body.bytes || createHash("sha256").update(patch).digest("hex") !== body.sha256)
        return fail(400, "patch_mismatch", "The upload was damaged on the way; hand off again.")
      const workspaceId = crypto.randomUUID()
      const threadId = b64(9)
      state.workspaces.set(workspaceId, { meta: body, patch, baseSha: body.baseSha })
      return send(201, {
        threadId,
        workspaceId,
        taskId: crypto.randomUUID(),
        url: `http://127.0.0.1:${server.address().port}/a/agent-1/${threadId}`,
      })
    }
    const checkpoint = /^\/workspaces\/([0-9a-f-]{36})\/checkpoint$/.exec(path)
    if (req.method === "GET" && checkpoint) {
      const workspace = state.workspaces.get(checkpoint[1])
      if (!workspace) return fail(404, "not_found", "Not found.")
      if (!workspace.patch.length) return fail(404, "no_checkpoint", "This workspace has no changes saved yet.")
      const digest = createHash("sha256").update(workspace.patch).digest("hex")
      record.status = 200
      res
        .writeHead(200, {
          "Content-Type": "application/octet-stream",
          "X-Kriya-Sha256": state.corruptCheckpoint ? "0".repeat(64) : digest,
          "X-Kriya-Base-Sha": workspace.baseSha,
        })
        .end(workspace.patch)
      return
    }
    if (path === "/sessions" || path.startsWith("/sessions/")) {
      if (state.mirrorDown) return fail(503, "server_error", "Something went wrong. Try again.")
      if (state.mirror === "off") return fail(404, "not_found", "Not found.")
      if (req.method === "POST" && path === "/sessions") {
        const found = [...state.sessions.values()].find((s) => s.body.deviceSessionId === body?.deviceSessionId)
        if (found) return send(200, { sessionId: found.id, threadId: found.threadId, mirror: state.mirror })
        const session = { id: crypto.randomUUID(), threadId: b64(9), body, turns: new Map() }
        state.sessions.set(session.id, session)
        return send(201, { sessionId: session.id, threadId: session.threadId, mirror: state.mirror })
      }
      const turn = /^\/sessions\/([0-9a-f-]{36})\/turns$/.exec(path)
      const session = turn && state.sessions.get(turn[1])
      if (req.method === "POST" && session) {
        if (body?.full && state.mirror !== "full")
          return fail(403, "mirror_summary_only", "This device mirrors summaries only.")
        if (!session.turns.has(body.seq)) session.turns.set(body.seq, body)
        return send(204)
      }
      return fail(404, "not_found", "Not found.")
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
