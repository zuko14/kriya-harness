// L5 Delivery (PERCEPTION §4): sentences, fillers, stutters, restarts, and take groups
// with a best take. Code flags only what it's sure of; the Director's take slot decides
// the rest. Thresholds are EX-11's starting points, to be tuned on real labelled clips.

export const RETAKES_VERSION = "l5-1"

const MS = 705_600
export const SENTENCE_GAP = 700 * MS // a pause this long ends a sentence without punctuation
export const FILLER_PAUSE = 150 * MS // a soft filler is cut only with a pause on both sides
export const SIMILAR = 0.65 // Jaccard on word trigrams (PERCEPTION §4)
export const LOW_CONFIDENCE = 0.5

// Sounds that are never words, and words that are fillers only when set apart by pauses
const HESITATIONS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "mm", "ah", "eh"])
const SOFT_FILLERS = { en: ["like", "basically", "actually", "so", "right", "literally"], hi: ["matlab", "basically", "yaani"], te: ["ante", "basically"] }
const RESTARTS = ["let me try that again", "let me start again", "let me start over", "let me redo that", "one more time", "okay again", "ok again", "start over", "take two", "sorry let me", "ek minute", "phir se", "malli", "inkosari"]

const bare = (text) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, "").trim()
const ends = (text) => /[.!?।]["')\]]*$/.test(text)

function trigrams(words) {
  const tokens = words.map((word) => bare(word.text)).filter(Boolean)
  if (tokens.length < 3) return new Set(tokens.length ? [tokens.join(" ")] : [])
  return new Set(tokens.slice(2).map((_, i) => tokens.slice(i, i + 3).join(" ")))
}

const jaccard = (a, b) => {
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  return a.size + b.size === shared ? 0 : shared / (a.size + b.size - shared)
}

/** Is the shorter run a word-for-word start of the longer? A cut-off attempt is. */
function prefixOf(short, long) {
  const a = short.map((word) => bare(word.text)).filter(Boolean)
  const b = long.map((word) => bare(word.text)).filter(Boolean)
  return a.length >= 3 && a.length < b.length && a.every((token, i) => token === b[i])
}

/**
 * "4.5" heard as "5" then ".5" (found in use: "Opus 4.5"): the same digits after punctuation are
 * one number split in two, not a stutter, and cutting the first half cuts inside the word (QG-05).
 */
export const decimalSplit = (word, next) => /^\d+$/.test(bare(word.text)) && /^[.,:]\d/.test(String(next?.text ?? "").trim())

/** Word flags: filler, stutter, low_confidence. Times decide a soft filler, not the word alone. */
export function flagWords(words, language = "en") {
  const soft = new Set(SOFT_FILLERS[language.split("-")[0]] ?? SOFT_FILLERS.en)
  return words.map((word, i) => {
    const flags = []
    const token = bare(word.text)
    const before = i === 0 ? Infinity : word.start - words[i - 1].end
    const after = i === words.length - 1 ? Infinity : words[i + 1].start - word.end
    // Punctuation marks a pause the recogniser heard, even with tight times
    const setApart = (before >= FILLER_PAUSE || ends(words[i - 1]?.text ?? ".") || /,$/.test(words[i - 1]?.text ?? "")) && (after >= FILLER_PAUSE || /[,.!?]$/.test(word.text))
    if (HESITATIONS.has(token) || (soft.has(token) && setApart)) flags.push("filler")
    const next = words[i + 1]
    if (next && token && !decimalSplit(word, next) && (bare(next.text) === token || (word.text.endsWith("-") && bare(next.text).startsWith(token)))) flags.push("stutter")
    if (typeof word.conf === "number" && word.conf < LOW_CONFIDENCE) flags.push("low_confidence")
    return flags
  })
}

/** Sentences: punctuation, or a long pause. @returns {{ first: number, last: number }[]} word positions */
export function sentencesOf(words) {
  const sentences = []
  let first = 0
  words.forEach((word, i) => {
    const next = words[i + 1]
    if (!next || ends(word.text) || next.start - word.end >= SENTENCE_GAP) {
      sentences.push({ first, last: i })
      first = i + 1
    }
  })
  return sentences
}

const isRestart = (words) => {
  const text = ` ${words.map((word) => bare(word.text)).join(" ")} `
  return RESTARTS.some((phrase) => text.includes(` ${phrase} `))
}

/**
 * The whole layer, on plain words with times in flicks.
 * @returns {{ flags: string[][], sentences: { first: number, last: number, start: number, end: number, group: number | null, score: number }[], takes: { group: number, sentence: number, rank: number, signals: object }[] }}
 */
export function analyseDelivery(words, { language = "en" } = {}) {
  const flags = flagWords(words, language)
  const sentences = sentencesOf(words).map((s) => ({ ...s, start: words[s.first].start, end: words[s.last].end, group: null, score: 0 }))
  const span = (s) => words.slice(s.first, s.last + 1)
  // Attempts are compared on what was meant: fillers would break the trigrams
  const content = (s) => span(s).filter((_, k) => !flags[s.first + k].includes("filler"))

  // A restart phrase belongs to no take; it marks the attempt before it as one
  const restart = sentences.map((s) => isRestart(span(s)))
  for (const [i, s] of sentences.entries()) if (restart[i]) for (let w = s.first; w <= s.last; w++) flags[w].push("restart")

  // Neighbouring attempts at one line, skipping restart phrases between them
  let groups = 0
  let previous = null
  for (const [i, s] of sentences.entries()) {
    if (restart[i]) continue
    if (previous !== null) {
      const a = content(sentences[previous])
      const b = content(s)
      const similar = jaccard(trigrams(a), trigrams(b)) >= SIMILAR || prefixOf(a, b) || prefixOf(b, a)
      const marked = sentences.slice(previous + 1, i).some((_, k) => restart[previous + 1 + k])
      if (similar || (marked && jaccard(trigrams(a.slice(0, 3)), trigrams(b.slice(0, 3))) > 0)) {
        sentences[previous].group ??= groups++
        s.group = sentences[previous].group
      }
    }
    previous = i
  }

  const takes = []
  for (let group = 0; group < groups; group++) {
    const members = sentences.map((s, i) => ({ s, i })).filter(({ s }) => s.group === group)
    const longest = Math.max(...members.map(({ s }) => content(s).length))
    for (const [order, { s, i }] of members.entries()) {
      const own = span(s)
      const fillers = own.filter((_, k) => flags[s.first + k].some((flag) => flag === "filler" || flag === "stutter")).length
      const complete = ends(own.at(-1).text) && content(s).length >= longest * 0.8 && !members.slice(order + 1).some(({ s: later }) => prefixOf(own, span(later)))
      const followedByRestart = restart[i + 1] === true
      const signals = { fluency: Math.round((1 - fillers / own.length) * 100) / 100, complete, followedByRestart, last: order === members.length - 1 }
      // The last clean take usually wins (PERCEPTION §4)
      s.score = Math.round((signals.fluency + (complete ? 1 : 0) - (followedByRestart ? 1 : 0) + (signals.last ? 0.1 : 0)) * 100) / 100
      takes.push({ group, sentence: i, rank: 0, signals })
    }
    const ranked = takes.filter((t) => t.group === group).sort((a, b) => sentences[b.sentence].score - sentences[a.sentence].score || b.sentence - a.sentence)
    ranked.forEach((take, rank) => (take.rank = rank + 1))
  }
  // An attempt abandoned for a different line is still a bad take
  sentences.forEach((s, i) => {
    if (s.group === null) s.score = restart[i] || restart[i + 1] ? 0 : 1
  })
  return { flags, sentences, takes }
}
