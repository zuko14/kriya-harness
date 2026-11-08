// Anchors name content instead of a time (EDIT_ENGINE §5). The index arrives as
// plain rows, so Edit Core stays free of I/O; times are flicks in the asset.

const opened = new WeakMap()
const NONE = {}

/** Lookup tables over raw index rows, built once per index object. */
export function openIndex(raw = NONE) {
  if (opened.has(raw)) return opened.get(raw)
  const byId = (rows = []) => new Map(rows.map((row) => [row.id, row]))
  const words = new Map()
  for (const word of raw.words ?? []) words.set(word.asset, [...(words.get(word.asset) ?? []), word])
  for (const list of words.values()) list.sort((a, b) => a.start - b.start)
  const index = { raw, word: byId(raw.words), shot: byId(raw.shots), beat: byId(raw.beats), words }
  opened.set(raw, index)
  return index
}

/** Where a word, shot or beat anchor sits in its asset; null if the index doesn't know it. */
export function anchorSource(anchor, index, fallback = "start") {
  if (anchor.word !== undefined) {
    const word = index.word.get(anchor.word)
    return word ? { asset: word.asset, t: word[anchor.edge] } : null
  }
  if (anchor.shot !== undefined) {
    const shot = index.shot.get(anchor.shot)
    return shot ? { asset: shot.asset, t: shot[anchor.edge ?? fallback] } : null
  }
  if (anchor.beat !== undefined) {
    const beat = index.beat.get(anchor.beat)
    return beat ? { asset: beat.asset, t: beat.t } : null
  }
  return null
}

// The word whose body t falls strictly inside, by binary search
export function wordAt(words, t) {
  let low = 0
  let high = words.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (t <= words[middle].start) high = middle - 1
    else if (t >= words[middle].end) low = middle + 1
    else return words[middle]
  }
  return null
}

export const wordBefore = (words, t) => words.findLast((word) => word.end <= t) ?? null
export const wordAfter = (words, t) => words.find((word) => word.start >= t) ?? null

const normal = (text) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]+/gu, "")

/**
 * Old word id → new id after re-transcription, or null when nothing matches. Both
 * transcripts share the file's clock, so one pass over time replaces a full alignment.
 */
export function alignWords(before, after) {
  const mapping = {}
  const sorted = [...after].sort((a, b) => a.start - b.start)
  let from = 0
  for (const word of [...before].sort((a, b) => a.start - b.start)) {
    while (from < sorted.length && sorted[from].end <= word.start) from++
    let best = null
    let overlap = 0
    for (let i = from; i < sorted.length && sorted[i].start < word.end; i++) {
      const shared = Math.min(word.end, sorted[i].end) - Math.max(word.start, sorted[i].start)
      if (shared > overlap && normal(sorted[i].text) === normal(word.text)) {
        best = sorted[i]
        overlap = shared
      }
    }
    mapping[word.id] = best?.id ?? null
  }
  return mapping
}

/**
 * Rewrites word ids through a mapping. A word with no new id keeps its old one and
 * is listed: it is reported, never guessed.
 * @returns {{ project: object, unmapped: string[] }}
 */
export function remapAnchors(project, mapping) {
  const unmapped = new Set()
  const next = (id) => {
    if (Object.hasOwn(mapping, id) && mapping[id]) return mapping[id]
    unmapped.add(id)
    return id
  }
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== "object") return value
    const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    if (typeof copy.word === "string") copy.word = next(copy.word)
    if (copy.type === "caption") {
      copy.words = copy.words.map(next)
      copy.emphasis = copy.emphasis.map(next)
    }
    return copy
  }
  return { project: { ...project, sequences: walk(project.sequences) }, unmapped: [...unmapped].sort() }
}
