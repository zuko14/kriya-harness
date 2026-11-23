// The Kriya Edit Project (EDIT_ENGINE §3, DATA_MODEL §2): one JSON document,
// validated on every load. It holds decisions, never derived data.

import { createHash } from "node:crypto"

import { isFlicks, isRate } from "./time.js"

export const SCHEMA = 1

const EDGE = { enum: ["start", "end"] }
const ROLES = ["base", "broll", "matte", "overlay", "caption", "dialogue", "sfx", "music", "ambience"]
const AUTHOR = { enum: ["person", "agent", "code"] }

export const ANCHORS = {
  word: { word: "id", edge: EDGE, "exact?": "bool" },
  shot: { shot: "id", "edge?": EDGE },
  beat: { beat: "id" },
  marker: { marker: "id" },
  clip: { clip: "id", edge: EDGE, "offset?": "signed" },
}

const BOX = { x: "int", y: "int", w: "pos", h: "pos" }

export const EFFECTS = {
  reframe: { mode: { enum: ["subject", "fixed"] }, "x?": "int", "y?": "int" },
  zoom: { scale: "num", "ease?": "str", "x?": "int", "y?": "int" },
  matte: { "model?": "str" },
  grade: { "lift?": "num", "gamma?": "num", "gain?": "num", "saturation?": "num", "ev?": "num", "match?": "id", "temperature?": "num", "vibrance?": "num", "vignette?": "num" },
  lut: { asset: "id" },
  stabilize: { "strength?": "num" },
  fade: { "in?": "flicks", "out?": "flicks" },
  transition: { kind: "str", duration: "flicks" },
  caption: { words: { list: "id" }, "text?": "str", look: "str", "placement?": BOX, emphasis: { list: "id" } },
  block: { blockId: "id", version: "pos", variables: "plain" },
  level: { db: "num" },
  eq: { preset: "str", "strength?": "num" },
  duck: { "depth?": "num", "attack?": "flicks", "release?": "flicks" },
  fit: {},
  freeze: { at: "ref", duration: "flicks" },
}

