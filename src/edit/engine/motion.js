// The motion layer (EDIT_ENGINE §6, EDD-07, EDD-17): blocks and captions become
// short HyperFrames compositions, each rendered on a transparent background to a
// ProRes 4444 tile, inside the OS sandbox (ES-05, EDD-44). Springs are computed here
// and baked into Web Animations keyframes (EX-01): no GSAP (EDD-09), no Remotion
// (EDD-08), no clock, no network, so one definition drives preview and render.

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { childEnv } from "../runtime/setup.js"
import { confine, confinement, installOf } from "./confine.js"
import { buildScene, SCENE_VERSION } from "./scenes.js"
import { buildGraphic, GRAPHIC_VERSION } from "./graphics.js"
import { EngineFailure, runTool } from "./tool.js"

const FLICKS = 705_600_000

/* ─────────────────────────────── springs ─────────────────────────────── */

/**
 * A damped spring's progress, 0 to 1 (it may overshoot), sampled evenly.
 * @param {{ damping: number, frequency: number, ms: number, steps?: number }} spring damping ratio, angular frequency in rad/s
 */
export function springCurve({ damping, frequency, ms, steps = 24 }) {
  if (!(damping > 0 && damping < 1)) throw new RangeError("a spring's damping ratio is between 0 and 1")
  const wd = frequency * Math.sqrt(1 - damping * damping)
  const out = []
  for (let i = 0; i <= steps; i++) {
    const t = ((i / steps) * ms) / 1000
    out.push(1 - Math.exp(-damping * frequency * t) * (Math.cos(wd * t) + ((damping * frequency) / wd) * Math.sin(wd * t)))
  }
  out[steps] = 1 // settled by the end, so the last frame is exact
  return out
}

/** Keyframes moving from `from` to `to` (y in px, opacity, scale) along a spring. */
export function springKeyframes({ from, to, ...spring }) {
  const curve = springCurve(spring)
  const at = (key, u) => (from[key] ?? to[key]) + ((to[key] ?? from[key]) - (from[key] ?? to[key])) * u
  return curve.map((u, i) => {
    const frame = { offset: i / (curve.length - 1) }
    const transform = []
    if ("y" in from || "y" in to) transform.push(`translateY(${at("y", u).toFixed(2)}px)`)
    if ("scale" in from || "scale" in to) transform.push(`scale(${at("scale", u).toFixed(4)})`)
    if (transform.length) frame.transform = transform.join(" ")
    if ("opacity" in from || "opacity" in to) frame.opacity = Math.min(1, Math.max(0, at("opacity", u))).toFixed(4)
    return frame
  })
}

/* ─────────────────────────────── documents ─────────────────────────────── */

// No network, no outside script; fonts and images only from the composition itself
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'"
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
// A script's data as JSON that can't close the script element
const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)

/** Seconds a tile lasts, as a whole number of frames at fps, so its last frame is covered. */
export function tileSeconds(flicks, fps) {
  const frames = Math.max(1, Math.ceil((flicks * fps.n) / (FLICKS * fps.d) - 1e-9))
  return (frames * fps.d) / fps.n
}

/**
 * One tile as a HyperFrames composition: a transparent stage, one clip for the whole
 * tile, Kriya's own animations. Non-GSAP, so `data-no-timeline` (EX-01).
 * @param {{ width: number, height: number, duration: number, css: string, body: string, animations: { id: string, keyframes: object[], options: object }[], fit?: { id: string, within: string, min: number } }} parts duration in flicks;
 *   fit: shrink an element's font, a pixel at a time, until it fits its box (no clock, so every render agrees)
 *   fit.box: the element measured against the box, when it isn't the one whose font shrinks (a plate around the text)
 */
