import { createHash } from "node:crypto"

import { CLIENT_VERSION } from "./paths.js"

// Harness 2.0 W16, MCP P3a (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GROUNDING_AND_CONNECTORS.md §4): servers from the owner's registry that need
// no sign-in, each tool used only if its full definition still hashes to what
// the owner pinned. The hash is Kriya's own (lib/mcp/tools.ts definitionHash
// over lib/agent/episodes.ts canonical), so a device and Kriya agree on drift.
// A minimal Streamable HTTP client: https only (http only to this machine),
// no redirects followed, and no credential of any kind sent: no
// Authorization, no cookie, never the device's Kriya token.

const PINNED = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"]

/** Kriya's canonical JSON: keys sorted, undefined dropped (lib/agent/episodes.ts). */
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/** The pinned parts of a tool definition, hashed as Kriya hashes them. */
export function definitionHash(definition) {
  const pinned = Object.fromEntries(PINNED.filter((k) => definition?.[k] !== undefined).map((k) => [k, definition[k]]))
  return createHash("sha256").update(canonical(pinned)).digest("hex")
}

/**
 * The tools a server lists that the owner pinned, unchanged: `{ tool, pin }`.
 * A listed tool with no pin, or whose definition drifted, is left out.
 */
export function pinnedTools(listed, pins) {
  const out = []
  const dropped = []
  for (const tool of listed ?? []) {
    const pin = (pins ?? []).find((p) => p.name === tool?.name)
    if (!pin) continue
    if (definitionHash(tool) !== pin.definitionHash) dropped.push(tool.name)
    else out.push({ tool, pin })
  }
  return { tools: out, drifted: dropped }
}

export class McpError extends Error {}

/** https, or http only to this machine; no credentials in the address. */
export function serverUrl(text) {
  let url
  try {
    url = new URL(text)
  } catch {
    throw new McpError("That isn't a server address.")
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password) throw new McpError("A server address carries no credentials.")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new McpError("Registry servers are https.")
  return url
}

const PROTOCOL = "2025-06-18"

/** One server's session: initialize, list, call. `fetchImpl` for tests. */
export function mcpSession(address, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const url = serverUrl(address)
  let session
  let id = 0
  const post = async (body, signal) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL }
    if (session) headers["mcp-session-id"] = session
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: signal ?? AbortSignal.timeout(timeoutMs) })
    const next = response.headers.get("mcp-session-id")
    if (next) session = next
    return response
  }
  async function request(method, params, signal) {
    const want = ++id
    const response = await post({ jsonrpc: "2.0", id: want, method, params }, signal)
    if (!response.ok) throw new McpError(`The server answered ${response.status}.`)
    const type = response.headers.get("content-type") ?? ""
    let message
    if (type.includes("text/event-stream")) {
      const text = await response.text()
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue
        try {
          const m = JSON.parse(line.slice(5))
          if (m?.id === want) message = m
        } catch {
          // Not a message
        }
      }
    } else message = await response.json()
    if (!message) throw new McpError("The server sent no answer.")
    if (message.error) throw new McpError(`The server refused: ${String(message.error.message ?? "error").slice(0, 300)}`)
    return message.result
  }
  return {
    async open() {
      await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "kriya-harness", version: CLIENT_VERSION } })
      await post({ jsonrpc: "2.0", method: "notifications/initialized" })
    },
    async tools() {
      const all = []
      let cursor
      for (let page = 0; page < 10; page++) {
        const result = await request("tools/list", cursor ? { cursor } : {})
        all.push(...(result?.tools ?? []))
        cursor = result?.nextCursor
        if (!cursor) break
      }
      return all
    },
    call: (name, args, signal) => request("tools/call", { name, arguments: args ?? {} }, signal),
  }
}

/** A model-facing name: mcp__<server>__<tool>, within DeepSeek's function-name rules. */
export const toolName = (serverId, name) =>
  `mcp__${serverId}__${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