export const SHAPES = {
  project: {
    schema: "pos",
    id: "id",
    name: "str",
    canvas: {
      width: "pos",
      height: "pos",
      fps: "rate",
      color: { primaries: "str", transfer: "str", range: "str" },
      workingBitDepth: "pos",
    },
    assets: {
      list: {
        id: "id",
        kind: { enum: ["video", "audio", "image", "document", "data", "font", "lut", "reference"] },
        fingerprint: "id",
        "sha256?": "str",
        path: "str",
        linked: "bool",
        rights: { enum: ["own", "licensed", "public_domain", "unknown"] },
        "rightsNote?": "str",
        "role?": { enum: ["aroll", "broll", "screen", "music", "sfx", "logo"] },
        facts: {
          "duration?": "flicks",
          "fps?": { nullable: "rate" },
          "vfr?": "bool",
          "width?": "pos",
          "height?": "pos",
          "hasAudio?": "bool",
          "sampleRate?": "pos",
          "channels?": "pos",
          "rotation?": "int",
          "color?": { primaries: "str", transfer: "str", range: "str", tagged: "bool", hdr: "bool" },
          "peak?": "flicks",
        },
      },
    },
    sequences: {
      list: {
        id: "id",
        name: "str",
        tracks: { list: { id: "id", role: { enum: ROLES }, order: "int", muted: "bool", locked: "bool" } },
        markers: { list: { id: "id", name: "str", at: "ref" } },
        clips: {
          list: {
            id: "id",
            track: "id",
            source: { nullable: { asset: "id", in: "ref", out: "ref" } },
            at: { nullable: "ref" },
            "until?": "ref",
            "duration?": "flicks",
            "peak?": "flicks",
            "loop?": "bool",
            effects: { list: "effect" },
            speed: "rate",
            "linkGroup?": "str",
            // A cold open's teaser: the same words again, before the story. Anchors skip it
            "echo?": "bool",
            // A join, not a cut: this edge continues the clip beside it exactly (a speed ramp's steps)
            "seamIn?": "bool",
            "seamOut?": "bool",
            "audioLead?": "flicks",
            "audioLag?": "flicks",
            createdBy: AUTHOR,
          },
        },
        "parent?": "id",
      },
    },
    active: "id",
    look: { id: "id", caption: "plain", color: "plain", motion: "plain", sound: "plain", brand: "plain" },
    deliverables: {
      list: {
        id: "id",
        preset: "str",
        size: { width: "pos", height: "pos" },
        fps: "rate",
        codec: "str",
        audio: "str",
        loudness: { lufs: "num", tp: "num" },
        burnCaptions: "bool",
        gates: { list: "str" },
      },
    },
    "brief?": {
      format: "str",
      targetDuration: "flicks",
      "audience?": "str",
      "tone?": "str",
      mustKeep: { list: "str" },
      mustCut: { list: "str" },
      "language?": "str",
      effort: { enum: ["fast", "best"] },
    },
    nextId: "pos",
    head: { nullable: "id" },
    history: {
      list: { id: "id", parent: { nullable: "id" }, "name?": "str", author: AUTHOR, opsRange: { list: "int" }, hash: "str", at: "str" },
    },
  },
  ...EFFECTS,
  ...ANCHORS,
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const PRIMITIVES = {
  str: (v) => (typeof v === "string" ? null : "must be text"),
  // Ids and fingerprints name cache files (ES-01): letters, digits and :_.@+- only, never ".." or a slash
  id: (v) => (typeof v === "string" && /^(?!.*\.\.)[\p{L}\p{N}_][\p{L}\p{N}:_.@+-]{0,127}$/u.test(v) ? null : "must be a short id of letters, digits and :_.@+-"),
  name: (v) => (typeof v === "string" && v.length > 0 ? null : "must be a non-empty name"),
  int: (v) => (Number.isSafeInteger(v) ? null : "must be a whole number"),
  pos: (v) => (Number.isSafeInteger(v) && v > 0 ? null : "must be a positive whole number"),
  num: (v) => (Number.isFinite(v) ? null : "must be a number"),
  bool: (v) => (typeof v === "boolean" ? null : "must be true or false"),
  flicks: (v) => (isFlicks(v) && v >= 0 ? null : "must be whole flicks, zero or more"),
  signed: (v) => (isFlicks(v) ? null : "must be whole flicks"),
  rate: (v) => (isRate(v) && Object.keys(v).length === 2 ? null : "must be a rational { n, d } of positive whole numbers"),
  plain: (v) => (isObject(v) ? null : "must be an object"),
}

/** Adds { path, reason } for everything wrong with value against spec. */
export function check(value, spec, path, errors) {
  if (typeof spec === "string") {
    if (spec === "ref") return checkRef(value, path, errors)
    if (spec === "anchor") return checkAnchor(value, path, errors)
    if (spec === "effect") return checkEffect(value, path, errors)
    const reason = PRIMITIVES[spec](value)
    if (reason) errors.push({ path, reason })
  } else if (spec.enum) {
    if (!spec.enum.includes(value)) errors.push({ path, reason: `must be one of ${spec.enum.join(", ")}` })
  } else if (spec.nullable) {
    if (value !== null) check(value, spec.nullable, path, errors)
  } else if (spec.list) {
    if (!Array.isArray(value)) errors.push({ path, reason: "must be a list" })
    else value.forEach((item, i) => check(item, spec.list, `${path}[${i}]`, errors))
  } else checkShape(value, spec, path, errors)
}

function checkShape(value, shape, path, errors) {
  if (!isObject(value)) {
    errors.push({ path, reason: "must be an object" })
    return
  }
  const at = (key) => (path ? `${path}.${key}` : key)
  const known = new Set()
  for (const [field, spec] of Object.entries(shape)) {
    const optional = field.endsWith("?")
    const key = optional ? field.slice(0, -1) : field
    known.add(key)
    if (value[key] !== undefined) check(value[key], spec, at(key), errors)
    else if (!optional) errors.push({ path: at(key), reason: "is required" })
  }
  for (const key of Object.keys(value)) if (!known.has(key)) errors.push({ path: at(key), reason: "is not a field here" })
}

function checkAnchor(value, path, errors) {
  const kind = isObject(value) ? Object.keys(ANCHORS).find((key) => key in value) : undefined
  if (kind) checkShape(value, ANCHORS[kind], path, errors)
  else errors.push({ path, reason: "must be an anchor: word, shot, beat, marker or clip" })
}

function checkRef(value, path, errors) {
  if (typeof value === "number") check(value, "flicks", path, errors)
  else checkAnchor(value, path, errors)
}

function checkEffect(value, path, errors) {
  const { type, ...fields } = isObject(value) ? value : {}
  if (!Object.hasOwn(EFFECTS, type)) errors.push({ path, reason: `is not a known effect: ${type}` })
  else checkShape(fields, EFFECTS[type], path, errors)
}

function checkMeaning(project, errors) {
  const unique = (items, path) => {
    const seen = new Set()
    for (const { id } of items) {
      if (seen.has(id)) errors.push({ path, reason: `duplicate id "${id}"` })
      seen.add(id)
    }
    return seen
  }
  const assets = unique(project.assets, "assets")
  unique(project.deliverables, "deliverables")
  const sequences = unique(project.sequences, "sequences")
  if (!sequences.has(project.active)) errors.push({ path: "active", reason: `no sequence "${project.active}"` })
  project.sequences.forEach((sequence, s) => {
    const path = `sequences[${s}]`
    const tracks = unique(sequence.tracks, `${path}.tracks`)
    unique(sequence.markers, `${path}.markers`)
    unique(sequence.clips, `${path}.clips`)
    sequence.clips.forEach((clip, c) => {
      if (!tracks.has(clip.track)) errors.push({ path: `${path}.clips[${c}].track`, reason: `no track "${clip.track}"` })
      if (clip.source && !assets.has(clip.source.asset)) errors.push({ path: `${path}.clips[${c}].source.asset`, reason: `no asset "${clip.source.asset}"` })
    })
  })
}

/** @returns {{ path: string, reason: string }[]} empty when the project is valid */
export function validateProject(project) {
  const errors = []
  check(project, SHAPES.project, "", errors)
  if (project?.schema !== undefined && project.schema !== SCHEMA) errors.push({ path: "schema", reason: `must be ${SCHEMA}` })
  if (errors.length === 0) checkMeaning(project, errors)
  return errors
}

// Pure v(n) → v(n+1) steps. Schema 1 is the first, so there are none yet
const MIGRATIONS = {}

export function migrate(doc, steps = MIGRATIONS) {
  let current = doc
  while (current.schema < SCHEMA) {
    const step = steps[current.schema]
    if (!step) throw new RangeError(`no migration from schema ${current.schema}`)
    current = step(current)
  }
  return current
}

/** Parses project text. A newer or invalid document is refused whole, never partly read. */
export function parseProject(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, errors: [{ path: "", reason: "this isn't a Kriya project file: it isn't valid JSON" }] }
  }
  if (!isObject(doc) || !Number.isSafeInteger(doc.schema)) return { ok: false, errors: [{ path: "schema", reason: "this isn't a Kriya project file" }] }
  if (doc.schema > SCHEMA) return { ok: false, errors: [{ path: "schema", reason: `this project was saved by a newer version of Kriya (schema ${doc.schema}). Update Kriya to open it` }] }
  try {
    const project = migrate(doc)
    const errors = validateProject(project)
    return errors.length ? { ok: false, errors } : { ok: true, project, errors }
  } catch (error) {
    return { ok: false, errors: [{ path: "schema", reason: error.message }] }
  }
}

/** A new, empty project: one sequence, a base track, and a caption track. */
export function newProject({ id, name, width = 1080, height = 1920, fps = { n: 30, d: 1 } }) {
  const track = (role, order) => ({ id: `t-${role}`, role, order, muted: false, locked: false })
  return {
    schema: SCHEMA,
    id,
    name,
    canvas: { width, height, fps, color: { primaries: "bt709", transfer: "bt709", range: "tv" }, workingBitDepth: 10 },
    assets: [],
    sequences: [{ id: "q1", name: "Main", tracks: [track("base", 0), track("caption", 4)], markers: [], clips: [] }],
    active: "q1",
    look: { id: "default", caption: {}, color: {}, motion: {}, sound: {}, brand: {} },
    deliverables: [],
    nextId: 1,
    head: null,
    history: [],
  }
}

/** JSON with sorted keys: the same value always gives the same bytes. */
export function canonical(value) {
  return JSON.stringify(value, (_, v) => (isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))
}

export const serialize = (project) => `${canonical(project)}\n`
export const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/** Hash of the decisions; where HEAD sits and the mirrored log aren't part of them. */
export function hashProject({ head, history, ...decisions }) {
  return sha256(canonical(decisions))
}
