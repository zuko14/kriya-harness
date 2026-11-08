import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { heard, lengthOf } from "./script.js"

// A raw take and a stand-in recogniser, shared by the real-media tests of a reel.

/** The raw take: a moving test chart and a voice made of tone bursts, over a quiet room. */
export function rawTake(file) {
  const rate = 48_000
  const seconds = lengthOf()
  const pcm = Buffer.alloc(Math.ceil(seconds * rate) * 2)
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.004
  const words = heard()
  for (let i = 0, w = 0; i < pcm.length / 2; i++) {
    const t = i / rate
    while (w < words.length && t >= words[w].e) w++
    const voiced = w < words.length && t >= words[w].s
    const value = (voiced ? 0.35 * Math.sin(2 * Math.PI * 170 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t)) : 0) + noise()
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2)
  }
  const raw = `${file}.pcm`
  writeFileSync(raw, pcm)
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${seconds.toFixed(3)}`, "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw, "-c:v", "libx264", "-crf", "18", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "192k", "-shortest", "-y", file])
}

export function fakeRuntime(home) {
  const dir = join(home, "media", "9.9.9")
  mkdirSync(join(dir, "python", "bin"), { recursive: true })
  mkdirSync(join(dir, "models", "whisper-large-v3-turbo"), { recursive: true })
  const python = join(dir, "python", "bin", "python")
  writeFileSync(python, `#!/bin/sh\ncat <<'EOF'\n${heard().map((w) => JSON.stringify({ w: ` ${w.text}`, s: w.s.toFixed(3), e: w.e.toFixed(3), p: 0.95 })).join("\n")}\nEOF\n`)
  chmodSync(python, 0o755)
  writeFileSync(join(dir, "manifest.json"), "{}")
  writeFileSync(join(dir, ".complete"), "test")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: "9.9.9", previous: null }))
}
