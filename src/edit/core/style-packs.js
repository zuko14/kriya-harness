// Style packs (TP7, CRAFT_UPGRADE §5.5, EDD-67): one name for a whole look. Data, like a
// recipe: no command, path, URL or model (ET-RCP-01's rule, ET-TY-08). Each names a type
// kit pair, a caption look, the graphics' tone and accent and name strap, a transition, a
// grade and a generated music mood, all ids of Kriya's own tables. The person picks one, or
// the Director proposes one and the person approves the plan; nothing here is chosen alone.
// What a pack names that this computer or server can't do (a mood or grade behind another
// switch) is left out with a note, never faked.

/**
 * @type {Record<string, { label: string, does: string, type: string, caption: string, graphics: { tone: string, accent: string, lower: string }, transition: string | null, grade: string | null, mood: string | null, density: "none" | "light" | "full" }>}
 */
export const STYLE_PACKS = {
  "clean-explainer": { label: "Clean explainer", does: "plain type, quiet captions, cuts that don't show", type: "clean", caption: "subtle", graphics: { tone: "light", accent: "teal", lower: "underline" }, transition: null, grade: "bright", mood: "calm", density: "light" },
  "bold-promo": { label: "Bold promo", does: "big condensed type, one word at a time, fast joins", type: "bold", caption: "single", graphics: { tone: "dark", accent: "yellow", lower: "box" }, transition: "zoom", grade: "vivid", mood: "upbeat", density: "full" },
  "warm-story": { label: "Warm story", does: "a serif, soft captions, slow fades, a warm grade", type: "story", caption: "story", graphics: { tone: "dark", accent: "amber", lower: "bar" }, transition: "fade", grade: "warm", mood: "warm", density: "light" },
  "creator-pop": { label: "Creator pop", does: "words that pop as they're said, bright colour", type: "modern", caption: "duo", graphics: { tone: "dark", accent: "pink", lower: "pill" }, transition: "slide", grade: "vivid", mood: "upbeat", density: "full" },
  "news-desk": { label: "News desk", does: "headline captions at the top, straps for every speaker", type: "clean", caption: "headline", graphics: { tone: "dark", accent: "white", lower: "split" }, transition: "wipe", grade: null, mood: null, density: "none" },
  "tutorial-steps": { label: "Tutorial", does: "steps on screen, a marker on each word, a plain screen frame", type: "tech", caption: "marker", graphics: { tone: "dark", accent: "teal", lower: "tag" }, transition: null, grade: "bright", mood: "calm", density: "light" },
  "podcast-clip": { label: "Podcast clip", does: "karaoke captions and a quiet look", type: "clean", caption: "karaoke", graphics: { tone: "dark", accent: "yellow", lower: "pill" }, transition: null, grade: null, mood: null, density: "none" },
  "cinematic-title": { label: "Cinematic", does: "a serif title card, slow dips, a filmic grade", type: "story", caption: "minimal", graphics: { tone: "dark", accent: "white", lower: "underline" }, transition: "dip", grade: "cinematic", mood: "warm", density: "light" },
  "handmade-vlog": { label: "Handmade vlog", does: "handwritten titles, friendly captions", type: "hand", caption: "grow", graphics: { tone: "light", accent: "amber", lower: "tag" }, transition: "fade", grade: "warm", mood: "calm", density: "light" },
  "type-on-quote": { label: "Typed quote", does: "captions typed on, mono headings", type: "tech", caption: "typewriter", graphics: { tone: "dark", accent: "amber", lower: "box" }, transition: "dip", grade: "mono", mood: null, density: "none" },
  "minimal-mono": { label: "Minimal", does: "black and white, few words, nothing loud", type: "modern", caption: "minimal", graphics: { tone: "light", accent: "white", lower: "underline" }, transition: "fade", grade: "mono", mood: "calm", density: "none" },
  "launch-energy": { label: "Launch", does: "underlined captions, flash joins, a punchy grade", type: "bold", caption: "underline", graphics: { tone: "dark", accent: "yellow", lower: "split" }, transition: "flash", grade: "vivid", mood: "upbeat", density: "full" },
}

/**
 * A pack as the fields of a make's brief and the kit to store, filled only where the brief
 * says nothing: the person's own choice in this brief always wins.
 * @param {string} id
 * @param {object} brief already cleaned by the Host
 * @param {{ moods: Record<string, unknown>, grades: Record<string, unknown>, transitions: Record<string, unknown>, looks: Record<string, unknown>, motion: boolean }} can what this server and computer allow
 * @returns {{ brief: object, kit: { pair: string, pack: string }, notes: string[] } | null}
 */
export function applyStylePack(id, brief, can) {
  const pack = Object.hasOwn(STYLE_PACKS, id) ? STYLE_PACKS[id] : null
  if (!pack) return null
  const out = { ...brief }
  const notes = []
  if (out.captions === undefined && Object.hasOwn(can.looks, pack.caption)) out.captions = pack.caption
  if (out.grade === undefined && pack.grade) {
    if (Object.hasOwn(can.grades, pack.grade)) out.grade = pack.grade
    else notes.push(`The ${pack.label} pack's ${pack.grade} grade isn't available here, so it was left out.`)
  }
  if (out.transition === undefined && pack.transition) {
    if (can.motion && Object.hasOwn(can.transitions, pack.transition)) out.transition = pack.transition
    else notes.push(`The ${pack.label} pack's ${pack.transition} joins need motion, which is off here.`)
  }
  if (out.music === undefined && pack.mood) {
    if (Object.hasOwn(can.moods, pack.mood)) out.music = `generated:${pack.mood}`
    else notes.push(`The ${pack.label} pack's ${pack.mood} music isn't available here, so there is none.`)
  }
  if (pack.density === "full") out.cutSound ??= "whoosh"
  // The plan's graphics in the pack's tone, accent and name strap; their words are untouched
  if (Array.isArray(out.graphics)) out.graphics = out.graphics.map((g) => ({ ...g, tone: pack.graphics.tone, accent: pack.graphics.accent, ...(g.kind === "lower" ? { style: pack.graphics.lower } : {}) }))
  return { brief: out, kit: { pair: pack.type, pack: id }, notes }
}
