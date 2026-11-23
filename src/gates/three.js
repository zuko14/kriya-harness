import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { localUrl } from "../browser.js"
import { CONTRACTS_DIR } from "../contracts.js"
import { kriyaHome } from "../paths.js"
import { readStack } from "../stack.js"
import { decodePng, keepShot, withGateBrowser } from "./page.js"

// Harness 2.0 W13 (WD-17): G-3D (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// THREE_D_AND_CREATIVE.md §4). Every number comes from an init script on the
// gate's own page that wraps HTMLCanvasElement.prototype.getContext before
// the app runs, so each WebGL context the page creates is counted by the gate,
// never reported by the app (it can't flatter them). The counts live in a
// closure, read through a non-writable, non-configurable function. Frame
// time is reported with the renderer string and never gated: headless Chrome
// may render on a software path that says nothing about a phone's GPU.

/** Code ceilings per tier; scene_direction.json can only tighten them. */
export const CEILINGS = Object.freeze({
  low: Object.freeze({ drawCalls: 100, triangles: 300_000, textureBytes: 64 * 2 ** 20, routeBytes: 8 * 2 ** 20, dpr: 1.5 }),
  mid: Object.freeze({ drawCalls: 300, triangles: 1_000_000, textureBytes: 256 * 2 ** 20, routeBytes: 16 * 2 ** 20, dpr: 2 }),
  high: Object.freeze({ drawCalls: 1000, triangles: 3_000_000, textureBytes: 512 * 2 ** 20, routeBytes: 32 * 2 ** 20, dpr: 2 }),
})
/** Each viewport, its device pixel ratio (above every cap, so an uncapped ratio shows) and the tier it is judged against. */
export const VIEWPORTS_3D = Object.freeze([
  Object.freeze({ name: "390", width: 390, height: 844, dpr: 3, tiers: ["low", "mid", "high"] }),
  Object.freeze({ name: "1440", width: 1440, height: 900, dpr: 3, tiers: ["high", "mid", "low"] }),
])
export const FRAMES = 120
export const LEAK_SLACK = 0.05
const FRAME_WAIT_MS = 8_000
const NAV_MS = 30_000
const RESTORE_WAIT_MS = 2_000
const DIRECTION = "scene_direction.json"
const READ = "__kriya3dRead"

/** The tier's budget: the code ceiling, tightened (never loosened) by the contract. */
export function budgetFor(tiers, wanted) {
  const tier = wanted.find((t) => tiers?.[t]) ?? wanted[0]
  const ceiling = CEILINGS[tier]
  const asked = tiers?.[tier] ?? {}
  const out = { tier, dpr: ceiling.dpr }
  for (const key of ["drawCalls", "triangles", "textureBytes", "routeBytes"]) out[key] = Number.isInteger(asked[key]) && asked[key] > 0 ? Math.min(asked[key], ceiling[key]) : ceiling[key]
  return out
}

/**
 * The drawing buffer against the CSS size: wider than CSS × min(DPR, cap) is an
 * uncapped pixel ratio; narrower than the CSS size is a stretched, blurry canvas.
 * A ratio below the cap is the app's choice (a lower tier), not a fault. 2 px slack.
 */
export function bufferProblem(canvas, dpr, cap) {
  if (!canvas || !canvas.clientWidth) return null
  const most = Math.round(canvas.clientWidth * Math.min(dpr, cap))
  if (canvas.width > most + 2) return `the drawing buffer is ${canvas.width}px wide for ${canvas.clientWidth} CSS px at DPR ${dpr}, over ${most} (the tier's cap of ${cap}): the pixel ratio is uncapped`
  if (canvas.width < canvas.clientWidth - 2) return `the drawing buffer is ${canvas.width}px wide for ${canvas.clientWidth} CSS px: not synced to the CSS size, so it stretches and blurs`
  return null
}

/** The direction, or null when absent or broken (G-CONTRACT reports a broken one). */
export function readDirection(root) {
  const file = join(root, CONTRACTS_DIR, DIRECTION)
  if (!existsSync(file)) return null
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(value?.routes) && value.routes.length ? value : null
  } catch {
    return null
  }
}

