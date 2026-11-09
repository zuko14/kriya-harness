import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { PROFILES } from "../src/profiles.js"
import { CLIENT_VERSION } from "../src/paths.js"
import { writeDevice } from "../src/store.js"
import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// H11 (HD-13): `kriya acp` is DSH's ACP server (dsh-acp-app) with the kriya
// bundle, on the real pinned DSH. A minimal ACP v1 client speaks
// newline-delimited JSON-RPC over the child's stdin/stdout, as an editor
// does: initialize, session/new, session/prompt, answering
// session/request_permission. Model calls must reach the fake Kriya
// gateway with the device token, Kriya tools must run, approvals reach
// Kriya too (first answer wins), and stdout must carry nothing but
// protocol frames. Nothing leaves this machine.

const DEVICE_ID = "11111111-2222-4333-8444-555555555555"
const MARK = "KRIYA-ACP-MARK"

function run(args, { cwd = ROOT, input } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    if (input !== undefined) child.stdin.end(input)
    child.on("exit", (code) => done({ code, stdout, stderr }))
  })
}

/** `kriya acp` driven like an editor; `onPermission` answers the agent's permission requests */
function acp(cwd, { onPermission = () => null } = {}) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "acp"], { cwd, env: process.env })
  const frames = []
  const updates = []
  const permissions = []
  const pending = new Map()
  let stderr = ""
  let buffer = ""
  let next = 0
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  child.stderr.on("data", (d) => (stderr += d))
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      // Throws on anything that isn't a frame: stdout belongs to ACP
      const message = JSON.parse(line)
      frames.push(message)
      if (message.method === "session/update") updates.push(message.params.update)
      else if (message.method === "session/request_permission") {
        permissions.push(message.params)
        const optionId = onPermission(message.params)
        if (optionId) send({ id: message.id, result: { outcome: { outcome: "selected", optionId } } })
      } else if (!message.method && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  const exited = new Promise((done) => child.on("exit", (code) => done(code)))
  return {
    frames,
    updates,
    permissions,
    get stderr() {
      return stderr
    },
    request(method, params) {
      const id = ++next
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`${method} timed out\n${stderr.slice(-1500)}`)), 120_000)
        pending.set(id, (message) => (clearTimeout(timer), done(message)))
        send({ id, method, params })
      })
    },
    /** Stdin EOF: DSH's ACP app shuts down cleanly */
    close() {
      child.stdin.end()
      return exited
    },
  }
}

async function signedIn(script) {
  freshHome()
  const fake = await startFakeKriya(script)
  writeDevice({ url: fake.url, token: fake.issueToken(), deviceId: DEVICE_ID })
  return fake
}

const text = (updates) =>
  updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("")

test("kriya acp --help explains the editor command and exits; other options are refused", async () => {
  freshHome()
  const help = await run(["acp", "--help"])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /Agent Client\nProtocol \(ACP v1\)/)
  assert.match(help.stdout, /use the command: {2}kriya acp/)
  assert.equal((await run(["acp", "-h"])).code, 0)
  for (const flags of [["--port", "8080"], ["--stdio"], ["extra"]]) {
    const refused = await run(["acp", ...flags])
    assert.equal(refused.code, 1)
    assert.equal(refused.stdout, "")
    assert.match(refused.stderr, /kriya acp takes no options but --help\./)
  }
})

test("kriya acp signed out: a message on stderr, nothing on stdout, exit 1", async () => {
  freshHome()
  const out = await run(["acp"], { input: "" })
  assert.equal(out.code, 1)
  assert.equal(out.stdout, "")
  assert.match(out.stderr, /run `kriya login` to connect your Kriya account/)
})

test("the kriya-acp profile is dsh-base, DSH's ACP app and the kriya bundle; ACP sessions start on the launcher's start tier (balanced if unset)", () => {
  assert.deepEqual(PROFILES["kriya-acp"], ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "@kriya-ai/harness"])
  const dump = readFileSync(join(ROOT, "expected", "kriya-acp.dump.yml"), "utf8")
  assert.match(dump, /- id: acp\n {2}name: '@deepseek-ai\/dsh-acp'\n {2}inject:\n {4}- acpAppStartup\n {2}config:\n {4}provider: kriya\n {4}model: !!js process\.env\.KRIYA_START_TIER \?\? 'balanced'\n/)
  // DeepSeek's model route is gone (its web-search row stays, disabled, as in every profile)
  assert.doesNotMatch(dump, /\n {4}provider: deepseek-official\n|deepseek-v4-flash/)
  for (const id of ["kriya-approvals", "kriya-mirror", "kriya-tools"]) assert.match(dump, new RegExp(`- id: ${id}\n`))
  // The same permission presets as the Web UI profile (both from dsh-base)
  const presets = (yaml) => /- id: permission\n[\s\S]*?(?=\n- id: )/.exec(yaml)?.[0]
  assert.equal(presets(dump), presets(readFileSync(join(ROOT, "expected", "kriya.dump.yml"), "utf8")))
})

