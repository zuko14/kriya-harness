// What the speech names that the footage doesn't show (DP4, DP6, EDD-52, EDD-57): one slot picks the
// lines where viewers would want to see a real place or thing and the hard terms worth defining;
// code places them, the server searches licensed sources, and the person approves each on the card.
// Search words leave the computer, so this runs only with editing.mediaSearch on.

import { paperEdit } from "../index/views.js"
import { phrasesOf } from "./beats.js"

const FLICKS = 705_600_000
const OPENING = 3 * FLICKS
const MIN = 2.5 * FLICKS
const MAX = 12 * FLICKS
const GAP = 1 * FLICKS
export const MAX_PICTURES = 8
export const MAX_TERMS = 4

const LOOKUPS_SCHEMA = {
  type: "object",
  properties: {
    pictures: { type: "array", maxItems: MAX_PICTURES, items: { type: "object", properties: { from: { type: "string", maxLength: 64 }, to: { type: "string", maxLength: 64 }, query: { type: "string", maxLength: 80 } }, required: ["from", "to", "query"], additionalProperties: false } },
    terms: { type: "array", maxItems: MAX_TERMS, items: { type: "object", properties: { at: { type: "string", maxLength: 64 }, term: { type: "string", maxLength: 60 } }, required: ["at", "term"], additionalProperties: false } },
  },
  required: ["pictures", "terms"],
  additionalProperties: false,
}

