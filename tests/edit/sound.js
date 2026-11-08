// Synthetic sound for the audio tests (ED9): drums, tone beds, tone-burst "speech".
// Made here, so a test knows exactly where every hit and every word is. No real music.

import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"

import { RATE } from "../../src/edit/index/layers/music.js"

/** A drum track at `rate`: a low kick on each bar's first beat, a bright tick on every beat; an optional tone over the last bar. */
export function drums(bpm, seconds, { offset = 0.37, rate = RATE, ending = 0 } = {}) {
  const n = Math.round(rate * seconds)
  const x = new Float32Array(n)
  const beat = 60 / bpm
  for (let k = 0; offset + k * beat < seconds; k++) {
    const t0 = offset + k * beat
    for (let i = 0; i < rate * 0.12; i++) {
      const t = i / rate
      const at = Math.floor(t0 * rate) + i
      if (at >= n) break
      x[at] += (k % 4 === 0 ? 0.8 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 30) : 0) + 0.25 * Math.sin(2 * Math.PI * 3100 * t + k) * Math.exp(-t * 60)
    }
  }
  // The song's ending: a 2 kHz tone through its last bar, so a test can find where the ending went
  if (ending) for (let i = Math.round(rate * (seconds - ending)); i < n; i++) x[i] += 0.2 * Math.sin((2 * Math.PI * 2000 * i) / rate)
  return x
}

/** Writes mono floats as a 48 kHz stereo WAV, through FFmpeg. */
export function writeWav(file, samples, rate) {
  const raw = `${file}.f32`
  writeFileSync(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(rate), "-ac", "1", "-i", raw, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-y", file])
}

/** "Speech": 500 Hz bursts at each word's time, over a quiet room. */
export function voice(seconds, words, rate = 48_000) {
  const x = new Float32Array(Math.round(rate * seconds))
  let seed = 11
  for (let i = 0; i < x.length; i++) {
    const t = i / rate
    const on = words.some((w) => t >= w.s && t < w.e)
    seed = (seed * 1103515245 + 12345) % 2147483648
    x[i] = (on ? 0.35 * Math.sin(2 * Math.PI * 500 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t)) : 0) + (seed / 2147483648 - 0.5) * 0.004
  }
  return x
}