// Installed on the gate's own page before any of the app's scripts
export const WRAP = `(() => {
  const P = HTMLCanvasElement.prototype
  const original = P.getContext
  const WEBGL = new Set(["webgl", "webgl2", "experimental-webgl"])
  const contexts = []
  const frames = []
  let errors = 0
  let draws = 0
  let triangles = 0
  const prims = (mode, count, n) => {
    const c = Math.max(0, count) * Math.max(1, n || 1)
    return mode === 4 ? c / 3 : mode === 5 || mode === 6 ? Math.max(0, c - 2) : 0
  }
  const KINDS = { Texture: "textures", Buffer: "buffers", Program: "programs", Framebuffer: "framebuffers", Renderbuffer: "renderbuffers" }
  function track(canvas, gl) {
    const rec = { canvas, gl, live: { textures: new Set(), buffers: new Set(), programs: new Set(), framebuffers: new Set(), renderbuffers: new Set() }, bytes: new Map() }
    contexts.push(rec)
    const wrap = (name, fn) => {
      const real = gl[name]
      if (typeof real !== "function") return
      Object.defineProperty(gl, name, { configurable: true, writable: true, value: function (...args) { return fn.call(this, real, args) } })
    }
    for (const [kind, set] of Object.entries(KINDS)) {
      wrap("create" + kind, (real, args) => {
        const o = real.apply(gl, args)
        if (o) rec.live[set].add(o)
        return o
      })
      wrap("delete" + kind, (real, args) => {
        rec.live[set].delete(args[0])
        rec.bytes.delete(args[0])
        return real.apply(gl, args)
      })
    }
    for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"])
      wrap(name, (real, args) => {
        draws++
        const count = name === "drawRangeElements" ? args[3] : args[name.startsWith("drawArrays") ? 2 : 1]
        const n = name === "drawArraysInstanced" ? args[3] : name === "drawElementsInstanced" ? args[4] : 1
        triangles += prims(args[0], count, n)
        return real.apply(gl, args)
      })
    const bound = (pname) => { try { return gl.getParameter(pname) } catch { return null } }
    const texBytes = (args, storage) => {
      if (storage) return args[3] * args[4] * 4 * (args[1] > 1 ? 1.34 : 1)
      if (args.length >= 9 || typeof args[3] === "number") return (args[3] || 0) * (args[4] || 0) * 4
      const src = args[5]
      return src ? (src.videoWidth || src.naturalWidth || src.width || 0) * (src.videoHeight || src.naturalHeight || src.height || 0) * 4 : 0
    }
    wrap("texImage2D", (real, args) => {
      const t = bound(gl.TEXTURE_BINDING_2D)
      if (t && args[1] === 0) rec.bytes.set(t, { kind: "texture", n: texBytes(args, false) })
      return real.apply(gl, args)
    })
    wrap("texStorage2D", (real, args) => {
      const t = bound(gl.TEXTURE_BINDING_2D)
      if (t) rec.bytes.set(t, { kind: "texture", n: texBytes(args, true) })
      return real.apply(gl, args)
    })
    wrap("bufferData", (real, args) => {
      const b = bound(args[0] === gl.ELEMENT_ARRAY_BUFFER ? gl.ELEMENT_ARRAY_BUFFER_BINDING : gl.ARRAY_BUFFER_BINDING)
      if (b) rec.bytes.set(b, { kind: "buffer", n: typeof args[1] === "number" ? args[1] : args[1]?.byteLength ?? 0 })
      return real.apply(gl, args)
    })
    return rec
  }
  Object.defineProperty(P, "getContext", {
    configurable: false,
    writable: false,
    value: function (type, ...rest) {
      const gl = original.call(this, type, ...rest)
      if (gl && WEBGL.has(type) && !contexts.some((c) => c.gl === gl)) track(this, gl)
      return gl
    },
  })
  let last = performance.now()
  const raf = window.requestAnimationFrame.bind(window)
  const tick = (now) => {
    for (const c of contexts) {
      try {
        if (!c.gl.isContextLost() && c.gl.getError() !== 0) errors++
      } catch {}
    }
    frames.push({ draws, triangles, ms: now - last })
    last = now
    draws = 0
    triangles = 0
    if (frames.length > 2000) frames.splice(0, 1000)
    raf(tick)
  }
  raf(tick)
  let lost = null
  const read = (action) => {
    const live = contexts.filter((c) => !c.gl.isContextLost())
    if (action === "lose") {
      const c = live.filter((x) => x.canvas.isConnected).sort((a, b) => b.canvas.clientWidth * b.canvas.clientHeight - a.canvas.clientWidth * a.canvas.clientHeight)[0]
      // Kept: a lost context's getExtension returns null, so restore needs this same object
      lost = c && c.gl.getExtension("WEBGL_lose_context")
      if (!lost) return false
      lost.loseContext()
      return true
    }
    if (action === "restore") {
      if (!lost) return false
      try {
        lost.restoreContext()
      } catch {}
      lost = null
      return true
    }
    const shown = contexts.filter((c) => c.canvas.isConnected).sort((a, b) => b.canvas.clientWidth * b.canvas.clientHeight - a.canvas.clientWidth * a.canvas.clientHeight)[0]
    const count = (set) => live.reduce((n, c) => n + c.live[set].size, 0)
    let textureBytes = 0
    let bufferBytes = 0
    for (const c of live) for (const b of c.bytes.values()) b.kind === "texture" ? (textureBytes += b.n) : (bufferBytes += b.n)
    let renderer = null
    if (shown) {
      try {
        const d = shown.gl.getExtension("WEBGL_debug_renderer_info")
        renderer = String(shown.gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : shown.gl.RENDERER))
      } catch {}
    }
    return {
      contexts: contexts.length,
      frames: frames.length,
      recent: frames.slice(-${FRAMES}),
      errors,
      live: { textures: count("textures"), buffers: count("buffers"), programs: count("programs"), framebuffers: count("framebuffers"), renderbuffers: count("renderbuffers") },
      textureBytes: Math.round(textureBytes),
      bufferBytes: Math.round(bufferBytes),
      renderer,
      canvas: shown ? { width: shown.canvas.width, height: shown.canvas.height, clientWidth: shown.canvas.clientWidth, clientHeight: shown.canvas.clientHeight, lost: shown.gl.isContextLost() } : null,
    }
  }
  Object.defineProperty(window, "${READ}", { configurable: false, writable: false, value: read })
})()`

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}
const p95 = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

