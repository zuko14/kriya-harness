// "Watch the Director edit" (editing.livePreview): the Director Build Strip that follows a make's
// real stages as the Host sends them, the layer-by-layer replay of how a cut was made, and the
// Look cards in the Brief. Everything shown comes from the Host's events and routes; nothing here
// invents a step or a time. Text is set as text only (h() appends text nodes), never as markup.

import { clear, h } from "./dom.js"
import { gradeFilter } from "./preview.js"

/** The stages a make goes through, in the order a person reads them. A stage is lit only when the Host says it happened. */
export const STAGES = [
  ["story", "Story"],
  ["cuts", "Cuts"],
  ["broll", "B-roll"],
  ["look", "Look"],
  ["captions", "Captions"],
  ["audio", "Audio"],
  ["render", "Render"],
  ["check", "Checks"],
  ["repair", "Repairs"],
  ["watch", "Watch"],
]
const KNOWN = new Set(STAGES.map(([id]) => id))

/** Each stage's state from what the Host has said so far: done, active (the latest) or waiting. */
export function stageStates(reached, current) {
  return Object.fromEntries(STAGES.map(([id]) => [id, id === current ? "active" : reached.has(id) ? "done" : "waiting"]))
}

const STATUS = { passed: "passed", failed: "failed", not_checked: "not checked", not_applicable: "not applicable" }

/**
 * The strip under Make it while a make runs.
 * @param {{ onFollow: (follow: boolean) => void }} options
 */
export function createDirectorStrip({ onFollow = () => {} } = {}) {
  let reached = new Set()
  let current = null
  let follow = true
  const pills = STAGES.map(([id, label]) => h("li", { class: "stage", dataset: { stage: id, state: "waiting" } }, h("span", { class: "dot", "aria-hidden": "true" }), label))
  const list = h("ol", { class: "stages", "aria-label": "What the Director has done so far" }, pills)
  const line = h("p", { class: "stage-line", role: "status", "aria-live": "polite" }, "Starting: reading the footage.")
  const changes = h("ul", { class: "stage-changes", "aria-label": "Changes in this stage" })
  const gates = h("ul", { class: "stage-gates", "aria-label": "Checks so far" })
  const followButton = h("button", { type: "button", class: "btn small follow", "aria-pressed": "true", title: "Show the Director's working cut on the monitor as it builds", onclick: () => setFollow(!follow) }, "Follow on the monitor")
  const el = h("div", { class: "director-strip" }, list, line, changes, gates, followButton)

  function paint() {
    const states = stageStates(reached, current)
    for (const pill of pills) {
      pill.dataset.state = states[pill.dataset.stage]
      if (states[pill.dataset.stage] === "active") pill.setAttribute("aria-current", "step")
      else pill.removeAttribute("aria-current")
    }
  }
  function setFollow(next) {
    follow = next
    followButton.setAttribute("aria-pressed", String(follow))
    onFollow(follow)
  }

  return {
    el,
    reset() {
      reached = new Set()
      current = null
      line.textContent = "Starting: reading the footage."
      followButton.hidden = false
      clear(changes)
      clear(gates)
      paint()
    },
    /** One event from the Host's `live` stream. An unknown stage is ignored. */
    push(event) {
      if (!event || !KNOWN.has(event.stage)) return false
      reached.add(event.stage)
      current = event.stage
      line.textContent = typeof event.text === "string" ? event.text : ""
      if (event.skipped) line.textContent += ` This layer couldn't be drawn on its own (${event.skipped}), so the monitor shows the one before.`
      if (Array.isArray(event.changes)) clear(changes).append(...event.changes.slice(0, 4).map((change) => h("li", {}, String(change))))
      else if (!["check", "repair", "watch"].includes(event.stage)) clear(changes)
      if (Array.isArray(event.gates)) clear(gates).append(...event.gates.map((g) => h("li", { class: `gate ${g.status === "failed" && g.severity === "note" ? "note" : g.status}`, title: `${g.id}: ${STATUS[g.status] ?? g.status}${g.message ? `. ${g.message}` : ""}` }, String(g.id))))
      paint()
      return true
    },
    /** The make ended: nothing is active any more; what happened stays lit. */
    finish() {
      current = null
      followButton.hidden = true
      paint()
    },
    get follow() {
      return follow
    },
    get states() {
      return stageStates(reached, current)
    },
  }
}

/** Timed steps only for a person who wants motion, and never for an automated browser: a test can't wait on a clock. */
export const shouldAnimate = ({ reduced = false, automated = false } = {}) => !reduced && !automated
export const REPLAY_STEP_MS = 1800

