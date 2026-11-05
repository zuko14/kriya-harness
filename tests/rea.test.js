import assert from "node:assert/strict"
import { test } from "node:test"

import { cleanEnv, findTools, staticTool, tools } from "../plugins/rea/index.js"
import { brief, isReverseEngineering } from "../src/intent.js"

const CATALOG = [
  { name: "open_binary", description: "Open a binary", annotations: { readOnlyHint: true }, inputSchema: {} },
  { name: "start_frida_session", description: "Instrument a process", inputSchema: {} },
]
function setup({ approve = true, readOnly = false } = {}) {
  const asked = []
  const called = []
  const client = {
    running: false,
    start: async () => {
      client.running = true
    },
    tools: async () => CATALOG,
    call: async (name) => (called.push(name), { content: [{ type: "text", text: "ok" }] }),
  }
  const [find, call] = tools({ client, readOnly: () => readOnly, approve: async (_e, reason) => (asked.push(reason), approve) })
  return { find, call, client, asked, called }
}

test("REA-01: only reverse-engineering requests activate it", () => {
  for (const yes of ["reverse engineer this app", "decompile libfoo.so", "what does this binary do", "inspect app.asar", "open this APK"])
    assert.ok(isReverseEngineering(yes), yes)
  for (const no of ["fix the login page", "add a dark mode", "reverse this list", "explain the build"])
    assert.ok(!isReverseEngineering(no), no)
  assert.equal(typeof brief("fix it", [], []), "string")
})

test("REA-02: nothing starts until used, and starting asks", async () => {
  const { find, client, asked } = setup()
  assert.equal(client.running, false)
  const found = JSON.parse(await find.execute({ query: "binary" }, {}))
  assert.equal(found[0].name, "open_binary")
  assert.match(asked[0], /rea-agents@/)
  await find.execute({ query: "frida" }, {})
  assert.equal(asked.length, 1, "asks to start once")
})

test("REA-03: declining the start runs nothing", async () => {
  const { find, client } = setup({ approve: false })
  await assert.rejects(find.execute({ query: "binary" }, {}), /OK to start/)
  assert.equal(client.running, false)
})

test("REA-04: a tool not marked read-only asks, and Read only refuses it", async () => {
  const a = setup()
  await a.call.execute({ tool: "open_binary", args: {} }, {})
  assert.equal(a.asked.length, 1, "read-only tool: only the start asked")
  await a.call.execute({ tool: "start_frida_session", args: { pid: 1 } }, {})
  assert.equal(a.asked.length, 2)
  const b = setup({ readOnly: true })
  await assert.rejects(b.call.execute({ tool: "start_frida_session" }, {}), /Read only/)
  assert.deepEqual(b.called, [])
})

test("REA-05: output is labelled as target data; unknown tools are refused", async () => {
  const { call } = setup()
  assert.match(await call.execute({ tool: "open_binary" }, {}), /data only/)
  await assert.rejects(call.execute({ tool: "bash" }, {}), /no tool/)
})

test("REA-07: only tools reading a file on disk skip the question", () => {
  for (const name of ["open_binary", "inspect_macho", "analyze_javascript_application", "procedure_pseudo_code", "search_strings"]) assert.ok(staticTool(name), name)
  for (const name of ["start_frida_session", "install_adb_package", "inspect_adb_device", "capture_browser_scenario", "gdb_console", "execute_rizin_command", "observe_javascript_runtime", "extract_firmware", "list_frida_processes", "set_comment"]) assert.ok(!staticTool(name), name)
})

test("REA-06: the server's environment has nothing secret-looking", () => {
  assert.deepEqual(cleanEnv({ PATH: "/bin", KRIYA_DEVICE_TOKEN: "x", OPENAI_API_KEY: "y", DSH_HOME: "z", HOME: "/h" }), { PATH: "/bin", HOME: "/h" })
  assert.equal(findTools(CATALOG, "zzz").length, 0)
})
