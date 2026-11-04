import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { startFakeKriya } from "./fake-kriya.js"
import { freshHome, ROOT } from "./helpers.js"

// Browser stage 2 end to end on the real, pinned DSH (headless `kriya run
// --browser-tools`), WP-BR-RUN-*: a scripted model opens a fixture app this
// test serves on a random loopback port, reads it, clicks its button and
// reads the result, all through the agent's tools on the installed Chrome.
// Without the switch no browser tool is offered. No real site is contacted.

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].some((p) => existsSync(p))
const noChrome = CHROME ? false : "Google Chrome isn't installed here; the agent's browser runs on the installed Chrome"

function kriya(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), ...args], { cwd, env: { ...process.env, KRIYA_BROWSER: "off" } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const PAGE = `<!doctype html><title>Fixture app</title><h1 id="h">Counter: 0</h1><button onclick="h.textContent='Counter: '+(++n)">Add one</button><script>let n=0</script>`

test("WP-BR-RUN-01: kriya run --browser-tools opens, reads and clicks a local app", { skip: noChrome, timeout: 300_000 }, async () => {
  freshHome()
  const server = createServer((_req, res) => (res.setHeader("content-type", "text/html"), res.end(PAGE)))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${server.address().port}/`
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-browser-run-")))
  let results = []
  let offered = []
  const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
  const fake = await startFakeKriya({
    approveAfter: 0,
    chat: (body) => {
      if (!body.tools?.length) return { content: "Browser check" }
      offered = body.tools.map((t) => t.function?.name ?? t.name)
      results = body.messages.filter((m) => m.role === "tool").map(text)
      const step = results.length
      if (step === 0) return { toolCall: { name: "browser_open", args: { url } } }
      if (step === 1) return { toolCall: { name: "browser_read", args: {} } }
      if (step === 2) {
        const ref = /(e\d+) button "Add one"/.exec(results[1])?.[1] ?? "e1"
        return { toolCall: { name: "browser_click", args: { ref } } }
      }
      if (step === 3) return { toolCall: { name: "browser_read", args: {} } }
      if (step === 4) return { toolCall: { name: "browser_open", args: { url: "https://example.com" } } }
      return { content: "The counter went from 0 to 1." }
    },
  })
  try {
    const login = await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)
    assert.equal(login.code, 0, login.stderr)
    const run = await kriya(["run", "--browser-tools", "Check the counter app"], dir)
    const report = `exit ${run.code}\nresults: ${JSON.stringify(results).slice(0, 3000)}\nstderr: ${run.stderr.slice(-1500)}`
    assert.equal(run.code, 0, report)
    for (const name of ["browser_open", "browser_read", "browser_screenshot", "browser_click", "browser_type", "browser_press", "browser_console", "browser_network"]) assert.ok(offered.includes(name), `${name}\n${report}`)
    assert.match(results[0], /Opened http:\/\/127\.0\.0\.1:\d+\/ \(200\): Fixture app/, report)
    assert.match(results[1], /Counter: 0/, report)
    assert.match(results[2], /Clicked/, report)
    assert.match(results[3], /Counter: 1/, report)
    assert.match(results[4], /opens apps on this computer only/, report)
  } finally {
    await fake.close()
    server.close()
  }
})

test("WP-BR-RUN-02: without --browser-tools no browser tool is offered", { timeout: 300_000 }, async () => {
  freshHome()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-browser-off-")))
  let offered = []
  const fake = await startFakeKriya({ approveAfter: 0, chat: (body) => (body.tools?.length && (offered = body.tools.map((t) => t.function?.name ?? t.name)), { content: "Done." }) })
  try {
    assert.equal((await kriya(["login", "--url", fake.url, "--no-browser"], ROOT)).code, 0)
    const run = await kriya(["run", "Say done"], dir)
    assert.equal(run.code, 0, run.stderr.slice(-1500))
    assert.ok(offered.length > 0)
    assert.equal(offered.filter((n) => n.startsWith("browser_")).length, 0, offered.join(", "))
  } finally {
    await fake.close()
  }
})
