import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { kriyaHome } from "./paths.js"

// The agent's localhost browser (browser stage 2; WORKSPACE_PANEL_SKILLS_PLUGINS.md
// §3b in the Kriya repository): the Chrome already on this computer, driven
// through playwright-core, headless, with its own profile in
// ~/.kriya/browser/. It opens only apps on this computer: every navigation
// request (any frame) must be a loopback http(s) address that isn't Kriya
// Harness's own port, or it is aborted before it is sent. A page's other
// requests (fonts, its own API calls) are allowed. One browser and one page
// per harness process, shared by the agent's tools and the person's view.

export class BrowserError extends Error {}

// Where Google Chrome lives on macOS, Linux and Windows (playwright's "chrome" channel uses the same)
export const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ...(process.env["PROGRAMFILES(X86)"] ? [join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")] : []),
]

// Other Chromium browsers, used when Google Chrome isn't there
export const CHROMIUM_PATHS = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/microsoft-edge",
  "/usr/bin/brave-browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  ...(process.env["PROGRAMFILES(X86)"] ? [join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")] : []),
]

/** What the agent's browser launches with: Google Chrome's channel, else another Chromium browser, else null */
export function browserTarget(exists = existsSync, chrome = CHROME_PATHS, others = CHROMIUM_PATHS) {
  if (chrome.some((p) => exists(p))) return { channel: "chrome" }
  const executablePath = others.find((p) => exists(p))
  return executablePath ? { executablePath } : null
}

/** Whether a browser the agent can use is installed */
export const chromeInstalled = (exists = existsSync, paths = CHROME_PATHS, others = CHROMIUM_PATHS) => browserTarget(exists, paths, others) !== null

// Chrome allows one process per profile; `kriya` and a task from Kriya can run at once
const PROFILE_BUSY = /ProcessSingleton|SingletonLock|profile.*(in use|already)|user data directory is already/i

const RING = 200
const TEXT_LIMIT = 8000
const ELEMENTS = 150
export const VIEWPORT = { width: 1280, height: 800 }

/**
 * A loopback http(s) address to open, normalised, or { error }. The same
 * rule as the Preview tab (plugins/preview/client.js previewUrl).
 * @param {unknown} input
 * @param {{ selfPort?: string }} [self] the Web UI's own port, refused
 */
