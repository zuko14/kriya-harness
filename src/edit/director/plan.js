// The Director's plan (2026-11-09): the person says what they want in their own words; the
// Director proposes the whole cut the way an editor pitches it (the opening, the pacing, the
// captions, the look, the music, the sound, the length) with the exact settings behind it.
// Nothing is made until the person approves; a change of mind revises the plan, and again
// nothing is made. Every setting is checked by code: ids must exist, values must be ones the
// engine renders, and a cold open must be a short stretch of one take.

import { FORMATS, GRADES } from "../recipes/reel.js"
import { MOODS } from "../engine/music-bed.js"
import { LOOKS } from "../engine/captions.js"
import { SFX } from "../engine/sfx.js"
import { paperEdit, shotDigest } from "../index/views.js"
import { planScenes, visualsIn } from "./beats.js"
import { picturesRefused, planLookups } from "./lookups.js"
import { applyPlaybook, footageFacts, GENRES, PLAYBOOKS, playbookPrompt } from "./playbooks.js"
import { timesIn } from "./revise.js"

const FLICKS = 705_600_000
// The highlight colours a plan may choose; hex stays in code
export const ACCENTS = { yellow: "#ffd23f", amber: "#ffb347", teal: "#4fd1c5", pink: "#ff7ab6", white: "#ffffff" }
const ID = { type: "string", maxLength: 64 }

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", maxLength: 900 },
    steps: { type: "array", maxItems: 10, items: { type: "string", maxLength: 240 } },
    settings: {
      type: "object",
      properties: {
        format: { type: "string", enum: Object.keys(FORMATS) },
        seconds: { type: "integer", minimum: 5, maximum: 600 },
        captions: { type: "string", enum: ["none", "clean", "karaoke", "boxed"] },
        grade: { type: "string", enum: ["natural", ...Object.keys(GRADES)] },
        music: { type: "string", enum: ["none", "reference", ...Object.keys(MOODS)] },
        cleanVoice: { type: "boolean" },
        hook: { anyOf: [{ type: "null" }, ID] },
        coldOpen: { anyOf: [{ type: "null" }, { type: "object", properties: { from: ID, to: ID, mono: { type: "boolean" } }, required: ["from", "to"], additionalProperties: false }] },
        cutSound: { type: "string", enum: ["none", "whoosh", "pop"] },
        introSound: { type: "string", enum: ["none", "riser", "hit"] },
        punches: { type: "integer", minimum: 0, maximum: 8 },
        angles: { type: "boolean" },
        broll: { type: "string", enum: ["none", "own"] },
        titles: { type: "boolean" },
        ramps: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  required: ["say", "steps", "settings"],
  additionalProperties: false,
}

/** What the plan's settings ask of a make job, as the make route takes them. */
export function briefOf(settings = {}) {
  return {
    ...(settings.format ? { format: settings.format } : {}),
    ...(settings.seconds ? { seconds: settings.seconds } : {}),
    ...(settings.captions && settings.captions !== "none" ? { captions: settings.captions } : {}),
    ...(settings.grade && settings.grade !== "natural" ? { grade: settings.grade } : {}),
    ...(settings.music && Object.hasOwn(MOODS, settings.music) ? { music: `generated:${settings.music}` } : {}),
    ...(settings.cleanVoice ? { cleanVoice: true } : {}),
    ...(settings.hook ? { hook: settings.hook } : {}),
    ...(settings.coldOpen ? { coldOpen: settings.coldOpen } : {}),
    ...(settings.cutSound && Object.hasOwn(SFX, settings.cutSound) ? { cutSound: settings.cutSound } : {}),
    ...(settings.introSound && Object.hasOwn(SFX, settings.introSound) ? { introSound: settings.introSound } : {}),
    ...(Number.isInteger(settings.punches) ? { punches: settings.punches } : {}),
    ...(settings.angles ? { angles: true } : {}),
    ...(settings.broll === "own" ? { broll: "own" } : {}),
    ...(settings.titles ? { titles: true } : {}),
    ...(settings.ramps ? { ramps: true } : {}),
    ...(Array.isArray(settings.cuts) && settings.cuts.length ? { cuts: mergeCuts(settings.cuts) } : {}),
    ...(typeof settings.song === "string" ? { music: settings.song } : {}),
    ...(settings.montage ? { montage: true } : {}),
    ...(settings.multicam ? { multicam: settings.multicam } : {}),
    ...(settings.captionStyle ? { captionStyle: settings.captionStyle } : {}),
    ...(settings.pictures?.length ? { pictures: settings.pictures.map(({ from, to, id }) => ({ from, to, id })) } : {}),
    ...(settings.terms?.length ? { terms: settings.terms.map(({ at, id, term }) => ({ at, id, term })) } : {}),
    ...(Number.isInteger(settings.soundEvery) && settings.soundEvery > 1 ? { soundEvery: settings.soundEvery } : {}),
    ...(Array.isArray(settings.scenes) && settings.scenes.length ? { scenes: settings.scenes, sceneSound: settings.sceneSound !== false } : {}),
  }
}

// The frame the person asked for in their own words. Code decides it, not the model: found in
// use, a plan approved for 16:9 left `format` out and the make fell back to 9:16.
const RATIO = (a, b) => new RegExp(`\\b${a}\\s*(?::|x|×|/|by|to)\\s*${b}\\b`, "gi")
const FORMAT_CUES = [
  ["16:9", RATIO(16, 9), 2],
  ["9:16", RATIO(9, 16), 2],
  ["1:1", RATIO(1, 1), 2],
  ["4:5", RATIO(4, 5), 2],
  ["16:9", /\b(?:landscape|horizontal|wide ?screen|youtube(?! ?shorts?))\b/gi, 1],
  ["9:16", /\b(?:vertical|portrait|reels?|shorts|tiktok|stories)\b/gi, 1],
  ["1:1", /\bsquare\b/gi, 1],
]
// "not 9:16", "instead of a reel", "from 9:16 to 16:9", "but it made 9:16": a mention turned away from
const AWAY = /(?:\bnot|\bno|\bisn't|\bwasn't|instead of|rather than|\bthan|\bfrom|\bmade(?: it| me)?|\bgave(?: me)?|came out|turned out|\bcurrently|\bbut it's|output (?:is|was))\s+(?:(?:a|an|the|in|at|as|like)\s+)?$/i

/** The format one message asks for: a ratio beats a word ("a reel in 16:9"), the last mention wins; null if none. */
export function formatIn(text) {
  const said = String(text ?? "")
  let best = null
  for (const [format, cue, strength] of FORMAT_CUES) {
    for (const m of said.matchAll(cue)) {
      if (AWAY.test(said.slice(Math.max(0, m.index - 24), m.index))) continue
      if (!best || strength > best.strength || (strength === best.strength && m.index > best.at)) best = { format, strength, at: m.index }
    }
  }
  return best?.format ?? null
}

/** The format the person wants: this message, then their earlier messages (latest first), then the plan being revised. */
export function formatAsked(text, history = [], previous = null) {
  for (const said of [text, ...history.filter((h) => h.who === "you").map((h) => h.text).reverse()]) {
    const format = formatIn(said)
    if (format) return format
  }
  return Object.hasOwn(FORMATS, previous?.settings?.format ?? "") ? previous.settings.format : null
}

// What words ask for, as plan settings. Used twice: the person's own words decide (trusted);
// the Director's pitch must be matched by its settings, and code fills what it left out.
// shortcut: English keywords; a pitch in another language is checked only by its settings
const SAID = [
  ["captions", /\bno (?:captions?|subtitles?)\b/i, "none"],
  ["captions", /\bkaraoke\b/i, "karaoke"],
  ["captions", /\bboxed\b/i, "boxed"],
  ["captions", /\b(?:captions?|subtitles?)\b/i, "clean"],
  ["grade", /\bcinematic\b|\bcool(?:er)?[- ](?:tone|look|grade)/i, "cinematic"],
  ["grade", /\bwarm(?:er)? (?:grade|look|tone|colou?r)/i, "warm"],
  ["grade", /\bvivid\b/i, "vivid"],
  ["grade", /\bbright(?:er)? (?:grade|look)\b/i, "bright"],
  ["music", /\bno music\b/i, "none"],
  ["music", /\bupbeat\b[^.]{0,24}\bmusic|\bmusic\b[^.]{0,16}\bupbeat/i, "upbeat"],
  ["music", /\bwarm\b[^.]{0,24}\bmusic|\bmusic\b[^.]{0,16}\bwarm/i, "warm"],
  ["music", /\b(?:calm|soft|gentle|low)\b[^.]{0,24}\bmusic|\bmusic\b/i, "calm"],
  ["cleanVoice", /\bnoise\b|\bdenois|\bclean (?:up )?(?:the |my |your )?(?:voice|audio)/i, true],
  ["cutSound", /\bwhoosh/i, "whoosh"],
  ["cutSound", /\bpops? on\b/i, "pop"],
  ["cutSound", /sound ?eff?ect|\bsfx\b|sound design/i, "whoosh"], // typed fast: "bestsound effectes"
  ["introSound", /\briser\b/i, "riser"],
  ["introSound", /\b(?:bass |impact )?hit into\b/i, "hit"],
  ["titles", /\btitle cards?\b/i, true],
  ["angles", /\bangles\b|\bwide (?:and|then) tight\b/i, true],
  ["broll", /\bb-?roll\b/i, "own"],
  ["ramps", /\b(?:speed )?ramp/i, true],
  ["coldOpen", /\bcold open|\bopen(?:s|ing)? cold\b/i, true],
]
const NO = /(?:\bno|\bnot|\bwithout|\bdon't|\bdo not|\bskip)\s+(?:any\s+|the\s+|a\s+)?$/i

/** Plan settings the words ask for; a later mention of the same setting wins, "no X" turns X off. */
export function settingsIn(text) {
  const said = String(text ?? "")
  const out = {}
  const done = new Set()
  for (const [key, cue, value] of SAID) {
    if (done.has(key)) continue
    const m = cue.exec(said)
    if (!m) continue
    done.add(key)
    const away = NO.test(said.slice(Math.max(0, m.index - 16), m.index))
    out[key] = away ? (typeof value === "boolean" ? false : key === "broll" ? "none" : "none") : value
  }
  const punches = /\bpunch(?:[- ]?ins?|ing in)?\b[^.]{0,24}?\b(\d)\b/i.exec(said) ?? /\b(\d)\s*(?:-|to)?\s*\d?\s*(?:key )?(?:words|punch)/i.exec(said)
  if (punches) out.punches = Math.min(8, Number(punches[1]))
  // The last length that could be a cut's ("about 4 seconds" of a cold open isn't)
  const lengths = [...said.matchAll(/\b(?:at|to|under|max(?:imum)?|about|around|of|after(?: the)?|upto|up to|only)\s+(\d{1,3})\s*(?:s|secs?|seconds?)\b|\b(\d{1,3})\s*(?:s|secs?|seconds?)\s+(?:max|long|video|reel|cut|only)\b/gi)].map((m) => Number(m[1] ?? m[2])).filter((n) => n >= 8 && n <= 600)
  if (lengths.length) out.seconds = lengths.at(-1)
  const format = formatIn(said)
  if (format) out.format = format
  return out
}

// Trims in the person's words, per clause so "a whoosh on every cut" never trims anything.
// "trim it to 0:05–0:20" and "keep 0:05 to 0:20" keep that stretch; "remove/cut/delete 0:05 to
// 0:09", "everything after 25 seconds", "the first 3 seconds" take it out. Times are the raw take's.
const REMOVE = /\b(?:remove|delete|drop|erase|skip|chop|get rid of|take out|trim (?:out|off|away)|cut (?:out|off|away|from|the|it|this|that|everything|anything|all|after|before|till|until|up ?to|[0-9]))/i
const KEEP = /\b(?:keep|only use|use only|trim (?:it |the video |this |the clip )?(?:to|from|down to|between))\b/i

/** The stretches of the take the person wants out, in seconds, merged and in order. */
export function trimsIn(text, duration) {
  const end = duration / FLICKS
  const cuts = []
  for (const clause of String(text ?? "").split(/(?:[;!?\n]|\.(?!\d))+/)) { // "14.6 seconds" stays whole
    const ranges = timesIn(clause, { duration }).filter((r) => r.to !== undefined && r.to > r.at).map((r) => ({ from: r.at / FLICKS, to: Math.min(end, r.to / FLICKS) })).filter((r) => r.from < end)
    if (!ranges.length) continue
    if (KEEP.test(clause) && !REMOVE.test(clause)) {
      let at = 0
      for (const r of [...ranges].sort((a, b) => a.from - b.from)) (r.from > at && cuts.push({ from: at, to: r.from }), (at = Math.max(at, r.to)))
      if (at < end) cuts.push({ from: at, to: end })
    } else if (REMOVE.test(clause)) cuts.push(...ranges)
  }
  return mergeCuts(cuts, end)
}

/** In order, overlaps joined, inside the take, to the hundredth of a second. At most eight. */
export function mergeCuts(cuts, end = Infinity) {
  const out = []
  for (const c of cuts.filter((c) => Number.isFinite(c.from) && Number.isFinite(c.to)).map((c) => ({ from: Math.max(0, c.from), to: Math.min(end, c.to) })).filter((c) => c.to - c.from >= 0.05).sort((a, b) => a.from - b.from)) {
    const last = out.at(-1)
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to)
    else out.push({ ...c })
  }
  return out.slice(0, 8).map((c) => ({ from: Math.round(c.from * 100) / 100, to: Math.round(c.to * 100) / 100 }))
}

const OFF = { captions: "none", grade: "natural", music: "none", cutSound: "none", introSound: "none", broll: "none" }
const unset = (settings, key) => settings[key] === undefined || settings[key] === null || settings[key] === false || settings[key] === OFF[key]

/** What the pitch says that the settings don't make: the Director is sent back once with these. */
export function pitchGaps(plan) {
  const promised = settingsIn([plan.say, ...(plan.steps ?? [])].join("\n"))
  const settings = plan.settings ?? {}
  return Object.entries(promised)
    .filter(([key, value]) => key !== "format" && value !== false && value !== "none" && (key === "coldOpen" ? !settings.coldOpen : unset(settings, key)))
    .map(([key, value]) => (key === "coldOpen" ? "your pitch promises a cold open but settings.coldOpen is empty: give its first and last word ids" : `your pitch promises ${key} ${JSON.stringify(value)} but settings.${key} doesn't make it`))
}

/**
 * A cold open chosen by code when the pitch promised one and the model gave no ids: 3 to 5
 * seconds of clean speech from the middle of the main take, ending on a sentence end when one is near.
 */
export function pickColdOpen(index, asset, cuts = []) {
  const out = (w) => cuts.some((c) => (w.start + w.end) / 2 >= c.from * FLICKS && (w.start + w.end) / 2 < c.to * FLICKS)
  const words = (index.words ?? []).filter((w) => w.asset === asset && !out(w))
  if (words.length < 4) return null
  const span = words.at(-1).end - words[0].start
  let i = words.findIndex((w) => w.start >= words[0].start + span * 0.4)
  if (i < 0) return null
  while (i < words.length && words[i].flags?.some((f) => f === "filler" || f === "stutter")) i++
  let end = null
  for (let j = i; j < words.length; j++) {
    const length = words[j].end - words[i].start
    if (length > 6 * FLICKS) break
    if (length >= 3 * FLICKS && (end === null || /[.!?]$/.test(words[j].text))) end = j
    if (end !== null && /[.!?]$/.test(words[end].text)) break
  }
  return end === null ? null : { from: words[i].id, to: words[end].id, mono: true }
}

/** Problems with a plan's settings against this project: unknown ids, a cold open that isn't one short stretch. */
export function planProblems(settings, index) {
  const problems = []
  const words = new Map((index.words ?? []).map((w) => [w.id, w]))
  if (settings.hook && !(index.sentences ?? []).some((s) => s.id === settings.hook)) problems.push(`hook "${settings.hook}" isn't a sentence id from the paper edit`)
  if (settings.coldOpen) {
    const from = words.get(settings.coldOpen.from)
    const to = words.get(settings.coldOpen.to)
    if (!from || !to) problems.push("the cold open must name two word ids from the paper edit")
    else if (from.asset !== to.asset || to.end <= from.start) problems.push("a cold open runs forward within one take: its first word, then its last")
    else if (to.end - from.start > 8 * FLICKS) problems.push("a cold open is short: 8 seconds at most")
  }
  return problems
}

/**
 * @param {{ ask: Function, project: object, index: object, text: string, history?: object[], previous?: object, references?: { name: string, lines: string[] }[], choices?: object, visuals?: boolean, playbooks?: boolean, signal?: AbortSignal }} input
 *   visuals, playbooks: the server's editing.visuals and editing.playbooks; off, this plan is what it always was
 *   lookups: { search, define, keep } with editing.mediaSearch on; null, no search word leaves the computer
 * @returns {Promise<{ say: string, steps: string[], settings: object, source: string, reason?: string }>}
 */
export async function planCut({ ask, project, index, text, history = [], previous = null, references = [], choices = {}, visuals = false, playbooks = false, lookups = null, signal }) {
  const assets = project.assets.filter((a) => a.kind === "video" || a.kind === "audio").map((a) => a.id)
  const refs = references.length ? `References the person added, measured by code:\n${references.map((r) => `- ${r.name}: ${r.lines.join("; ")}`).join("\n")}` : "No references added."
  const view = [paperEdit(index, { assets }), shotDigest(index, { assets }), refs, `The person's current choices in the Studio: ${JSON.stringify(choices)}`].join("\n\n")
  const asked = formatAsked(text, history, previous)
  // Trims are the person's, read by code from their words (this message and earlier ones) and kept through revisions
  const take = project.assets.find((a) => a.kind === "video" && (index.words ?? []).some((w) => w.asset === a.id)) ?? project.assets.find((a) => a.kind === "video")
  const length = take?.facts?.duration ?? Math.max(0, ...(index.words ?? []).filter((w) => w.asset === take?.id).map((w) => w.end))
  const kept = Array.isArray(previous?.settings?.cuts) ? previous.settings.cuts.filter((c) => c && Number.isFinite(c.from) && Number.isFinite(c.to)) : []
  const cuts = take ? mergeCuts([...kept, ...[...history.filter((h) => h.who === "you").map((h) => h.text), text].flatMap((said) => trimsIn(said, length))], length / FLICKS) : []
  const at = (n) => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, "0")}`
  // The scenes first, so the pitch can speak for them; each is checked by code, and the person swaps them on the card
  const planned = visuals && take ? await planScenes({ ask, index, asset: take.id, text, history, previous, cuts, signal }) : null
  const scenes = planned?.scenes ?? []
  const { scenes: _shownOnTheCard, ...previousSettings } = previous?.settings ?? {}
  const earlier = history.length ? `Earlier in this chat:\n${history.map((h) => `${h.who === "you" ? "Person" : "Kriya"}: ${JSON.stringify(h.text)}`).join("\n")}\n\n` : ""
  const request = [
    `${earlier}The person says (their own words, trusted): ${JSON.stringify(String(text).slice(0, 2000))}`,
    cuts.length ? `The person asked to trim ${cuts.map((c) => `${at(c.from)} to ${at(c.to)}`).join(", ")} of the take (${take.id}); code cuts exactly that, between words. Plan around it: no hook or cold open inside a trimmed stretch, and say the trim in your pitch.` : "",
    asked ? `The person wants the ${asked} format: settings.format is "${asked}", and your pitch says ${asked}.` : "",
    previous ? `Your previous plan, which they want changed: ${JSON.stringify(previous.settings ? { ...previous, settings: previousSettings } : previous).slice(0, 3000)}. Revise it by what they say now; keep what they didn't ask to change.` : "",
    scenes.length ? `Animated explainer scenes that take over the frame while the voice keeps playing are already planned on these lines: ${scenes.map((s) => `${s.from} (${s.kind}: ${s.title || s.items[0].text})`).join("; ")}. Say so in one sentence of your pitch. They're code-drawn from the speaker's words, so promise no others, and don't choose a hook or cold open on those lines.` : "",
    ...(playbooks ? playbookPrompt(footageFacts(project, index, take)) : []),
    "You are the Director: plan the whole cut the way a top editor pitches it. Decide the opening (a hook sentence first, or a cold open: one strong later moment of 2 to 6 seconds played first, in black and white, before the story starts), the pacing (punch-ins), captions, the colour look, music, sound design (a sound on each cut, a riser into the story after a cold open), whether to clean background noise from the voice, the format and the length. You can also cut one camera like two (angles: wide then tight on alternate clips), lay the person's other clips over the story as B-roll (broll 'own', only if the project has other video), pop key words on screen as title cards (titles, when there are no captions), and ramp the speed out of a cold open into the story (ramps). Follow the references where they say something. Don't promise what these settings can't do: no stock footage or generated video.",
    "Answer with JSON only: `say` is your pitch in 2 to 4 plain sentences, `steps` the concrete things you'll do, and `settings` exactly what will be made: every promise in the pitch has its setting (captions, grade, music, cleanVoice, cutSound, introSound, punches, seconds, coldOpen), because only the settings are made. Use sentence ids for `hook` and word ids for `coldOpen`, only from the paper edit. Music 'reference' means follow the music reference.",
  ].filter(Boolean).join("\n")
  // Only real faults go back to the model: a second refusal throws the whole plan away for the
  // fallback, so what the pitch promised and the settings left out is filled by code below instead
  const check = ({ settings }) => planProblems(settings ?? {}, index)
  const fallback = () => ({
    say: "I couldn't reach the Director's model, so here's a plan from your current choices: the best takes, fillers out, and your settings as they are.",
    steps: ["Keep each line's best take and cut fillers and restarts", "Use the format, length, captions, look and music you've chosen"],
    settings: { format: choices.format ?? "9:16", ...(choices.seconds ? { seconds: choices.seconds } : {}), captions: choices.captions ?? "none", grade: choices.grade ?? "natural", music: (choices.music ?? "").replace(/^generated:/, "") || "none", cleanVoice: !!choices.cleanVoice },
  })
  // With playbooks the answer also names the genre; off, the schema is the same object as before
  const schema = playbooks ? { ...PLAN_SCHEMA, properties: { ...PLAN_SCHEMA.properties, genre: { type: "string", enum: GENRES }, settings: { ...PLAN_SCHEMA.properties.settings, properties: { ...PLAN_SCHEMA.properties.settings.properties, captions: { type: "string", enum: ["none", ...Object.keys(LOOKS)] }, accent: { type: "string", enum: Object.keys(ACCENTS) }, song: { type: "string", maxLength: 64 } } } }, required: [...PLAN_SCHEMA.required, "genre"] } : PLAN_SCHEMA
  const answer = await ask({ task: "plan", tier: "budget", schema, view, request, maxOutput: 2500, check, fallback, signal, priority: 0 })
  const clean = (value) => String(value ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim()
  // The frame is always set, and set by what the person said, never left to a default
  // The fallback plan keeps the person's choices: no model read the speech, so no genre was found
  const genre = playbooks && answer.source !== "default" && Object.hasOwn(PLAYBOOKS, answer.value.genre ?? "") ? answer.value.genre : null
  const settings = genre ? applyPlaybook(answer.value.settings ?? {}, genre, length / FLICKS) : { ...(answer.value.settings ?? {}) }
  if (genre) settings.genre = genre
  settings.format = asked ?? (Object.hasOwn(FORMATS, settings.format ?? "") ? settings.format : Object.hasOwn(FORMATS, choices.format ?? "") ? choices.format : "9:16")
  // What the pitch promised and the settings left out, code fills; what the person said, code
  // sets. So the approved brief makes what the card says, not just the format
  // Only a model's pitch promises anything: the fallback's own sentence names captions and music without asking for them
  const promised = answer.source === "default" ? {} : settingsIn([answer.value.say, ...(answer.value.steps ?? [])].join("\n"))
  for (const [key, value] of Object.entries(promised)) if (key !== "format" && key !== "coldOpen" && value !== false && unset(settings, key)) settings[key] = value
  const person = [...history.filter((h) => h.who === "you").map((h) => h.text), text].map(settingsIn).reduce((all, one) => ({ ...all, ...one }), {})
  for (const [key, value] of Object.entries(person)) {
    if (key === "format") continue
    if (key === "coldOpen") value ? (promised.coldOpen = true) : (settings.coldOpen = null)
    else settings[key] = value
  }
  if (cuts.length) settings.cuts = cuts
  else delete settings.cuts
  if (promised.coldOpen && !settings.coldOpen && take) settings.coldOpen = pickColdOpen(index, take.id, cuts)
  if (settings.coldOpen && planProblems({ coldOpen: settings.coldOpen }, index).length) settings.coldOpen = null
  // Said plainly when a promise can't be kept, so the card never pitches what won't be made
  const steps = (answer.value.steps ?? []).map((s) => clean(s).slice(0, 240)).filter(Boolean)
  if (promised.coldOpen && !settings.coldOpen) steps.push("No cold open: the footage has no clean 3-second stretch in its middle to open on.")
  // The genre decides what the plan may reach for; the person's asking outranks it
  const book = genre ? PLAYBOOKS[genre] : null
  const sceneList = book && !book.scenes && !visualsIn(text) ? [] : scenes
  if (genre) {
    const songs = project.assets.filter((a) => a.kind === "audio" && !/kriya-(?:music|sfx)-/.test(a.path ?? ""))
    const wanted = songs.find((a) => a.id === answer.value.settings?.song) ?? (/\b(?:my|this|the) (?:song|track|audio file)\b/i.test(text) || genre === "montage" ? songs[0] : null)
    if (wanted && person.music !== "none") {
      settings.song = wanted.id
      delete settings.music
    } else delete settings.song
    if (genre === "montage" && settings.song && project.assets.some((a) => a.kind === "video")) settings.montage = true
    // Two or more cameras of a conversation: the switcher decides who's on screen
    const cameras = project.assets.filter((a) => a.kind === "video")
    if (genre === "podcast" && cameras.length >= 2 && take) settings.multicam = { master: take.id, angles: cameras.slice(0, 6).map((a, speaker) => ({ asset: a.id, speaker })) }
    if (Object.hasOwn(ACCENTS, answer.value.settings?.accent ?? "")) settings.captionStyle = { accent: ACCENTS[answer.value.settings.accent] }
    delete settings.accent
  }
  // Licensed pictures and cited definitions, only with their switch on and a search to ask
  if (lookups && take && !picturesRefused(text)) {
    const found = await planLookups({ ask, index, asset: take.id, text, scenes: sceneList, cuts, search: lookups.search, define: lookups.define, wantPictures: !book || book.scenes || genre === "documentary", wantTerms: true, signal })
    lookups.keep(found)
    if (found.pictures.length) {
      settings.pictures = found.pictures
      steps.push(`Show ${found.pictures.length} real picture${found.pictures.length === 1 ? "" : "s"} of what's named, from openly licensed sources, credited. You can swap or remove each below; nothing downloads until you approve.`)
    }
    if (found.terms.length) {
      settings.terms = found.terms
      steps.push(`Define ${found.terms.map((t) => `"${t.term}"`).join(", ")} on screen, quoted from ${[...new Set(found.terms.map((t) => t.source))].join(", ")}.`)
    }
  }
  if (sceneList.length) {
    settings.scenes = sceneList
    // A sound as each scene arrives, unless the person said no sound effects
    settings.sceneSound = person.cutSound !== "none"
    steps.push(`Cut away to ${sceneList.length} animated scene${sceneList.length === 1 ? "" : "s"} while the voice keeps playing. You can swap or remove each one below.`)
  } else if (planned && planned.source !== "person") {
    const why = planned.dropped[0]?.reason
    if (visualsIn(text)) steps.push(`No animated scene this time${why ? `: ${why}` : ": nothing in the speech can be drawn from the speaker's own words"}.`)
    delete settings.scenes
  }
  return { say: clean(answer.value.say).slice(0, 900), steps: steps.slice(0, 13), settings, source: answer.source, ...(genre ? { genreLabel: PLAYBOOKS[genre].label } : {}), ...(answer.reason ? { reason: answer.reason } : {}) }
}
