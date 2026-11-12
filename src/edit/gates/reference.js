// QG-16, reference fit (TP6, CRAFT_UPGRADE §4.4, EDD-65): after a make that followed a reference's
// style brief, the same code measures the made cut's Edit DNA 2 and compares it, trait by trait,
// with the lines the person kept ticked, each within a tolerance. It is a note and never blocks:
// the film is the person's, not the reference's (audit §6 rule 8). A missed trait carries a typed
// repair hint: a rung and a direction, never free text from a model.

import { PRESENT } from "../core/style-brief.js"

// How near is near enough, per trait. Untuned on real references (EQ-19): a note only
export const TOLERANCE = {
  pace: 0.3, // share of the reference's seconds between picture changes
  joinShare: 0.25,
  zoomScale: 0.08, // a punch-in's scale
  captionHeight: 0.35, // share
  graphics: 0.5, // share, or 1.5 a minute
  lightness: 0.08, // OKLab L
  chroma: 0.04, // OKLab a, b
  bars: 0.03, // share of the height
  bpm: 4,
}

const near = (made, wanted, part, floor = 0) => Math.abs(made - wanted) <= Math.max(floor, Math.abs(wanted) * part)
const hint = (rung, change, extra = {}) => ({ rung, change, ...extra })

/**
 * One kept line against the made cut's DNA.
 * @returns {{ ok: boolean, hint?: object } | null} null when the made cut's trait couldn't be read, so it isn't counted either way
 */
function judge(line, dna) {
  const t = line.target
  const read = (name) => dna[name]?.read === "yes"
  switch (line.id) {
    case "pace": {
      if (!read("rhythm")) return null
      // The rate of visual change, as the brief counted it: every join and punch-in over the running time
      const every = dna.rhythm.cutsPerMinute > 0 ? 60 / dna.rhythm.cutsPerMinute : Infinity
      return near(every, t.every, TOLERANCE.pace) ? { ok: true } : { ok: false, hint: hint("punches", every > t.every ? "more" : "fewer") }
    }
    case "joins": {
      if (!read("transitions")) return null
      const per = dna.transitions.perMinute
      const total = Object.values(per).reduce((sum, v) => sum + (v ?? 0), 0) + (dna.transitions.unread ?? 0)
      if (!total) return null
      if (t.kind === "cut") return per.cut / total >= 1 - TOLERANCE.joinShare ? { ok: true } : { ok: false, hint: hint("transition", "fewer", { kind: "cut" }) }
      const part = (per[t.kind] ?? 0) / total
      // Kriya dresses the joins where the story changes moment, so "some" is followed by any; "most" needs most
      const enough = t.share >= 0.6 ? part >= t.share - TOLERANCE.joinShare : part > 0
      return enough ? { ok: true } : { ok: false, hint: hint("transition", "more", { kind: t.kind }) }
    }
    case "zooms": {
      if (!read("moves")) return null
      if (!(dna.moves.zoomsPerMinute > 0)) return { ok: false, hint: hint("punches", "more") }
      return Math.abs(dna.moves.scale - t.scale) <= TOLERANCE.zoomScale ? { ok: true } : { ok: false, hint: hint("zoom_scale", dna.moves.scale < t.scale ? "larger" : "smaller") }
    }
    case "captions": {
      if (!read("captions")) return null
      if (!dna.captions.present) return { ok: false, hint: hint("captions", "more") }
      // Where they sit is the safe zones' call, not the reference's: only size and plate are compared
      if (t.height !== null && dna.captions.height !== null && !near(dna.captions.height, t.height, TOLERANCE.captionHeight)) return { ok: false, hint: hint("caption_size", dna.captions.height < t.height ? "larger" : "smaller") }
      if (t.plate !== null && dna.captions.plate !== null && dna.captions.plate !== t.plate) return { ok: false, hint: hint("caption_look", t.plate === "box" ? "more" : "fewer") }
      return { ok: true }
    }
    case "graphics": {
      if (!read("graphics")) return null
      return near(dna.graphics.perMinute, t.perMinute, TOLERANCE.graphics, 1.5) ? { ok: true } : { ok: false, hint: hint("graphics", dna.graphics.perMinute < t.perMinute ? "more" : "fewer") }
    }
    case "colour": {
      if (!read("colour")) return null
      const [l, a, b] = dna.colour.mean.map((v, i) => v - t.mean[i])
      return Math.abs(l) <= TOLERANCE.lightness && Math.hypot(a, b) <= TOLERANCE.chroma ? { ok: true } : { ok: false, hint: hint("colour_match", "more") }
    }
    case "grain":
      return !read("colour") || dna.colour.grain === null ? null : dna.colour.grain > PRESENT.grain ? { ok: true } : { ok: false, hint: hint("grain", "more") }
    case "corners":
      return !read("colour") || dna.colour.vignette === null ? null : dna.colour.vignette > PRESENT.corners ? { ok: true } : { ok: false, hint: hint("vignette", "more") }
    case "bars":
      return !read("colour") || dna.colour.letterbox === null ? null : Math.abs(dna.colour.letterbox - t.letterbox) <= TOLERANCE.bars ? { ok: true } : { ok: false, hint: hint("letterbox", dna.colour.letterbox < t.letterbox ? "more" : "fewer") }
    case "music": {
      if (!read("sound") || dna.sound.bed === null) return null
      if (dna.sound.bed <= PRESENT.bed) return { ok: false, hint: hint("music", "more") }
      return t.bpm === null || dna.sound.bpm === null || Math.abs(dna.sound.bpm - t.bpm) <= TOLERANCE.bpm ? { ok: true } : { ok: false, hint: hint("music_tempo", dna.sound.bpm < t.bpm ? "more" : "fewer") }
    }
    case "opening":
      return !read("opening") || dna.opening.textEarly === null ? null : dna.opening.textEarly === true ? { ok: true } : { ok: false, hint: hint("titles", "more") }
    case "format":
      return !read("format") ? null : dna.format.shape === t.shape ? { ok: true } : { ok: false, hint: hint("format", "more") }
    default:
      return null
  }
}

/**
 * @param {{ id: string, text: string, target?: object }[]} kept the style brief's lines the person left ticked
 * @param {object} dna the made cut's Edit DNA 2
 * @returns {{ followed: number, of: number, unread: number, missed: { id: string, text: string, hint: object }[] }}
 */
export function referenceFit(kept, dna) {
  let [followed, unread] = [0, 0]
  const missed = []
  for (const line of kept) {
    if (!line.target) continue
    const judged = judge(line, dna)
    if (!judged) unread++
    else if (judged.ok) followed++
    else missed.push({ id: line.id, text: line.text, hint: judged.hint })
  }
  return { followed, of: followed + missed.length, unread, missed }
}

/** The note, in plain words. */
export function sayFit({ followed, of, unread, missed }) {
  if (!of) return "Nothing from your reference could be compared in this cut."
  const lower = (text) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`
  return `Followed ${followed} of ${of} things from your reference${missed.length ? `; not: ${missed.map((m) => lower(m.text)).join("; ")}` : ""}${unread ? `. ${unread} couldn't be read back from the cut` : ""}.`
}
