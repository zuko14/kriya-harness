// Operations (EDIT_ENGINE §4): the only way anything changes. Each is validated
// for shape, then for meaning, and a batch applies whole or not at all. Undo needs
// no inverse per operation: history moves HEAD and replays (history.js).

import { anchorSource, openIndex, wordAfter, wordAt, wordBefore } from "./anchors.js"
import { check, EFFECTS, SHAPES, validateProject } from "./project.js"

class Refused extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const refuse = (code, message) => {
  throw new Refused(code, message)
}

const ROLE_ORDER = ["base", "broll", "matte", "overlay", "caption", "dialogue", "sfx", "music", "ambience"]
const SEQUENCED = ["video", "audio", "image"]
const PICTURE = ["video", "image"]
const ONE = { n: 1, d: 1 }
const SPAN = { "until?": "ref", "duration?": "flicks" }

const sequenceOf = (s) => s.project.sequences.find((q) => q.id === s.project.active)
const trackOf = (s, clip) => sequenceOf(s).tracks.find((t) => t.id === clip.track)
const isBase = (s, clip) => trackOf(s, clip).role === "base"
const newId = (s, prefix) => `${prefix}${s.project.nextId++}`

function ensureTrack(s, role) {
  const sequence = sequenceOf(s)
  let track = sequence.tracks.find((t) => t.role === role)
  if (!track) {
    track = { id: `t-${role}`, role, order: ROLE_ORDER.indexOf(role), muted: false, locked: false }
    sequence.tracks.push(track)
  }
  if (track.locked) refuse("track_locked", `the ${role} track is locked, so nothing can change on it`)
  return track
}

function clipOf(s, id) {
  const clip = sequenceOf(s).clips.find((c) => c.id === id)
  if (!clip) refuse("unknown_clip", `there is no clip "${id}" in this sequence`)
  return clip
}

function writable(s, id) {
  const clip = clipOf(s, id)
  if (trackOf(s, clip).locked) refuse("track_locked", `clip "${id}" is on a locked track, so it can't change`)
  return clip
}

function assetOf(s, id, kinds) {
  const asset = s.project.assets.find((a) => a.id === id)
  if (!asset) refuse("unknown_asset", `there is no asset "${id}" in this project`)
  if (kinds && !kinds.includes(asset.kind)) refuse("wrong_asset_kind", `asset "${id}" is ${asset.kind}; this needs ${kinds.join(" or ")}`)
  return asset
}

// Every anchor must point at something real before it enters the project
function known(s, ref) {
  if (typeof ref === "number") return
  if (ref.word !== undefined && !s.index.word.has(ref.word)) refuse("unknown_word", `word "${ref.word}" isn't in the transcript`)
  if (ref.shot !== undefined && !s.index.shot.has(ref.shot)) refuse("unknown_shot", `shot "${ref.shot}" isn't in the index`)
  if (ref.beat !== undefined && !s.index.beat.has(ref.beat)) refuse("unknown_beat", `beat "${ref.beat}" isn't in the index`)
  if (ref.marker !== undefined && !sequenceOf(s).markers.some((m) => m.name === ref.marker || m.id === ref.marker)) refuse("unknown_marker", `there is no marker "${ref.marker}"`)
  if (ref.clip !== undefined) clipOf(s, ref.clip)
}

/** A reference as a time inside an asset. */
function sourceEdge(s, ref, asset, edge) {
  if (typeof ref === "number") return ref
  known(s, ref)
  const place = anchorSource(ref, s.index, edge)
  if (!place) refuse("not_a_source_time", "this needs a word, a shot or a time inside the asset")
  if (place.asset !== asset) refuse("wrong_asset", `that anchor is in asset "${place.asset}", not "${asset}"`)
  return place.t
}

const clipRange = (s, clip) => [sourceEdge(s, clip.source.in, clip.source.asset, "start"), sourceEdge(s, clip.source.out, clip.source.asset, "end")]

function checkRange(s, asset, from, to) {
  if (to <= from) refuse("range_inverted", "the range ends before it starts; give the earlier point first")
  if (from < 0 || (asset.facts.duration !== undefined && to > asset.facts.duration)) refuse("longer_than_source", `that range runs past the end of asset "${asset.id}"`)
}

