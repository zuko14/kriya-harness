import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { test } from "node:test"

import { BrowserError, LocalBrowser, localUrl } from "../src/browser.js"
import { freshHome } from "./helpers.js"

// The agent's localhost browser (src/browser.js), WP-BR-*: loopback only,
// on the Chrome already installed, against a fixture page this test serves.
// No real site is contacted: the outside navigation is aborted before it is
// sent.

test("WP-BR-01: only loopback http(s) addresses, never the harness's own port", () => {
  for (const [input, url] of [
    ["localhost:3000", "http://localhost:3000/"],
    ["5173", "http://localhost:5173/"],
    ["http://127.0.0.1:8080/x?y=1", "http://127.0.0.1:8080/x?y=1"],
    ["https://app.localhost", "https://app.localhost/"],
    ["http://[::1]:9000", "http://[::1]:9000/"],
  ])
    assert.equal(localUrl(input, { selfPort: "6796" }).url, url, input)
  for (const input of ["https://example.com", "http://10.0.0.2:3000", "http://localhost.evil.com", "file:///etc/hosts", "javascript:alert(1)", "http://a:b@localhost:3000", "localhost:6796", "", null])
    assert.ok(localUrl(input, { selfPort: "6796" }).error, String(input))
})

// Chrome is needed for the rest; macOS's and the CI runner's standard places
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].some((p) => existsSync(p))
const noChrome = CHROME ? false : "Google Chrome isn't installed here; the engine runs on the installed Chrome"

const PAGE = `<!doctype html><title>Fixture app</title>
<h1 id="h">Counter: 0</h1>
<button id="add" onclick="n++;document.getElementById('h').textContent='Counter: '+n;console.log('clicked',n)">Add one</button>
<input id="name" placeholder="Your name" oninput="document.getElementById('out').textContent='Hello '+this.value">
<p id="out"></p>
<a id="away" href="https://example.com/">Leave</a>
<script>let n=0;console.log('ready');fetch('/api/ping').then(r=>r.text()).then(t=>console.log('api',t))</script>`

