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

function candidates(item, { canvas, safe, prefer }) {
  if (item.fixed) return [{ box: item.fixed, cost: 0 }]
  const { top = 0, right = 0, bottom = 0, left = 0 } = safe
  const width = canvas.width - left - right
  const last = canvas.height - bottom - item.h
  if (item.w > width || last < top) return []
  const wanted = Math.round((canvas.height * prefer) / 100)
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
