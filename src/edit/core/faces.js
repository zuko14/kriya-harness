// L8 face boxes on the output (ED8): through each piece's crop path, zoom and the
// final scale-and-centre-crop, exactly as ffmpeg.js's pictureChain draws the frame.
// The matte and QG-08 both read faces from here, so they agree with the picture.

import { scaleFlicks } from "./time.js"

/** The x of a crop path at source time t: straight lines between points, like ffmpeg.js's cropX. */
function cropAt(crop, t) {
  if (t <= crop[0].t) return crop[0].x
  const next = crop.findIndex((point) => point.t > t)
  if (next === -1) return crop.at(-1).x
  const [a, b] = [crop[next - 1], crop[next]]
  return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t)
}

/**
 * Maps one source box through a picture item to output pixels.
 * @param {{ x: number, y: number, w: number, h: number }} box source pixels
 * @param {{ crop?: { t: number, x: number }[], zoom?: { scale: number } }} item
 * @param {{ width: number, height: number }} source
 * @param {{ width: number, height: number }} canvas the project's frame (sets the crop's width)
 * @param {{ width: number, height: number }} output
 * @param {number} t source time, for the crop path
 */
export function mapBox(box, item, source, canvas, output, t) {
  let { x, y, w, h } = box
  let width = source.width
  let height = source.height
  if (item.crop?.length) {
    const cropWidth = (height * canvas.width) / canvas.height
    x -= cropAt(item.crop, t)
    width = cropWidth
  }
  const focused = item.zoom && (item.zoom.x !== undefined || item.zoom.ease === "smooth")
  if (item.zoom && !focused) {
    const zw = width / item.zoom.scale
    const zh = height / item.zoom.scale
    x -= (width - zw) / 2
    y -= (height - zh) / 2
    width = zw
    height = zh
  }
  // scale with force_original_aspect_ratio=increase, then a centred crop
  const scale = Math.max(output.width / width, output.height / height)
  const left = (width * scale - output.width) / 2
  const top = (height * scale - output.height) / 2
  let out = { x: x * scale - left, y: y * scale - top, w: w * scale, h: h * scale }
  // A focused or eased punch-in zooms the finished frame (ffmpeg.js's zoomSteps).
  // shortcut: an eased zoom is mapped at its full scale, so faces in its first and last 0.3 s sit a little off
  if (focused) {
    const s = item.zoom.scale
    const [zw, zh] = [output.width / s, output.height / s]
    const zx = Math.min(Math.max(((item.zoom.x ?? 500) / 1000) * output.width - zw / 2, 0), output.width - zw)
    const zy = Math.min(Math.max(((item.zoom.y ?? 500) / 1000) * output.height - zh / 2, 0), output.height - zh)
    out = { x: (out.x - zx) * s, y: (out.y - zy) * s, w: out.w * s, h: out.h * s }
  }
  const x0 = Math.max(0, Math.floor(out.x))
  const y0 = Math.max(0, Math.floor(out.y))
  const x1 = Math.min(output.width, Math.ceil(out.x + out.w))
  const y1 = Math.min(output.height, Math.ceil(out.y + out.h))
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * Every face sample that plays, at its output time, in output pixels.
 * @param {object[]} picture picture items with absolute output times (wholeSegment's)
 * @param {object[]} faces the index's L8 rows: { asset, t, box }
 * @param {(asset: string) => { width: number, height: number } | undefined} sizeOf
 * @param {{ canvas: object, output: object, zoomAt?: (t: number) => { scale: number } | undefined }} frame
 *   zoomAt: the punch-in at an output time, when items don't carry their own
 * @returns {{ t: number, box: object }[]} sorted by time
 */
export function outputFaces(picture, faces, sizeOf, { canvas, output, zoomAt }) {
  const found = []
  for (const item of picture) {
    const source = sizeOf(item.asset)
    if (!source?.width || !source?.height) continue
    for (const face of faces ?? []) {
      if (face.asset !== item.asset) continue
      if (item.hold ? face.t !== item.in : face.t < item.in || face.t > item.out) continue
      const t = item.hold ? item.at : item.at + scaleFlicks(face.t - item.in, { n: item.speed.d, d: item.speed.n })
      if (t < item.at || t > item.end) continue
      const zoom = zoomAt ? zoomAt(t) : item.zoom
      const box = mapBox(face.box, { crop: item.crop, zoom }, source, canvas, output, face.t)
      if (box) found.push({ t, box })
    }
  }
  return found.sort((a, b) => a.t - b.t)
}

/** The smallest box holding all of these. */
export function unionBox(boxes) {
  if (boxes.length === 0) return null
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.w))
  const y1 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