export function tileDocument({ width, height, duration, css, body, animations, fit }) {
  const fitting = fit ? `{const t=document.getElementById(${scriptJson(fit.id)}),a=document.getElementById(${scriptJson(fit.within)}),b=document.getElementById(${scriptJson(fit.box ?? fit.id)});let s=parseFloat(getComputedStyle(t).fontSize);while((b.offsetHeight>a.clientHeight||b.scrollWidth>a.clientWidth)&&s>${Number(fit.min)}){s-=1;t.style.fontSize=s+"px"}}` : ""
  const seconds = (duration / FLICKS).toFixed(6)
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8">${CSP_META}`,
    `<style>html,body{margin:0;background:transparent;overflow:hidden}#stage{position:relative;width:${width}px;height:${height}px;overflow:hidden}${css}</style></head>`,
    `<body><div id="stage" data-composition-id="kriya" data-no-timeline data-start="0" data-duration="${seconds}" data-width="${width}" data-height="${height}">`,
    `<div id="clip" class="clip" data-start="0" data-duration="${seconds}" data-track-index="0">${body}</div></div>`,
    `<script>${fitting}for (const a of ${scriptJson(animations)}) document.getElementById(a.id).animate(a.keyframes, a.options)</script>`,
    "</body></html>",
  ].join("")
}

/* ─────────────────────────────── blocks ─────────────────────────────── */

const escapeText = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const textVar = (variables, key, max = 120) => {
  const value = variables?.[key]
  if (value === undefined) return ""
  if (typeof value !== "string" || value.length > max) throw new EngineFailure("plan", "bad_variable", `The "${key}" of this card must be text of up to ${max} characters.`)
  return value
}

const RISE = { damping: 0.55, frequency: 11, ms: 900 }

