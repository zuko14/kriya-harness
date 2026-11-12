// The style brief (TP6, CRAFT_UPGRADE §4.2–4.4, EDD-65), behind editing.referenceIntent: an Edit
// DNA 2 turned into what Kriya can really do, one line per trait, each `matched`, `nearest` (with
// the reason in plain words) or `cannot`. The person unticks any line before the make.
// A reference sets the method; the gates set the floor (§4.3). Where they disagree the gate wins
// and the line says so: a reference never lowers contrast, loudness, cut hygiene or safe zones.
// Pure code over numbers and fixed words: no model, no text from the reference (there is none in
// a DNA). Every sentence here is written by this file.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const one = (v) => (Math.round(v * 10) / 10).toFixed(1)

export const TRAIT_IDS = ["pace", "joins", "zooms", "captions", "graphics", "colour", "grain", "corners", "bars", "music", "loudness", "opening", "format"]
// The floor the gates hold, whatever a reference does (QUALITY_GATES; CRAFT §4.3)
export const FLOOR = {
  hold: 1.0, // seconds a picture stays at least: shorter cuts into words (cut hygiene, QG-05)
  contrast: 4.5, // QG-09
  lufs: -14, // QG-06, the deliverable's own level
  graphicsPerMinute: 6, // each needs room to be read (QG-08's reading time)
  punches: 8, // a make's most punch-ins
}
// Above these a trait is there at all (spike TPX-03: plain references read 0.18–0.26, −0.02–0.06 and 0)
export const PRESENT = { grain: 0.8, corners: 0.2, bars: 0.04, bed: -30 }
const JOIN_WORDS = { fade: "Fades", dip: "Dips to black", flash: "Flashes", wipe: "Wipes", slide: "Slides", zoom: "Zooms" }
const FORMAT_OF = { vertical: "9:16", portrait: "4:5", square: "1:1", landscape: "16:9" }
const TRAIT_WORDS = { rhythm: "its pace", opening: "how it opens", transitions: "its transitions", moves: "its zooms", captions: "its captions", graphics: "its graphics", colour: "its colour", sound: "its sound", structure: "its sections", format: "its shape" }
// What Edit DNA 2 doesn't measure at all (TPX-03): said once, so no one thinks it was followed
export const NEVER_READ = ["how much of the time music plays", "the music's level under the voice", "sound effects", "words on a caption page", "outlined captions", "faces in the shots"]

const share = (v) => (v >= 0.9 ? "every join" : v >= 0.6 ? "most joins" : v >= 0.4 ? "half the joins" : v >= 0.25 ? "a third of the joins" : "a few joins")

/**
 * @param {object} dna a checked Edit DNA 2
 * @param {{ looks: Record<string, { size: number, box: object | null, highlight: boolean, place?: string }>, lookLabels?: Record<string, string>, moods: Record<string, { bpm: number }>, motion: boolean, craft: boolean, safe?: { top?: number, bottom?: number } }} can what this server and computer allow; `safe` as shares of the height for the format the cut will have
 * @returns {{ version: 1, lines: { id: string, state: "matched" | "nearest" | "cannot", text: string, why?: string, gate?: string, locked?: boolean, set?: object, target?: object }[], unread: string[] }}
 */
