// Synthetic Edit Core fixture: no real person, no media file. One talking-head
// take, one B-roll, one sound, one song. Every time is integer flicks.

export const ms = (n) => n * 705_600

/** Ten sentences of five words: 400 ms words, 100 ms gaps, 600 ms between sentences. */
export function makeWords(asset = "a1", sentences = 10) {
  const words = []
  const list = []
  let t = ms(1000)
  for (let s = 0; s < sentences; s++) {
    const first = words.length
    for (let w = 0; w < 5; w++) {
      const id = `${asset}:w${words.length}`
      words.push({ asset, id, start: t, end: t + ms(400), text: `word${words.length}`, lang: "en", speaker: "s0", conf: 1 })
      t += ms(500)
    }
    list.push({ asset, id: `${asset}:n${s}`, first_word: words[first].id, last_word: words[words.length - 1].id })
    t += ms(500)
  }
  return { words, sentences: list, end: t }
}

export function makeIndex() {
  const { words, sentences } = makeWords()
  return {
    words,
    sentences,
    shots: [
      { asset: "a1", id: "a1:s0", start: 0, end: ms(20000) },
      { asset: "a1", id: "a1:s1", start: ms(20000), end: ms(60000) },
      { asset: "a2", id: "a2:s0", start: 0, end: ms(8000) },
    ],
    beats: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ asset: "m1", id: `m1:b${i}`, t: ms(i * 500), downbeat: i % 4 === 0, strength: 1 })),
    faces: [{ asset: "a1", shot: "a1:s0", t: ms(2000), box: { x: 300, y: 300, w: 480, h: 480 } }],
  }
}

export function makeProject() {
  const video = (id, seconds, role) => ({
    id,
    kind: "video",
    fingerprint: `fp-${id}`,
    path: `media/${id}.mov`,
    linked: true,
    rights: "own",
    role,
    facts: { duration: ms(seconds * 1000), fps: { n: 30, d: 1 }, vfr: false, width: 1080, height: 1920, hasAudio: true },
  })
  const audio = (id, seconds, role, peak) => ({
    id,
    kind: "audio",
    fingerprint: `fp-${id}`,
    path: `media/${id}.wav`,
    linked: true,
    rights: "licensed",
    role,
    facts: { duration: ms(seconds * 1000), hasAudio: true, ...(peak === undefined ? {} : { peak }) },
  })
  return {
    schema: 1,
    id: "p1",
    name: "Synthetic reel",
    canvas: { width: 1080, height: 1920, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv" }, workingBitDepth: 10 },
    assets: [
      video("a1", 60, "aroll"),
      video("a2", 8, "broll"),
      audio("sfx:whoosh-soft", 1, "sfx", ms(200)),
      audio("m1", 120, "music"),
      { id: "ref1", kind: "reference", fingerprint: "fp-ref1", path: "media/ref.mp4", linked: true, rights: "unknown", facts: { duration: ms(10000) } },
      { id: "lut1", kind: "lut", fingerprint: "fp-lut1", path: "media/warm.cube", linked: true, rights: "own", facts: {} },
    ],
    sequences: [
      {
        id: "q1",
        name: "Main",
        tracks: [
          { id: "t-base", role: "base", order: 0, muted: false, locked: false },
          { id: "t-caption", role: "caption", order: 5, muted: false, locked: false },
        ],
        markers: [],
        clips: [],
      },
    ],
    active: "q1",
    look: { id: "default", caption: {}, color: {}, motion: {}, sound: {}, brand: {} },
    deliverables: [],
    nextId: 1,
    head: null,
    history: [],
  }
}

/** A deterministic random source, so a failing property test can be replayed. */
export function prng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/** One random operation, valid or not, from the ones that shape a timeline. */
export function randomOp(random, project) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const clipIds = project.sequences[0].clips.map((c) => c.id)
  const clip = () => (clipIds.length && random() < 0.95 ? pick(clipIds) : "nope")
  const w = (n, edge = "start") => ({ word: `a1:w${n}`, edge })
  const word = () => Math.floor(random() * 50)
  const span = () => {
    const a = word()
    return { from: w(a), to: w(Math.min(49, a + Math.floor(random() * 8)), "end") }
  }
  return pick([
    () => ({ op: "keep_range", asset: "a1", ...span() }),
    () => ({ op: "remove_range", ...span() }),
    () => ({ op: "use_take", clip: clip(), ...span() }),
    () => ({ op: "reorder", clip: clip(), after: random() < 0.3 ? null : clip() }),
    () => ({ op: "trim", clip: clip(), out: w(word(), "end") }),
    () => ({ op: "split", clip: clip(), at: w(word()) }),
    () => ({ op: "ripple_delete", clip: clip() }),
    () => ({ op: "punch_in", at: w(word()), scale: 1.1 }),
    () => ({ op: "place_broll", asset: "a2", at: w(word()), duration: ms(1000) }),
    () => ({ op: "speed", clip: clip(), rate: { n: 3, d: 2 } }),
    () => ({ op: "freeze", clip: clip(), at: w(word()), duration: ms(500) }),
    () => ({ op: "caption_style", look: "bold", words: [`a1:w${word()}`] }),
    () => ({ op: "add_sfx", asset: "sfx:whoosh-soft", peak_at: w(word()) }),
    () => ({ op: "set_music", asset: "m1" }),
    () => ({ op: "duck", depth: -10 }),
    () => ({ op: "set_level", clip: clip(), db: -3 }),
    () => ({ op: "mark", name: "m", at: w(word()) }),
    () => ({ op: "grade", clip: clip(), gain: 1.1 }),
  ])()
}