test("an editor session: handshake, Kriya's tiers, the gateway with the device token, a Kriya tool, clean exit", { timeout: 300_000 }, async () => {
  const fake = await signedIn({
    chat: (body) => {
      if (!body.tools?.length) return { content: "title" }
      const done = body.messages.filter((m) => m.role === "tool").length
      return done < 1
        ? { toolCall: { name: "kriya_memory_save", args: { content: "Saved from the editor." } } }
        : { content: "Hello from Kriya over ACP." }
    },
  })
  const cwd = mkdtempSync(join(tmpdir(), "kriya-acp-ws-"))
  const editor = acp(cwd)
  try {
    const init = await editor.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(init.result.protocolVersion, 1, JSON.stringify(init))
    assert.deepEqual(init.result.authMethods, [])

    const session = await editor.request("session/new", { cwd, mcpServers: [] })
    const model = session.result.configOptions.find((o) => o.id === "model")
    assert.equal(model.currentValue, JSON.stringify(["kriya", "balanced"]))
    const choices = model.options.flatMap((group) => group.options.map((o) => o.value))
    assert.deepEqual(choices.sort(), ["balanced", "budget", "escalation"].map((m) => JSON.stringify(["kriya", m])))

    const prompt = await editor.request("session/prompt", {
      sessionId: session.result.sessionId,
      prompt: [{ type: "text", text: "Remember this and say hello" }],
    })
    assert.equal(prompt.result.stopReason, "end_turn", editor.stderr.slice(-1500))
    assert.equal(text(editor.updates), "Hello from Kriya over ACP.")
    const tool = editor.updates.find((u) => u.sessionUpdate === "tool_call")
    assert.equal(tool.title, "kriya_memory_save")
    assert.deepEqual(fake.state.saved.map((s) => s.content), ["Saved from the editor."])

    const chats = fake.state.requests.filter((r) => r.path === "/chat/completions")
    assert.ok(chats.length >= 2)
    for (const chat of chats) {
      assert.equal(chat.body.model, "balanced")
      assert.equal(chat.headers.authorization, `Bearer ${[...fake.state.tokens][0]}`)
      assert.equal(chat.headers["x-kriya-harness"], CLIENT_VERSION)
    }
    // The device token never reaches the model
    assert.doesNotMatch(JSON.stringify(chats.map((c) => c.body)), new RegExp([...fake.state.tokens][0]))
  } finally {
    assert.equal(await editor.close(), 0, editor.stderr.slice(-1500))
    await fake.close()
  }
  assert.ok(editor.frames.length > 0)
  assert.ok(editor.frames.every((f) => f.jsonrpc === "2.0"))
})

const BASH = {
  name: "bash",
  args: {
    description: "Print a marker",
    command: `echo ${MARK}`,
    sandbox_permissions: "danger-full-access",
    justification: "The test needs this exact command to run unsandboxed.",
  },
}

async function bashSession({ onApproval, onPermission }) {
  let fake
  fake = await signedIn({
    approveAfter: 0,
    onApproval: (approval) => onApproval?.(fake, approval),
    chat: (body) => {
      if (!body.tools?.length) return { content: "title" }
      const done = body.messages.filter((m) => m.role === "tool").length
      return done < 1 ? { toolCall: BASH } : { content: "Finished." }
    },
  })
  const cwd = mkdtempSync(join(tmpdir(), "kriya-acp-ws-"))
  const editor = acp(cwd, { onPermission })
  await editor.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const session = await editor.request("session/new", { cwd, mcpServers: [] })
  const prompt = await editor.request("session/prompt", {
    sessionId: session.result.sessionId,
    prompt: [{ type: "text", text: "Run the check" }],
  })
  const chats = fake.state.requests.filter((r) => r.path === "/chat/completions")
  const toolResult = JSON.stringify(chats.at(-1)?.body?.messages?.filter((m) => m.role === "tool"))
  const code = await editor.close()
  await fake.close()
  return { fake, editor, prompt, toolResult, code }
}

const allow = (params) => params.options.find((o) => o.kind === "allow_once")?.optionId

test("approval answered in the editor: the command runs once and Kriya's phone request is withdrawn", { timeout: 300_000 }, async () => {
  const { fake, editor, prompt, toolResult, code } = await bashSession({ onPermission: allow })
  assert.equal(prompt.result?.stopReason, "end_turn", editor.stderr.slice(-1500))
  assert.equal(editor.permissions.length, 1)
  assert.match(toolResult, new RegExp(`(?<!echo )${MARK}`))
  const [approval] = fake.state.approvals.values()
  assert.ok(approval, "the approval request reached Kriya too")
  assert.equal(approval.body.tool, "bash")
  assert.equal(approval.status, "canceled")
  assert.equal(code, 0)
})

test("approval answered on the phone while the editor waits: the command runs", { timeout: 300_000 }, async () => {
  const { fake, editor, prompt, toolResult, code } = await bashSession({
    onApproval: (fake, { id }) => setTimeout(() => fake.answer(id, "approved"), 300),
  })
  assert.equal(prompt.result?.stopReason, "end_turn", editor.stderr.slice(-1500))
  assert.equal(editor.permissions.length, 1)
  assert.equal([...fake.state.approvals.values()][0]?.status, "approved")
  assert.match(toolResult, new RegExp(`(?<!echo )${MARK}`))
  assert.equal(code, 0)
})
