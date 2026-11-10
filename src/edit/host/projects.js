// Projects on disk (DATA_MODEL §2): the project file is written atomically in the
// person's folder; its history and cache stay in ~/.kriya/edit/<id>/, never synced.

import { randomBytes } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path"

import { checkout, commit, createLog, parseEntry, undo, versions } from "../core/history.js"
import { canonical, newProject, parseProject, serialize, sha256 } from "../core/project.js"
import { createEngine, ENGINE_VERSION, guardPath } from "../engine/index.js"
import { blockComposition, motionRuntime } from "../engine/motion.js"
import { cleanScene, SCENE_BLOCK, SCENE_KINDS, SCENE_THEMES, SCENE_VERSION, swapsFor } from "../engine/scenes.js"
import { parseCube } from "../engine/color.js"
import { fingerprint } from "../engine/media.js"
import { probe } from "../engine/probe.js"
import { EngineFailure, runTool } from "../engine/tool.js"
import { openJournal } from "../graph/journal.js"
import { DEFAULT_RULES, solve } from "../core/solver.js"
import { safeZoneFor, sceneFrame } from "../core/layout.js"
import { revealWords } from "../director/beats.js"
import { termId } from "../director/lookups.js"
import { allowedMediaUrl, downloadMedia, MEDIA_TYPES, stillClipArgs } from "../engine/found-media.js"
import { planMontage } from "../recipes/montage.js"
import { analyseMulticam, PODCAST_MULTICAM } from "../recipes/multicam.js"
import { planProgramme, programmeRecipe } from "../recipes/programme.js"
import { defineTerms, fetchFeatures, searchMedia } from "../runtime/fetch.js"
import { readDevice } from "../../store.js"
import { createAsk } from "../director/ask.js"
import { LOOKS } from "../engine/captions.js"
import { cleanSelection, cleanWord, describe, noteWord, revise } from "../director/revise.js"
import { openIndexDb } from "../index/db.js"
import { makeReel, rebase } from "../loop/make.js"
import { runGates } from "../gates/index.js"
import { FORMATS, REEL_TALKING_HEAD } from "../recipes/reel.js"
import { compareRuns, replayAsk } from "../loop/replay.js"
import { verifiedRecogniser, writeDelivery, writeHandoff } from "./deliver.js"
import { createIndexer, layersFor } from "../index/index.js"
import { activeRuntime } from "../runtime/setup.js"
import { editHome } from "./paths.js"
import { createTaste } from "./taste.js"
import { ASPECTS, analyseReference, cleanRefs, takeFrom } from "../engine/reference.js"
import { briefOf, planCut } from "../director/plan.js"
import { editsSince, planDiff, storyFor } from "../director/continuity.js"
import { cleanGraphic, GRAPHIC_ACCENTS, GRAPHIC_BLOCK, GRAPHIC_FONTS, GRAPHIC_KINDS, GRAPHIC_TONES, GRAPHIC_VERSION, graphicLength, STYLE_LABELS } from "../engine/graphics.js"
import { MOODS, writeMusicBed } from "../engine/music-bed.js"
import { SFX, writeSfx } from "../engine/sfx.js"

// "start over", "from scratch": the one way a request after a make isn't a change to that cut
const STARTS_OVER = /\b(?:start (?:over|again|afresh)|from scratch|fresh (?:cut|edit|start)|brand[- ]new (?:cut|edit))\b/i

function atomicWrite(file, text) {
  const part = `${file}.${process.pid}.tmp`
  const handle = openSync(part, "w")
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(part, file)
}

// EG-3: a damaged database is set aside, never deleted (the index keeps the person's
// transcript corrections), and an empty one opens in its place. Other errors stand.
function openOrSetAside(file, open) {
  try {
    return { value: open(file), damaged: false }
  } catch (error) {
    if (!/not a database|malformed|corrupt/i.test(error.message)) throw error
    const aside = `${file}.damaged-${Date.now()}`
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix)
    return { value: open(file), damaged: true }
  }
}

const readIndex = (file) => {
  const db = openIndexDb(file)
  try {
    return { db, index: db.read() }
  } catch (error) {
    db.close()
    throw error
  }
}

const kindOf = ({ width, hasAudio }) => (width ? "video" : hasAudio ? "audio" : "data")

/**
 * @param {{ home: string, roots: string[], scheduler: object, tools: () => Promise<{ capabilities: object, version: string }> }} options
 */
const FLICKS = 705_600_000
// Director model calls a job may make (DIRECTOR_AND_AGENT §13, short form)
const JOB_CALLS = 40

// What the server has switched on, asked for at most once a minute, so turning a switch off takes effect soon
const FEATURES_MS = 60_000
const askServer = async () => {
  const device = readDevice()
  return device ? fetchFeatures(device) : { visuals: false, playbooks: false, mediaSearch: false }
}
const NOTHING_FOUND = { items: {}, definitions: {} }