/** Kriya's blocks (SKILLS_AND_OPEN_SOURCE §6): typed variables, escaped, WAAPI only. */
export const BLOCKS = {
  title: {
    version: 1,
    build: ({ variables, area, size }) => ({
      css: `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:center;justify-content:center}#t{font:800 ${Math.round(size * 1.6)}px/1.1 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f2eadf;background:#13292bea;padding:${Math.round(size * 0.4)}px ${Math.round(size * 0.7)}px;border-radius:${Math.round(size * 0.5)}px;text-align:center}`,
      body: `<div id="a"><div id="t" data-text>${escapeText(textVar(variables, "text"))}</div></div>`,
      animations: [{ id: "t", keyframes: springKeyframes({ ...RISE, from: { y: Math.round(size * 4), scale: 0.8, opacity: 0 }, to: { y: 0, scale: 1, opacity: 1 } }), options: { duration: RISE.ms, fill: "both" } }],
    }),
  },
  "lower-third": {
    version: 1,
    build: ({ variables, area, size }) => ({
      css: `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:flex-end}#t{font:800 ${Math.round(size * 1.1)}px/1.15 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#ffffff;background:#13292bf0;padding:${Math.round(size * 0.3)}px ${Math.round(size * 0.5)}px;border-left:${Math.round(size * 0.18)}px solid #ffb347}#t small{display:block;font-weight:500;font-size:${Math.round(size * 0.7)}px;color:#f2eadf}`,
      body: `<div id="a"><div id="t" data-text>${escapeText(textVar(variables, "text"))}${variables?.subtitle ? `<small>${escapeText(textVar(variables, "subtitle"))}</small>` : ""}</div></div>`,
      animations: [{ id: "t", keyframes: springKeyframes({ ...RISE, from: { y: Math.round(size * 2), opacity: 0 }, to: { y: 0, opacity: 1 } }), options: { duration: RISE.ms, fill: "both" } }],
    }),
  },
  card: {
    version: 1,
    build: ({ variables, area, size }) => ({
      css: `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px}#t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 ${Math.round(size * 1.2)}px/1.2 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f2eadf;background:#13292b;border-radius:${Math.round(size * 0.6)}px;text-align:center}`,
      body: `<div id="a"><div id="t" data-text>${escapeText(textVar(variables, "text"))}</div></div>`,
      animations: [{ id: "t", keyframes: springKeyframes({ ...RISE, from: { y: Math.round(size * 6), scale: 0.8, opacity: 0 }, to: { y: 0, scale: 1, opacity: 1 } }), options: { duration: RISE.ms, fill: "both" } }],
    }),
  },
  // A hard term, its definition quoted with its source (EDD-57). The words are never edited
  term: {
    version: 1,
    build: ({ variables, area, size, output }) => {
      const floor = Math.ceil(output.height * 0.0205)
      const quote = Math.max(floor, Math.round(size * 0.72))
      const cite = Math.max(floor, Math.round(size * 0.6))
      return {
        css: `#a{position:absolute;left:${area.x}px;top:${area.y}px;width:${area.w}px;height:${area.h}px;display:flex;align-items:flex-end}#t{width:100%;box-sizing:border-box;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#13292b;color:#f2eadf;padding:${Math.round(size * 0.4)}px ${Math.round(size * 0.55)}px;border-left:${Math.round(size * 0.18)}px solid #ffb347;border-radius:${Math.round(size * 0.2)}px}#t b,#t q,#t small{display:block;background:#13292b}#t b{font-size:${Math.round(size * 1.05)}px;font-weight:800}#t q{font-size:${quote}px;line-height:1.2;margin:${Math.round(size * 0.15)}px 0;quotes:'“' '”'}#t small{font-size:${cite}px;color:#ffb347}`,
        body: `<div id="a"><div id="t"><b data-text>${escapeText(textVar(variables, "text", 60))}</b><q data-text>${escapeText(textVar(variables, "quote", 120))}</q><small data-text>${escapeText(textVar(variables, "source", 40))}</small></div></div>`,
        animations: [{ id: "t", keyframes: springKeyframes({ ...RISE, from: { y: Math.round(size * 2), opacity: 0 }, to: { y: 0, opacity: 1 } }), options: { duration: RISE.ms, fill: "both" } }],
      }
    },
  },
  // An explainer scene (VISUAL_SCENES.md): an opaque cutaway; `placement` is its content box
  scene: { version: SCENE_VERSION, build: (parts) => buildScene(parts, springKeyframes) },
  // The motion kit (MOTION_GRAPHICS.md): a title, strap or card in the box the layout gives it
  graphic: { version: GRAPHIC_VERSION, build: (parts) => buildGraphic(parts, springKeyframes) },
}

/** A block tile's composition. An unknown block or version is refused, never drawn as something else. */
export function blockComposition(node, { output, canvas }) {
  const block = BLOCKS[node.blockId]
  if (!block || block.version !== node.version) throw new EngineFailure("plan", "unknown_block", `There is no motion block "${node.blockId}" version ${node.version}.`)
  const sx = output.width / canvas.width
  const sy = output.height / canvas.height
  const box = node.placement ?? { x: Math.round(canvas.width * 0.1), y: Math.round(canvas.height * 0.4), w: Math.round(canvas.width * 0.8), h: Math.round(canvas.height * 0.12) }
  const area = { x: Math.round(box.x * sx), y: Math.round(box.y * sy), w: Math.round(box.w * sx), h: Math.round(box.h * sy) }
  const size = Math.round(output.height * 0.03)
  return tileDocument({ width: output.width, height: output.height, duration: node.duration, ...block.build({ variables: node.variables, area, size, output, duration: node.duration }) })
}

/* ─────────────────────────────── model-written code ─────────────────────────────── */