export function styleBrief(dna, can) {
  const lines = []
  const add = (line) => lines.push(line)
  const read = (name) => dna[name]?.read === "yes"

  if (read("rhythm") && dna.rhythm.cutsPerMinute > 0) {
    // The rate of visual change: every join and every punch-in, in and out, over the running time
    const every = 60 / dna.rhythm.cutsPerMinute
    const held = Math.max(every, FLOOR.hold)
    add({
      id: "pace",
      state: every < FLOOR.hold ? "nearest" : "matched",
      text: `A change of picture about every ${one(every)} s`,
      // A talking cut can't cut faster than its sentences, so the rate is reached with punch-ins between them (§4.3)
      why: every < FLOOR.hold ? `I hold each picture at least ${one(FLOOR.hold)} s: shorter ones cut into words.` : "Reached with punch-ins between the cuts your sentences allow.",
      ...(every < FLOOR.hold ? { gate: "cut hygiene" } : {}),
      set: { paceEvery: held },
      target: { every: held },
    })
  }

  if (read("transitions")) {
    const per = dna.transitions.perMinute
    const total = Object.values(per).reduce((sum, v) => sum + (v ?? 0), 0) + (dna.transitions.unread ?? 0)
    const [kind, most] = Object.entries(per).filter(([k]) => k !== "cut").sort((a, b) => b[1] - a[1])[0]
    if (total > 0 && most > 0) {
      const part = most / total
      const base = { id: "joins", text: `${JOIN_WORDS[kind]} on ${share(part)}`, target: { kind, share: Math.round(part * 100) / 100 } }
      if (!can.motion) add({ ...base, state: "cannot", why: "Transitions need motion, which is off here." })
      else if (part >= 0.6) add({ ...base, state: "matched", set: { transition: kind, transitionAll: true } })
      else add({ ...base, state: "nearest", why: "I use it where the story changes moment, not by count.", set: { transition: kind } })
    } else if (total > 0) add({ id: "joins", state: "matched", text: "Hard cuts, no transitions", target: { kind: "cut", share: 1 } })
  }

  if (read("moves") && dna.moves.zoomsPerMinute > 0) {
    const scale = clamp(dna.moves.scale ?? 1.2, 1.05, 1.5)
    const fits = scale === (dna.moves.scale ?? 1.2)
    // How many is the pace line's to say (a talking cut needs more of them than the reference to change as often); this line is their size
    add({ id: "zooms", state: fits ? "matched" : "nearest", text: `Punch-ins at ×${scale.toFixed(2)}`, ...(fits ? {} : { why: `Its own are ×${dna.moves.scale.toFixed(2)}; mine stay between ×1.05 and ×1.50 so a face holds up.` }), set: { punchesPerMinute: dna.moves.zoomsPerMinute, zoom: Math.round(scale * 100) / 100 }, target: { scale: Math.round(scale * 100) / 100 } })
  }

  if (read("captions") && dna.captions.present) {
    const c = dna.captions
    const centre = (c.top + c.bottom) / 2
    const place = centre < 0.33 ? "top" : centre < 0.6 ? "middle" : "bottom"
    // The nearest of Kriya's own looks: plate, word-by-word marking, place, then size (a look's size is its font's; the letters measure about 0.93 of it)
    const scored = Object.entries(can.looks).map(([id, look]) => [id, (!!look.box === (c.plate === "box") || c.plate === null ? 0 : 2) + (!!look.highlight === !!c.highlight || (look.mark && look.mark !== "none") === !!c.highlight ? 0 : 1) + ((look.place ?? "bottom") === place ? 0 : 1.5) + Math.abs(look.size * 0.93 - (c.height ?? look.size * 0.93)) * 40])
    const [look] = scored.sort((a, b) => a[1] - b[1])[0]
    const words = `${c.highlight ? "Word-by-word captions" : "Captions"}${c.plate === "box" ? " on a plate" : ""}, ${place === "bottom" ? "lower third" : place === "top" ? "at the top" : "in the middle"}`
    const size = `${one(can.looks[look].size * 100)}% of the height`
    // Gates outrank the reference: where its captions sit under an app's buttons, or read under 4.5:1, mine don't follow
    const under = can.safe?.bottom !== undefined && 1 - c.bottom < can.safe.bottom && place === "bottom"
    const over = can.safe?.top !== undefined && c.top < can.safe.top && place === "top"
    const faint = c.plate === "none" && c.contrast !== null && c.contrast < 3
    const gates = [...(under || over ? ["Your reference's captions run under the app's buttons. I kept mine clear of them."] : []), ...(faint ? [`Your reference's captions read at about ${one(c.contrast)}:1 against the picture. Mine hold ${FLOOR.contrast}:1.`] : [])]
    add({ id: "captions", state: "nearest", text: words, why: [`nearest: ${can.lookLabels?.[look] ?? look}, ${size}`, ...gates].join(" "), ...(gates.length ? { gate: under || over ? "safe zones" : "contrast", gateNote: gates.join(" ") } : {}), set: { captions: look }, target: { centre: Math.round(centre * 1000) / 1000, height: c.height, plate: c.plate } })
  }

  if (read("graphics") && dna.graphics.perMinute > 0) {
    const n = dna.graphics.perMinute
    const strap = dna.graphics.lowerBand ? ", with a name strap lower left" : ""
    const text = `${n >= 1.5 ? `${Math.round(n)} graphics a minute` : "A graphic now and then"}${strap}`
    if (!can.motion) add({ id: "graphics", state: "cannot", text, why: "Graphics need motion, which is off here.", target: { perMinute: n } })
    else if (n > FLOOR.graphicsPerMinute) add({ id: "graphics", state: "nearest", text, why: `I can place ${FLOOR.graphicsPerMinute}: they need room to be read.`, gate: "reading time", set: { graphicsPerMinute: FLOOR.graphicsPerMinute }, target: { perMinute: FLOOR.graphicsPerMinute } })
    else add({ id: "graphics", state: "matched", text, set: { graphicsPerMinute: n }, target: { perMinute: n } })
  }

  if (read("colour")) {
    const c = dna.colour
    const words = [c.mean[2] > 0.02 ? "warm" : c.mean[2] < -0.02 ? "cool" : "neutral", c.saturation > 0.12 ? "saturated" : c.saturation < 0.04 ? "muted" : "natural colour", c.contrast > 0.22 ? "contrasty" : c.contrast < 0.1 ? "soft contrast" : "even contrast", c.mean[0] > 0.7 ? "bright" : c.mean[0] < 0.4 ? "dark" : "mid brightness"]
    add({ id: "colour", state: "matched", text: `Its colour: ${words.join(", ")}`, why: "Measured against your own footage and matched within limits, so skin stays skin.", set: { colourMatch: true }, target: { mean: c.mean } })
    const craft = (id, text, set, target) => add(can.craft ? { id, state: "matched", text, set, target } : { id, state: "cannot", text, why: "It is one of the effects, which are off here.", target })
    if (c.grain !== null && c.grain > PRESENT.grain) craft("grain", "Film grain", { grain: clamp(Math.round(c.grain * 6.3), 1, 40) }, { grain: c.grain })
    if (c.vignette !== null && c.vignette > PRESENT.corners) craft("corners", "Darker corners", { vignette: Math.round(clamp(c.vignette * 1.9, 0, 1) * 100) / 100 }, { vignette: c.vignette })
    if (c.letterbox !== null && c.letterbox > PRESENT.bars && read("format")) {
      const ratio = dna.format.aspect / (1 - c.letterbox)
      const text = `Black bars, about ${ratio.toFixed(2)}:1`
      // Bars on a tall film would sit where the captions and the app's buttons are
      if (can.tall) add({ id: "bars", state: "cannot", text, why: "On a tall film bars would cover the picture and the captions, so I left them off.", gate: "safe zones", target: { letterbox: c.letterbox } })
      else craft("bars", text, { letterbox: Math.round(clamp(ratio, 1.5, 3) * 100) / 100 }, { letterbox: c.letterbox })
    }
  }

  if (read("sound")) {
    const s = dna.sound
    if (s.bed !== null && s.bed > PRESENT.bed) {
      const moods = Object.entries(can.moods)
      const [mood, spec] = s.bpm === null ? (moods.find(([id]) => id === "calm") ?? moods[0]) : moods.sort((a, b) => Math.abs(a[1].bpm - s.bpm) - Math.abs(b[1].bpm - s.bpm))[0]
      add({ id: "music", state: "nearest", text: `Music under the voice${s.bpm === null ? "" : `, about ${Math.round(s.bpm)} bpm`}`, why: s.bpm === null ? `I couldn't read its tempo, so ${/^[aeiou]/.test(mood) ? "an" : "a"} ${mood} bed of my own.` : `nearest: ${/^[aeiou]/.test(mood) ? "an" : "a"} ${mood} bed of my own at ${Math.round(clamp(s.bpm, 60, 180))} bpm (its own is ${spec.bpm}).`, set: { music: `generated:${mood}`, ...(s.bpm === null ? {} : { musicBpm: Math.round(clamp(s.bpm, 60, 180)) }) }, target: { bed: s.bed, bpm: s.bpm } })
    }
    // Loudness is the gate's, never the reference's: said, not offered
    if (s.lufs !== null && Math.abs(s.lufs - FLOOR.lufs) > 1.5) add({ id: "loudness", state: "nearest", text: `Mastered at ${one(s.lufs)} LUFS`, why: `Mine is mastered at ${FLOOR.lufs} LUFS, the level the loudness gate holds.`, gate: "loudness", locked: true })
  }

  if (read("opening") && dna.opening.style) {
    const style = dna.opening.style
    if (style === "title_first") add(can.motion ? { id: "opening", state: "nearest", text: "Text on screen in the first two seconds", why: "nearest: a title card of my own, on your own words.", set: { titles: true }, target: { textEarly: true } } : { id: "opening", state: "cannot", text: "Text on screen in the first two seconds", why: "Title cards need motion, which is off here.", target: { textEarly: true } })
    else if (style === "cold_open") add({ id: "opening", state: "nearest", text: `A short piece first, then a cut at ${one(dna.opening.firstCut)} s`, why: "The Director picks a cold open when it plans the cut; a make without a plan opens on your hook." })
    else add({ id: "opening", state: "matched", text: "Straight in: no title, no cold open" })
  }

  if (read("format")) {
    const format = FORMAT_OF[dna.format.shape]
    add({ id: "format", state: "matched", text: `${format} ${dna.format.shape === "vertical" || dna.format.shape === "portrait" ? "tall" : dna.format.shape === "square" ? "square" : "wide"} frame`, set: { format }, target: { shape: dna.format.shape } })
  }

  const unread = [...Object.keys(TRAIT_WORDS).filter((name) => !read(name)).map((name) => TRAIT_WORDS[name]), ...(read("sound") && dna.sound.bpm === null && dna.sound.bed > PRESENT.bed ? ["its tempo"] : []), ...(read("captions") && dna.captions.present && dna.captions.plate === null ? ["whether its captions have a plate"] : []), ...(read("transitions") && dna.transitions.unread > 0 ? ["some of its joins"] : [])]
  return { version: 1, lines, unread }
}

