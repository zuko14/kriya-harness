// QG-06's mix checks (QUALITY_GATES §2, ED9), on the stems the Engine rendered:
// speech over music in every stretch of speech, sound effects against the voice, and
// the loudness range of the whole. Loudness is EBU R128 momentary, at 100 ms.

import { readSound, soundArgs, STEP } from "../index/layers/sound.js"

const FLICKS = 705_600_000

/** Momentary loudness every 100 ms, null where silent (below R128's gate). */
export async function curveOf(file, { run, duration }) {
  return readSound(await run("ffmpeg", soundArgs(file), { timeoutMs: 600_000 }), duration).data.loudness
}

/** Energy mean of LUFS values, ignoring silence; null when all silent. */
export function energyMean(values) {
  const live = values.filter((v) => v !== null && v !== undefined)
  if (!live.length) return null
  return 10 * Math.log10(live.reduce((sum, v) => sum + 10 ** (v / 10), 0) / live.length)
}

const slice = (curve, at, end) => curve.slice(Math.floor(at / STEP), Math.ceil(end / STEP))

/**
 * @param {{ speech: { at: number, end: number }[], dialogue: (number|null)[], music?: (number|null)[], sfx?: (number|null)[], voice: number | null, thresholds: { speechOverMusic: number, sfxOverVoice: number } }} input
 *   voice: the dialogue stem's integrated loudness
 * @returns {{ failures: object[], numbers: object }}
 */
export function judgeMix({ speech, dialogue, music, sfx, voice, thresholds }) {
  const failures = []
  let worst = null
  if (music) {
    for (const span of speech) {
      if (span.end - span.at < FLICKS) continue // too short to read loudness from
      const d = energyMean(slice(dialogue, span.at, span.end))
      const m = energyMean(slice(music, span.at, span.end))
      if (d === null || m === null) continue
      const margin = d - m
      worst = worst === null ? margin : Math.min(worst, margin)
      if (margin < thresholds.speechOverMusic) failures.push({ kind: "music_masks_speech", seconds: Math.round((span.at / FLICKS) * 10) / 10, margin: Math.round(margin * 10) / 10, needed: thresholds.speechOverMusic })
    }
  }
  let loudestEffect = null
  if (sfx && voice !== null) {
    const top = Math.max(...sfx.filter((v) => v !== null), -Infinity)
    if (top > -Infinity) {
      loudestEffect = Math.round((top - voice) * 10) / 10
      if (top - voice > thresholds.sfxOverVoice) failures.push({ kind: "effect_over_voice", over: loudestEffect, allowed: thresholds.sfxOverVoice, seconds: Math.round(((sfx.indexOf(top) * STEP) / FLICKS) * 10) / 10 })
    }
  }
  return { failures, numbers: { speechOverMusic: worst === null ? null : Math.round(worst * 10) / 10, effectOverVoice: loudestEffect, sections: speech.filter((s) => s.end - s.at >= FLICKS).length } }
}

/** The loudness range (LRA, LU) from FFmpeg's ebur128 summary. */
export async function rangeOf(file, run) {
  const text = await run("ffmpeg", ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", file, "-vn", "-af", "ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.LRA:file=-", "-f", "null", "-"], { timeoutMs: 600_000 })
  const values = [...text.matchAll(/lavfi\.r128\.LRA=([\d.]+)/g)].map((m) => Number(m[1]))
  return values.length ? Math.round(values.at(-1) * 10) / 10 : null
}