/**
 * "Replay how it was edited": the latest make's layers on the monitor and timeline, one at a time,
 * from the raw footage to the finished mix. Nothing renders: each layer is the Host's preview plan.
 * @param {{ load: () => Promise<{ layers: object[] }>, show: (layer: object) => Promise<void> | void, restore: () => Promise<void> | void, animate: boolean, stepMs?: number }} options
 */
export function createReplay({ load, show, restore, animate, stepMs = REPLAY_STEP_MS }) {
  let layers = []
  let at = 0
  let timer = null
  let playing = false
  let open = false
  const title = h("p", { class: "replay-title" }, "How it was edited")
  const steps = h("div", { class: "replay-steps", role: "group", "aria-label": "Layers of the edit" })
  const detail = h("p", { class: "replay-detail", role: "status", "aria-live": "polite" })
  const pause = h("button", { type: "button", class: "btn small", hidden: true, onclick: () => (playing ? halt() : play()) }, "Pause replay")
  const skip = h("button", { type: "button", class: "btn small", onclick: () => stop() }, "Skip replay")
  const el = h("div", { class: "replay", hidden: true, "aria-label": "Replay of how the cut was edited", role: "region" }, h("div", { class: "replay-head" }, title, h("div", { class: "replay-actions" }, pause, skip)), steps, detail)

  const halt = () => {
    clearTimeout(timer)
    timer = null
    playing = false
    pause.textContent = "Play replay"
  }
  const play = () => {
    playing = true
    pause.textContent = "Pause replay"
    schedule()
  }
  function schedule() {
    clearTimeout(timer)
    if (!playing) return
    timer = setTimeout(() => (at < layers.length - 1 ? go(at + 1).then(schedule) : stop()), stepMs)
  }
  async function go(i) {
    at = i
    const layer = layers[i]
    for (const [n, button] of [...steps.children].entries()) button.setAttribute("aria-pressed", String(n === i))
    const said = layer.id === "raw" ? "The cut before the Director touched it." : layer.ops ? `${layer.ops} change${layer.ops === 1 ? "" : "s"}${layer.changes?.length ? `: ${layer.changes.join("; ")}` : ""}.` : "Nothing changed in this layer."
    detail.textContent = `${i + 1} of ${layers.length} · ${layer.label}. ${said}${layer.skipped ? ` It couldn't be drawn on its own (${layer.skipped}), so this shows the layer before.` : ""}`
    skip.textContent = i === layers.length - 1 ? "Back to my cut" : "Skip replay"
    await show(layer)
  }
  async function stop() {
    halt()
    if (!open) return
    open = false
    el.hidden = true
    await restore()
  }

  return {
    el,
    get open() {
      return open
    },
    get at() {
      return at
    },
    /** Loads the latest make's layers and shows the first. A refusal (no make yet) is said, not thrown. */
    async start() {
      halt()
      let answer
      try {
        answer = await load()
      } catch (error) {
        el.hidden = false
        open = false
        clear(steps)
        detail.textContent = error.message
        skip.textContent = "Close"
        return false
      }
      // Raw, then each layer that did something: an empty layer is a step with nothing to see
      layers = answer.layers.filter((layer, i) => i === 0 || layer.ops > 0)
      clear(steps).append(...layers.map((layer, i) => h("button", { type: "button", class: "btn small step", "aria-pressed": "false", onclick: () => (halt(), go(i)) }, layer.label)))
      open = true
      el.hidden = false
      pause.hidden = !animate
      await go(0)
      if (animate) play()
      return true
    },
    stop,
  }
}

/* ── Look cards ── */

// The reel recipe's own looks (src/edit/recipes/reel.js GRADES), copied because the Studio
// imports nothing from the Host; tests/edit-live-studio.test.js keeps the two the same
export const LOOK_GRADES = {
  vivid: { saturation: 1.15, gain: 1.06, vibrance: 0.35 },
  cinematic: { saturation: 0.9, gain: 1.12, gamma: 0.95, temperature: 7200, vignette: 0.45 },
  warm: { temperature: 5200, saturation: 1.05, vibrance: 0.2, vignette: 0.2 },
  bright: { lift: 0.04, gamma: 1.1, vibrance: 0.2 },
  mono: { saturation: 0, gain: 1.1, vignette: 0.3 },
}

/**
 * How a card sketches a look: the monitor's own filter, plus a tint for its colour temperature and
 * its vignette, which the render applies and the monitor leaves out. A sketch, and it says so.
 */
