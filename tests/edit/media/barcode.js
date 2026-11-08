import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"

// A synthetic source with its frame number burned in as a 12-bit barcode, so a
// test reads which frame came out rather than trusting timestamps. No real footage.

export const W = 640
export const H = 360
export const BITS = 12
const BLOCK = Math.floor(W / BITS)

function frame(n) {
  const row = Buffer.alloc(W)
  for (let bit = 0; bit < BITS; bit++) row.fill((n >> bit) & 1 ? 235 : 16, bit * BLOCK, (bit + 1) * BLOCK)
  const data = Buffer.alloc(W * H)
  for (let y = 0; y < H; y++) row.copy(data, y * W)
  return data
}

/** Encodes `frames` barcode frames with a steady tone. */
export async function barcodeVideo(file, { frames = 300, fps = 30 } = {}) {
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(fps), "-i", "pipe:0", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${frames / fps}`, "-map", "0:v", "-map", "1:a", "-vf", "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", "-c:v", "libx264", "-crf", "12", "-g", "15", "-c:a", "aac", "-y", file], { stdio: ["pipe", "ignore", "inherit"] })
  for (let n = 0; n < frames; n++) if (!child.stdin.write(frame(n))) await once(child.stdin, "drain")
  child.stdin.end()
  await once(child, "exit")
}

/** The frame numbers in a file, in order. */
export function readBarcodes(file, { ss, count } = {}) {
  const args = ["-hide_banner", "-loglevel", "error", ...(ss === undefined ? [] : ["-ss", ss]), "-i", file, ...(count ? ["-frames:v", String(count)] : []), "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"]
  const out = execFileSync("ffmpeg", args, { maxBuffer: 1 << 30 })
  const numbers = []
  for (let at = 0; at + W * H <= out.length; at += W * H) {
    let n = 0
    const y = at + (H >> 1) * W
    for (let bit = 0; bit < BITS; bit++) if (out[y + bit * BLOCK + (BLOCK >> 1)] > 128) n |= 1 << bit
    numbers.push(n)
  }
  return numbers
}
