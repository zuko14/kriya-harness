// Drawing on the frame (TP9, CRAFT_UPGRADE §7), only with editing.customMotion on: the person draws a
// box, a ring or an arrow on the paused monitor, and it goes with their next message as "this":
// { kind, x, y, w, h, at }, whole thousandths of the frame and the playhead in flicks. The Host checks
// every number again (server.js cleanMark); here it is only drawn and sent.

import { h } from "./dom.js"

const SVG = "http://www.w3.org/2000/svg"
export const KINDS = { box: "Box", ring: "Ring", arrow: "Arrow" }
const MIN = 10 // thousandths: a smaller box is a slip

const clamp01 = (v) => Math.min(1, Math.max(0, v))
// The monitor zooms from the centre: a point shown at u is the frame's 0.5 + (u − 0.5) / zoom, and back
export const toFrame = (u, zoom) => clamp01(0.5 + (u - 0.5) / zoom)
export const toShown = (f, zoom) => 0.5 + (f - 0.5) * zoom

/**
 * A drag on the shown picture (0…1 of its box) as a mark in thousandths of the frame, or null when too small.
 * @returns {{ kind: string, x: number, y: number, w: number, h: number, at: number } | null}
 */
export function markFromDrag(kind, start, end, { zoom = 1, at }) {
  const [x0, x1] = [toFrame(start.u, zoom), toFrame(end.u, zoom)].sort((a, b) => a - b)
  const [y0, y1] = [toFrame(start.v, zoom), toFrame(end.v, zoom)].sort((a, b) => a - b)
  const x = Math.round(x0 * 1000)
  const y = Math.round(y0 * 1000)
  const w = Math.min(1000 - x, Math.round(x1 * 1000) - x)
  const hh = Math.min(1000 - y, Math.round(y1 * 1000) - y)
  if (w < MIN || hh < MIN || !Number.isSafeInteger(at) || at < 0) return null
  return { kind, x, y, w, h: hh, at: Math.round(at) }
}

/**
 * @param {{ frame: HTMLElement, canvas: HTMLCanvasElement, timeNow: () => number, zoomNow: () => number, usable: () => string | null, onChange: (mark: object | null) => void, pause: () => void }} options
 *   usable: why drawing can't be used now (a preview shape that isn't the project's), or null
 * @returns {{ tools: HTMLElement, mark: () => object | null, clear: () => void, redraw: () => void }}
 */
export function createDrawing({ frame, canvas, timeNow, zoomNow, usable, onChange, pause }) {
  let tool = null
  let mark = null
  let drag = null
  const svg = document.createElementNS(SVG, "svg")
  svg.setAttribute("class", "draw-layer")
  svg.setAttribute("viewBox", "0 0 1000 1000")
  svg.setAttribute("preserveAspectRatio", "none")
  svg.setAttribute("aria-hidden", "true")
  frame.classList.add("drawable")
  frame.append(svg)
  const note = h("span", { class: "note small draw-note", role: "status", "aria-live": "polite" })

  // The layer sits exactly over the picture, wherever the canvas lands in its frame
  function place() {
    Object.assign(svg.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.offsetWidth}px`, height: `${canvas.offsetHeight}px` })
  }
  new ResizeObserver(() => (place(), redraw())).observe(canvas)
  window.addEventListener("resize", () => (place(), redraw()))

  const shape = (name, attrs) => {
    const el = document.createElementNS(SVG, name)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    el.setAttribute("vector-effect", "non-scaling-stroke")
    return el
  }
  // One mark, in shown coordinates (the monitor's zoom applied)
  function drawn(kind, box, draft = false) {
    const z = zoomNow()
    const x = toShown(box.x / 1000, z) * 1000
    const y = toShown(box.y / 1000, z) * 1000
    const w = (box.w / 1000) * z * 1000
    const hh = (box.h / 1000) * z * 1000
    const cls = `draw-mark${draft ? " draft" : ""}`
    if (kind === "ring") return [shape("ellipse", { cx: x + w / 2, cy: y + hh / 2, rx: w / 2, ry: hh / 2, class: cls })]
    if (kind === "box") return [shape("rect", { x, y, width: w, height: hh, rx: 6, class: cls })]
    const tip = y > 120 ? y : y + hh
    const from = y > 120 ? Math.max(0, y - 110) : Math.min(1000, y + hh + 110)
    return [shape("rect", { x, y, width: w, height: hh, class: `${cls} faint` }), shape("line", { x1: x + w / 2, y1: from, x2: x + w / 2, y2: tip, class: cls }), shape("polyline", { points: `${x + w / 2 - 22},${tip + (y > 120 ? -26 : 26)} ${x + w / 2},${tip} ${x + w / 2 + 22},${tip + (y > 120 ? -26 : 26)}`, class: cls })]
  }
  function redraw() {
    svg.replaceChildren(...(mark ? drawn(mark.kind, mark) : []), ...(drag?.box ? drawn(tool, drag.box, true) : []))
  }
  function setTool(next) {
    const why = next ? usable() : null
    if (why) {
      note.textContent = why
      return
    }
    tool = tool === next ? null : next
    for (const [kind, button] of Object.entries(buttons)) button.setAttribute("aria-pressed", String(kind === tool))
    svg.classList.toggle("active", !!tool)
    note.textContent = tool ? `Drag on the picture to draw a ${KINDS[tool].toLowerCase()}.` : ""
    if (tool) pause()
  }
  const at = (event) => {
    const r = svg.getBoundingClientRect()
    return { u: clamp01((event.clientX - r.left) / r.width), v: clamp01((event.clientY - r.top) / r.height) }
  }
  svg.addEventListener("pointerdown", (event) => {
    if (!tool) return
    event.preventDefault()
    svg.setPointerCapture(event.pointerId)
    drag = { start: at(event), box: null }
  })
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return
    drag.box = markFromDrag(tool, drag.start, at(event), { zoom: zoomNow(), at: 0 })
    redraw()
  })
  const finish = (event) => {
    if (!drag) return
    const made = markFromDrag(tool, drag.start, at(event), { zoom: zoomNow(), at: timeNow() })
    drag = null
    if (!made) {
      note.textContent = "Too small: drag a bigger shape."
      return redraw()
    }
    mark = made
    setTool(null)
    note.textContent = `Drawn: ${KINDS[made.kind].toLowerCase()}. Say what to do with it, like "callout this", "blur this", "zoom here" or "mask this".`
    redraw()
    onChange(mark)
  }
  svg.addEventListener("pointerup", finish)
  svg.addEventListener("pointercancel", () => ((drag = null), redraw()))
  window.addEventListener("keydown", (event) => event.key === "Escape" && tool && setTool(null))

  const buttons = Object.fromEntries(Object.entries(KINDS).map(([kind, label]) => [kind, h("button", { type: "button", class: "btn", "aria-pressed": "false", title: `Draw a ${label.toLowerCase()} on the frame`, onclick: () => setTool(kind) }, label)]))
  const clearButton = h("button", { type: "button", class: "btn", title: "Remove the drawing", onclick: () => clear() }, "Clear")
  function clear() {
    mark = null
    drag = null
    note.textContent = ""
    if (tool) setTool(null)
    redraw()
    onChange(null)
  }
  const tools = h("div", { class: "row draw-tools", role: "group", "aria-label": "Draw on the frame" }, ...Object.values(buttons), clearButton, note)
  place()
  return { tools, mark: () => mark, clear, redraw: () => (place(), redraw()) }
}