function anchorAsset(s, op, fallback) {
  if (op.asset) return op.asset
  for (const ref of [op.from, op.to]) {
    if (typeof ref === "object") {
      known(s, ref)
      const place = anchorSource(ref, s.index)
      if (place) return place.asset
    }
  }
  if (fallback) return fallback
  refuse("needs_asset", "a range given as plain times needs an asset")
}

function addClip(s, role, fields) {
  const clip = { id: newId(s, "c"), track: ensureTrack(s, role).id, source: null, at: null, effects: [], speed: ONE, createdBy: s.author, ...fields }
  sequenceOf(s).clips.push(clip)
  return clip
}

function span(s, op) {
  if (op.until === undefined && op.duration === undefined) refuse("needs_duration", "say how long it lasts, with duration or until")
  if (op.until !== undefined) known(s, op.until)
  return op.until !== undefined ? { until: op.until } : { duration: op.duration }
}

/** Sets an effect, merging into one of the same type so each clip has one of each. */
function setEffect(clip, effect) {
  const i = clip.effects.findIndex((e) => e.type === effect.type)
  if (i >= 0) clip.effects[i] = { ...clip.effects[i], ...effect }
  else clip.effects.push(effect)
}

// Optional fields of an operation, left out when not given
const given = (op, keys) => Object.fromEntries(keys.filter((key) => op[key] !== undefined).map((key) => [key, op[key]]))

function musicClip(s) {
  const clip = sequenceOf(s).clips.find((c) => trackOf(s, c).role === "music")
  if (!clip) refuse("no_music", "there is no music yet; use set_music first")
  return writable(s, clip.id)
}

function block(s, op, blockId, version, variables) {
  known(s, op.at)
  return addClip(s, "overlay", { at: op.at, ...span(s, op), effects: [{ type: "block", blockId, version, variables }] })
}

function splitClip(s, clip, cut, cutTime) {
  const second = { ...structuredClone(clip), id: newId(s, "c") }
  clip.source.out = cut.out
  second.source.in = cut.in
  const inFirst = (effect) => sourceEdge(s, effect.at, clip.source.asset, "start") < cutTime
  clip.effects = clip.effects.filter((e) => e.type !== "freeze" || inFirst(e))
  second.effects = second.effects.filter((e) => (e.type !== "freeze" || !inFirst(e)) && e.type !== "transition")
  const clips = sequenceOf(s).clips
  clips.splice(clips.indexOf(clip) + 1, 0, second)
  return second
}

function removeFrom(s, op, asset, from, to) {
  const words = s.index.words.get(asset) ?? []
  // Keep word anchors at the words either side, so what's left follows them too
  const outRef = (start) => {
    if (op.from.word === undefined) return op.from
    const word = wordBefore(words, from)
    return word && word.end > start ? { word: word.id, edge: "end" } : null
  }
  const inRef = (end) => {
    if (op.to.word === undefined) return op.to
    const word = wordAfter(words, to)
    return word && word.start < end ? { word: word.id, edge: "start" } : null
  }
  let touched = false
  for (const clip of [...sequenceOf(s).clips]) {
    if (!clip.source || clip.source.asset !== asset || !isBase(s, clip)) continue
    const [start, end] = clipRange(s, clip)
    if (end <= from || start >= to) continue
    writable(s, clip.id)
    touched = true
    const left = start < from ? outRef(start) : null
    const right = end > to ? inRef(end) : null
    if (left !== null && right !== null) splitClip(s, clip, { out: left, in: right }, from)
    else if (left !== null) clip.source.out = left
    else if (right !== null) clip.source.in = right
    else sequenceOf(s).clips.splice(sequenceOf(s).clips.indexOf(clip), 1)
  }
  if (!touched) refuse("range_not_on_timeline", "that range isn't on the timeline, so there is nothing to remove")
}