/** The ids a person may untick: every line that would change the cut. */
export const tickable = (brief) => brief.lines.filter((line) => line.set && !line.locked).map((line) => line.id)

/** `off` as the Host takes it: known trait ids only, each once. */
export const cleanOff = (off) => (Array.isArray(off) ? [...new Set(off.filter((id) => TRAIT_IDS.includes(id)))] : [])

/**
 * The lines the person kept, as fields of a make's brief, filled only where the brief says nothing:
 * what the person chose in this brief always wins over a reference.
 * @param {object} brief already cleaned by the Host
 * @param {{ lines: object[] }} style from styleBrief
 * @param {string[]} off the ids the person unticked
 * @param {{ seconds: number }} cut the length the cut aims for
 * @returns {{ brief: object, notes: string[], kept: object[], colourMatch: boolean }} kept: the lines QG-16 compares
 */
export function applyStyleBrief(brief, style, off, { seconds }) {
  const out = { ...brief }
  const notes = []
  const kept = style.lines.filter((line) => line.state !== "cannot" && !off.includes(line.id))
  const taken = (line, extra = "") => notes.push(`From your reference: ${line.text.charAt(0).toLowerCase()}${line.text.slice(1)}${extra}.`)
  let colourMatch = false
  for (const line of kept) {
    const set = line.set ?? {}
    if (line.gate && line.why) notes.push(line.gateNote ?? line.why)
    if (set.paceEvery !== undefined && out.punches === undefined) {
      out.punches = clamp(Math.round(seconds / set.paceEvery / 2), 1, FLOOR.punches)
      taken(line, `, so ${out.punches} punch-in${out.punches === 1 ? "" : "s"} between your sentences`)
    }
    if (set.punchesPerMinute !== undefined) {
      if (out.punches === undefined) out.punches = clamp(Math.round((set.punchesPerMinute * seconds) / 60), 1, FLOOR.punches)
      if (out.zoom === undefined) out.zoom = set.zoom
      taken(line)
    }
    if (set.transition !== undefined && out.transition === undefined) {
      out.transition = set.transition
      if (set.transitionAll) out.transitionAll = true
      taken(line)
    }
    if (set.captions !== undefined && out.captions === undefined) {
      out.captions = set.captions
      taken(line, ` (${line.why.split(" Your reference")[0]})`)
    }
    if (set.graphicsPerMinute !== undefined && Array.isArray(out.graphics)) {
      const most = Math.max(1, Math.round((set.graphicsPerMinute * seconds) / 60))
      if (out.graphics.length > most) out.graphics = out.graphics.slice(0, most)
      taken(line)
    }
    if (set.colourMatch && out.grade === undefined) colourMatch = true
    const fx = [...(set.grain !== undefined ? [{ effect: "grain", params: { amount: set.grain } }] : []), ...(set.vignette !== undefined ? [{ effect: "vignette", params: { strength: set.vignette } }] : []), ...(set.letterbox !== undefined ? [{ effect: "letterbox", params: { ratio: set.letterbox } }] : [])]
    if (fx.length) {
      out.fx = [...(out.fx ?? []), ...fx]
      taken(line)
    }
    if (set.music !== undefined && out.music === undefined) {
      out.music = set.music
      if (set.musicBpm) out.musicBpm = set.musicBpm
      taken(line, ` (${line.why.replace(/\.$/, "")})`)
    }
    if (set.titles && out.titles === undefined) {
      out.titles = true
      taken(line)
    }
    if (set.format !== undefined && out.format === undefined) out.format = set.format
  }
  return { brief: out, notes, kept, colourMatch }
}
