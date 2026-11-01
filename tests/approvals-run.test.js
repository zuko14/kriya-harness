import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// H5 end to end on the real, pinned DSH (headless `kriya run`): the fake
// gateway asks for a bash call that needs wider sandbox access, so DSH's
// approval seam asks; the only answerer is the Kriya plugin, which posts
// the request to the fake Kriya; the test answers it as the phone would.
// The command is a harmless echo. Nothing leaves this machine.

const MARK = "kriya-approved-run"

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

async function runWith(answer) {
  freshHome()
  let fake
  fake = await startFakeKriya({
    approveAfter: 0,
    // The phone answers a moment after the request arrives
    onApproval: ({ id }) => setTimeout(() => fake.answer(id, answer), 300),
    chat: (_body, turn) =>
      turn === 1
        ? {
            toolCall: {
              name: "bash",
              args: {
                description: "Print a marker",
                command: `echo ${MARK}`,
                sandbox_permissions: "danger-full-access",
                justification: "The test needs this exact command to run unsandboxed.",
              },
            },
          }
        : { content: "Finished." },
  })
  const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
  assert.equal(login.code, 0, login.stderr)
  const run = await kriya(["run", "Run the check"], mkdtempSync(join(tmpdir(), "kriya-ws-")))
  await fake.close()
  const chats = fake.state.requests.filter((r) => r.path === "/chat/completions")
  const toolResult = JSON.stringify(chats.at(-1)?.body?.messages?.filter((m) => m.role === "tool"))
  // What a failure message needs: the run's output, the bash tool DSH offered, the result
  const bash = chats[0]?.body?.tools?.find((t) => t.function?.name === "bash")
  run.report = [
    `exit ${run.code}; ${chats.length} model turns`,
    `bash parameters offered: ${Object.keys(bash?.function?.parameters?.properties ?? {}).join(", ") || "(no bash tool)"}`,
    `tool result: ${toolResult?.slice(0, 800)}`,
    `stdout: ${run.stdout.slice(-800)}`,
    `stderr: ${run.stderr.slice(-800)}`,
  ].join("\n")
  return { fake, run, toolResult }
}

test("approved on the phone: DSH runs the command once", { timeout: 300_000 }, async () => {
  const { fake, run, toolResult } = await runWith("approved")
  assert.equal(run.code, 0, run.stderr)
  const [approval] = fake.state.approvals.values()
  assert.ok(approval, `no approval request reached Kriya\n${run.report}`)
  assert.equal(approval.status, "approved")
  assert.equal(approval.body.tool, "bash")
  assert.equal(approval.body.input.command, `echo ${MARK}`)
  assert.match(run.stderr, /bash needs your OK\. Waiting for your answer in Kriya on your phone\./)
  // The echo's output, not the command text
  assert.match(toolResult, new RegExp(`(?<!echo )${MARK}`), run.report)
  assert.match(run.stdout, /Finished\./)
})

test("declined on the phone: the command doesn't run", { timeout: 300_000 }, async () => {
  const { fake, run, toolResult } = await runWith("declined")
  assert.equal(run.code, 0, run.stderr)
  assert.equal([...fake.state.approvals.values()][0]?.status, "declined")
  // The model is told no; the echo's output never appears
  assert.match(toolResult, /reject|denied|declin/i)
  assert.doesNotMatch(toolResult.replace(`echo ${MARK}`, ""), new RegExp(`(?<!echo )${MARK}`))
})