const OPS = {
  // Selection
  keep_range: {
    fields: { asset: "id", from: "ref", to: "ref", "after?": { nullable: "id" } },
    run(op, s) {
      const asset = assetOf(s, op.asset, SEQUENCED)
      checkRange(s, asset, sourceEdge(s, op.from, asset.id, "start"), sourceEdge(s, op.to, asset.id, "end"))
      const clip = addClip(s, "base", { source: { asset: asset.id, in: op.from, out: op.to } })
      if (op.after === undefined) return
      const clips = sequenceOf(s).clips
      clips.pop()
      clips.splice(op.after === null ? 0 : clips.indexOf(clipOf(s, op.after)) + 1, 0, clip)
    },
  },
  // A cold open (ED story): a moment from later plays first, then the story starts. The
  // clip is marked an echo, so captions and anchors stay on the moment itself; mono puts it
  // in black and white, the classic teaser
  cold_open: {
    fields: { asset: "id", from: "ref", to: "ref", "mono?": "bool" },
    run(op, s) {
      const asset = assetOf(s, op.asset, SEQUENCED)
      checkRange(s, asset, sourceEdge(s, op.from, asset.id, "start"), sourceEdge(s, op.to, asset.id, "end"))
      const clip = addClip(s, "base", { source: { asset: asset.id, in: op.from, out: op.to }, echo: true })
      const clips = sequenceOf(s).clips
      clips.pop()
      clips.splice(0, 0, clip)
      if (op.mono) setEffect(clip, { type: "grade", saturation: 0, gain: 1.12, vignette: 0.4 })
    },
  },
  remove_range: {
    fields: { "asset?": "id", from: "ref", to: "ref" },
    run(op, s) {
      const asset = anchorAsset(s, op)
      const from = sourceEdge(s, op.from, asset, "start")
      const to = sourceEdge(s, op.to, asset, "end")
      if (to <= from) refuse("range_inverted", "the range ends before it starts; give the earlier point first")
      removeFrom(s, op, asset, from, to)
    },
  },
  use_take: {
    fields: { clip: "id", "asset?": "id", from: "ref", to: "ref" },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!clip.source) refuse("no_source", `clip "${op.clip}" has no source to replace`)
      const asset = assetOf(s, anchorAsset(s, op, clip.source.asset), SEQUENCED)
      checkRange(s, asset, sourceEdge(s, op.from, asset.id, "start"), sourceEdge(s, op.to, asset.id, "end"))
      clip.source = { asset: asset.id, in: op.from, out: op.to }
    },
  },
  reorder: {
    fields: { clip: "id", after: { nullable: "id" } },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!isBase(s, clip)) refuse("not_on_base", "only clips on the main picture have an order; other clips follow their anchors")
      if (op.after === op.clip) refuse("same_clip", "a clip can't go after itself")
      if (op.after !== null && !isBase(s, clipOf(s, op.after))) refuse("not_on_base", `clip "${op.after}" isn't on the main picture`)
      const clips = sequenceOf(s).clips
      clips.splice(clips.indexOf(clip), 1)
      clips.splice(op.after === null ? 0 : clips.indexOf(clipOf(s, op.after)) + 1, 0, clip)
    },
  },
  trim: {
    fields: { clip: "id", "in?": "ref", "out?": "ref", "audioLead?": "flicks", "audioLag?": "flicks" },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!clip.source) refuse("no_source", `clip "${op.clip}" has no source to trim`)
      const source = { ...clip.source, ...given(op, ["in", "out"]) }
      checkRange(s, assetOf(s, source.asset), ...clipRange(s, { source }))
      clip.source = source
      Object.assign(clip, given(op, ["audioLead", "audioLag"]))
    },
  },
  split: {
    fields: { clip: "id", at: "ref" },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!clip.source) refuse("no_source", `clip "${op.clip}" has no source to split`)
      const t = sourceEdge(s, op.at, clip.source.asset, "start")
      const [start, end] = clipRange(s, clip)
      if (t <= start || t >= end) refuse("outside_clip", `that point isn't inside clip "${op.clip}"`)
      if (typeof op.at === "number" && wordAt(s.index.words.get(clip.source.asset) ?? [], t)) refuse("cut_inside_word", "that time is inside a word; split at a word's edge instead")
      // Exact: a split is one continuous cut, so neither side takes a pad
      const cut = typeof op.at === "number" ? op.at : { ...op.at, exact: true }
      splitClip(s, clip, { out: cut, in: cut }, t)
    },
  },
  ripple_delete: {
    fields: { clip: "id" },
    run(op, s) {
      const clips = sequenceOf(s).clips
      clips.splice(clips.indexOf(writable(s, op.clip)), 1)
    },
  },

  // Picture
  punch_in: {
    // x, y (ED11): where to zoom, in thousandths of the framed picture; both or neither. ease "smooth" eases in and out
    fields: { at: "ref", ...SPAN, scale: "num", "ease?": "str", "x?": "int", "y?": "int" },
    run(op, s) {
      known(s, op.at)
      if (op.scale <= 1) refuse("bad_scale", "a punch-in's scale must be above 1")
      if ((op.x === undefined) !== (op.y === undefined) || [op.x, op.y].some((v) => v !== undefined && (v < 0 || v > 1000))) refuse("bad_focus", "a punch-in's focus needs both x and y, each from 0 to 1000")
      if (op.until !== undefined) known(s, op.until)
      addClip(s, "overlay", { at: op.at, ...given(op, ["until", "duration"]), effects: [{ type: "zoom", scale: op.scale, ...given(op, ["ease", "x", "y"]) }] })
    },
  },
  reframe: {
    fields: { clip: "id", mode: { enum: ["subject", "fixed"] }, "x?": "int", "y?": "int" },
    run(op, s) {
      setEffect(writable(s, op.clip), { type: "reframe", mode: op.mode, ...given(op, ["x", "y"]) })
    },
  },
  place_broll: {
    fields: { asset: "id", at: "ref", "in?": "flicks", "out?": "flicks", ...SPAN },
    run(op, s) {
      const asset = assetOf(s, op.asset, PICTURE)
      known(s, op.at)
      const start = op.in ?? 0
      const out = op.out ?? (op.duration === undefined ? asset.facts.duration : start + op.duration)
      if (out === undefined || (op.out === undefined && op.until === undefined && op.duration === undefined)) refuse("needs_duration", "say how long it lasts, with duration, until or out")
      checkRange(s, asset, start, out)
      if (op.until !== undefined) known(s, op.until)
      addClip(s, "broll", { source: { asset: asset.id, in: start, out }, at: op.at, ...given(op, ["until"]) })
    },
  },
  speed: {
    fields: { clip: "id", rate: "rate" },
    run(op, s) {
      writable(s, op.clip).speed = op.rate
    },
  },
  freeze: {
    fields: { clip: "id", at: "ref", duration: "flicks" },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!clip.source) refuse("no_source", `clip "${op.clip}" has no picture to freeze`)
      const t = sourceEdge(s, op.at, clip.source.asset, "start")
      const [start, end] = clipRange(s, clip)
      if (t < start || t >= end) refuse("outside_clip", `that point isn't inside clip "${op.clip}"`)
      setEffect(clip, { type: "freeze", at: op.at, duration: op.duration })
    },
  },
  transition: {
    fields: { clip: "id", kind: "str", duration: "flicks" },
    run(op, s) {
      setEffect(writable(s, op.clip), { type: "transition", kind: op.kind, duration: op.duration })
    },
  },
  stabilize: {
    fields: { clip: "id", "strength?": "num" },
    run(op, s) {
      setEffect(writable(s, op.clip), { type: "stabilize", ...given(op, ["strength"]) })
    },
  },
  set_camera: {
    fields: { clip: "id", asset: "id", "offset?": "signed" },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!clip.source) refuse("no_source", `clip "${op.clip}" has no source to switch`)
      const asset = assetOf(s, op.asset, PICTURE)
      const [start, end] = clipRange(s, clip).map((t) => t + (op.offset ?? 0))
      checkRange(s, asset, start, end)
      clip.source = { asset: asset.id, in: start, out: end }
    },
  },

  // Words on screen
  caption_style: {
    fields: { look: "str", "words?": { list: "id" }, "placement?": EFFECTS.caption["placement?"] },
    run(op, s) {
      if (op.placement) {
        const { x, y, w, h } = op.placement
        const { width, height } = s.project.canvas
        if (x < 0 || y < 0 || x + w > width || y + h > height) refuse("outside_frame", `that placement falls outside the ${width}×${height} frame`)
      }
      if (!op.words?.length) {
        s.project.look.caption = { ...s.project.look.caption, style: op.look }
        return
      }
      for (const word of op.words) known(s, { word })
      addClip(s, "caption", {
        at: { word: op.words[0], edge: "start" },
        until: { word: op.words.at(-1), edge: "end" },
        effects: [{ type: "caption", words: op.words, look: op.look, emphasis: [], ...given(op, ["placement"]) }],
      })
    },
  },
  caption_edit: {
    fields: { caption: "id", text: "str" },
    run(op, s) {
      captionOf(s, op.caption).text = op.text
    },
  },
  caption_emphasis: {
    fields: { caption: "id", word: "id" },
    run(op, s) {
      const caption = captionOf(s, op.caption)
      if (!caption.words.includes(op.word)) refuse("word_not_in_caption", `word "${op.word}" isn't in caption "${op.caption}"`)
      if (!caption.emphasis.includes(op.word)) caption.emphasis.push(op.word)
    },
  },
  add_title: {
    fields: { text: "str", at: "ref", ...SPAN },
    run(op, s) {
      block(s, op, "title", 1, { text: op.text })
    },
  },
  add_lower_third: {
    fields: { text: "str", "subtitle?": "str", at: "ref", ...SPAN },
    run(op, s) {
      block(s, op, "lower-third", 1, { text: op.text, ...given(op, ["subtitle"]) })
    },
  },
  add_motion: {
    fields: { block: "id", version: "pos", variables: "plain", at: "ref", ...SPAN },
    run(op, s) {
      block(s, op, op.block, op.version, op.variables)
    },
  },
  // Text behind the speaker (EDIT_ENGINE §6, ED8): the clip moves under the matte track,
  // and a matte clip spans the same anchors, so it follows its words through a re-cut
  text_behind: {
    fields: { clip: "id" },
    run(op, s) {
      const clip = writable(s, op.clip)
      const kind = clip.effects.find((e) => e.type === "caption" || e.type === "block")
      if (!kind) refuse("not_text", `clip "${op.clip}" isn't a caption, title or card`)
      const matte = ensureTrack(s, "matte")
      const sequence = sequenceOf(s)
      let under = sequence.tracks.find((t) => t.id === "t-behind")
      if (!under) {
        under = { id: "t-behind", role: "overlay", order: matte.order - 1, muted: false, locked: false }
        sequence.tracks.push(under)
      }
      if (clip.track === under.id) refuse("already_behind", `clip "${op.clip}" is already behind the speaker`)
      clip.track = under.id
      addClip(s, "matte", { at: clip.at, ...(clip.until !== undefined ? { until: clip.until } : { duration: clip.duration }), effects: [{ type: "matte", model: "face-box" }] })
    },
  },

  // Sound
  add_sfx: {
    fields: { asset: "id", peak_at: "ref" },
    run(op, s) {
      const asset = assetOf(s, op.asset, ["audio"])
      known(s, op.peak_at)
      if (asset.facts.duration === undefined) refuse("not_probed", `asset "${op.asset}" hasn't been probed yet`)
      addClip(s, "sfx", { source: { asset: asset.id, in: 0, out: asset.facts.duration }, at: op.peak_at, peak: asset.facts.peak ?? 0 })
    },
  },
  set_music: {
    fields: { asset: "id", "in?": "flicks", "out?": "flicks" },
    run(op, s) {
      const asset = assetOf(s, op.asset, ["audio"])
      const start = op.in ?? 0
      const out = op.out ?? asset.facts.duration
      if (out === undefined) refuse("not_probed", `asset "${op.asset}" hasn't been probed yet`)
      checkRange(s, asset, start, out)
      const track = ensureTrack(s, "music")
      const sequence = sequenceOf(s)
      sequence.clips = sequence.clips.filter((c) => c.track !== track.id)
      addClip(s, "music", { source: { asset: asset.id, in: start, out }, at: 0 })
    },
  },
  music_shape: {
    fields: { "fadeIn?": "flicks", "fadeOut?": "flicks", "fit?": "bool" },
    run(op, s) {
      if (op.fadeIn === undefined && op.fadeOut === undefined && op.fit === undefined) refuse("needs_a_value", "give fadeIn, fadeOut or fit")
      const clip = musicClip(s)
      if (op.fadeIn !== undefined || op.fadeOut !== undefined) setEffect(clip, { type: "fade", ...(op.fadeIn === undefined ? {} : { in: op.fadeIn }), ...(op.fadeOut === undefined ? {} : { out: op.fadeOut }) })
      // fit: the song is edited on its downbeats to the timeline's length (ED9)
      if (op.fit === true) setEffect(clip, { type: "fit" })
      if (op.fit === false) clip.effects = clip.effects.filter((e) => e.type !== "fit")
    },
  },
  duck: {
    fields: { "depth?": "num", "attack?": "flicks", "release?": "flicks" },
    run(op, s) {
      setEffect(musicClip(s), { type: "duck", ...given(op, ["depth", "attack", "release"]) })
    },
  },
  clean_voice: {
    fields: { clip: "id", "strength?": "num" },
    run(op, s) {
      const clip = writable(s, op.clip)
      if (!clip.source || assetOf(s, clip.source.asset).facts.hasAudio === false) refuse("no_audio", `clip "${op.clip}" has no voice to clean`)
      setEffect(clip, { type: "eq", preset: "voice-clean", ...given(op, ["strength"]) })
    },
  },
  set_level: {
    fields: { clip: "id", db: "num" },
    run(op, s) {
      setEffect(writable(s, op.clip), { type: "level", db: op.db })
    },
  },
  room_tone: {
    fields: { asset: "id", from: "ref", to: "ref" },
    run(op, s) {
      const asset = assetOf(s, op.asset, ["video", "audio"])
      checkRange(s, asset, sourceEdge(s, op.from, asset.id, "start"), sourceEdge(s, op.to, asset.id, "end"))
      addClip(s, "ambience", { source: { asset: asset.id, in: op.from, out: op.to }, at: 0, loop: true })
    },
  },

  // Colour
  grade: {
    // temperature in kelvin (6500 neutral, lower is warmer), vibrance -2 to 2, vignette 0 to 1
    fields: { clip: "id", "lift?": "num", "gamma?": "num", "gain?": "num", "saturation?": "num", "temperature?": "num", "vibrance?": "num", "vignette?": "num" },
    run(op, s) {
      const values = given(op, ["lift", "gamma", "gain", "saturation", "temperature", "vibrance", "vignette"])
      if (Object.keys(values).length === 0) refuse("needs_a_value", "give at least one of lift, gamma, gain, saturation, temperature, vibrance or vignette")
      if (values.temperature !== undefined && (values.temperature < 2000 || values.temperature > 12000)) refuse("bad_value", "temperature is between 2000 and 12000 kelvin")
      if (values.vibrance !== undefined && Math.abs(values.vibrance) > 2) refuse("bad_value", "vibrance is between -2 and 2")
      if (values.vignette !== undefined && (values.vignette < 0 || values.vignette > 1)) refuse("bad_value", "vignette is between 0 and 1")
      setEffect(writable(s, op.clip), { type: "grade", ...values })
    },
  },
  match_color: {
    fields: { clip: "id", reference: "id" },
    run(op, s) {
      clipOf(s, op.reference)
      setEffect(writable(s, op.clip), { type: "grade", match: op.reference })
    },
  },
  apply_lut: {
    fields: { clip: "id", asset: "id" },
    run(op, s) {
      setEffect(writable(s, op.clip), { type: "lut", asset: assetOf(s, op.asset, ["lut"]).id })
    },
  },
  fix_exposure: {
    fields: { clip: "id", ev: "num" },
    run(op, s) {
      setEffect(writable(s, op.clip), { type: "grade", ev: op.ev })
    },
  },

  // Project
  set_format: {
    fields: { "width?": "pos", "height?": "pos", "fps?": "rate" },
    run(op, s) {
      const change = given(op, ["width", "height", "fps"])
      const odd = [op.width, op.height].some((side) => side !== undefined && side % 2 !== 0)
      if (Object.keys(change).length === 0 || odd) refuse("bad_format", "give width, height or fps; width and height must be even, as video encoders need")
      Object.assign(s.project.canvas, change)
    },
  },
  add_deliverable: {
    fields: {
      preset: "str",
      size: { width: "pos", height: "pos" },
      fps: "rate",
      codec: "str",
      audio: "str",
      loudness: { lufs: "num", tp: "num" },
      burnCaptions: "bool",
      "gates?": { list: "str" },
    },
    run({ op: _, gates = [], ...fields }, s) {
      s.project.deliverables.push({ id: newId(s, "d"), ...fields, gates })
    },
  },
  set_look: {
    fields: { "caption?": "plain", "color?": "plain", "motion?": "plain", "sound?": "plain", "brand?": "plain" },
    run({ op: _, ...parts }, s) {
      for (const [key, part] of Object.entries(parts)) s.project.look[key] = { ...s.project.look[key], ...part }
    },
  },
  mark: {
    fields: { name: "str", at: "ref" },
    run(op, s) {
      known(s, op.at)
      sequenceOf(s).markers.push({ id: newId(s, "k"), name: op.name, at: op.at })
    },
  },
  // Names the history entry (history.js): the project itself doesn't change
  name_version: { fields: { name: "name" }, run() {} },
}

