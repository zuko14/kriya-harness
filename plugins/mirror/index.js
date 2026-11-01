import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import { call, deviceFromEnv } from "../../src/api.js"
import { kriyaHome } from "../../src/paths.js"

// Kriya mirror plugin (H6, HD-09, P-SYNC): a summary of each DeepSeek
// Harness turn goes to a thread in Kriya, so the phone shows progress.
// It only watches DSH's committed `session/event` feed: local history stays
// DSH's own and complete. A turn's summary is its answer text and each
// tool's name, status and time; tool arguments and output go only when the
// person chose "Full" for this device (Kriya says which when the session
// opens, and refuses `full` otherwise). Turns wait in a queue on disk (0600
// in the Kriya home) while Kriya is unreachable and are sent in order; a
// session Kriya doesn't mirror (404, mirror off) is dropped and not retried.

export const name = "kriya-mirror"

// The contract's limits (TurnRequest)
const MAX_TEXT = 64 * 1024
const MAX_FULL = 64 * 1024
const MAX_TOOLS = 100
// Each tool's output in a full turn
const MAX_OUTPUT = 4 * 1024
// Turns kept while Kriya is unreachable; the oldest go first
const MAX_QUEUE = 500
const MAX_BACKOFF = 60_000

const REJECTED = /the user rejected (tool|escalating)/

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("")
const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
const parsed = (json) => {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

function fullOf(tools) {
  const full = {
    tools: tools.slice(0, MAX_TOOLS).map((tool) => ({
      name: tool.name,
      input: parsed(tool.args ?? "{}"),
      output: cut(tool.output, MAX_OUTPUT),
    })),
  }
  while (full.tools.length && JSON.stringify(full).length > MAX_FULL) full.tools.pop()
  return full
}

export function apply(ctx, config = {}) {
  const retryMs = config.retryMs ?? 5_000
  const file = join(kriyaHome(), "mirror-queue.json")
  const warn = (text) => ctx.logger?.warn?.(`kriya mirror: ${text}`)

  let queue = []
  try {
    const kept = JSON.parse(readFileSync(file, "utf8"))
    if (Array.isArray(kept)) queue = kept
  } catch {
    // No queue yet
  }
  const save = () => {
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(queue), { mode: 0o600 })
    if (process.platform !== "win32") chmodSync(temporary, 0o600)
    renameSync(temporary, file)
  }

  // DSH session id → what's being collected; Kriya's session per DSH session
  const live = new Map()
  const opened = new Map()
  let timer
  let flushing = null
  let failures = 0
  let disposed = false

  const schedule = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(flush, ms)
    timer.unref?.()
  }

  // One queued turn: "done", "drop" (this session isn't mirrored), or "retry"
  async function deliver(device, entry) {
    try {
      let session = opened.get(entry.deviceSessionId)
      if (!session) {
        const made = await call(device.url, "POST", "/sessions", {
          token: device.token,
          body: { deviceSessionId: entry.deviceSessionId, project: entry.project, title: entry.title },
        })
        session = { sessionId: made.sessionId, mirror: made.mirror }
        opened.set(entry.deviceSessionId, session)
      }
      const body = { seq: entry.seq, text: entry.text, tools: entry.tools }
      if (session.mirror === "full" && entry.full) body.full = entry.full
      const send = () => call(device.url, "POST", `/sessions/${session.sessionId}/turns`, { token: device.token, body })
      try {
        await send()
      } catch (error) {
        // The person switched to summaries mid-session
        if (error.code !== "mirror_summary_only" || !body.full) throw error
        session.mirror = "summary"
        delete body.full
        await send()
      }
      return "done"
    } catch (error) {
      if (error.status === 400) {
        warn(`Kriya refused a turn (${error.code}); skipped`)
        return "done"
      }
      if (error.status === 0 || error.status === 429 || error.status >= 500) return "retry"
      // Mirror off, signed out, no agent, an old client: not this session
      if (error.code === "no_agent") warn(error.message)
      return "drop"
    }
  }

  async function flush() {
    if (flushing) return flushing
    flushing = (async () => {
      const device = deviceFromEnv()
      while (device && queue.length && !disposed) {
        const entry = queue[0]
        const outcome = await deliver(device, entry)
        if (outcome === "retry") {
          failures++
          schedule(Math.min(retryMs * 2 ** (failures - 1), MAX_BACKOFF))
          return
        }
        failures = 0
        if (outcome === "drop") {
          opened.set(entry.deviceSessionId, "off")
          queue = queue.filter((e) => e.deviceSessionId !== entry.deviceSessionId)
        } else queue.shift()
        save()
      }
    })().finally(() => (flushing = null))
    return flushing
  }

  function enqueue(entry) {
    queue.push(entry)
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
    save()
    if (!failures) schedule(0)
  }

  const projectOf = (session) => {
    let dir
    try {
      dir = ctx.get("workingDirectory")?.get(session)
    } catch {
      // Not composed: the launch folder
    }
    return cut(basename(dir || process.cwd()), 80)
  }

  ctx.on("session/event", (session, event) => {
    const id = typeof session?.id === "string" ? session.id.slice(0, 100) : ""
    if (disposed || !id || opened.get(id) === "off" || !deviceFromEnv()) return
    let state = live.get(id)
    if (!state) live.set(id, (state = { title: "", project: projectOf(session), turn: null }))
    const data = event.data
    const turn = state.turn
    switch (event.type) {
      case "user/message":
        // The person's first message names the session (DSH's own context is a user message too)
        if (!state.title && data?.source?.kind === "user")
          state.title = cut(textOf(data.content).trim().split("\n")[0], 80)
        break
      case "turn/start":
        state.turn = { seq: data.turn, texts: [], calls: new Map(), tools: [] }
        break
      case "tool/call":
        turn?.calls.set(data.callId, { name: data.name, args: data.arguments, time: event.time })
        break
      case "tool/result": {
        const started = turn?.calls.get(data.message?.toolCallId)
        if (!started) break
        const output = textOf(data.message.content)
        const failed = data.message.isError || data.error
        turn.tools.push({
          name: cut(String(started.name), 60),
          status: failed ? (REJECTED.test(output) ? "declined" : "error") : "ok",
          ms: Math.max(0, event.time - started.time),
          args: started.args,
          output,
        })
        break
      }
      case "assistant/message": {
        const text = textOf(data?.message?.content).trim()
        if (text) turn?.texts.push(text)
        break
      }
      case "turn/end": {
        if (!turn) break
        state.turn = null
        // Tool details stay off the disk once Kriya has said this session is summaries only
        const summaryOnly = opened.get(id)?.mirror === "summary"
        enqueue({
          deviceSessionId: id,
          project: state.project,
          title: state.title,
          seq: turn.seq,
          text: cut(turn.texts.join("\n\n"), MAX_TEXT),
          tools: turn.tools.slice(0, MAX_TOOLS).map(({ name, status, ms }) => ({ name, status, ms })),
          ...(!summaryOnly && turn.tools.length && { full: fullOf(turn.tools) }),
        })
        break
      }
    }
  })

  // Turns left from an earlier run
  if (queue.length) schedule(0)
  ctx.effect(
    () => () => {
      disposed = true
      clearTimeout(timer)
    },
    "kriya-mirror: stop"
  )
}
