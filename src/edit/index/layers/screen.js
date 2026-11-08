// L9 Screen (PERCEPTION §2): cursor track and where the screen changes, by frame
// difference on a small grey copy of the picture. Own code, no OpenCV: a grid of cells
// marks what changed; joined cells make regions; small changes that revert are the
// cursor; the largest change that isn't its trail is the action. Times are flicks.

import { runTool } from "../../engine/tool.js"

export const SCREEN_VERSION = "l9-1"
export const SCREEN = { fps: 5, width: 160, height: 90, cell: 5, threshold: 24, minPixels: 3, cursorCells: 4, lag: 5 }
const FLICKS = 705_600_000

export const screenArgs = (source, { fps, width, height } = SCREEN) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-an", "-sn", "-dn", "-vf", `fps=${fps},scale=${width}:${height},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]

/** Reads the grey frames of `source`. @returns {Promise<Buffer>} */
export async function readScreenFrames(source, { run = runTool, signal } = {}) {
  const chunks = []
  await run("ffmpeg", screenArgs(source), { onStdout: (chunk) => chunks.push(chunk), signal, stallMs: 60_000 })
  return Buffer.concat(chunks)
}

/** Joined changed cells (4-neighbour), each as a cell count and a bounding box in cells. */
function regions(changed, cols, rows) {
  const seen = new Uint8Array(changed.length)
  const found = []
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue
    const stack = [start]
    seen[start] = 1
    const box = { x0: cols, y0: rows, x1: -1, y1: -1, cells: 0 }
    while (stack.length) {
      const i = stack.pop()
      const [x, y] = [i % cols, Math.floor(i / cols)]
      Object.assign(box, { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y), cells: box.cells + 1 })
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const j = ny * cols + nx
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && changed[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    found.push(box)
  }
  return found
}

/**
 * One sample per frame after the first. A cursor gives back what it covered: pixels it
 * entered one frame return the next, so a sample whose change reverts (or the sample
 * just before one) is the cursor's. Content stays: a new character never reverts. The
 * action is what changed since `lag` frames before (a second), minus the cells the
 * cursor touched meanwhile: typing grows a few pixels a frame and adds up.
 * shortcut: a moving cursor shows as two blobs (where it was, where it is) and the track takes their middle; a pointer-shape match replaces it when L9 grows one
 * @param {Buffer} frames grey frames of `width` × `height`
 * @param {{ sourceWidth: number, sourceHeight: number, start?: number }} source boxes come back in source pixels
 * @returns {{ t: number, change: { x: number, y: number, w: number, h: number } | null, cursor: { x: number, y: number } | null }[]}
 */
export function screenTrack(frames, { sourceWidth, sourceHeight, start = 0 }, options = SCREEN) {
  const { fps, width, height, cell, threshold, minPixels, cursorCells, lag } = options
  const size = width * height
  const count = Math.floor(frames.length / size)
  const [cols, rows] = [Math.ceil(width / cell), Math.ceil(height / cell)]
  const [sx, sy] = [sourceWidth / width, sourceHeight / height]
  const toSource = (b) => ({ x: Math.round(b.x0 * cell * sx), y: Math.round(b.y0 * cell * sy), w: Math.round(Math.min(width - b.x0 * cell, (b.x1 - b.x0 + 1) * cell) * sx), h: Math.round(Math.min(height - b.y0 * cell, (b.y1 - b.y0 + 1) * cell) * sy) })
  const differs = (a, b, i) => Math.abs(frames[a * size + i] - frames[b * size + i]) > threshold
  const changedCells = (a, b) => {
    const counts = new Uint16Array(cols * rows)
    for (let i = 0; i < size; i++) if (differs(a, b, i)) counts[Math.floor(Math.floor(i / width) / cell) * cols + Math.floor((i % width) / cell)]++
    return counts.map((n) => (n >= minPixels ? 1 : 0))
  }
  const touches = (a, b) => a.x0 <= b.x1 + 1 && b.x0 <= a.x1 + 1 && a.y0 <= b.y1 + 1 && b.y0 <= a.y1 + 1

  // Pass 1: each sample's small blobs, and whether anything that changed last frame went back
  const blobs = [null]
  const reverts = [false]
  for (let f = 1; f < count; f++) {
    blobs.push(regions(changedCells(f - 1, f), cols, rows).filter((r) => r.cells <= cursorCells))
    let back = 0
    if (f >= 2) for (let i = 0; i < size && back < minPixels; i++) if (differs(f - 1, f - 2, i) && !differs(f, f - 2, i)) back++
    reverts.push(back >= minPixels)
  }
  const isCursor = (f) => blobs[f].length > 0 && (reverts[f] || (f + 1 < count && reverts[f + 1] && blobs[f].some((r) => blobs[f + 1].some((b) => touches(r, b)))))

  // Pass 2: the cursor's trail, and the action since a second ago without it
  const trails = []
  const samples = []
  for (let f = 1; f < count; f++) {
    const small = isCursor(f) ? blobs[f] : []
    const trail = new Set()
    for (const r of small) for (let y = r.y0 - 1; y <= r.y1 + 1; y++) for (let x = r.x0 - 1; x <= r.x1 + 1; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) trail.add(y * cols + x)
    trails.push(trail)
    const crossed = new Set(trails.slice(-lag).flatMap((t) => [...t]))
    const since = changedCells(Math.max(0, f - lag), f).map((v, i) => (v && !crossed.has(i) ? 1 : 0))
    const action = regions(since, cols, rows).sort((p, q) => q.cells - p.cells)[0]
    const cursor = small.length ? toSource({ x0: Math.min(...small.map((r) => r.x0)), y0: Math.min(...small.map((r) => r.y0)), x1: Math.max(...small.map((r) => r.x1)), y1: Math.max(...small.map((r) => r.y1)) }) : null
    samples.push({ t: start + Math.round((f * FLICKS) / fps), change: action ? toSource(action) : null, cursor: cursor ? { x: cursor.x + Math.round(cursor.w / 2), y: cursor.y + Math.round(cursor.h / 2) } : null })
  }
  return samples
}