/** A screenshot's look over a downsampled grid: luminance variance and distinct (4-bit) colours. */
export function canvasLook(png) {
  const p = decodePng(png)
  if (!p) return null
  const step = Math.max(1, Math.floor(Math.min(p.width, p.height) / 48))
  const colours = new Set()
  let n = 0
  let sum = 0
  let sq = 0
  const samples = []
  for (let y = 0; y < p.height; y += step)
    for (let x = 0; x < p.width; x += step) {
      const i = (y * p.width + x) * p.channels
      const [r, g, b] = [p.data[i], p.data[i + 1], p.data[i + 2]]
      colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4))
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      n++
      sum += l
      sq += l * l
      samples.push(r, g, b)
    }
  return { variance: n ? sq / n - (sum / n) ** 2 : 0, colours: colours.size, samples }
}
export const blank = (look) => !look || look.variance < 4 || look.colours < 8
/** The share of sampled channels that differ between two looks. */
export const moved = (a, b) => {
  if (!a || !b || a.samples.length !== b.samples.length) return 0
  let d = 0
  for (let i = 0; i < a.samples.length; i++) if (Math.abs(a.samples[i] - b.samples[i]) > 6) d++
  return d / a.samples.length
}

const evidenceDir = (root, label) =>
  join(kriyaHome(), "evidence", createHash("sha256").update(root).digest("hex").slice(0, 16), String(label ?? "g-3d").replace(/[^\w.-]+/g, "-").slice(0, 60), `3d-${new Date().toISOString().replace(/[:.]/g, "-")}`)

/**
 * G-3D on the confirmed app's direction routes. `app` and `direction` may be
 * given (tests); otherwise the stack's app and the project's scene_direction.json.
 * @returns {Promise<{ id: "G-3D", status: "pass" | "fail" | "not_checked", reason?: string, kind?: string, excerpt?: string, note?: string, optional?: true, report?: any }>}
 */
export async function threeGate({ root, label, launch, app: givenApp, direction: givenDirection }) {
  const app = givenApp ?? readStack(root).app
  if (!app) return { id: "G-3D", status: "not_checked", reason: "no app is confirmed for this project (kriya stack use --app http://localhost:<port>)", optional: true }
  const direction = givenDirection ?? readDirection(root)
  if (!direction) return { id: "G-3D", status: "not_checked", reason: `no ${DIRECTION} with routes in .kriya/contracts (the designer step writes it)`, optional: true }
  const dir = evidenceDir(root, label)
  const run = await withGateBrowser((_open, browser) => checkScenes(browser, app, direction, dir), { launch })
  if (run.unavailable) return { id: "G-3D", status: "not_checked", reason: run.unavailable }
  return run.value
}

