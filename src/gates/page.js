import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { inflateSync } from "node:zlib"

import { browserTarget, localUrl } from "../browser.js"

// Harness 2.0 W4: the gates' own browser (Kriya-Tavi docs/kriya-harness/
// upgrade_2.0/GATES.md G-UI, G-A11Y; REAUDIT RA-20). Never the agent's shared
// page: a short-lived headless browser of the same installed Chrome, one
// context per viewport and colour scheme, the same loopback rule on every
// navigation (src/browser.js localUrl), closed when the gate ends. It reads
// the rendered page; it clicks, types and submits nothing.

export const VIEWPORTS = [
  { name: "360", width: 360, height: 780 },
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
]
export const SCHEMES = ["light", "dark"]

const NAV_MS = 30_000
const IDLE_MS = 5_000

/** Runs `fn(open)` with a gate browser; `open(url, { viewport, scheme, reducedMotion })` gives a page report. Closes everything after. */
export async function withGateBrowser(fn, { launch } = {}) {
  const target = browserTarget()
  if (!target && !launch) return { unavailable: "no Chrome, Edge, Brave or Chromium on this computer" }
  let browser
  try {
    if (launch) browser = await launch()
    else {
      const { chromium } = await import("playwright-core")
      browser = await chromium.launch({ ...target, headless: true, args: ["--no-first-run", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--disable-component-update"] })
    }
  } catch (error) {
    return { unavailable: `the browser didn't start (${String(error?.message ?? error).split("\n")[0].slice(0, 160)})` }
  }
  try {
    // G-3D (W13) opens its own pages on the same browser, so it gets the browser too
    return { value: await fn((url, options) => visit(browser, url, options), browser) }
  } finally {
    await browser.close().catch(() => {})
  }
}

// Installed before the page's own scripts: layout shifts as they happen
const INIT = `(() => {
  window.__kriyaCLS = 0
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__kriyaCLS += e.value
    }).observe({ type: "layout-shift", buffered: true })
  } catch {}
})()`

async function visit(browser, url, { viewport, scheme = "light", reducedMotion = "no-preference" }) {
  const target = localUrl(url)
  if (target.error) throw new Error(target.error)
  const origin = new URL(target.url).origin
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme, reducedMotion, acceptDownloads: false, serviceWorkers: "block" })
  try {
    await context.route("**/*", (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && localUrl(request.url()).error) return route.abort("blockedbyclient")
      return route.continue()
    })
    await context.addInitScript(INIT)
    const page = await context.newPage()
    const consoleErrors = []
    const failed = []
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)))
    page.on("pageerror", (e) => consoleErrors.push(String(e?.message ?? e).slice(0, 300)))
    page.on("response", (r) => {
      const u = r.url()
      if (r.status() >= 400 && u.startsWith(origin) && !/\/favicon\.ico$/.test(u)) failed.push(`${r.status()} ${u.slice(origin.length) || "/"}`)
    })
    page.on("requestfailed", (r) => r.url().startsWith(origin) && failed.push(`failed ${r.url().slice(origin.length) || "/"} (${r.failure()?.errorText ?? "error"})`))
    let status = null
    try {
      status = (await page.goto(target.url, { waitUntil: "load", timeout: NAV_MS }))?.status() ?? null
    } catch (error) {
      return { url: target.url, viewport: viewport.name, scheme, unreachable: /ERR_CONNECTION_REFUSED/.test(String(error?.message)) ? "nothing answers there" : String(error?.message ?? error).split("\n")[0].slice(0, 200) }
    }
    await page.waitForLoadState("networkidle", { timeout: IDLE_MS }).catch(() => {})
    await page.waitForTimeout(250)
    const facts = await page.evaluate(MEASURE)
    const glass = []
    for (const g of facts.glass.slice(0, 12)) {
      const clip = { x: Math.max(0, g.box.x), y: Math.max(0, g.box.y), width: Math.max(1, Math.min(g.box.width, viewport.width - Math.max(0, g.box.x))), height: Math.max(1, Math.min(g.box.height, viewport.height - Math.max(0, g.box.y))) }
      // The text hidden, the backdrop shot: contrast against its lightest and darkest pixel
      await page.evaluate(({ i, hide }) => document.querySelectorAll("[data-kriya-glass]")[i]?.style.setProperty("color", hide ? "transparent" : "", hide ? "important" : ""), { i: g.index, hide: true })
      const png = await page.screenshot({ clip, animations: "disabled" }).catch(() => null)
      await page.evaluate(({ i }) => document.querySelectorAll("[data-kriya-glass]")[i]?.style.removeProperty("color"), { i: g.index })
      if (!png) continue
      const range = luminanceRange(png)
      if (range) glass.push({ ...g, worst: Math.min(contrast(g.text, range.min), contrast(g.text, range.max)) })
    }
    const shot = await page.screenshot({ fullPage: false, animations: "disabled" }).catch(() => null)
    return { url: target.url, viewport: viewport.name, scheme, status, consoleErrors, failed, ...facts, glass, shot }
  } finally {
    await context.close().catch(() => {})
  }
}

