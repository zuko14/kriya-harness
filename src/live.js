// Remote Control's stream (Kriya-Tavi docs/kriya-harness/REMOTE_CONTROL.md):
// DSH's committed session events as the short lines Kriya shows. A tool line
// carries one target (a path, a command, an address), never its output.

export const MAX_TEXT = 8000
const MAX_TARGET = 400

const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("")

/** A command or address with anything secret-looking hidden */
export const redact = (text) =>
  String(text)
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 ***")
    .replace(/([\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key|auth)[\w-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/(--[\w-]*(?:token|secret|password|key)[\w-]*[ =])\S+/gi, "$1***")
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, "$1***@")

const TARGET_KEYS = ["path", "file_path", "filePath", "url", "command", "pattern", "query", "ref", "description"]

/** The one thing a tool call acts on, from its JSON arguments */
export function targetOf(args) {
  let value = args
  try {
    if (typeof args === "string") value = JSON.parse(args)
  } catch {
    return undefined
  }
  const key = TARGET_KEYS.find((name) => typeof value?.[name] === "string" && value[name])
  return key ? cut(redact(value[key]), MAX_TARGET) : undefined
}

/**
 * One DSH session event as a change to the stream.
 * @param {{ type: string, time: number, data: any }} event
 * @param {Map<string, { time: number }>} calls the open tool calls
 * @returns {{ line?: object, state?: string, title?: string } | null}
 */
export function liveChange(event, calls) {
  const { type, data, time } = event
  switch (type) {
    case "turn/start":
    case "approval/decided":
      return { state: "running" }
    case "turn/end":
      return { state: "idle" }
    case "approval/asked":
      return { state: "waiting" }
    case "user/message": {
      if (data?.source?.kind !== "user") return null
      const text = textOf(data.content).trim()
      return text ? { title: cut(text.split("\n")[0], 120), line: { kind: "user", text: cut(text, MAX_TEXT) } } : null
    }
    case "assistant/message": {
      const text = textOf(data?.message?.content).trim()
      return text ? { line: { kind: "assistant", text: cut(text, MAX_TEXT) } } : null
    }
    case "tool/call": {
      calls.set(data.callId, { time })
      const target = targetOf(data.arguments)
      return { line: { kind: "tool_start", callId: String(data.callId).slice(0, 100), tool: cut(String(data.name), 60), ...(target && { target }) } }
    }
    case "tool/result": {
      const id = data.message?.toolCallId
      const started = calls.get(id)
      if (!started) return null
      calls.delete(id)
      const failed = data.message.isError || data.error
      const declined = failed && /the user rejected (tool|escalating)/.test(textOf(data.message.content))
      return { line: { kind: "tool_end", callId: String(id).slice(0, 100), status: declined ? "declined" : failed ? "error" : "ok", ms: Math.max(0, Math.round(time - started.time)) } }
    }
    default:
      return null
  }
}