async function openPage(browser, url, { viewport, reducedMotion = "no-preference" }) {
  const target = localUrl(url)
  if (target.error) throw new Error(target.error)
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr, reducedMotion, acceptDownloads: false, serviceWorkers: "block" })
  await context.route("**/*", (route) => (route.request().isNavigationRequest() && localUrl(route.request().url()).error ? route.abort("blockedbyclient") : route.continue()))
  // The gate's own page only: never the agent's page, never the whole context
  const page = await context.newPage()
  await page.addInitScript(WRAP)
  const consoleErrors = []
  let bytes = 0
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)))
  page.on("pageerror", (e) => consoleErrors.push(String(e?.message ?? e).slice(0, 300)))
  page.on("response", async (r) => {
    const n = Number(r.headers()["content-length"])
    bytes += Number.isFinite(n) ? n : (await r.body().catch(() => Buffer.alloc(0))).length
  })
  const started = Date.now()
  try {
    await page.goto(target.url, { waitUntil: "load", timeout: NAV_MS })
  } catch (error) {
    await context.close().catch(() => {})
    return { unreachable: /ERR_CONNECTION_REFUSED/.test(String(error?.message)) ? "nothing answers there" : String(error?.message ?? error).split("\n")[0].slice(0, 200) }
  }
  const read = (action) => page.evaluate(({ name, action }) => window[name]?.(action), { name: READ, action })
  const framesFrom = async (from, n = FRAMES) => {
    await page.waitForFunction(({ name, want }) => (window[name]?.().frames ?? 0) >= want, { name: READ, want: from + n }, { timeout: FRAME_WAIT_MS, polling: 50 }).catch(() => {})
    return read()
  }
  const shot = async () => {
    const canvas = page.locator("canvas").first()
    if (!(await canvas.count())) return null
    return canvas.screenshot({ timeout: 5_000 }).catch(() => null)
  }
  return { page, context, read, framesFrom, shot, consoleErrors, bytes: () => bytes, started }
}