async function fixture() {
  const server = createServer((req, res) => {
    if (req.url === "/api/ping") return res.end("pong")
    res.setHeader("content-type", "text/html")
    res.end(PAGE)
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

test("WP-BR-02: open, read, click, type, console and network on a local app; outside navigation aborted", { skip: noChrome, timeout: 120_000 }, async () => {
  freshHome()
  const { server, url } = await fixture()
  const browser = new LocalBrowser({ selfPort: "6796" })
  try {
    const opened = await browser.open(url)
    assert.equal(opened.title, "Fixture app")
    assert.equal(opened.status, 200)
    const page = await browser.read()
    assert.match(page.text, /Counter: 0/)
    const add = page.elements.find((e) => e.name === "Add one")
    const name = page.elements.find((e) => e.name === "Your name")
    assert.ok(add && name, JSON.stringify(page.elements))
    await browser.click(add.ref)
    await browser.type(name.ref, "Asha")
    const after = await browser.read()
    assert.match(after.text, /Counter: 1/)
    assert.match(after.text, /Hello Asha/)
    const logs = browser.logs()
    assert.ok(logs.console.some((m) => m.text === "clicked 1"), JSON.stringify(logs.console))
    assert.ok(logs.console.some((m) => m.text === "api pong"), JSON.stringify(logs.console))
    assert.ok(browser.requests().some((r) => r.url.endsWith("/api/ping") && r.status === 200))
    const shot = await browser.screenshot()
    assert.equal(shot.mimeType, "image/jpeg")
    assert.ok(Buffer.from(shot.data, "base64").length > 1000)
    // A link out of localhost: Chrome is stopped before the request leaves
    const away = after.elements.find((e) => e.name === "Leave")
    const left = await browser.click(away.ref)
    assert.deepEqual(left.refused, ["https://example.com/"])
    assert.ok(browser.logs().blocked.some((b) => b.url.startsWith("https://example.com")), JSON.stringify(browser.logs().blocked))
    assert.ok((await browser.read()).url.startsWith(url), "still on the local app")
    await assert.rejects(browser.open("https://example.com"), BrowserError)
    await assert.rejects(browser.open("localhost:6796"), /Kriya Harness itself/)
    await assert.rejects(browser.click("e999"), /Unknown element ref/)
  } finally {
    await browser.close()
    server.close()
  }
})

test("WP-BR-03: a closed port says the app isn't running; nothing open means open first", { skip: noChrome, timeout: 60_000 }, async () => {
  freshHome()
  const browser = new LocalBrowser()
  try {
    await assert.rejects(browser.read(), /call browser_open/)
    await assert.rejects(browser.open("http://127.0.0.1:1/"), /Nothing is listening|Couldn't open/)
  } finally {
    await browser.close()
  }
})

test("WP-BR-04: the view's routes: state, a frame or nothing, and the person's input; Read only refuses acting tools", async () => {
  const { routes, tools, ROUTES } = await import("../plugins/browser/index.js")
  const calls = []
  const fake = {
    current: undefined,
    frame: async () => (fake.current ? { url: "http://localhost:3000/a b", data: Buffer.from([0xff, 0xd8, 1, 2]) } : undefined),
    open: async (url) => (calls.push(["open", url]), url.includes("example") ? Promise.reject(new BrowserError("This browser opens apps on this computer only (localhost).")) : { url }),
    pointer: async (p) => (calls.push(["pointer", p]), { url: "u" }),
    press: async (key) => (calls.push(["press", key]), { pressed: key }),
    requireOpen: async () => ({ keyboard: { type: async (t) => calls.push(["text", t]) } }),
  }
  const r = routes(fake)
  const post = (body) => r[ROUTES.input](new Request("http://127.0.0.1/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }))
  assert.deepEqual(await (await r[ROUTES.state]()).json(), { enabled: true, url: null })
  assert.equal((await r[ROUTES.frame]()).status, 204)
  fake.current = { isClosed: () => false, url: () => "http://localhost:3000/" }
  const frame = await r[ROUTES.frame]()
  assert.equal(frame.headers.get("content-type"), "image/jpeg")
  assert.equal(decodeURI(frame.headers.get("x-kriya-url")), "http://localhost:3000/a b")
  assert.equal((await post({ kind: "open", url: "localhost:3000" })).status, 200)
  assert.equal((await post({ kind: "open", url: "https://example.com" })).status, 400)
  assert.equal((await post({ kind: "click", x: 10, y: 20 })).status, 200)
  assert.equal((await post({ kind: "key", key: "Enter" })).status, 200)
  assert.equal((await post({ kind: "text", text: "hi" })).status, 200)
  assert.equal((await post({ kind: "text", text: "x".repeat(501) })).status, 400)
  assert.equal((await post({ kind: "delete-everything" })).status, 400)
  assert.equal((await post("not json")).status, 400)
  assert.deepEqual(calls.map((c) => c[0]), ["open", "open", "pointer", "press", "text"])

  const list = tools({ browser: { click: async () => ({}), type: async () => ({}), press: async () => ({}), read: async () => ({}) }, readOnly: () => true, image: async () => undefined })
  for (const name of ["browser_click", "browser_type", "browser_press"]) {
    const tool = list.find((t) => t.name === name)
    await assert.rejects(Promise.resolve().then(() => tool.execute({ ref: "e1", text: "x", key: "Enter" }, {})), /Read only/, name)
  }
  assert.deepEqual(list.map((t) => t.name), ["browser_open", "browser_read", "browser_screenshot", "browser_click", "browser_type", "browser_press", "browser_console", "browser_network"])
})

test("the agent's browser is on by default and offered only where Google Chrome is installed", async () => {
  const { switchEnv } = await import("../src/modes.js")
  const env = {}
  switchEnv([], env)
  assert.equal(env.KRIYA_BROWSER, "on")
  const off = {}
  switchEnv(["--no-browser-tools"], off)
  assert.equal(off.KRIYA_BROWSER, "off")
  const { chromeInstalled } = await import("../src/browser.js")
  assert.equal(chromeInstalled(() => false), false)
  assert.equal(chromeInstalled((p) => p === "/usr/bin/google-chrome"), true)
  const { GUIDANCE } = await import("../plugins/browser/index.js")
  assert.match(GUIDANCE, /not a Playwright, Puppeteer or headless-Chrome script/)
  assert.match(GUIDANCE, /Preview tab/)
})