// Not an edit: the Host records what was brought in, so a replay sees the same assets.
// An agent or a person can't name a file through an operation (ES-01).
const CODE_OPS = {
  add_asset: {
    fields: Object.fromEntries(Object.entries(SHAPES.project.assets.list)),
    run({ op: _, ...asset }, s) {
      if (s.author !== "code") refuse("code_only", "assets are added by the Host, when a file is brought in")
      if (s.project.assets.some((a) => a.id === asset.id)) refuse("duplicate_asset", `there is already an asset "${asset.id}"`)
      s.project.assets.push(asset)
    },
  },
  // The brief (DIRECTOR_AND_AGENT §3): what the edit is for, so QG-12 can check it (ED7).
  // A setting, not one of the 37 edits; history records it like any other entry
  set_brief: {
    fields: SHAPES.project["brief?"],
    run({ op: _, ...brief }, s) {
      if (brief.targetDuration <= 0) refuse("bad_brief", "a brief's target length must be above zero")
      s.project.brief = brief
    },
  },
}

const ALL_OPS = { ...OPS, ...CODE_OPS }

function captionOf(s, id) {
  const caption = writable(s, id).effects.find((e) => e.type === "caption")
  if (!caption) refuse("not_a_caption", `clip "${id}" isn't a caption`)
  return caption
}

