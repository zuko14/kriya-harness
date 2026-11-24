import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// The Supabase and Render tools on the real, pinned DSH (plugins/providers):
// offered to the model only with --provider-tools (or the Developer tab's saved
// switch); without it, none of them. No provider CLI is run. PV-RUN-01.

function kriya(args, cwd) {
  return new Promise((done) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KRIYA_") || k === "KRIYA_HOME"))
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...base, KRIYA_LOOP: "off", KRIYA_ROUTER: "off", KRIYA_BROWSER: "off" } })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("exit", (code) => (clearTimeout(timer), done({ code, stderr })))
  })
}

async function toolsOffered(flags) {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-providers-run-")))
  const fake = await startFakeKriya({ approveAfter: 0, chat: () => ({ content: "Done." }) })
  assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
  const run = await kriya(["run", ...flags, "List my Supabase projects"], dir)
  await fake.close()
  const asked = fake.state.requests.find((r) => r.path === "/chat/completions" && r.body?.tools?.length)
  return { run, names: (asked?.body.tools ?? []).map((t) => t.function?.name ?? t.name) }
}

const PROVIDER_TOOLS = ["supabase_projects", "supabase_migrations", "supabase_migrate_local", "render_services", "render_deploys", "render_logs"]

test("PV-RUN-01: --provider-tools offers the six tools to the model; without it, none (real DSH)", { timeout: 300_000 }, async () => {
  const on = await toolsOffered(["--provider-tools"])
  assert.equal(on.run.code, 0, on.run.stderr.slice(-800))
  for (const name of PROVIDER_TOOLS) assert.ok(on.names.includes(name), `${name}: ${on.names.join(",")}`)
  const off = await toolsOffered([])
  assert.equal(off.run.code, 0, off.run.stderr.slice(-800))
  assert.deepEqual(off.names.filter((n) => PROVIDER_TOOLS.includes(n)), [])
})
