// L8 Faces: boxes sampled once a second and linked into tracks by centroid, for the
// layout's safe zones. macOS uses Vision through a small helper compiled once; other
// systems wait for the runtime's MediaPipe or YuNet, and the layer says so.
// Eye and chin lines and gaze come with landmarks, later.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const FACES_VERSION = "l8-1"
export const MIN_CONFIDENCE = 0.5
const FLICKS = 705_600_000
const HELPER = join(dirname(fileURLToPath(import.meta.url)), "faces.swift")

export const frameArgs = (source, folder) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-an", "-sn", "-dn", "-vf", "fps=1,scale=640:-2", "-q:v", "4", "-y", join(folder, "f%06d.jpg")]

/** The compiled helper's path, building it on first use. @returns {Promise<{ path?: string, missing?: string }>} */
export async function faceHelper(binDir, run, platform = process.platform) {
  if (platform !== "darwin") return { missing: "Face tracking on this system needs the Media Runtime's face model, which isn't in it yet." }
  const source = readFileSync(HELPER)
  const path = join(binDir, `faces-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`)
  if (existsSync(path)) return { path }
  mkdirSync(binDir, { recursive: true })
  try {
    await run("swiftc", ["-O", HELPER, "-o", `${path}.${process.pid}.part`])
    renameSync(`${path}.${process.pid}.part`, path)
  } catch {
    return { missing: "Face tracking needs Apple's command line tools (xcode-select --install)." }
  }
  return { path }
}

/**
 * Helper lines → boxes in source pixels, top-left origin, each with a track id.
 * Frame n of the fps=1 sampling sits at n − 1 seconds.
 */
export function readFaces(text, { width, height }) {
  const faces = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const { frame, faces: found } = JSON.parse(line)
    const t = (Number(/f(\d+)\.jpg$/.exec(frame)[1]) - 1) * FLICKS
    for (const f of found) {
      if (f.c < MIN_CONFIDENCE) continue
      faces.push({ t, box: { x: Math.floor(f.x * width), y: Math.floor((1 - f.y - f.h) * height), w: Math.ceil(f.w * width), h: Math.ceil(f.h * height) } })
    }
  }
  return track(faces)
}

const centre = ({ box }) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })

/** Links each box to the nearest track seen in the last two samples, within half a face width. */
export function track(faces) {
  const live = [] // { id, last }
  let next = 0
  const byTime = [...faces].sort((a, b) => a.t - b.t)
  for (const face of byTime) {
    const here = centre(face)
    let best = null
    for (const candidate of live) {
      const gap = face.t - candidate.last.t
      if (gap <= 0 || gap > 2 * FLICKS) continue
      const there = centre(candidate.last)
      const distance = Math.hypot(here.x - there.x, here.y - there.y)
      if (distance <= face.box.w / 2 && (!best || distance < best.distance)) best = { candidate, distance }
    }
    if (best) {
      face.identity = best.candidate.id
      best.candidate.last = face
    } else {
      face.identity = next++
      live.push({ id: face.identity, last: face })
    }
  }
  return byTime
}
