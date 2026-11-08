// FFmpeg arguments for the sound (EDIT_ENGINE §10, ED9): one bus, or the whole mix,
// at 48 kHz. Voice clean, music fit on downbeats, a band-split duck that leaves the
// bass and the air, levels and edge fades. Built only from typed plan data.

import { busOf, voiceClean } from "./audio.js"
import { escapeFilterValue } from "./ffmpeg.js"
import { flicksToSamples, secondsArg } from "./time.js"

export const MIX_RATE = 48_000
const EDGE_FADE = "0.015" // every boundary gets one, so no pops
export const DUCK_BANDS = [300, 3500] // Hz: only the speech band ducks (brief §E2)

const filter = (name, options) => `${name}=${Object.entries(options).map(([key, value]) => `${key}=${escapeFilterValue(value)}`).join(":")}`

function absolute(path) {
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) throw new RangeError(`an input must be an absolute path, got "${path}"`)
  return path
}

const RENDERED = new Set(["level", "fade", "eq", "duck", "fit"])

/** One item's chain, from its input label to `[a<label>]`. */
function itemChain(item, input, label, duration, gain) {
  const seconds = secondsArg(item.end - item.at)
  const chains = []
  const steps = []
  let from = `[${input}:a]`
  if (item.fit?.segments?.length > 1) {
    // The music's path: each piece trimmed, joined by short equal-power crossfades
    const parts = item.fit.segments.map((_, i) => `[f${label}_${i}]`)
    chains.push(`${from}asplit=${parts.length}${parts.join("")}`)
    item.fit.segments.forEach((segment, i) => chains.push(`${parts[i]}${filter("atrim", { start: secondsArg(segment.in), end: secondsArg(segment.out) })},asetpts=PTS-STARTPTS[g${label}_${i}]`))
    let joined = `[g${label}_0]`
    for (let i = 1; i < parts.length; i++) {
      const next = `[j${label}_${i}]`
      chains.push(`${joined}[g${label}_${i}]${filter("acrossfade", { d: secondsArg(item.fit.crossfade), c1: "qsin", c2: "qsin" })}${next}`)
      joined = next
    }
    from = joined
    steps.push(filter("atrim", { duration: seconds }))
  } else {
    const range = item.fit?.segments?.[0] ?? { in: item.in, out: item.out }
    if (item.loop) steps.push("aloop=loop=-1:size=2147483647")
    steps.push(filter("atrim", { start: secondsArg(range.in), ...(item.loop ? {} : { end: secondsArg(range.out) }) }), "asetpts=PTS-STARTPTS")
    if (item.loop || item.fit) steps.push(filter("atrim", { duration: seconds }))
  }
  if (item.speed && item.speed.n !== item.speed.d) steps.push(filter("atempo", { tempo: (item.speed.n / item.speed.d).toFixed(6) }))
  steps.push(filter("aresample", { sample_rate: MIX_RATE }), "aformat=channel_layouts=stereo")
  const length = secondsArg(Math.min(item.end, duration) - item.at)
  steps.push(filter("afade", { t: "in", d: EDGE_FADE }), filter("afade", { t: "out", st: (Number(length) - Number(EDGE_FADE)).toFixed(9), d: EDGE_FADE }))
  for (const effect of item.effects) {
    if (!RENDERED.has(effect.type)) throw new RangeError(`this render can't do ${effect.type} yet`)
    if (effect.type === "eq") {
      if (effect.preset !== "voice-clean") throw new RangeError(`this render has no "${effect.preset}" EQ`)
      steps.push(...voiceClean(effect.strength))
    }
    if (effect.type === "level") steps.push(filter("volume", { volume: `${effect.db}dB` }))
    if (effect.type === "fade" && effect.in) steps.push(filter("afade", { t: "in", d: secondsArg(effect.in) }))
    if (effect.type === "fade" && effect.out) steps.push(filter("afade", { t: "out", st: secondsArg(Math.max(0, item.end - item.at - effect.out)), d: secondsArg(effect.out) }))
  }
  // A measured gain (SFX against the voice) unless the person set a level
  if (gain !== undefined && !item.effects.some((e) => e.type === "level")) steps.push(filter("volume", { volume: `${gain.toFixed(2)}dB` }))
  if (item.at > 0) steps.push(`adelay=delays=${flicksToSamples(item.at, MIX_RATE)}S:all=1`)
  chains.push(`${from}${steps.join(",")}[a${label}]`)
  return chains
}