/** Runs in the page: overflow, layout shift, targets, names, headings, lang, text contrast and glass surfaces. */
const MEASURE = () => {
  const parse = (c) => {
    const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)/.exec(c || "")
    if (!m) return null
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4])
    return [Number(m[1]), Number(m[2]), Number(m[3]), a]
  }
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0
  }
  const backdrop = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n)
      if ((s.backdropFilter && s.backdropFilter !== "none") || (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none")) return { glass: n }
      const bg = parse(s.backgroundColor)
      if (bg && bg[3] >= 0.95) return { color: bg }
      if (bg && bg[3] > 0.05) return { glass: n }
      if (s.backgroundImage && s.backgroundImage !== "none") return { image: true }
    }
    return { color: [255, 255, 255, 1] }
  }
  const overflow = document.scrollingElement.scrollWidth > window.innerWidth + 1
  const small = []
  const unnamed = []
  const interactive = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [tabindex]:not([tabindex='-1'])")].filter(visible)
  for (const el of interactive) {
    const r = el.getBoundingClientRect()
    if (Math.min(r.width, r.height) < 44) small.push({ what: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""), size: [Math.round(r.width), Math.round(r.height)] })
    const labelled = el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || (el.textContent || "").trim() || el.querySelector("img[alt]:not([alt=''])") || (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) && el.value)
    if (!labelled) unnamed.push(el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/)[0]}` : ""))
  }
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((h) => Number(h.tagName[1]))
  const skips = headings.filter((h, i) => i > 0 && h > headings[i - 1] + 1).length
  const lowContrast = []
  const glassText = []
  const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (t) => ((t.textContent || "").trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) })
  for (let t = walker.nextNode(), n = 0; t && n < 400; t = walker.nextNode(), n++) {
    const el = t.parentElement
    if (!el || seen.has(el) || !visible(el)) continue
    seen.add(el)
    const s = getComputedStyle(el)
    const fg = parse(s.color)
    if (!fg || fg[3] < 0.1) continue
    const size = Number.parseFloat(s.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
    const need = large ? 3 : 4.5
    const behind = backdrop(el)
    if (behind.glass) {
      if (glassText.length < 12) {
        el.setAttribute("data-kriya-glass", "")
        const r = el.getBoundingClientRect()
        glassText.push({ index: glassText.length, text: fg, need, what: el.tagName.toLowerCase(), box: { x: r.x, y: r.y, width: r.width, height: r.height } })
      }
    } else if (behind.color) {
      const value = ratio(fg, behind.color)
      if (value < need) lowContrast.push({ what: el.tagName.toLowerCase(), text: (t.textContent || "").trim().slice(0, 40), ratio: Math.round(value * 100) / 100, need })
    }
  }
  return {
    overflow,
    cls: Math.round((window.__kriyaCLS ?? 0) * 1000) / 1000,
    small,
    unnamed: unnamed.slice(0, 20),
    lang: Boolean(document.documentElement.getAttribute("lang")),
    headingSkips: skips,
    lowContrast: lowContrast.slice(0, 20),
    glass: glassText,
  }
}

const relLum = (r, g, b) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
/** WCAG contrast between an [r,g,b] colour and a relative luminance */
export const contrast = (rgb, luminance) => {
  const a = relLum(rgb[0], rgb[1], rgb[2])
  return (Math.max(a, luminance) + 0.05) / (Math.min(a, luminance) + 0.05)
}

/** The lightest and darkest relative luminance in a PNG (8-bit RGB/RGBA, any filter), or null. */
export function luminanceRange(png) {
  const pixels = decodePng(png)
  if (!pixels) return null
  let min = 1
  let max = 0
  for (let i = 0; i < pixels.data.length; i += pixels.channels) {
    const l = relLum(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2])
    if (l < min) min = l
    if (l > max) max = l
  }
  return { min, max }
}

/** A minimal PNG decoder for screenshots: 8-bit truecolour (2) or truecolour+alpha (6), not interlaced. */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let width
  let height
  let type
  const idat = []
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at)
    const name = buf.toString("ascii", at + 4, at + 8)
    const body = buf.subarray(at + 8, at + 8 + length)
    if (name === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0) return null
      type = body[9]
    } else if (name === "IDAT") idat.push(body)
    else if (name === "IEND") break
    at += 12 + length
  }
  const channels = type === 6 ? 4 : type === 2 ? 3 : 0
  if (!channels || !width || !height) return null
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0
      const up = y > 0 ? out[(y - 1) * stride + x] : 0
      const ul = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0
      let v = line[x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - ul
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - ul)
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      }
      out[y * stride + x] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

/** Saves a screenshot as evidence outside the project; returns its sha256. */
export function keepShot(dir, name, png) {
  if (!png) return undefined
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), png)
  return createHash("sha256").update(png).digest("hex")
}
