// Licensed media the person approved on the Plan Card (EDD-52): downloaded by the Host, only over
// HTTPS, only from the hosts the server's search reads, with no redirects and a size limit. A still
// becomes a short clip with a slow move, so it goes through the same render as any B-roll.

import { createWriteStream, renameSync, rmSync } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { EngineFailure } from "./tool.js"

export const MEDIA_HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org", "images-assets.nasa.gov", "live.staticflickr.com"]
export const MEDIA_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/webm": ".webm", "video/mp4": ".mp4", "video/ogg": ".ogv", "application/ogg": ".ogv" }
const MAX_BYTES = 100 * 1024 * 1024
const TIMEOUT_MS = 120_000

export function allowedMediaUrl(url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && MEDIA_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * @param {string} url
 * @param {string} base the file's path without its extension; the type the server states picks it
 * @returns {Promise<{ file: string, type: string }>}
 */
export async function downloadMedia(url, base, { signal, maxBytes = MAX_BYTES, get = fetch } = {}) {
  if (!allowedMediaUrl(url)) throw new EngineFailure("input", "bad_media_url", "That picture isn't from a source Kriya may download from.")
  const limit = AbortSignal.timeout(TIMEOUT_MS)
  const response = await get(url, { redirect: "error", headers: { "user-agent": "KriyaEditingStudio/1.0 (https://github.com/zuko14/kriya-harness)" }, signal: signal ? AbortSignal.any([signal, limit]) : limit })
  if (!response.ok) throw new EngineFailure("environment", "media_download", `The source answered ${response.status}.`)
  const type = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  const extension = MEDIA_TYPES[type]
  if (!extension) throw new EngineFailure("input", "bad_media_type", "That file isn't a picture or video Kriya can use.")
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new EngineFailure("input", "media_too_big", "That file is too big.")
  const file = `${base}${extension}`
  const part = `${file}.${process.pid}.part`
  let seen = 0
  const counted = async function* (source) {
    for await (const chunk of source) {
      seen += chunk.length
      if (seen > maxBytes) throw new EngineFailure("input", "media_too_big", "That file is too big.")
      yield chunk
    }
  }
  try {
    await pipeline(Readable.fromWeb(response.body), counted, createWriteStream(part))
    renameSync(part, file)
  } catch (error) {
    rmSync(part, { force: true })
    throw error
  }
  return { file, type }
}

/** FFmpeg's arguments for a still as a clip: filling the frame, moving slowly in or out. No sound. */
export function stillClipArgs({ image, output, width, height, seconds, fps = 30, inward = true }) {
  const frames = Math.max(1, Math.round(seconds * fps))
  const zoom = inward ? `1+0.1*on/${frames}` : `1.1-0.1*on/${frames}`
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", image, "-vf", `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},format=yuv420p`, "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", "-y", output]
}