export function lookSketch(grade) {
  if (!grade) return { filter: "none", tint: null, vignette: 0 }
  const kelvin = grade.temperature ?? 6500
  const off = Math.min(1, Math.abs(kelvin - 6500) / 2500)
  const tint = kelvin === 6500 ? null : { colour: kelvin < 6500 ? "255 150 60" : "70 140 255", alpha: Math.round(off * 0.22 * 1000) / 1000 }
  return { filter: gradeFilter(grade), tint, vignette: grade.vignette ?? 0 }
}

/** Which of a thumbnail sheet's cells (10 × 10, one every `every` seconds) shows the middle of a clip. */
export function sheetCell(durationSeconds) {
  const every = Math.max(1, Math.ceil(durationSeconds / 100))
  return Math.min(99, Math.max(0, Math.floor(durationSeconds / every / 2)))
}

/**
 * Cards beside the Brief's look select: each look drawn on a frame of the person's own footage.
 * The select stays the one control the make reads; a card sets it and follows it.
 * @param {{ select: HTMLSelectElement, source: () => { url: string, cell: number } | null }} options
 */
export function createLookCards({ select, source }) {
  const cards = [...select.options].map((option) => {
    const canvas = h("canvas", { class: "look-sketch", width: 96, height: 54, "aria-hidden": "true" })
    const name = option.textContent.replace(/^Look:\s*/, "").replace(/\s*\(.*\)$/, "")
    const button = h("button", { type: "button", class: "look-card", "aria-pressed": String(select.value === option.value), title: `${option.textContent}. A sketch on your footage: the render is exact.`, onclick: () => {
      select.value = option.value
      select.dispatchEvent(new Event("change", { bubbles: true }))
      mark()
    } }, canvas, h("span", { class: "look-name" }, name.charAt(0).toUpperCase() + name.slice(1)))
    return { value: option.value, button, canvas }
  })
  const el = h("div", { class: "look-cards", role: "group", "aria-label": "Colour looks, drawn on your footage" }, cards.map((c) => c.button))
  let image = null
  let url = null
  let cell = 0

  function mark() {
    for (const card of cards) card.button.setAttribute("aria-pressed", String(card.value === select.value))
  }
  function paint() {
    for (const card of cards) {
      const c = card.canvas.getContext("2d")
      const { width: W, height: H } = card.canvas
      const sketch = lookSketch(LOOK_GRADES[card.value] ?? null)
      c.filter = "none"
      c.fillStyle = "#22302f"
      c.fillRect(0, 0, W, H)
      if (image?.naturalWidth) {
        const cw = image.naturalWidth / 10
        const ch = image.naturalHeight / 10
        const scale = Math.max(W / cw, H / ch)
        c.filter = sketch.filter
        c.drawImage(image, (cell % 10) * cw, Math.floor(cell / 10) * ch, cw, ch, (W - cw * scale) / 2, (H - ch * scale) / 2, cw * scale, ch * scale)
        c.filter = "none"
      } else {
        // No footage yet: a neutral ramp, so the looks still differ
        const ramp = c.createLinearGradient(0, 0, W, H)
        ramp.addColorStop(0, "#c98f6b")
        ramp.addColorStop(0.5, "#6f9c98")
        ramp.addColorStop(1, "#33486b")
        c.filter = sketch.filter
        c.fillStyle = ramp
        c.fillRect(0, 0, W, H)
        c.filter = "none"
      }
      if (sketch.tint) {
        c.fillStyle = `rgb(${sketch.tint.colour} / ${sketch.tint.alpha})`
        c.fillRect(0, 0, W, H)
      }
      if (sketch.vignette > 0) {
        const v = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7)
        v.addColorStop(0, "rgb(0 0 0 / 0)")
        v.addColorStop(1, `rgb(0 0 0 / ${Math.min(0.8, sketch.vignette * 1.2)})`)
        c.fillStyle = v
        c.fillRect(0, 0, W, H)
      }
    }
  }
  select.addEventListener("change", mark)

  return {
    el,
    /** Draws the cards again from the footage's first video, when it changed. */
    refresh() {
      mark()
      const next = source()
      if (next?.url === url && next?.cell === cell) return paint()
      url = next?.url ?? null
      cell = next?.cell ?? 0
      if (!url) {
        image = null
        return paint()
      }
      const img = new Image()
      img.addEventListener("load", () => url === next.url && ((image = img), paint()))
      img.addEventListener("error", () => url === next.url && ((image = null), paint()))
      img.src = url
      paint()
    },
    mark,
  }
}