async function checkScenes(browser, app, direction, dir) {
  const problems = []
  const reported = []
  const motion = direction.motion ?? "none"
  // Does this browser make WebGL at all? Otherwise not_checked, never pass
  const probe = await openPage(browser, new URL(direction.routes[0].path, app).href, { viewport: VIEWPORTS_3D[0] })
  if (probe.unreachable) return { id: "G-3D", status: "not_checked", reason: `${app} doesn't answer (${probe.unreachable}); start the app, or confirm another with kriya stack use --app` }
  const hasGl = await probe.page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl"))).catch(() => false)
  await probe.context.close().catch(() => {})
  if (!hasGl) return { id: "G-3D", status: "not_checked", reason: "no WebGL in this browser" }
  let renderer = null
  for (const route of direction.routes)
    for (const viewport of VIEWPORTS_3D) {
      const at = `${route.path} at ${viewport.name}px`
      const budget = budgetFor(direction.tiers, viewport.tiers)
      const v = await openPage(browser, new URL(route.path, app).href, { viewport })
      if (v.unreachable) return { id: "G-3D", status: "not_checked", reason: `${app}${route.path} doesn't answer (${v.unreachable})` }
      try {
        const first = await v.framesFrom(0, 30)
        if (!first?.contexts) {
          problems.push(`${at}: no WebGL context was created`)
          continue
        }
        const a = await v.shot()
        const mid = await v.framesFrom(first.frames, 60)
        const b = await v.shot()
        const r = await v.framesFrom(mid.frames, FRAMES - 60)
        renderer ??= r.renderer
        const lookA = canvasLook(a)
        const lookB = canvasLook(b)
        keepShot(dir, `${route.path.replace(/\W+/g, "_") || "root"}-${viewport.name}-f30.png`, a)
        keepShot(dir, `${route.path.replace(/\W+/g, "_") || "root"}-${viewport.name}-f90.png`, b)
        if (v.consoleErrors.length) problems.push(`${at}: console errors (shader compile and link failures are logged here): ${v.consoleErrors.slice(0, 3).join(" | ")}`)
        if (r.errors) problems.push(`${at}: ${r.errors} WebGL error${r.errors === 1 ? "" : "s"} (gl.getError) while drawing`)
        if (blank(lookB)) problems.push(`${at}: the canvas is blank or one colour (${lookB ? `${lookB.colours} colours` : "no screenshot"}); check the shader, the camera and the light`)
        else if (motion !== "none" && moved(lookA, lookB) === 0) problems.push(`${at}: motion is "${motion}" in the direction, but frame 30 and frame 90 are identical`)
        const recent = r.recent ?? []
        const drawCalls = median(recent.map((f) => f.draws))
        const tris = median(recent.map((f) => f.triangles))
        if (drawCalls > budget.drawCalls) problems.push(`${at}: ${drawCalls} draw calls a frame (median) over the ${budget.tier} budget of ${budget.drawCalls}; instance or merge`)
        if (tris > budget.triangles) problems.push(`${at}: ${Math.round(tris)} triangles a frame over the ${budget.tier} budget of ${budget.triangles}; use LODs or simplify`)
        if (r.textureBytes > budget.textureBytes) problems.push(`${at}: ${mb(r.textureBytes)} of textures over the ${budget.tier} budget of ${mb(budget.textureBytes)}; compress (KTX2) or resize`)
        if (v.bytes() > budget.routeBytes) problems.push(`${at}: the route transferred ${mb(v.bytes())}, over the ${budget.tier} budget of ${mb(budget.routeBytes)}`)
        const sizing = bufferProblem(r.canvas, viewport.dpr, budget.dpr)
        if (sizing) problems.push(`${at}: ${sizing}`)
        const deltas = recent.map((f) => f.ms).filter((ms) => ms > 0 && ms < 1000)
        reported.push(`${at}: ${drawCalls} draws, ${Math.round(tris)} triangles, ${mb(r.textureBytes)} textures, frame ${median(deltas).toFixed(1)} ms median / ${p95(deltas).toFixed(1)} ms p95 (reported, not gated)`)
        // The deeper checks once per route, at the phone width
        if (viewport !== VIEWPORTS_3D[0]) continue
        // Resize: the buffer follows the new CSS size
        await v.page.setViewportSize({ width: viewport.width - 60, height: viewport.height - 100 })
        const resized = await v.framesFrom((await v.read()).frames, 20)
        const after = bufferProblem(resized.canvas, viewport.dpr, budget.dpr)
        if (after) problems.push(`${at}, after a resize: ${after}`)
        // Leaks: unmount and mount again, through the route's own unmount path
        if (route.unmount) {
          const before = (await v.framesFrom((await v.read()).frames, 10)).live
          const go = (path) => v.page.evaluate((p) => (history.pushState({}, "", p), dispatchEvent(new PopStateEvent("popstate"))), path)
          await go(route.unmount)
          await v.framesFrom((await v.read()).frames, 20)
          await go(route.path)
          const after = (await v.framesFrom((await v.read()).frames, 30)).live
          const grew = Object.keys(before).filter((k) => after[k] > before[k] * (1 + LEAK_SLACK) && after[k] > before[k])
          if (grew.length) problems.push(`${at}: GPU objects leak over unmount → mount: ${grew.map((k) => `${k} ${before[k]} → ${after[k]}`).join(", ")}; dispose on unmount`)
        } else reported.push(`${at}: leaks not checked (no "unmount" path for this route in ${DIRECTION})`)
        // Context loss: lose, restore, wait, draw again
        if (await v.read("lose")) {
          await v.page.waitForTimeout(100)
          await v.read("restore")
          await v.page.waitForTimeout(RESTORE_WAIT_MS)
          const after = await v.read()
          const look = canvasLook(await v.shot())
          if (after.canvas?.lost || blank(look)) problems.push(`${at}: after a lost and restored WebGL context the canvas stays ${after.canvas?.lost ? "lost" : "blank"}; prevent default on webglcontextlost and rebuild on webglcontextrestored`)
        } else reported.push(`${at}: context loss not checked (no WEBGL_lose_context)`)
      } finally {
        await v.context.close().catch(() => {})
      }
      // Reduced motion: decorative motion stops
      if (motion !== "none" && viewport === VIEWPORTS_3D[0]) {
        const q = await openPage(browser, new URL(route.path, app).href, { viewport, reducedMotion: "reduce" })
        if (!q.unreachable)
          try {
            await q.framesFrom(0, 30)
            const a = canvasLook(await q.shot())
            await q.framesFrom((await q.read()).frames, 60)
            const b = canvasLook(await q.shot())
            if (moved(a, b) > 0) problems.push(`${at}: decorative motion still runs under prefers-reduced-motion`)
          } finally {
            await q.context.close().catch(() => {})
          }
      }
    }
  const note = [`renderer: ${renderer ?? "unknown"}`, ...reported].join("\n")
  if (problems.length) return { id: "G-3D", status: "fail", kind: "gate", excerpt: `G-3D:\n${problems.slice(0, 12).map((p) => `- ${p}`).join("\n")}${problems.length > 12 ? `\n- … and ${problems.length - 12} more` : ""}\n(${note.split("\n")[0]})`, note }
  return { id: "G-3D", status: "pass", note }
}

const mb = (n) => `${(n / 2 ** 20).toFixed(1)} MB`