/**
 * The sound of a plan, or of one bus of it.
 * @param {object} plan
 * @param {{ input: (asset: string) => string, output: string, encoder: string[], bus?: string, envelope?: string, gains?: Record<string, number> }} io
 *   bus: only this bus (a stem); envelope: the duck's gain curve, mono float at 1 kHz (needed when the music ducks);
 *   gains: dB per asset, for music and sound effects levelled against the voice
 */
export function audioArgs(plan, { input, output, encoder, bus, envelope, gains = {} }) {
  const items = plan.audio.items.filter((item) => bus === undefined || busOf(item.role) === bus)
  const length = secondsArg(plan.duration)
  const tail = ["-t", length, ...encoder, "-y", output]
  if (items.length === 0) return ["-nostdin", "-hide_banner", "-f", "lavfi", "-i", `anullsrc=r=${MIX_RATE}:cl=stereo`, ...tail]
  const ducks = items.some((item) => busOf(item.role) === "music") && plan.audio.duck
  if (ducks && !envelope) throw new RangeError("the duck needs its gain curve")
  const inputs = items.flatMap((item) => ["-protocol_whitelist", "file,pipe", "-i", absolute(input(item.asset))])
  const chains = items.flatMap((item, i) => itemChain(item, i, i, plan.duration, gains[item.asset]))
  const music = items.map((item, i) => (busOf(item.role) === "music" ? `[a${i}]` : null)).filter(Boolean)
  const rest = items.map((item, i) => (busOf(item.role) === "music" ? null : `[a${i}]`)).filter(Boolean)
  let labels = [...rest]
  if (music.length) {
    let bed = music[0]
    if (music.length > 1) {
      chains.push(`${music.join("")}amix=inputs=${music.length}:normalize=0:duration=longest[mbed]`)
      bed = "[mbed]"
    }
    if (ducks) {
      // Only the speech band ducks: split, lower the middle by the gain curve, put back together
      inputs.push("-f", "f32le", "-ar", "1000", "-ac", "1", "-i", absolute(envelope))
      const e = items.length
      chains.push(`[${e}:a]${filter("aresample", { sample_rate: MIX_RATE })},pan=stereo|c0=c0|c1=c0,${filter("apad", { whole_dur: length })}[env]`)
      chains.push(`${bed}${filter("apad", { whole_dur: length })},${filter("acrossover", { split: DUCK_BANDS.join(" ") })}[lo][mid][hi]`)
      chains.push("[mid][env]amultiply[midd]")
      chains.push("[lo][midd][hi]amix=inputs=3:normalize=0:duration=first[ducked]")
      bed = "[ducked]"
    }
    labels = [...labels, bed]
  }
  chains.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,${filter("apad", { whole_dur: length })}[mix]`)
  return ["-nostdin", "-hide_banner", ...inputs, "-filter_complex", chains.join(";"), "-map", "[mix]", "-vn", ...tail]
}

/** Stems summed into one mix, losslessly before mastering. */
export function stemsMixArgs({ stems, duration, output, encoder }) {
  const length = secondsArg(duration)
  if (stems.length === 1) return ["-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", absolute(stems[0]), "-t", length, ...encoder, "-y", output]
  const labels = stems.map((_, i) => `[${i}:a]`).join("")
  return ["-nostdin", "-hide_banner", ...stems.flatMap((stem) => ["-protocol_whitelist", "file,pipe", "-i", absolute(stem)]), "-filter_complex", `${labels}amix=inputs=${stems.length}:normalize=0:duration=longest,${filter("apad", { whole_dur: length })}[mix]`, "-map", "[mix]", "-t", length, ...encoder, "-y", output]
}