// Anything that reaches out, reads the clock or loads code (SKILLS §6, ET-SEC-04)
const REFUSED = [
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts|Worker|SharedWorker)\b/, "it reaches the network"],
  [/\bimport\s*\(|<script[^>]*\bsrc\s*=|<link\b|<iframe\b|<object\b|<embed\b|<base\b|@import\b/i, "it loads code or pages from outside"],
  [/\b(?:https?|wss?|ftp|file|blob):|(?:src|href|action|poster|srcset)\s*=\s*["']?\s*\/\/|url\(\s*["']?\s*\/\//i, "it names an address"],
  [/\bDate\b|\bperformance\s*\.\s*now\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\brequestIdleCallback\b/, "it reads the clock, so it wouldn't seek"],
  [/\bMath\s*\.\s*random\b|\bcrypto\b/, "it is random, so two renders differ"],
  [/\beval\b|\bFunction\s*\(|\bnew\s+Function\b|\bdocument\s*\.\s*write\b/, "it builds code from text"],
  [/\b(?:localStorage|sessionStorage|indexedDB|caches|navigator\s*\.\s*(?:clipboard|serviceWorker|geolocation|mediaDevices))\b/, "it reaches the browser's storage or devices"],
  [/\bgsap\b|\bTweenMax\b|\bTimelineMax\b|\bremotion\b/i, "it uses GSAP or Remotion (EDD-08, EDD-09)"],
]

/** @returns {string[]} why the composition is refused; empty when it may render */
export function lintComposition(html) {
  return REFUSED.filter(([pattern]) => pattern.test(html)).map(([, reason]) => reason)
}

/**
 * A composition a model wrote (`edit_motion`, EDD-44): off unless `editing.customMotion`
 * is on, refused where the OS can't confine Chrome, and linted before it renders.
 * @param {string} html
 * @param {{ allowed: boolean, which?: ReturnType<typeof confinement> }} gate allowed: the server's editing.customMotion
 */
export function customComposition(html, { allowed, which = confinement() }) {
  if (allowed !== true) throw new EngineFailure("plan", "custom_motion_off", "Model-written motion is switched off.")
  if (!which.kind) throw new EngineFailure("environment", "no_confinement", which.missing)
  if (typeof html !== "string" || html.length > 200_000) throw new EngineFailure("plan", "bad_composition", "A composition is text of up to 200 kB.")
  const reasons = lintComposition(html)
  if (reasons.length) throw new EngineFailure("plan", "lint_refused", `This composition was refused: ${reasons.join("; ")}.`)
  // Kriya's policy first in the document: a second, looser one in the model's text can't widen it
  const head = /<head[^>]*>/i.exec(html)
  if (!head) throw new EngineFailure("plan", "bad_composition", "A composition needs a <head>.")
  return `${html.slice(0, head.index + head[0].length)}${CSP_META}${html.slice(head.index + head[0].length)}`
}

/** The composition for any tile in a plan. */
export function compositionFor(tile, frame, captions) {
  if (tile.kind === "caption") return captions(tile.node, frame)
  if (tile.kind === "block") return blockComposition(tile.node, frame)
  throw new EngineFailure("plan", "unknown_tile", `This render can't draw a ${tile.kind} tile.`)
}

/* ─────────────────────────────── the runtime ─────────────────────────────── */

const CLI = ["hyperframes", "node_modules", "hyperframes", "bin", "hyperframes.mjs"]

/**
 * HyperFrames and Chrome from the Media Runtime: `<runtime>/hyperframes/` and the
 * manifest's `chrome-headless-shell` artifact.
 * @param {{ dir: string, manifest: object } | null} runtime from activeRuntime()
 * @returns {{ cli: string, chrome: string, dir: string, reads: string[] } | { missing: string }}
 */
export function motionRuntime(runtime, platform = `${process.platform}-${process.arch}`) {
  if (!runtime) return { missing: "The motion layer needs the Media Runtime. Run kriya edit setup." }
  const cli = join(runtime.dir, ...CLI)
  const chrome = runtime.manifest?.platforms?.[platform]?.artifacts?.find((a) => a.id === "chrome-headless-shell")
  const chromePath = chrome ? join(runtime.dir, chrome.id, chrome.entry) : null
  if (!chromePath || !existsSync(chromePath)) return { missing: "This Media Runtime has no Chrome for the motion layer." }
  // Without HyperFrames, Kriya draws tiles in the runtime's own Chrome, frame by frame (renderTileInChrome)
  if (!existsSync(cli)) return { cli: null, chrome: chromePath, dir: runtime.dir, reads: [runtime.dir, realpathSync(join(runtime.dir, chrome.id))] }
  // The runtime's own folders, after links: all a confined render may read of it
  return { cli, chrome: chromePath, dir: runtime.dir, reads: [runtime.dir, realpathSync(join(runtime.dir, "hyperframes")), realpathSync(join(runtime.dir, chrome.id))] }
}

/** The environment for a confined render: built from scratch, telemetry off (EH-43), home in the work folder. */
export function motionEnv(work, runtime, env = process.env) {
  return { ...childEnv(undefined, env), HOME: work, TMPDIR: join(work, "tmp"), HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", HYPERFRAMES_HISTORY_ROOT: join(work, "history"), PRODUCER_HEADLESS_SHELL_PATH: runtime.chrome }
}

/**
 * Renders one composition to a transparent ProRes 4444 tile, confined.
 * @param {{ html: string, work: string, output: string, fps: { n: number, d: number }, runtime: ReturnType<typeof motionRuntime>, run?: typeof runTool, signal?: AbortSignal, which?: ReturnType<typeof confinement>, seconds?: number }} input
 *   work: a folder of this tile's own; output: where the tile goes
 */
export async function renderTile({ html, work, output, fps, runtime, run = runTool, signal, which = confinement(), seconds = 10, launch }) {
  if (runtime.missing) throw new EngineFailure("environment", "missing_feature", runtime.missing)
  if (!runtime.cli) return renderTileInChrome({ html, work, output, fps, runtime, run, signal, which, seconds, launch })
  const comp = join(work, "comp")
  mkdirSync(join(work, "tmp"), { recursive: true })
  mkdirSync(comp, { recursive: true })
  writeFileSync(join(comp, "index.html"), html)
  const outDir = output.slice(0, output.lastIndexOf("/"))
  const args = [runtime.cli, "render", comp, "--format", "mov", "--prores-profile", "4444", "--fps", `${fps.n}/${fps.d}`, "--workers", "1", "--quiet", "--no-wait", "--no-browser-gpu", "-o", output]
  const { command, args: wrapped } = confine(process.execPath, args, { read: [installOf(process.execPath), ...runtime.reads, ...ffmpegHome()], write: [work, outDir] }, which)
  await run(command, wrapped, { env: motionEnv(work, runtime), cwd: work, signal, timeoutMs: 60_000 + seconds * 10_000, stallMs: 120_000 })
  if (!existsSync(output)) throw new EngineFailure("render", "failed", "The motion renderer finished without writing its tile.")
}

/**
 * A tile without HyperFrames: the composition in the runtime's Chrome, inside the same
 * sandbox, every animation paused at each frame's time and the stage captured with its
 * transparency, then encoded by our FFmpeg to the same ProRes 4444 tile. The runtime
 * signed for 2026.11.0 carries Chrome but not HyperFrames, so captions never rendered.
 */
export async function renderTileInChrome({ html, work, output, fps, runtime, run = runTool, signal, which = confinement(), seconds = 10, launch }) {
  const frames = Math.max(1, Math.round((seconds * fps.n) / fps.d))
  const dir = join(work, "frames")
  mkdirSync(dir, { recursive: true })
  await withChrome({ work, runtime, which, launch }, async (page) => {
    writeFileSync(join(work, "index.html"), html)
    await page.goto(`file://${join(work, "index.html")}`)
    const [width, height] = await page.evaluate(() => {
      const stage = document.getElementById("stage")
      return [Number(stage.dataset.width), Number(stage.dataset.height)]
    })
    await page.setViewportSize({ width, height })
    const stage = page.locator("#stage")
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw signal.reason
      await page.evaluate((t) => {
        for (const animation of document.getAnimations()) {
          animation.pause()
          animation.currentTime = t
        }
      }, (i * 1000 * fps.d) / fps.n)
      await stage.screenshot({ path: join(dir, `${String(i).padStart(6, "0")}.png`), omitBackground: true, animations: "allow" })
    }
  })
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-framerate", `${fps.n}/${fps.d}`, "-i", join(dir, "%06d.png"), "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", "-y", output], { signal, timeoutMs: 60_000 + seconds * 10_000 })
  if (!existsSync(output)) throw new EngineFailure("render", "failed", "The caption renderer finished without writing its tile.")
}

/** The runtime's Chrome, started confined by playwright through a sandbox wrapper; one page. */
async function withChrome({ work, runtime, which, launch }, use) {
  const { chromium } = launch ? {} : await import("playwright-core")
  const open = launch ?? ((dir, options) => chromium.launchPersistentContext(dir, options))
  if ([work, runtime.chrome].some((path) => path.includes("'"))) throw new EngineFailure("environment", "bad_path", "A folder name with a quote can't hold the motion layer's work.")
  mkdirSync(join(work, "tmp"), { recursive: true })
  // Playwright starts this script; the script starts Chrome inside the sandbox
  const { args } = confine(runtime.chrome, [], { read: [...runtime.reads, work], write: [work] }, which)
  writeFileSync(join(work, "chrome.sb"), args[1])
  const wrapper = join(work, "chrome.sh")
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${join(work, "chrome.sb")}' '${runtime.chrome}' "$@"\n`, { mode: 0o755 })
  const context = await open(join(work, "profile"), { executablePath: wrapper, headless: true, offline: true, env: { HOME: work, TMPDIR: join(work, "tmp") } })
  try {
    return await use(context.pages()[0] ?? (await context.newPage()))
  } finally {
    await context.close()
  }
}

// HyperFrames encodes with the FFmpeg on PATH; Homebrew's lives outside the runtime (EDD-06)
function ffmpegHome() {
  return ["/opt/homebrew", "/usr/local/Cellar", "/usr/local/opt", "/usr/local/bin"].filter((path) => existsSync(path))
}

/* ─────────────────────────────── measuring ─────────────────────────────── */

// Run in the page by Kriya, never by the composition: every animation paused at t, then the text's boxes
function readBoxes(times) {
  return times.map((t) => {
    for (const animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = t
    }
    return [...document.querySelectorAll("[data-text]")].map((el) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const colours = new Set([style.color, ...[...el.querySelectorAll("span")].map((span) => getComputedStyle(span).color)])
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent, size: parseFloat(style.fontSize), colours: [...colours], plate: style.backgroundColor, stroke: style.webkitTextStrokeColor, strokeWidth: parseFloat(style.webkitTextStrokeWidth) || 0, clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 }
    })
  })
}

/**
 * The rendered text boxes of compositions at given times (QG-08's "boxes from the
 * DOM at each beat"), read in the runtime's Chrome inside the same sandbox.
 * @param {{ items: { id: string, html: string, times: number[] }[], work: string, runtime: object, which?: object, launch?: Function }} input times in ms
 * @returns {Promise<Map<string, object[][]>>} per item, per time, its text boxes
 */
export async function measureText({ items, work, runtime, which = confinement(), launch }) {
  if (runtime.missing) throw new EngineFailure("environment", "missing_feature", runtime.missing)
  mkdirSync(join(work, "tmp"), { recursive: true })
  const files = items.map((item, i) => {
    const dir = join(work, `c${i}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "index.html"), item.html)
    return join(dir, "index.html")
  })
  return withChrome({ work, runtime, which, launch }, async (page) => {
    const out = new Map()
    for (const [i, item] of items.entries()) {
      await page.goto(`file://${files[i]}`)
      out.set(item.id, await page.evaluate(readBoxes, item.times))
    }
    return out
  })
}
