import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// H5 browser check of DSH's Web UI approval prompt (not part of npm test):
// the fake Kriya and fake gateway on 127.0.0.1, a throwaway Kriya home, and
// `kriya --no-open --port <web>`. A message containing "[verify:approval]"
// makes the fake model ask for a harmless `echo` with wider sandbox access,
// so DSH asks for approval. A control port answers as the phone would:
//
//   node scripts/verify-approvals-web.js [webPort] [controlPort]
//   POST http://127.0.0.1:<control>/answer?status=approved|declined
//   GET  http://127.0.0.1:<control>/state
//
// Prints the Web UI's local link (it carries DSH's own session token for
// this throwaway home). Nothing leaves this machine. Ctrl-C stops it all.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
process.env.KRIYA_HOME = mkdtempSync(join(tmpdir(), "kriya-verify-"))

const { startFakeKriya } = await import("../tests/fake-kriya.js")
const { writeDevice } = await import("../src/store.js")

const MARK = "kriya-approved-web"
const webPort = process.argv[2] ?? "4317"
const controlPort = Number(process.argv[3] ?? "4318")

const text = (content) => (typeof content === "string" ? content : JSON.stringify(content ?? ""))

const fake = await startFakeKriya({
  chat: (body) => {
    // DSH adds its own context as user messages after the person's, so the
    // marker is looked for in the latest user message that has it
    const at = body.messages.findLastIndex((m) => m.role === "user" && text(m.content).includes("[verify:approval]"))
    if (at === -1) return { content: "Say [verify:approval] to try an approval." }
    const step = body.messages.slice(at + 1).filter((m) => m.role === "assistant").length
    return step === 0
      ? {
          toolCall: {
            name: "bash",
            args: {
              description: "Print a marker",
              command: `echo ${MARK}`,
              sandbox_permissions: "danger-full-access",
              justification: "This check needs the command to run unsandboxed.",
            },
          },
        }
      : { content: "Finished the approval check." }
  },
})
writeDevice({ url: fake.url, token: fake.issueToken(), deviceId: "11111111-2222-4333-8444-555555555555" })

const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "--no-open", "--port", webPort], {
  cwd: mkdtempSync(join(tmpdir(), "kriya-ws-")),
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
})

createServer((req, res) => {
  const url = new URL(req.url, "http://control")
  const approvals = [...fake.state.approvals.values()]
  if (req.method === "POST" && url.pathname === "/answer") {
    const pending = approvals.findLast((a) => a.status === "pending")
    const ok = pending ? fake.answer(pending.id, url.searchParams.get("status")) : false
    res.writeHead(ok ? 200 : 409).end(JSON.stringify({ ok }))
    return
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify(approvals.map((a) => ({ status: a.status, tool: a.body.tool, input: a.body.input, summary: a.body.summary })))
  )
}).listen(controlPort, "127.0.0.1", () => console.log(`verify: control on http://127.0.0.1:${controlPort}`))

const stop = () => {
  child.kill("SIGTERM")
  fake.close().finally(() => process.exit(0))
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
child.on("exit", stop)