export function createProjects({ home, roots, scheduler, tools, governor = null, features = askServer }) {
  const base = editHome(home)
  let known = null
  const taste = createTaste({ home })
  const registry = join(base, "projects.json")
  const open = new Map()

  const list = () => (existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : [])
  const entry = (id) => list().find((item) => item.id === id)
  const dirOf = (id) => join(base, id)
  // Where an asset's file is, fenced to the roots and the project's folder
  const sourcesOf = (state) => (id) => {
    const found = state.log.current.assets.find((a) => a.id === id)
    return guardPath(isAbsolute(found.path) ? found.path : join(state.folder, found.path), [...roots, state.folder])
  }

  function persist(state) {
    const project = { ...state.log.current, head: state.log.head, history: versions(state.log) }
    atomicWrite(state.file, serialize(project))
    atomicWrite(join(dirOf(project.id), "head"), state.log.head ?? "")
    state.engine.load(state.log.current, state.index)
  }

  async function attach(id, file) {
    const dir = dirOf(id)
    const root = parseProject(readFileSync(join(dir, "root.json"), "utf8"))
    if (!root.ok) throw new EngineFailure("input", "unreadable", root.errors[0].reason)
    const lines = existsSync(join(dir, "ops.jsonl")) ? readFileSync(join(dir, "ops.jsonl"), "utf8").split("\n").filter(Boolean) : []
    const entries = lines.map((line) => {
      const parsed = parseEntry(line)
      if (!parsed.ok) throw new EngineFailure("input", "unreadable", "This project's history is damaged.")
      return parsed.entry
    })
    const head = existsSync(join(dir, "head")) ? readFileSync(join(dir, "head"), "utf8") || null : null
    const opened = openOrSetAside(join(dir, "index.sqlite"), readIndex)
    const { db: indexDb, index } = opened.value
    const log = checkout({ ...createLog(root.project), entries }, head, { index })
    const { capabilities, version } = await tools()
    const folder = dirname(file)
    const journaled = openOrSetAside(join(dir, "journal.sqlite"), openJournal)
    const journal = journaled.value
    const engine = createEngine({ folder, roots: [...roots, folder], cache: join(dir, "cache"), exports: join(folder, "exports"), journal, toolVersion: version, capabilities, scheduler, motion: () => motionRuntime(activeRuntime(home)) })
    engine.load(log.current, index)
    const state = { id, file, folder, log, journal, engine, indexDb, index, proposals: new Map(), damaged: [...(opened.damaged ? ["index"] : []), ...(journaled.damaged ? ["journal"] : [])] }
    open.set(id, state)
    return state
  }

  // One attach per project at a time: two at once (the start's resume and a request) opened
  // its databases twice, and the second saw the first's repair, not the damage (found in ED17)
  const opening = new Map()
  async function get(id) {
    if (open.has(id)) return open.get(id)
    if (opening.has(id)) return opening.get(id)
    const known = entry(id)
    if (!known) return null
    const pending = attach(id, known.file).finally(() => opening.delete(id))
    opening.set(id, pending)
    return pending
  }

  function change(state, { ops, author }) {
    const result = commit(state.log, { ops, author, at: new Date().toISOString() }, { index: state.index })
    if (!result.ok) return result
    state.log = result.log
    appendFileSync(join(dirOf(state.id), "ops.jsonl"), `${JSON.stringify(state.log.entries.at(-1))}\n`)
    persist(state)
    // What the person does; a job's own operations teach nothing
    if (author === "person") taste.note(state.id, ops, state.log.head)
    return result
  }

  return {
    list,
    get,
    change,
    taste,
    each: async (visit) => {
      for (const { id } of list()) {
        // One damaged project never stops the others, or the Host's start (EG-3); opening it says why
        const state = await get(id).catch(() => null)
        if (state) await visit(state)
      }
    },
    close: () => {
      for (const state of open.values()) {
        state.journal.close()
        state.indexDb.close()
      }
    },

    undo(state) {
      taste.forget(state.id, state.log.head)
      state.log = undo(state.log, { index: state.index })
      persist(state)
    },

    /**
     * Removes a project from the Studio: its history, cache, index and journal in
     * ~/.kriya/edit/<id>/ go. The person's folder (the project file, footage, exports)
     * is theirs and is never touched. A project with work running is refused.
     */
    remove(id, { running = () => false } = {}) {
      const known = entry(id)
      if (!known) throw new EngineFailure("input", "no_project", "There is no such project.")
      if (running(id)) throw new EngineFailure("input", "busy", "This project has work running. Let it finish or stop it first.")
      const state = open.get(id)
      if (state) {
        state.journal.close()
        state.indexDb.close()
        open.delete(id)
      }
      atomicWrite(registry, JSON.stringify(list().filter((item) => item.id !== id)))
      rmSync(dirOf(id), { recursive: true, force: true })
      return { removed: id, kept: dirname(known.file) }
    },

    /** @param {{ name: string, folder: string, offered?: boolean }} input offered: the person offered this folder on this computer (CC-D2) */
    async create({ name, folder, offered = false }) {
      const real = guardPath(folder, offered ? [folder] : roots)
      const id = randomBytes(8).toString("hex")
      const dir = dirOf(id)
      mkdirSync(dir, { recursive: true })
      const project = newProject({ id, name })
      const file = join(real, `${name.replace(/[^\p{L}\p{N} _-]+/gu, "-")}.kriya-edit`)
      if (existsSync(file)) throw new EngineFailure("input", "exists", "A project with that name is already in this folder.")
      atomicWrite(join(dir, "root.json"), serialize(project))
      atomicWrite(file, serialize(project))
      atomicWrite(registry, JSON.stringify([...list(), { id, name, file }]))
      return attach(id, file)
    },

    /** Brings a file in by reference: probed, fingerprinted, never copied or written. */
    async addAsset(state, path, { reference = false, rights = "unknown", rightsNote, extraFacts = {} } = {}) {
      const real = guardPath(path, [...roots, state.folder])
      // A .cube is a LUT (ED13): read and checked here, before FFmpeg ever sees it, never probed as media
      const lut = extname(real).toLowerCase() === ".cube"
      if (lut) {
        try {
          parseCube(readFileSync(real, "utf8"))
        } catch (error) {
          throw new EngineFailure("input", "refused", error.message)
        }
      }
      const { facts: probed } = lut ? { facts: {} } : await probe(real)
      const facts = { ...probed, ...extraFacts }
      const id = `a${state.log.current.assets.length + 1}`
      const within = relative(state.folder, real)
      const stored = within.startsWith("..") || isAbsolute(within) ? real : within.split(sep).join("/")
      // A reference is measured for its style only (EDD-23); the person confirmed they may use it
      if (reference && !facts.width && !facts.hasAudio) throw new EngineFailure("input", "refused", "A reference needs to be a video, an image or a piece of music.")
      const op = { op: "add_asset", id, kind: reference ? "reference" : lut ? "lut" : kindOf(facts), fingerprint: await fingerprint(real), path: stored, linked: true, rights: reference ? "unknown" : rights, ...(reference ? { rightsNote: "The person confirmed they may use it as a style reference." } : rightsNote ? { rightsNote } : {}), facts }
      const result = change(state, { ops: [op], author: "code" })
      if (!result.ok) throw new EngineFailure("input", "refused", result.diagnostics[0].message)
      return state.log.current.assets.at(-1)
    },

    /** Runs the Footage Index on one asset; word and shot anchors resolve once it has. */
    async indexAsset(state, assetId, { signal, onStep } = {}) {
      const asset = state.log.current.assets.find((item) => item.id === assetId)
      if (!asset || !["video", "audio"].includes(asset.kind)) throw new EngineFailure("input", "unknown_asset", "There is no such video or sound in this project.")
      const path = guardPath(isAbsolute(asset.path) ? asset.path : join(state.folder, asset.path), [...roots, state.folder])
      const owner = Symbol("index")
      const indexer = createIndexer({
        db: state.indexDb,
        cache: join(dirOf(state.id), "cache"),
        binDir: join(base, "bin"),
        language: state.log.current.brief?.language ?? "en",
        runtime: () => activeRuntime(home),
        acquire: (resources, abort) => scheduler.acquire(resources, { signal: abort, owner }),
      })
      const report = await indexer.indexAsset(asset, path, { signal, onStep, only: layersFor(asset.kind) })
      state.index = state.indexDb.read()
      state.damaged = state.damaged.filter((part) => part !== "index")
      state.engine.load(state.log.current, state.index)
      return report
    },

    /** The Director for one job: the Governor's queue, the job's call budget, the journal's record. */
    askFor(state, job = 0) {
      if (!governor) throw new EngineFailure("environment", "no_director", "This Host has no Director.")
      let left = JOB_CALLS
      const ask = createAsk({ governor, record: (row) => state.journal.call({ job, ...row }), budget: { take: () => left-- > 0 } })
      // Each slot's final answer, so the job can be replayed with no model call
      return async (slot) => {
        const answer = await ask(slot)
        state.journal.answer({ job, task: slot.task, source: answer.source, value: answer.value })
        return answer
      }
    },

    /** The console: words → a proposal, applied to a copy, nothing landing yet (UX_SPEC §4, §5). */
    async ask(state, { text, selection, history = [], job = 0 }) {
      const chosen = cleanSelection(selection, state.log.current, state.index)
      const { motion } = await this.features()
      const result = await revise({ ask: this.askFor(state, job), project: state.log.current, index: state.index, text, selection: chosen, history, motion: motion && !state.engine.motion().missing })
      // A request about the whole video goes to the Director's make job; the Studio offers it
      const direct = result.direct ? { brief: { ...(result.direct.seconds ? { seconds: result.direct.seconds } : {}), ...(result.direct.captions ? { captions: result.direct.captions } : {}) } } : null
      if (!result.ops.length && !result.corrections.length) return { proposal: null, direct, say: result.say, source: result.source, reason: direct || result.say ? null : (result.reason ?? "Kriya couldn't turn that into an edit. Try saying it another way.") }
      const id = randomBytes(6).toString("hex")
      state.proposals.set(id, { ops: result.ops, corrections: result.corrections, head: state.log.head })
      const { picture, duration } = solve(result.project ?? state.log.current, state.index)
      // Changes in one list, operations first, then corrections: "Only this" counts across both
      return { proposal: { id, ops: result.ops, changes: [...result.changes, ...result.corrections.map((c) => c.change)], timeline: result.ops.length ? { picture, duration } : null }, direct, say: result.say, source: result.source, ...(result.reason ? { reason: result.reason } : {}) }
    },

    /** Accept all, accept some, or reject a proposal. Rebased onto HEAD; the person's own edits never move. */
    decide(state, id, { accept, only }) {
      const proposal = state.proposals.get(id)
      if (!proposal) throw new EngineFailure("input", "no_proposal", "That proposal has gone. Ask again.")
      state.proposals.delete(id)
      if (!accept) return { applied: 0, dropped: [] }
      const chosen = Array.isArray(only) ? proposal.ops.filter((_, i) => only.includes(i)) : proposal.ops
      const fixes = (proposal.corrections ?? []).filter((_, i) => !Array.isArray(only) || only.includes(proposal.ops.length + i))
      for (const fix of fixes) this.correctWord(state, fix.word, fix.text)
      const { ops, dropped } = rebase(state.log.current, chosen, state.index)
      if (ops.length) {
        const result = change(state, { ops, author: "agent" })
        if (!result.ok) throw new EngineFailure("input", "refused", result.diagnostics[0].message)
        // Accepting a proposal is the person's choice
        taste.note(state.id, ops, state.log.head)
      }
      return { applied: ops.length + fixes.length, dropped: dropped.map((d) => ({ change: describe(d.op, state.index), reason: d.reason })) }
    },

    /** What this Kriya allows now. A failed question means off. */
    async features() {
      if (!known || Date.now() - known.at > FEATURES_MS) known = { at: Date.now(), value: await features().catch(() => ({ visuals: false, playbooks: false, mediaSearch: false })) }
      // A server from before editing.motion says nothing of it: off
      return { motion: false, customMotion: false, ...known.value }
    },

    /** One motion graphic as the render will draw it, for the Plan Card. @returns {string} a complete document */
    graphicPreview(state, raw, format) {
      const graphic = cleanGraphic(raw)
      if (!graphic) throw new EngineFailure("input", "bad_graphic", "That isn't a graphic from this project's plan.")
      const shape = FORMATS[format] ?? FORMATS["9:16"]
      const canvas = { width: shape.width, height: shape.height }
      // Where a strap or a title usually lands; the make places each clear of the face and the captions
      const low = graphic.kind === "lower" || graphic.kind === "end"
      const placement = { x: Math.round(canvas.width * 0.1), y: Math.round(canvas.height * (low ? 0.66 : 0.42)), w: Math.floor((canvas.width * DEFAULT_RULES.boxWidth) / 100), h: Math.floor((canvas.height * DEFAULT_RULES.boxHeight) / 100) }
      // A graphic sits over footage; the card shows it on a plain backdrop so a light or dark plate both read
      return blockComposition({ blockId: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: graphic, placement, duration: graphicLength(graphic) }, { output: canvas, canvas }).replace("html,body{margin:0;background:transparent", "html,body{margin:0;background:linear-gradient(160deg,#6b7b80,#2a3437)")
    },

    /**
     * One scene as the render will draw it, for the Plan Card: the words fall where they will,
     * so the person sees the real thing before anything is rendered.
     * @returns {string} a complete document
     */
    scenePreview(state, raw, format) {
      const scene = cleanScene(raw)
      const words = new Map(state.index.words.map((w) => [w.id, w]))
      const from = words.get(scene?.from)
      const to = words.get(scene?.to)
      if (!from || !to || to.end <= from.start) throw new EngineFailure("input", "bad_scene", "That isn't a scene from this project's plan.")
      const shape = FORMATS[format] ?? FORMATS["9:16"]
      const canvas = { width: shape.width, height: shape.height }
      const safe = safeZoneFor({ canvas, deliverables: [{ preset: shape.preset, size: canvas }] })
      const { content } = sceneFrame(canvas, safe, { w: Math.floor((canvas.width * DEFAULT_RULES.boxWidth) / 100), h: Math.floor((canvas.height * DEFAULT_RULES.boxHeight) / 100) })
      const duration = to.end - from.start
      const landing = revealWords(scene, state.index.words.filter((w) => w.asset === from.asset && w.start >= from.start && w.end <= to.end))
      const items = scene.items.map((item, i) => ({ ...item, ...(landing[i] ? { reveal: Math.round(((landing[i].start - from.start) / FLICKS) * 1000) } : {}) }))
      return blockComposition({ blockId: SCENE_BLOCK, version: SCENE_VERSION, variables: { ...scene, items }, placement: content, duration }, { output: canvas, canvas })
    },

    foundOf(state) {
      const file = join(dirOf(state.id), "cache", "found.json")
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : NOTHING_FOUND
    },

    keepFound(state, { items = [], definitions = [] }) {
      const dir = join(dirOf(state.id), "cache")
      mkdirSync(dir, { recursive: true })
      const known = this.foundOf(state)
      const next = { items: { ...known.items, ...Object.fromEntries(items.map((item) => [item.id, item])) }, definitions: { ...known.definitions, ...Object.fromEntries(definitions.map((d) => [termId(d.term), d])) } }
      atomicWrite(join(dir, "found.json"), JSON.stringify(next))
    },

    /** A found picture's small version for the Plan Card, fetched once. Only ids this project's plan found. */
    async foundThumb(state, id, { signal } = {}) {
      const item = this.foundOf(state).items[id]
      if (!item || !allowedMediaUrl(item.thumb)) throw new EngineFailure("input", "unknown_media", "That picture isn't from this project's plan.")
      const dir = join(dirOf(state.id), "cache", "found-thumbs")
      mkdirSync(dir, { recursive: true })
      const base = join(dir, sha256(id).slice(0, 24))
      for (const [type, extension] of Object.entries(MEDIA_TYPES)) if (existsSync(`${base}${extension}`)) return { file: `${base}${extension}`, type }
      return downloadMedia(item.thumb, base, { signal, maxBytes: 12 * 1024 * 1024 })
    },

    /**
     * The approved pictures on disk, as assets with their credit, and the approved definitions as
     * kept. A still becomes a clip with a slow move. One that can't be had is left out with a note.
     */
    async resolveFound(state, brief, { signal, say }) {
      const found = this.foundOf(state)
      const words = new Map(state.index.words.map((w) => [w.id, w]))
      const shape = FORMATS[brief.format] ?? FORMATS["9:16"]
      const media = join(state.folder, "media")
      const pictures = []
      for (const { from, to, id } of brief.pictures ?? []) {
        const item = found.items[id]
        const first = words.get(from)
        const last = words.get(to)
        if (!item || !first || !last || !allowedMediaUrl(item.url)) {
          say("Left out a picture that isn't from this project's plan.")
          continue
        }
        try {
          mkdirSync(media, { recursive: true })
          const tag = `found-${sha256(id).slice(0, 16)}`
          const seconds = Math.min(16, Math.ceil((last.end - first.start) / FLICKS) + 2)
          const clipName = `${tag}-${shape.width}x${shape.height}-${seconds}s.mp4`
          const note = `${item.title} by ${item.creator}, ${item.licence}, ${item.page}`
          let known = state.log.current.assets.find((a) => a.path.endsWith(item.kind === "video" ? tag : clipName) || a.path.includes(`${tag}.`))
          if (!known) {
            const { file } = await downloadMedia(item.url, join(media, tag), { signal })
            let path = file
            if (item.kind === "image") {
              path = join(media, clipName)
              await runTool("ffmpeg", stillClipArgs({ image: file, output: path, width: shape.width, height: shape.height, seconds, inward: pictures.length % 2 === 0 }), { signal, timeoutMs: 180_000 })
            }
            known = await this.addAsset(state, path, { rights: item.rights, rightsNote: note })
          }
          pictures.push({ asset: known.id, from, to })
        } catch (error) {
          if (signal?.aborted) throw error
          say(`Left out the picture "${item.title}": ${error.message}`)
        }
      }
      const terms = (brief.terms ?? []).flatMap(({ at, id }) => {
        const d = found.definitions[id]
        return d && words.has(at) ? [{ at, term: d.term, quote: d.quote, source: d.source, page: d.page }] : []
      })
      return { pictures, terms }
    },

    /**
     * The last make this cut still descends from: its brief, story, approved plan and the
     * person's edits it carried (continuity.js). Null once that make is undone or none was run.
     */
    lastMake(state) {
      try {
        const last = JSON.parse(readFileSync(join(dirOf(state.id), "last-make.json"), "utf8"))
        const since = editsSince(state.log, last.head)
        return since ? { ...last, edits: [...(Array.isArray(last.carried) ? last.carried : []), ...since] } : null
      } catch {
        return null
      }
    },

    /** The story a make of this brief keeps from the last one; null when it's chosen again. */
    keptStory(state, brief) {
      return brief.fresh ? null : storyFor(this.lastMake(state), brief)
    },

    /** The Director's plan for the whole cut: proposed, never made until the person approves it. */
    async plan(state, { text, history = [], previous = null, choices = {}, job = 0, signal } = {}) {
      // With a cut already made, a request changes that cut: the plan it was made from is the one revised
      const fresh = STARTS_OVER.test(text)
      const last = fresh ? null : this.lastMake(state)
      previous ??= last?.plan ?? null
      // The references in use, each only for what the person took it for; with none named, every reference, whole
      const named = cleanRefs(choices.references)
      const chosen = named.length ? named : state.log.current.assets.filter((a) => a.kind === "reference").map((a) => ({ id: a.id, aspect: "all" }))
      const references = []
      for (const { id, aspect } of chosen) {
        const ref = state.log.current.assets.find((a) => a.id === id && a.kind === "reference")
        const found = ref && (await this.referenceAnalysis(state, ref.id, { signal }).catch(() => null))
        if (!found) continue
        const taken = takeFrom(found, aspect)
        const name = `${ref.path.split(/[\\/]/).at(-1)}${aspect === "all" ? "" : ` (only for: ${ASPECTS[aspect]})`}`
        references.push({ name, lines: taken.lines.length ? taken.lines : [`nothing measured for ${ASPECTS[aspect].toLowerCase()}`] })
      }
      const { visuals, playbooks, mediaSearch, motion } = await this.features()
      const device = mediaSearch ? readDevice() : null
      // What was found is kept here, so an approval names an id and never carries a URL or a licence from the browser
      const lookups = device ? { search: (queries) => searchMedia(device, queries), define: (terms) => defineTerms(device, terms), keep: (found) => this.keepFound(state, found) } : null
      const plan = await planCut({ ask: this.askFor(state, job), project: state.log.current, index: state.index, text, history, previous, references, choices, motion: motion && !state.engine.motion().missing, visuals: visuals && !state.engine.motion().missing, playbooks, lookups, signal })
      const scenes = plan.settings.scenes ?? []
      const brief = briefOf(plan.settings)
      // The exact brief an approval makes, so the Studio sends back what was shown
      return {
        ...plan,
        brief: { ...brief, ...(fresh ? { fresh: true } : {}) },
        // Said by code from the two briefs, so the card shows what an approval changes in the cut that's there,
        // and whether its story stays (the same test the make route applies, in the make's own units)
        ...(last ? { revises: true, differs: last.plan ? planDiff(briefOf(last.plan.settings ?? {}), brief) : [], keepsStory: !!storyFor(last, { ...(brief.seconds ? { targetDuration: Math.round(brief.seconds * FLICKS) } : {}), ...(brief.cuts ? { cuts: brief.cuts.map((c) => ({ from: Math.round(c.from * FLICKS), to: Math.round(c.to * FLICKS) })) } : {}) }) } : {}),
        // What the card may restyle each graphic to: labels only, the colours and fonts stay in code
        ...(plan.settings.graphics?.length ? { graphicChoices: { kinds: Object.fromEntries(Object.entries(GRAPHIC_KINDS).map(([id, kind]) => [id, { label: kind.label, styles: kind.styles }])), styles: STYLE_LABELS, accents: Object.keys(GRAPHIC_ACCENTS), tones: Object.keys(GRAPHIC_TONES), fonts: Object.keys(GRAPHIC_FONTS) } } : {}),
        // What the card may swap each scene to; code says, so it can't offer what won't draw
        ...(scenes.length ? { sceneChoices: { kinds: Object.fromEntries(Object.entries(SCENE_KINDS).map(([id, kind]) => [id, kind.label])), themes: Object.fromEntries(Object.entries(SCENE_THEMES).map(([id, theme]) => [id, theme.label])), swaps: scenes.map(swapsFor) } } : {}),
      }
    },

    /** A reference's classified analysis (reference.js), kept by its fingerprint so it's measured once. */
    async referenceAnalysis(state, assetId, { signal } = {}) {
      const asset = state.log.current.assets.find((a) => a.id === assetId && a.kind === "reference")
      if (!asset) throw new EngineFailure("input", "unknown_asset", "There is no such reference in this project.")
      const dir = join(dirOf(state.id), "cache", "refs")
      // .2: a video's soundtrack is measured too, and each line is kept under its aspect
      const file = join(dir, `${asset.fingerprint}.2.json`)
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
      const found = await analyseReference(sourcesOf(state)(assetId), asset.facts, { signal })
      mkdirSync(dir, { recursive: true })
      atomicWrite(file, JSON.stringify(found))
      return found
    },

    /** The person's fix of a misheard word; captions, the transcript and the Director read it from now on. */
    correctWord(state, word, text) {
      const clean = cleanWord(text)
      const asset = typeof word === "string" ? word.split(":w")[0] : ""
      if (!state.index.words.some((w) => w.id === word) || !state.indexDb.correct(asset, word, clean)) throw new EngineFailure("input", "unknown_word", "There's no such word in this project's transcript.")
      state.index = state.indexDb.read()
      state.engine.load(state.log.current, state.index)
      return state.index.words.find((w) => w.id === word)
    },

    /** A make job: the reel recipe through the Edit Loop, checked by the gates. */
    /**
     * A make job. With `replay`, the Director's slots are answered from that job's
     * recording (no model call), and nothing lands on the project (EDIT_LOOP §10).
     */
    async make(state, request, { job = 0, signal, onStep = () => {}, replay, beforeStory } = {}) {
      const video = state.log.current.assets.filter((a) => a.kind === "video")
      const asset = request.asset ?? video[0]?.id
      if (!asset || !video.some((a) => a.id === asset)) throw new EngineFailure("input", "no_take", "Add a video first.")
      if (!state.index.words.some((w) => w.asset === asset)) await this.indexAsset(state, asset, { signal })
      // References, classified (reference.js), numbers only and never placed on a track
      // (EDD-23): a video's pace and captions, an image's or video's colour, music's tempo and mood
      const styled = []
      let captionsFromReference = false
      const fromRefs = {}
      // Each reference gives only what the person took it for (editing, sound, colour, graphics, or
      // all); one taken for an aspect goes first, so it wins that aspect over one taken for everything
      const refs = cleanRefs([request.brief?.reference, ...(request.brief?.references ?? [])].filter(Boolean)).sort((a, b) => (a.aspect === "all") - (b.aspect === "all"))
      const aspectOf = new Map()
      for (const { id, aspect } of replay ? [] : refs) {
        const ref = state.log.current.assets.find((a) => a.id === id && a.kind === "reference")
        if (!ref) continue
        const name = ref.path.split(/[\\/]/).at(-1)
        try {
          const found = takeFrom(await this.referenceAnalysis(state, id, { signal }), aspect)
          if (aspect !== "all" && !found.lines.length) styled.push(`${name} has nothing Kriya can measure for ${ASPECTS[aspect].toLowerCase()}, so it wasn't used.`)
          const seconds = (request.brief.targetDuration ?? REEL_TALKING_HEAD.target.default) / FLICKS
          // The first reference to give an aspect sets it. One the person took for that aspect
          // is their explicit choice, so it outranks the brief's own setting there; one taken
          // for everything sits under the brief, as before
          const claim = (key) => !aspectOf.has(key) && (aspectOf.set(key, aspect), true)
          const explicit = aspect !== "all"
          if (found.pace?.every && claim("pace")) {
            const punches = Math.min(8, Math.max(1, Math.round(seconds / found.pace.every / 2)))
            if (explicit) request = { ...request, brief: { ...request.brief, punches } }
            else fromRefs.punches = punches
            styled.push(`Took the pace of ${name}: its picture changes every ${found.pace.every.toFixed(1)} s, so ${punches} punch-ins`)
          }
          if (found.captions && !request.brief.captions && !state.engine.motion().missing && claim("captions")) {
            fromRefs.captions = "clean"
            captionsFromReference = true
            styled.push(`${name} has captions, so this cut has them too`)
          }
          // An image says the most about colour, so it wins over a video's taken the same way
          const colourBy = aspectOf.get("colour")
          const colourFree = explicit ? colourBy === undefined || (colourBy !== "all" && found.kind === "image" && fromRefs.colourKind !== "image") : !request.brief.grade && (colourBy === undefined || (colourBy === "all" && found.kind === "image" && fromRefs.colourKind !== "image"))
          if (found.colour && colourFree) {
            aspectOf.set("colour", aspect)
            fromRefs.customGrade = found.colour.grade
            fromRefs.colourKind = found.kind
            if (explicit && request.brief.grade) request = { ...request, brief: { ...request.brief, grade: undefined } }
            styled.push(`Took the colour of ${name}: ${found.colour.words.join(", ")}`)
          }
          // A song the person chose stays; a reference taken for its sound replaces a generated bed
          const musicFree = explicit ? !request.brief.music || /^generated:/.test(request.brief.music) : !request.brief.music
          if (found.music && musicFree && claim("music")) {
            request = { ...request, brief: { ...request.brief, music: `generated:${found.music.mood}`, musicBpm: found.music.bpm ?? undefined } }
            styled.push(`Music follows ${name}: ${/^[aeiou]/.test(found.music.mood) ? "an" : "a"} ${found.music.mood} bed${found.music.bpm ? ` at ${found.music.bpm} bpm` : ""}`)
          }
        } catch (error) {
          if (signal?.aborted) throw error
          styled.push(`${name} couldn't be measured (${error.message}), so its style wasn't used.`)
        }
      }
      // "generated:<mood>": a bed Kriya writes itself (music-bed.js), so a cut can have music with no file to find
      const mood = /^generated:(\w+)$/.exec(request.brief?.music ?? "")?.[1]
      if (mood && Object.hasOwn(MOODS, mood) && !replay) {
        const seconds = Math.ceil((request.brief.targetDuration ?? REEL_TALKING_HEAD.target.default) / FLICKS) + 15
        const media = join(state.folder, "media")
        mkdirSync(media, { recursive: true })
        const bpm = request.brief.musicBpm
        const tag = `kriya-music-${mood}${bpm ? `-${bpm}bpm` : ""}-${seconds}s.wav`
        const file = join(media, tag)
        const known = state.log.current.assets.find((a) => a.kind === "audio" && a.path.endsWith(tag))
        if (!existsSync(file)) writeMusicBed(file, { mood, seconds, bpm })
        const bed = known ?? (await this.addAsset(state, file, { rights: "own", rightsNote: "Made by Kriya's music generator: no one else's recording." }))
        request = { ...request, brief: { ...request.brief, music: bed.id } }
      }
      // The pictures the person approved, downloaded now and not before, and their definitions as found
      if (request.brief?.pictures?.length || request.brief?.terms?.length) {
        const resolved = replay ? { pictures: [], terms: [] } : await this.resolveFound(state, request.brief, { signal, say: (line) => styled.push(line) })
        request = { ...request, brief: { ...request.brief, ...resolved } }
      }
      // Scenes are drawn by the motion layer: without it they go, with a note, rather than fail the cut
      if ((request.brief?.scenes?.length || request.brief?.terms?.length) && state.engine.motion().missing) {
        request = { ...request, brief: { ...request.brief, scenes: undefined, terms: undefined } }
        styled.push(`No animated scenes or definitions this time: ${state.engine.motion().missing}`)
      }
      // Sound design Kriya writes itself (sfx.js): a cut sound and an intro sound, each knowing its peak;
      // a whoosh as a scene arrives and a pop as each of its labels lands
      const sceneSound = (request.brief?.scenes?.length || request.brief?.pictures?.length) && request.brief.sceneSound !== false
      const wanted = { cut: request.brief?.cutSound, intro: request.brief?.introSound, scene: sceneSound ? "whoosh" : undefined, reveal: sceneSound ? "pop" : undefined }
      if (!replay && (wanted.cut || wanted.intro || wanted.scene)) {
        const media = join(state.folder, "media")
        mkdirSync(media, { recursive: true })
        const sfx = {}
        for (const [slot, kind] of Object.entries(wanted)) {
          if (!kind || !Object.hasOwn(SFX, kind)) continue
          const file = join(media, `kriya-sfx-${kind}.wav`)
          const made = writeSfx(file, kind)
          const known = state.log.current.assets.find((a) => a.kind === "audio" && a.path.endsWith(`kriya-sfx-${kind}.wav`))
          sfx[slot] = (known ?? (await this.addAsset(state, file, { rights: "own", rightsNote: "Made by Kriya's sound generator: no one else's recording.", extraFacts: { peak: made.peak } }))).id
        }
        request = { ...request, brief: { ...request.brief, sfx } }
      }
      // The song's beats, so the music can be fitted on its downbeats
      const song = request.brief?.music && state.log.current.assets.find((a) => a.id === request.brief.music && a.kind === "audio")
      if (song && !state.index.beats?.some((b) => b.asset === song.id)) await this.indexAsset(state, song.id, { signal })
      // A real choice goes to the person before the story is planned (TAVI_INTEGRATION §5)
      const picks = !replay && beforeStory ? await beforeStory(state, asset, { signal, sourcePath: sourcesOf(state) }) : null
      // The person's confirmed rules, under anything the brief says, and their choices. A
      // replay uses what the job really used. Captions only where they can render
      const recorded = replay?.answers.find((a) => a.task === "brief_extra")
      const extra = recorded ? JSON.parse(recorded.value) : { ...taste.defaults(), ...(picks && { picks }) }
      const { colourKind: _kind, ...fromRefBrief } = fromRefs
      Object.assign(extra, fromRefBrief)
      // Captions only where they can render: a missing runtime or Chrome drops them with a note,
      // rather than failing the whole cut at render (found in use: every render failed)
      const motionMissing = state.engine.motion().missing
      if (extra.captions && (!Object.hasOwn(LOOKS, extra.captions) || motionMissing)) delete extra.captions
      if (motionMissing && request.brief?.captions) {
        request = { ...request, brief: { ...request.brief, captions: undefined } }
        styled.push(`No captions this time: ${motionMissing}`)
      }
      if (!replay && Object.keys(extra).length) state.journal.answer({ job, task: "brief_extra", source: "person", value: extra })
      const usedRules = [...styled, ...(extra.captions && !request.brief?.captions && !captionsFromReference ? [`Used your rule: ${extra.captions} captions`] : []), ...(extra.zoom && !request.brief?.zoom ? [`Used your rule: ${extra.zoom.toFixed(2)}× zoom`] : [])]
      const stages = ["story", "check", "repair"]
      const run = runTool
      const work = join(dirOf(state.id), "cache", "gates")
      const sourcePath = sourcesOf(state)
      // A podcast's cameras or a montage's song: their own recipes, with the same render and gates.
      // Cameras that won't sync fall back to the reel, and it says so
      let planner = null
      let plannerRecipe = null
      const direct = { ...extra, ...request.brief }
      if (!replay && direct.multicam) {
        const { master, angles } = direct.multicam
        const facts = (id) => state.log.current.assets.find((a) => a.id === id)?.facts
        if (facts(master)?.duration && angles.every((a) => facts(a.asset))) {
          const analysis = await analyseMulticam({ master: { asset: master, file: sourcePath(master), duration: facts(master).duration }, angles: angles.map((a) => ({ ...a, file: sourcePath(a.asset) })) }, { signal })
          if (angles.every((a) => analysis.sync[a.asset].confidence >= PODCAST_MULTICAM.syncFloor)) {
            planner = () => planProgramme({ project: state.log.current, index: state.index, brief: direct, multicam: { master, angles, analysis } })
            plannerRecipe = programmeRecipe
          } else styled.push("The cameras' sound didn't match well enough to sync them, so this is cut from one camera.")
        }
      } else if (!replay && direct.montage && direct.music) {
        planner = () => planMontage({ project: state.log.current, index: state.index, brief: direct })
      }
      const runtime = activeRuntime(home)
      const ask = replay ? replayAsk(replay.answers) : this.askFor(state, job)
      const parent = state.log.head
      // The person's edits to the last cut go onto this one, unless they asked to start over
      const last = replay || request.brief?.fresh ? null : this.lastMake(state)
      const result = await makeReel({
        edits: last?.edits ?? [],
        project: state.log.current,
        head: state.log.head,
        index: state.index,
        asset,
        brief: { ...extra, ...request.brief },
        ask,
        render: (project, deliverable, abort) => state.engine.render({ quality: "master", deliverable, project, job, signal: abort }),
        sourcePath,
        signal,
        planner,
        plannerRecipe,
        onStage: (stage) => onStep(stages.indexOf(stage) + 1, stages.length + 1),
        gateKit: {
          tilePath: state.engine.tilePath,
          motion: state.engine.motion(),
          work,
          stems: state.engine.stems,
          binDir: join(base, "bin"),
          recognise: verifiedRecogniser(runtime, { run, work, language: state.log.current.brief?.language ?? "en" }),
          ask,
        },
      })
      // Each attempt as ranked, for the report: never the model's words
      const attempts = result.outcome.history.slice(1).map((h) => ({ round: h.round, accepted: h.accepted, level: h.verdict?.level ?? null, rank: h.rank, ...(h.verdict?.error ? { error: h.verdict.error } : {}) }))
      if (!result.best) return { verdict: "not_checked", notes: result.notes, calls: result.calls, stop: result.outcome.stop, changes: [], dropped: [], attempts }
      const gates = result.best.gates
      const planHash = result.best.plan ? sha256(canonical(result.best.plan)) : null
      const repairs = result.best.repairs ?? []
      const person = result.best.person ?? []
      const carried = result.best.carried ?? []
      const lost = result.best.dropped ?? []
      const notes = [...result.notes, ...(carried.length ? [`Kept ${carried.length} of your own edit${carried.length === 1 ? "" : "s"} to the last cut.`] : []), ...(lost.length ? [`${lost.length} of your edits no longer fit this cut and ${lost.length === 1 ? "was" : "were"} left out: ${lost.map((d) => describe(d.op, state.index)).join("; ")}.`] : []), ...person.map((p) => `${p.gate}: ${p.message} This is yours to decide.`)]
      if (replay) return { replayOf: replay.of, verdict: gates?.verdict ?? "not_checked", gates: gates?.gates ?? [], planHash, notes, repairs, calls: result.calls, stop: result.outcome.stop }
      const { ops, dropped } = state.log.head === result.head ? { ops: result.best.ops, dropped: [] } : rebase(state.log.current, result.best.ops, state.index)
      const landed = change(state, { ops, author: "agent" })
      if (!landed.ok) throw new EngineFailure("plan", "refused", landed.diagnostics[0].message)
      // What the next change to this cut starts from
      atomicWrite(join(dirOf(state.id), "last-make.json"), JSON.stringify({ head: state.log.head, brief: request.brief ?? {}, story: result.best.story ?? null, carried, plan: request.plan ?? (request.brief?.fresh ? null : (last?.plan ?? null)) }))
      // A caption per spoken line is one change to a person: said once, with the count
      const captioned = ops.filter((op) => op.op === "caption_style" && op.words?.length)
      const changes = [...usedRules, ...ops.filter((op) => !["ripple_delete", "reframe", "caption_style"].includes(op.op) || (op.op === "caption_style" && !op.words?.length)).map((op) => describe(op, state.index)), ...(captioned.length ? [`Captioned ${captioned.length} line${captioned.length === 1 ? "" : "s"} (${captioned[0].look})`] : [])]
      const { version } = await tools()
      const delivery = result.best.file
        ? await writeDelivery({ file: result.best.file, title: state.log.current.name, project: result.best.project, parent, plan: result.best.plan, sourcePath, tools: { engine: ENGINE_VERSION, ffmpeg: version, runtime: runtime?.version ?? null }, gates: gates?.gates ?? [], verdict: gates?.verdict ?? "not_checked", calls: state.journal.calls(job), changes, notes, repairs, beforeFrom: sourcePath(asset), run, work })
        : null
      if (delivery?.credits) changes.push(`Credits for your description are in ${delivery.credits.split(/[\\/]/).at(-1)}`)
      return {
        verdict: gates?.verdict ?? "not_checked",
        credits: delivery?.credits ?? null,
        file: result.best.file ?? null,
        head: state.log.head, // the version this file shows, so the Studio can say when it's out of date
        receipt: delivery?.receipt ?? null,
        report: delivery?.report ?? null,
        planHash,
        gates: gates?.gates ?? [],
        changes,
        notes,
        repairs,
        calls: result.calls,
        slots: result.slots,
        stop: result.outcome.stop,
        attempts,
        dropped: [...dropped, ...lost].map((d) => ({ change: describe(d.op, state.index), reason: d.reason })),
      }
    },

    /**
     * A revision: each note or change, in the person's words, through the same validated
     * console as the Studio (ES-20), then this cut rendered and gated. A note is pinned to
     * the word it was made at, so it shows on the Studio's timeline and survives re-cuts. A
     * note that can't become an edit is counted and left for the person, never forced.
     */
    async revise(state, request, { job = 0, signal, onStep = () => {} } = {}) {
      const recipe = REEL_TALKING_HEAD
      const deliverableOf = () => state.log.current.deliverables.find((d) => d.preset === recipe.deliverable.preset) ?? state.log.current.deliverables[0]
      if (!deliverableOf()) throw new EngineFailure("input", "no_cut", "There's no cut in this project to revise yet.")
      const notes = request.notes ?? []
      const steps = notes.length + 2
      let applied = 0
      let skipped = 0
      for (const [i, note] of notes.entries()) {
        signal?.throwIfAborted()
        onStep(i, steps)
        const word = Number.isSafeInteger(note.at) ? noteWord(state.log.current, state.index, note.at) : null
        if (word) change(state, { ops: [{ op: "mark", name: `Note: ${note.text}`.slice(0, 80), at: { word, edge: "start" } }], author: "code" })
        const { proposal } = await this.ask(state, { text: note.text, job, ...(word && { selection: { words: [word, word] } }) })
        if (proposal && this.decide(state, proposal.id, { accept: true }).applied > 0) applied++
        else skipped++
      }
      onStep(notes.length, steps)
      const parent = state.log.head
      const project = state.log.current
      const run = runTool
      const work = join(dirOf(state.id), "cache", "gates")
      const sourcePath = sourcesOf(state)
      const runtime = activeRuntime(home)
      const { file, plan } = await state.engine.render({ quality: "master", deliverable: deliverableOf().id, project, job, signal })
      onStep(notes.length + 1, steps)
      // shortcut: one render and its verdict, with no repair ladder; a make job climbs it, and a blocked revision says so
      const gates = await runGates({ file, plan, project, index: state.index, sourcePath, thresholds: recipe.thresholds, tilePath: state.engine.tilePath, motion: state.engine.motion(), work, stems: state.engine.stems, binDir: join(base, "bin"), recognise: verifiedRecogniser(runtime, { run, work, language: project.brief?.language ?? "en" }), ask: this.askFor(state, job) })
      const { version } = await tools()
      const mentions = gates.gates.filter((g) => g.status === "not_checked" || (g.status === "failed" && g.severity === "note")).map((g) => g.id)
      const delivery = await writeDelivery({ file, title: project.name, project, parent, plan, sourcePath, tools: { engine: ENGINE_VERSION, ffmpeg: version, runtime: runtime?.version ?? null }, gates: gates.gates, verdict: gates.verdict, calls: state.journal.calls(job), changes: [], notes: mentions, repairs: [], beforeFrom: null, run, work })
      return { verdict: gates.verdict, file, head: state.log.head, receipt: delivery?.receipt ?? null, report: delivery?.report ?? null, planHash: sha256(canonical(plan)), gates: gates.gates, notes: mentions, applied, skipped }
    },

    /** `kriya edit replay`: a make job again from its recording; it compares, and lands nothing. */
    async replay(state, number, { job = 0, signal, onStep } = {}) {
      const original = state.journal.job(number)
      if (!original || original.kind !== "make" || original.status !== "done") throw new EngineFailure("input", "no_job", "Only a finished make job can be replayed.")
      const answers = state.journal.answers(number)
      const again = await this.make(state, JSON.parse(original.request), { job, signal, onStep, replay: { of: `${state.id}.${number}`, answers } })
      const before = JSON.parse(original.dispatch)
      return { ...again, ...compareRuns(before, again) }
    },

    /** The current cut as a handoff package (OTIO, FCPXML, EDL, SRT) in the project's exports folder (EDIT_ENGINE §11). */
    handoff(state) {
      const done = writeHandoff({ project: state.log.current, index: state.index, exportsDir: join(state.folder, "exports"), sourcePath: sourcesOf(state) })
      return { ...done, folder: relative(state.folder, done.folder) }
    },

    /** What each layer found or why it couldn't, per asset, for the Studio to say. */
    indexStatus: (state) => state.log.current.assets.filter((asset) => state.indexDb.mediaOf(asset.id)).map((asset) => ({ asset: asset.id, layers: state.indexDb.layers(state.indexDb.mediaOf(asset.id)) })),
  }
}