export const OPERATIONS = Object.keys(OPS)

/** Shape only, with no project: what reading the log back can check. */
export function opShapeErrors(op) {
  if (op === null || typeof op !== "object" || !Object.hasOwn(ALL_OPS, op.op)) return [{ code: "unknown_op", message: `unknown operation; use one of ${OPERATIONS.join(", ")}` }]
  const { op: name, ...fields } = op
  const errors = []
  check(fields, ALL_OPS[name].fields, "", errors)
  return errors.map(({ path, reason }) => ({ code: "bad_field", message: `${name}.${path} ${reason}` }))
}

/**
 * Applies operations as one unit. Pure: the input is never changed, and on any
 * refusal the same project comes back with the reason.
 * @param {object} project
 * @param {object[]} ops
 * @param {{ index?: object, author?: "person" | "agent" | "code" }} [ctx]
 * @returns {{ project: object, applied: boolean, diagnostics: { code: string, message: string, op: number }[] }}
 */
export function apply(project, ops, { index, author = "agent" } = {}) {
  if (!Array.isArray(ops)) return { project, applied: false, diagnostics: [{ code: "unknown_op", message: "operations must be a list", op: 0 }] }
  const s = { project: structuredClone(project), index: openIndex(index), author }
  for (const [i, op] of ops.entries()) {
    const shape = opShapeErrors(op)
    if (shape.length) return { project, applied: false, diagnostics: shape.map((d) => ({ ...d, op: i })) }
    try {
      ALL_OPS[op.op].run(op, s)
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      return { project, applied: false, diagnostics: [{ code: error.code, message: error.message, op: i }] }
    }
  }
  const errors = validateProject(s.project)
  if (errors.length) return { project, applied: false, diagnostics: errors.map(({ path, reason }) => ({ code: "invalid_result", message: `${path} ${reason}`, op: ops.length - 1 })) }
  return { project: s.project, applied: true, diagnostics: [] }
}

export const validateOps = (project, ops, ctx) => apply(project, ops, ctx).diagnostics