const SAID_OFF = /\b(?:no|without|skip|don't (?:want|add|use)|do not (?:want|add|use))\s+(?:any\s+|the\s+)?(?:images?|photos?|pictures?|footage from|stock|internet)\b/i

/** Where the person said no pictures. */
export const picturesRefused = (text) => SAID_OFF.test(text)

/** The id a term's definition is kept under. */
export const termId = (term) => `term:${lower(term)}`

const lower = (text) => String(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()

/**
 * A slot's picks, on phrase edges, clear of the scenes and each other; a term only where its words are said.
 * @returns {{ pictures: { from: string, to: string, query: string }[], terms: { at: string, term: string }[] }}
 */
export function arrangeLookups({ pictures = [], terms = [] }, { index, asset, scenes = [], cuts = [] }) {
  const words = (index.words ?? []).filter((w) => w.asset === asset)
  const position = new Map(words.map((w, i) => [w.id, i]))
  const phrases = phrasesOf(index, asset)
  const phraseAt = (i) => phrases.findIndex((p) => i >= p.first && i <= p.last)
  const trimmed = (w) => cuts.some((c) => (w.start + w.end) / 2 >= c.from * FLICKS && (w.start + w.end) / 2 < c.to * FLICKS)
  const taken = scenes.flatMap((s) => (position.has(s.from) && position.has(s.to) ? [{ start: words[position.get(s.from)].start, end: words[position.get(s.to)].end }] : []))
  const out = []
  const spans = pictures.map((p) => ({ p, i: phraseAt(position.get(p.from) ?? -1), k: phraseAt(position.get(p.to) ?? -1) })).filter(({ i, k }) => i >= 0 && k >= i).sort((a, b) => a.i - b.i)
  for (const { p, i, k: asked } of spans) {
    let k = asked
    while (k + 1 < phrases.length && phrases[k].end - phrases[i].start < MIN) k++
    const start = phrases[i].start
    const end = phrases[k].end
    const query = String(p.query ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 80)
    if (query.length < 2 || start - words[0].start < OPENING || end - start > MAX || end - start < MIN) continue
    if (words.some((w) => w.start >= start && w.end <= end && trimmed(w))) continue
    if ([...taken, ...out].some((t) => start < t.end + GAP && t.start < end + GAP)) continue
    out.push({ start, end, from: words[phrases[i].first].id, to: words[phrases[k].last].id, query })
  }
  const shown = new Set()
  const keptTerms = terms.flatMap((t) => {
    const at = position.get(t.at)
    const term = String(t.term ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 60)
    const said = lower(words.slice(Math.max(0, (at ?? 0) - 1), (at ?? 0) + 6).map((w) => w.text).join(" "))
    const key = lower(term)
    if (at === undefined || term.length < 3 || trimmed(words[at]) || shown.has(key) || !said.includes(key)) return []
    if ([...taken, ...out].some((s) => words[at].start >= s.start - GAP && words[at].start <= s.end + GAP)) return []
    shown.add(key)
    return [{ at: t.at, term }]
  })
  return { pictures: out.slice(0, MAX_PICTURES).map(({ from, to, query }) => ({ from, to, query })), terms: keptTerms.slice(0, MAX_TERMS) }
}

// Clinical photographs nobody asked to see in an explainer (found live: "human pancreas" gave a skull with lesions)
const GRAPHIC = /metasta|lesion|carcinoma|tumou?r|cancer|autops|cadaver|corpse|necro|gangren|wound|surgery|surgical|dissect|injur|blood ?stain|dead body|execution/i

/**
 * Search engines drift. A picture must be named for what was asked, the closest title first: every word
 * asked for, then the fewest others. The person still sees each one before anything is downloaded.
 */
export function rankPictures(query, items) {
  const wanted = lower(query).split(" ").filter((w) => w.length > 2)
  const main = [...wanted].sort((a, b) => b.length - a.length)[0]
  const score = (item) => {
    const title = lower(item.title.replace(/\.[a-z0-9]{3,4}$/i, ""))
    const hits = wanted.filter((w) => title.includes(w)).length
    return hits * 10 - title.split(" ").length
  }
  return items.filter((item) => !GRAPHIC.test(item.title) && (!main || lower(item.title).includes(main))).sort((a, b) => score(b) - score(a))
}

/**
 * @param {{ ask: Function, index: object, asset: string, text: string, scenes?: object[], cuts?: object[], search: (queries: string[]) => Promise<object[]>, define: (terms: string[]) => Promise<object[]>, wantTerms?: boolean, wantPictures?: boolean, signal?: AbortSignal }} input
 * @returns {Promise<{ pictures: object[], terms: object[], items: object[], definitions: object[] }>} items, definitions: everything found, for the Host to keep
 */
export async function planLookups({ ask, index, asset, text, scenes = [], cuts = [], search, define, wantTerms = true, wantPictures = true, signal }) {
  const none = { pictures: [], terms: [], items: [], definitions: [] }
  const sentences = (index.sentences ?? []).filter((s) => s.asset === asset)
  if (!sentences.length) return none
  const answer = await ask({
    task: "lookups",
    tier: "budget",
    schema: LOOKUPS_SCHEMA,
    view: paperEdit({ ...index, sentences, takes: [] }, { assets: [asset] }),
    request: [
      `The person says (their own words, trusted): ${JSON.stringify(String(text).slice(0, 800))}`,
      wantPictures ? `pictures: the moments where the speaker names a real place, building, object, animal or event the viewer would want to see and the footage doesn't show. \`from\` and \`to\` are word ids covering about 3 to 10 seconds; \`query\` is 2 to 6 English words naming that exact thing for an encyclopaedia image search. Never a private person, never a generic mood. Leave it empty if nothing is named.` : "pictures: leave empty.",
      wantTerms ? "terms: up to 4 hard technical terms a general viewer wouldn't know, exactly as spoken, with `at`, the id of the term's first word. Leave it empty if there are none." : "terms: leave empty.",
    ].join("\n"),
    maxOutput: 900,
    fallback: () => ({ pictures: [], terms: [] }),
    signal,
    priority: 0,
  })
  const arranged = arrangeLookups(answer.value, { index, asset, scenes, cuts })
  const results = arranged.pictures.length ? await search([...new Set(arranged.pictures.map((p) => p.query))].slice(0, 6)) : []
  const definitions = arranged.terms.length ? await define(arranged.terms.map((t) => t.term)) : []
  const byQuery = new Map(results.map((r) => [r.query, r.items ?? []]))
  const used = new Set()
  const pictures = arranged.pictures.flatMap((p) => {
    const items = rankPictures(p.query, byQuery.get(p.query) ?? []).filter((item) => !used.has(item.id))
    if (!items.length) return []
    used.add(items[0].id)
    return [{ ...p, id: items[0].id, options: items.slice(0, 4).map(({ id, title, licence, creator, kind }) => ({ id, title, licence, creator, kind })) }]
  })
  const byTerm = new Map(definitions.map((d) => [d.term, d]))
  const terms = arranged.terms.flatMap((t) => {
    const d = byTerm.get(t.term)
    return d ? [{ at: t.at, term: t.term, id: termId(t.term), quote: d.quote, source: d.source }] : []
  })
  return { pictures, terms, items: results.flatMap((r) => r.items ?? []), definitions }
}