export function localUrl(input, { selfPort } = {}) {
  let text = typeof input === "string" ? input.trim() : ""
  if (!text) return { error: "Give a local address, e.g. localhost:3000." }
  if (/^\d{2,5}(\/|$)/.test(text)) text = `localhost:${text}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    return { error: "That isn't an address." }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http and https addresses." }
  if (url.username || url.password) return { error: "Addresses with a user name or password aren't opened." }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
  if (!loopback) return { error: "This browser opens apps on this computer only (localhost)." }
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  if (selfPort && port === String(selfPort)) return { error: "That's Kriya Harness itself; open your app's port instead." }
  return { url: url.href }
}

const push = (ring, item) => {
  ring.push(item)
  if (ring.length > RING) ring.shift()
}

// Elements a person or test would act on, in page order
const INTERACTIVE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=true], [onclick]"

export class LocalBrowser {
  /**
   * @param {{ selfPort?: string | (() => string | number | undefined), profileDir?: string, launch?: (dir: string, options: object) => Promise<any> }} [options]
   *   selfPort: the Web UI's own port (or a getter, read when a page is opened), refused
   *   launch: playwright's chromium.launchPersistentContext (injected for tests)
   */
  constructor({ selfPort, profileDir = join(kriyaHome(), "browser", "profile"), launch } = {}) {
    this.port = typeof selfPort === "function" ? selfPort : () => selfPort
    this.profileDir = profileDir
    this.launch = launch
    this.console = []
    this.network = []
    this.refs = []
    this.blocked = []
    this.starting = undefined
  }

  /** The page, starting Chrome on first use */
  async page() {
    if (this.current && !this.current.isClosed()) return this.current
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  async start() {
    let launch = this.launch
    if (!launch) {
      const { chromium } = await import("playwright-core")
      launch = (dir, options) => chromium.launchPersistentContext(dir, options)
    }
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })
    const options = {
        ...(browserTarget() ?? { channel: "chrome" }),
        headless: true,
        viewport: VIEWPORT,
        acceptDownloads: false,
        // Nothing of the person's: no extensions, no sync, no first-run calls home
        args: ["--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--disable-component-update"],
    }
    try {
      try {
        this.context = await launch(this.profileDir, options)
      } catch (error) {
        if (!PROFILE_BUSY.test(String(error?.message))) throw error
        // Another kriya has the profile open: this process gets its own for this run
        this.spareProfile = mkdtempSync(join(tmpdir(), "kriya-browser-"))
        this.context = await launch(this.spareProfile, options)
      }
    } catch (error) {
      throw new BrowserError(
        /executable|channel|not found|ENOENT/i.test(String(error?.message)) ? "No Chrome, Edge, Brave or Chromium on this computer; the agent's browser needs one." : `Chrome didn't start: ${String(error?.message ?? error).split("\n")[0]}`
      )
    }
    await this.context.route("**/*", (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && localUrl(request.url(), { selfPort: this.port()?.toString() }).error) {
        push(this.blocked, { at: Date.now(), url: request.url().slice(0, 300) })
        return route.abort("blockedbyclient")
      }
      return route.continue()
    })
    const page = this.context.pages()[0] ?? (await this.context.newPage())
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !localUrl(frame.url(), { selfPort: this.port()?.toString() }).error) this.lastLocal = frame.url()
    })
    page.on("console", (m) => push(this.console, { at: Date.now(), type: m.type(), text: m.text().slice(0, 1000) }))
    page.on("pageerror", (e) => push(this.console, { at: Date.now(), type: "error", text: String(e?.message ?? e).slice(0, 1000) }))
    page.on("response", (r) => push(this.network, { at: Date.now(), method: r.request().method(), url: r.url().slice(0, 300), status: r.status() }))
    page.on("requestfailed", (r) => push(this.network, { at: Date.now(), method: r.method(), url: r.url().slice(0, 300), status: null, failure: r.failure()?.errorText }))
    this.current = page
    return page
  }

  /** Opens a local address; anything else is refused before Chrome sees it */
  async open(input) {
    const { url, error } = localUrl(input, { selfPort: this.port()?.toString() })
    if (error) throw new BrowserError(error)
    const page = await this.page()
    try {
      const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 })
      return { url: page.url(), title: await page.title(), status: response?.status() ?? null }
    } catch (error) {
      throw new BrowserError(/ERR_CONNECTION_REFUSED/.test(String(error?.message)) ? `Nothing is listening at ${url}: is the app running?` : `Couldn't open ${url}: ${String(error?.message ?? error).split("\n")[0]}`)
    }
  }

  /**
   * After an action: a navigation refused by the guard leaves Chrome on its
   * error page, so go back to the last local page and say what was refused.
   */
  async settle(page, since) {
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {})
    const refused = this.blocked.filter((b) => b.at >= since).map((b) => b.url)
    if (page.url().startsWith("chrome-error://") && this.lastLocal) await page.goto(this.lastLocal, { waitUntil: "load", timeout: 30_000 }).catch(() => {})
    return { url: page.url(), title: await page.title(), ...(refused.length && { refused }) }
  }

  async requireOpen() {
    const page = await this.page()
    if (page.url() === "about:blank") throw new BrowserError("No page is open: call browser_open with your app's local address first.")
    return page
  }

  /** The page's text and the elements on it, each with a ref for click and type */
  async read() {
    const page = await this.requireOpen()
    const handles = await page.$$(INTERACTIVE)
    const elements = []
    this.refs = []
    for (const handle of handles) {
      if (elements.length >= ELEMENTS) break
      const info = await handle.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const label = el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || ""
        return { visible: r.width > 0 && r.height > 0, role: el.getAttribute("role") || el.tagName.toLowerCase(), type: el.getAttribute("type") || undefined, name: String(label).replace(/\s+/g, " ").trim().slice(0, 80) }
      })
      if (!info.visible) continue
      this.refs.push(handle)
      elements.push({ ref: `e${this.refs.length}`, role: info.role, ...(info.type && { type: info.type }), name: info.name })
    }
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{3,}/g, "\n\n").trim()
    return { url: page.url(), title: await page.title(), text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… (cut)` : text, elements }
  }

  handle(ref) {
    const n = /^e(\d+)$/.exec(String(ref ?? ""))?.[1]
    const handle = n && this.refs[Number(n) - 1]
    if (!handle) throw new BrowserError("Unknown element ref: call browser_read first and use one of its refs.")
    return handle
  }

  async click(ref) {
    const page = await this.requireOpen()
    const since = Date.now()
    await this.handle(ref).click({ timeout: 10_000 })
    return this.settle(page, since)
  }

  async type(ref, text) {
    await this.requireOpen()
    if (typeof text !== "string" || text.length > 2000) throw new BrowserError("Text to type is a string of at most 2000 characters.")
    await this.handle(ref).fill(text, { timeout: 10_000 })
    return { typed: text.length }
  }

  async press(key) {
    const page = await this.requireOpen()
    if (typeof key !== "string" || !/^[A-Za-z0-9+]{1,30}$/.test(key)) throw new BrowserError("A key is a name like Enter, Tab, Escape or ArrowDown.")
    const since = Date.now()
    await page.keyboard.press(key)
    return { pressed: key, ...(await this.settle(page, since)) }
  }

  /** A JPEG of the visible page, base64 */
  async screenshot() {
    const page = await this.requireOpen()
    return { url: page.url(), mimeType: "image/jpeg", data: (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64") }
  }

  /** The person's view: a JPEG of whatever is open (blank before anything is), and where */
  async frame() {
    if (!this.current || this.current.isClosed()) return undefined
    const page = this.current
    return { url: page.url(), data: await page.screenshot({ type: "jpeg", quality: 60 }) }
  }

  /** The person clicks or scrolls the view at x, y in page pixels */
  async pointer({ x, y, kind = "click", deltaY = 0 }) {
    const page = await this.requireOpen()
    if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 10_000)) throw new BrowserError("A point is two numbers in the page.")
    const since = Date.now()
    if (kind === "wheel") await page.mouse.wheel(0, Math.max(-5000, Math.min(5000, Number(deltaY) || 0)))
    else await page.mouse.click(x, y)
    return this.settle(page, since)
  }

  logs({ since = 0 } = {}) {
    return { console: this.console.filter((m) => m.at > since), blocked: this.blocked.filter((b) => b.at > since) }
  }

  requests({ since = 0 } = {}) {
    return this.network.filter((r) => r.at > since)
  }

  async close() {
    const context = this.context
    this.context = this.current = undefined
    await context?.close().catch(() => {})
    if (this.spareProfile) rmSync(this.spareProfile, { recursive: true, force: true })
    this.spareProfile = undefined
  }
}
