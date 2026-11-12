// The live preview's page parts (TP3): the renderer's tiles in sandboxed frames over the
// monitor's canvas, and the plan's music and sounds through WebAudio. Both follow the
// monitor's playhead; neither has a clock of its own. Only with editing.livePreview on.

import { FLICKS, gainAt, sourceOf } from "./preview.js"

// One audio context for the page: the plan's sounds and the level meter share it
let shared = null
const audioContext = () => (shared ??= new AudioContext())

/** A level in dBFS as a fill fraction of the meter: −60 dB is empty, 0 dB full. */
export const meterFill = (db) => (Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 60)) : 0)

/** The RMS level of samples in dBFS; −Infinity for silence. */
export function levelOf(samples) {
  let sum = 0
  for (const v of samples) sum += v * v
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity
}

/**
 * The level meter beside the transport timer: an AnalyserNode the picture's own sound and the
 * plan's sounds pass through on their way out. A take's element joins only when it first plays,
 * in the person's own gesture, so nothing is rerouted before they press Play.
 */
export function createMeter() {
  let analyser = null
  let buffer = null
  const joined = new WeakSet()
  const ready = () => {
    if (!analyser) {
      const context = audioContext()
      analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.connect(context.destination)
      buffer = new Float32Array(analyser.fftSize)
    }
    return analyser
  }
  return {
    /** Where a sound goes to be measured and heard. */
    input: () => ready(),
    /** A take's element, through the meter from now on (an element can join only once). */
    join(element) {
      if (joined.has(element)) return
      try {
        audioContext().createMediaElementSource(element).connect(ready())
        joined.add(element)
      } catch {
        // Already joined elsewhere, or no WebAudio: it plays as it did, unmeasured
      }
      void audioContext().resume().catch(() => {})
    },
    /** The level now, in dBFS. */
    level() {
      if (!analyser) return -Infinity
      analyser.getFloatTimeDomainData(buffer)
      return levelOf(buffer)
    },
  }
}

/**
 * Tiles over the canvas: one frame per tile showing at the playhead, sized to the render's
 * output and scaled to the canvas on screen. Each frame is its own document (no network,
 * the Studio's frame-src 'self'); the monitor posts it the tile's time and it seeks to it.
 * TPX-01 measured 20 frames scrubbing at 49 steps a second, so tiles stay while scrubbing.
 * @param {{ canvas: HTMLCanvasElement, urlOf: (key: string) => string }} options
 */
export function createTileLayer({ canvas, urlOf }) {
  const layer = document.createElement("div")
  layer.className = "tile-layer"
  layer.setAttribute("aria-hidden", "true")
  const mounted = new Map() // key → { frame, tile, loaded }

  function place(output) {
    layer.style.left = `${canvas.offsetLeft}px`
    layer.style.top = `${canvas.offsetTop}px`
    layer.style.width = `${canvas.clientWidth}px`
    layer.style.height = `${canvas.clientHeight}px`
    const scale = canvas.clientWidth / output.width
    for (const { frame } of mounted.values()) frame.style.transform = `scale(${scale})`
  }

  return {
    /** The tiles showing at t, at their own times; none when tiles is empty (a source on the monitor). */
    sync(tiles, t, output) {
      // Beside the canvas once it is on the page: the monitor is made before its canvas is placed
      if (!layer.isConnected && canvas.isConnected) canvas.after(layer)
      const showing = (tiles ?? []).filter((tile) => t >= tile.at && t < tile.end)
      const keep = new Set(showing.map((tile) => tile.key))
      for (const [key, { frame }] of mounted) if (!keep.has(key)) (frame.remove(), mounted.delete(key))
      for (const tile of showing) {
        let entry = mounted.get(tile.key)
        if (!entry) {
          const frame = document.createElement("iframe")
          frame.setAttribute("sandbox", "allow-scripts")
          frame.setAttribute("tabindex", "-1")
          frame.title = tile.kind === "caption" ? "Caption" : "Graphic"
          frame.className = "tile"
          frame.style.width = `${output.width}px`
          frame.style.height = `${output.height}px`
          frame.style.zIndex = String(tile.depth ?? 1)
          frame.dataset.key = tile.key
          entry = { frame, tile, loaded: false, at: 0 }
          frame.addEventListener("load", () => {
            entry.loaded = true
            frame.contentWindow?.postMessage({ t: entry.at }, "*")
          })
          frame.src = urlOf(tile.key)
          mounted.set(tile.key, entry)
          layer.append(frame)
        }
        // The tile's own clock in milliseconds, as renderTileInChrome seeks it
        entry.at = ((t - tile.at) * 1000) / FLICKS
        if (entry.loaded) entry.frame.contentWindow?.postMessage({ t: entry.at }, "*")
      }
      if (mounted.size) place(output)
    },
    /** The compare wipe: tiles show only right of this fraction of the width (null: everywhere). */
    clipLeft(fraction) {
      layer.style.clipPath = fraction === null ? "" : `inset(0 0 0 ${(fraction * 100).toFixed(2)}%)`
    },
    /** Every frame, for tests and the scopes: key → its element. */
    get frames() {
      return new Map([...mounted].map(([key, { frame }]) => [key, frame]))
    },
    clear() {
      for (const { frame } of mounted.values()) frame.remove()
      mounted.clear()
    },
  }
}

