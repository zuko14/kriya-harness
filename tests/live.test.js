import assert from "node:assert/strict"
import { test } from "node:test"

import { liveChange, redact, targetOf } from "../src/live.js"

test("RC-01: a tool line carries a target with secrets hidden, never output", () => {
  assert.equal(targetOf('{"path":"src/a.ts","content":"x"}'), "src/a.ts")
  const command = targetOf({ command: "curl -H 'Authorization: Bearer abc.def' https://u:p@h.io?api_key=zzz" })
  assert.doesNotMatch(command, /abc\.def|:p@|zzz/)
  assert.equal(redact("TOKEN=abc npm test"), "TOKEN=*** npm test")
  assert.equal(targetOf("not json"), undefined)
})

test("RC-02: events map to lines and states", () => {
  const calls = new Map()
  assert.deepEqual(liveChange({ type: "turn/start", time: 1, data: {} }, calls), { state: "running" })
  assert.deepEqual(liveChange({ type: "approval/asked", time: 1, data: {} }, calls), { state: "waiting" })
  assert.equal(liveChange({ type: "user/message", time: 1, data: { source: { kind: "system" }, content: [{ type: "text", text: "x" }] } }, calls), null)
  const start = liveChange({ type: "tool/call", time: 10, data: { callId: "c", name: "bash", arguments: '{"command":"ls"}' } }, calls)
  assert.deepEqual(start.line, { kind: "tool_start", callId: "c", tool: "bash", target: "ls" })
  const end = liveChange({ type: "tool/result", time: 60, data: { message: { toolCallId: "c", content: [{ type: "text", text: "secret output" }] } } }, calls)
  assert.deepEqual(end.line, { kind: "tool_end", callId: "c", status: "ok", ms: 50 })
})
