// Layout solver (EDIT_ENGINE §5.1). Priority: never on a face; inside safe zones;
// stable; then the look's preference. Dynamic programming picks the cheapest
// sequence, so stability is decided across time, not per caption.

const ROWS = 13

/**
 * Margins kept clear of each platform's own buttons and text, as shares of the frame.
 * shortcut: Kriya's working margins, not figures the platforms publish; check them
 * against each app's current layout before EG-8, and replace with reviewed data.
 */
export const SAFE_ZONES = {
  "reel-9x16": { top: 0.12, right: 0.14, bottom: 0.22, left: 0.06 },
  "short-9x16": { top: 0.1, right: 0.12, bottom: 0.2, left: 0.06 },
  "tiktok-9x16": { top: 0.12, right: 0.16, bottom: 0.24, left: 0.06 },
}

/** The strictest margins over a project's deliverables, in canvas pixels; {} when none applies. */
export function safeZoneFor(project) {
  const { width, height } = project.canvas
  const zone = {}
  for (const deliverable of project.deliverables ?? []) {
    // Only exports in this frame's shape: an earlier 9:16 export's margins don't squeeze a 16:9 cut (found in use)
    if (deliverable.size && deliverable.size.width * height !== deliverable.size.height * width) continue
    const share = SAFE_ZONES[deliverable.preset]
    if (!share) continue
    for (const [side, value] of Object.entries(share)) zone[side] = Math.max(zone[side] ?? 0, Math.ceil(value * (side === "top" || side === "bottom" ? height : width)))
  }
  return zone
}

/** A cutaway scene's block (VISUAL_SCENES.md): it covers the frame, so the speaker's face isn't in the picture under it. */
export const isSceneBlock = (block) => block?.blockId === "scene"

/**
 * A scene's two regions, in canvas pixels: its content box, inside the safe zones, and the
 * caption row under it, so a caption over a scene never lands on the diagram.
 * @param {{ width: number, height: number }} canvas
 * @param {{ top?: number, right?: number, bottom?: number, left?: number }} safe
 * @param {{ w: number, h: number }} caption the caption box's size
 */
export function sceneFrame(canvas, safe, caption) {
  const margin = Math.round(Math.min(canvas.width, canvas.height) * 0.05)
  // A little inside the safe zone: a spring's overshoot on entry mustn't cross it (found on real footage)
  const inset = Math.round(margin / 4)
  const left = Math.max(safe.left ?? 0, margin) + inset
  const right = Math.max(safe.right ?? 0, margin) + inset
  const top = Math.max(safe.top ?? 0, margin) + inset
  const bottom = Math.max(safe.bottom ?? 0, Math.round(margin / 2))
  const w = Math.min(caption.w, canvas.width - (safe.left ?? 0) - (safe.right ?? 0))
  const row = { x: (safe.left ?? 0) + Math.floor((canvas.width - (safe.left ?? 0) - (safe.right ?? 0) - w) / 2), y: canvas.height - bottom - caption.h, w, h: caption.h }
  return { row, content: { x: left, y: top, w: canvas.width - left - right, h: row.y - Math.round(margin / 2) - top } }
}