/**
 * The plan's music, sound effects and ambience, played with the picture at 1×: one media
 * element per item through a gain node the plan's levels, fades and duck drive. The voice
 * stays the take's own sound from the picture, as before. Other speeds play the picture alone.
 * @param {{ urlOf: (asset: string) => string }} options
 */
export function createSound({ urlOf, meter = null }) {
  let context = null
  let playing = [] // { item, element, node, gain, timers }
  let plan = { items: [], duck: null }

  const stop = () => {
    for (const p of playing) {
      for (const timer of p.timers) clearTimeout(timer)
      p.element.pause()
      p.node.disconnect()
      p.gain.disconnect()
    }
    playing = []
  }

  function schedule(entry, t, now) {
    const { item, element, gain } = entry
    const at = sourceOf(item, Math.max(t, item.at))
    if (!at) return
    const startIn = Math.max(0, (item.at - t) / FLICKS)
    const seek = () => {
      const where = sourceOf(item, Math.max(t + (performance.now() - now) * (FLICKS / 1000), item.at))
      if (!where) return
      element.currentTime = where.source / FLICKS
      element.play().catch(() => {})
      // A fitted bed or a loop jumps when its piece ends
      if (where.until < item.end) entry.timers.push(setTimeout(seek, ((where.until - t) * 1000) / FLICKS - (performance.now() - now)))
    }
    entry.timers.push(setTimeout(seek, startIn * 1000))
    // Gain along the item, in the context's time: the same function the tests check (gainAt)
    const step = 0.02 * FLICKS
    const from = Math.max(t, item.at)
    const values = []
    for (let x = from; x < item.end; x += step) values.push(gainAt(item, x, plan.duck))
    values.push(0)
    const begin = context.currentTime + (from - t) / FLICKS
    gain.gain.setValueAtTime(values[0], begin)
    if (values.length > 1) gain.gain.setValueCurveAtTime(Float32Array.from(values), begin, Math.max(0.01, (item.end - from) / FLICKS))
  }

  return {
    load(next) {
      stop()
      plan = next ?? { items: [], duck: null }
    },
    /** Starts everything due from t on; a rate other than 1 plays nothing here. */
    start(t, rate) {
      stop()
      if (rate !== 1) return
      const items = plan.items.filter((item) => item.bus !== "dialogue" && item.end > t)
      if (!items.length) return
      context ??= audioContext()
      void context.resume()
      const now = performance.now()
      for (const item of items) {
        const element = new Audio()
        element.preload = "auto"
        element.src = urlOf(item.asset)
        const node = context.createMediaElementSource(element)
        const gain = context.createGain()
        node.connect(gain).connect(meter ? meter.input() : context.destination)
        const entry = { item, element, node, gain, timers: [] }
        playing.push(entry)
        schedule(entry, t, now)
      }
    },
    stop,
    /** For tests: each playing item's planned gain at t and its node's value now. */
    state(t) {
      return playing.map(({ item, gain }) => ({ asset: item.asset, bus: item.bus, planned: gainAt(item, t, plan.duck), node: gain.gain.value }))
    },
  }
}