const overlaps =(a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * TP7 (CRAFT_UPGRADE §5.4): the boxes motion kit 2 needs, by the graphic's kind. "full" covers
 * the frame like a scene; "frame" is a border round the whole picture, with no text; "third",
 * "corner" and "point" are placed by the solver, still clear of faces (a point marks one), safe
 * zones and captions. A kind not here is a caption-sized row, as before.
 * size: shares of the frame (w of the safe width or the frame's width, h of its height)
 */
export const REGIONS = {
  card: { region: "full" },
  frame: { region: "frame" },
  list: { region: "third", w: 0.9, h: 0.36 },
  count: { region: "third", w: 0.7, h: 0.16 },
  cta: { region: "third", w: 0.86, h: 0.15 },
  handle: { region: "corner", w: 0.5, h: 0.075 },
  callout: { region: "point", w: 0.26, h: 0.26 },
}
const CORNER_ORDER = ["tr", "tl", "br", "bl"]

/** A kit-2 item's own places, cheapest first; faces are cleared, except by a callout, which points at one. */
function regionCandidates(item, { canvas, safe }) {
  const { top = 0, right = 0, bottom = 0, left = 0 } = safe
  const W = canvas.width - left - right
  const H = canvas.height - top - bottom
  const w = Math.min(item.w, W)
  const h = Math.min(item.h, H)
  let boxes = []
  if (item.region === "third") {
    const x = left + Math.floor((W - w) / 2)
    boxes = [top + H - h, top + Math.floor((H - h) / 2), top].map((y) => ({ x, y, w, h }))
  } else if (item.region === "corner") {
    const at = { tl: { x: left, y: top }, tr: { x: left + W - w, y: top }, bl: { x: left, y: top + H - h }, br: { x: left + W - w, y: top + H - h } }
    const order = [item.corner, ...CORNER_ORDER.filter((c) => c !== item.corner)].filter(Boolean)
    boxes = order.map((c) => ({ ...at[c], w, h }))
  } else if (item.region === "point") {
    const side = Math.min(w, h)
    const p = item.point ?? { x: Math.round(canvas.width / 2), y: Math.round(canvas.height / 2) }
    const x = Math.min(Math.max(left, Math.round(p.x - side / 2)), left + W - side)
    const y = Math.min(Math.max(top, Math.round(p.y - side / 2)), top + H - side)
    return [{ box: { x, y, w: side, h: side }, cost: 0 }]
  }
  return boxes.map((box, i) => ({ box, cost: i * Math.round(canvas.height / 4) })).filter(({ box }) => !(item.faces ?? []).some((face) => overlaps(box, face)))
}

function candidates(item, { canvas, safe, prefer }) {
  if (item.fixed) return [{ box: item.fixed, cost: 0 }]
  if (item.region) return regionCandidates(item, { canvas, safe })
  const { top = 0, right = 0, bottom = 0, left = 0 } = safe
  const width = canvas.width - left - right
  const last = canvas.height - bottom - item.h
  if (item.w > width || last < top) return []
  // A look that sits higher (TP7's caption looks) asks for its own row; others use the recipe's
  const wanted = Math.round((canvas.height * (item.prefer ?? prefer)) / 100)
  const rows = new Set([Math.min(last, Math.max(top, wanted))])
  for (let i = 0; i < ROWS; i++) rows.add(top + Math.floor(((last - top) * i) / (ROWS - 1)))
  const x = left + Math.floor((width - item.w) / 2)
  return [...rows]
    .sort((a, b) => a - b)
    .map((y) => ({ box: { x, y, w: item.w, h: item.h }, cost: Math.abs(y - wanted) }))
    .filter(({ box }) => !(item.faces ?? []).some((face) => overlaps(box, face)))
}

/**
 * @param {{ id: string, at: number, end: number, w: number, h: number, faces?: object[], fixed?: object }[]} items
 * @param {{ canvas: { width: number, height: number }, safe?: object, prefer: number }} options prefer: percent of the height
 * @returns {{ placements: Record<string, object | null>, issues: object[] }}
 */
export function solveLayout(items, { canvas, safe = {}, prefer }) {
  // Stability outranks preference, so one jump costs more than all preference together
  const jump = canvas.height * (items.length + 1)
  const issues = []
  const placements = {}
  const noRoom = (item) => {
    placements[item.id] = null
    issues.push({ code: "no_placement", clip: item.id, message: "no position clears the faces inside the safe zones" })
  }
  const between = (previous, a, item, b) => {
    if (previous.end > item.at && overlaps(a.box, b.box)) return Infinity
    return a.box.y === b.box.y ? 0 : jump + Math.abs(a.box.y - b.box.y)
  }

  const chain = []
  for (const item of [...items].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))) {
    const options = candidates(item, { canvas, safe, prefer })
    const step = chain.at(-1)
    const states = options.map((option) => {
      if (!step) return { option, total: option.cost, from: -1 }
      let best = { total: Infinity, from: -1 }
      step.states.forEach((state, i) => {
        const total = state.total + between(step.item, state.option, item, option)
        if (total < best.total) best = { total, from: i }
      })
      return { option, total: best.total + option.cost, from: best.from }
    })
    const reachable = states.filter((state) => state.total < Infinity)
    if (reachable.length === 0) noRoom(item)
    else chain.push({ item, states })
  }

  let at = chain.at(-1)?.states.reduce((best, state, i, all) => (state.total < all[best].total ? i : best), 0)
  for (let i = chain.length - 1; i >= 0; i--) {
    const state = chain[i].states[at]
    placements[chain[i].item.id] = state.option.box
    at = state.from
  }
  return { placements, issues }
}
