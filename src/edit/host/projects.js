// Projects on disk (DATA_MODEL §2): the project file is written atomically in the
// person's folder; its history and cache stay in ~/.kriya/edit/<id>/, never synced.

import { randomBytes } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path"

import { checkout, commit, createLog, parseEntry, undo, versions } from "../core/history.js"
import { apply } from "../core/ops.js"
import { canonical, newProject, parseProject, serialize, sha256 } from "../core/project.js"
import { createEngine, ENGINE_VERSION, guardPath } from "../engine/index.js"
import { blockComposition, customDocument, motionRuntime } from "../engine/motion.js"
import { confinement as osConfinement } from "../engine/confine.js"
import { CUSTOM_BLOCK, CUSTOM_VERSION, partsProblems } from "../engine/custom.js"
import { motionLength, nearestKit, writeMotion } from "../director/custom-motion.js"
import { gateCustomTile } from "../gates/tile.js"
import { cleanScene, SCENE_BLOCK, SCENE_KINDS, SCENE_THEMES, SCENE_VERSION, swapsFor } from "../engine/scenes.js"
import { parseCube } from "../engine/color.js"
import { fingerprint } from "../engine/media.js"
import { probe } from "../engine/probe.js"
import { EngineFailure, runTool } from "../engine/tool.js"
import { openJournal } from "../graph/journal.js"
import { DEFAULT_RULES, markPixels, solve } from "../core/solver.js"
import { safeZoneFor, sceneFrame } from "../core/layout.js"
import { revealWords } from "../director/beats.js"
import { termId } from "../director/lookups.js"
import { allowedMediaUrl, downloadMedia, MEDIA_TYPES, stillClipArgs } from "../engine/found-media.js"
import { measureLoudness } from "../engine/loudness.js"
import { planAssembly } from "../recipes/assembly.js"
import { planMontage } from "../recipes/montage.js"
import { analyseMulticam, PODCAST_MULTICAM } from "../recipes/multicam.js"
import { planProgramme, programmeRecipe } from "../recipes/programme.js"
import { defineTerms, fetchFeatures, searchMedia } from "../runtime/fetch.js"
import { readDevice } from "../../store.js"
import { models } from "../../api.js"
import { measureDraft, timelineOf, viewerReport } from "../director/viewer.js"
import { sayWatch } from "../director/watch-fix.js"
import { planOpenings } from "../recipes/openings.js"
import { createAsk } from "../director/ask.js"
import { LOOKS } from "../engine/captions.js"
import { cleanSelection, cleanWord, describe, noteWord, revise } from "../director/revise.js"
import { clipList, decideAssembly, isAssembly } from "../director/assembly.js"
import { cleanMentions, mentionsView } from "../director/mentions.js"
import { openIndexDb } from "../index/db.js"
import { makeReel, rebase } from "../loop/make.js"
import { runGates } from "../gates/index.js"
import { FORMATS, REEL_TALKING_HEAD } from "../recipes/reel.js"
import { compareRuns, replayAsk } from "../loop/replay.js"
import { verifiedRecogniser, writeDelivery, writeHandoff } from "./deliver.js"
import { createIndexer, layersFor } from "../index/index.js"
import { activeRuntime, childEnv } from "../runtime/setup.js"
import { readWords, recogniser, speechArgs, transcribeArgs } from "../index/layers/words.js"
import { editHome } from "./paths.js"
import { createTaste } from "./taste.js"
import { ASPECTS, analyseReference, cleanRefs, takeFrom } from "../engine/reference.js"
import { checkDna2, extractDna2, readDna2 } from "../engine/dna2.js"
import { referenceMatch } from "../engine/reference2.js"
import { applyStyleBrief, cleanOff, styleBrief } from "../core/style-brief.js"
import { SAFE_ZONES } from "../core/layout.js"
import { ALL_LOOKS } from "../engine/captions.js"
import { briefOf, planCut } from "../director/plan.js"
import { editsSince, planDiff, storyFor } from "../director/continuity.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic, GRAPHIC_ACCENTS, GRAPHIC_BLOCK, GRAPHIC_FONTS, GRAPHIC_KINDS, GRAPHIC_TONES, GRAPHIC_VERSION, graphicLength, REGIONS, STYLE_LABELS, STYLE_LABELS_2 } from "../engine/graphics.js"
import { ALL_MOODS, MOODS, writeAccent, writeMusicBed } from "../engine/music-bed.js"
import { SFX, SOUNDS, writeSfx } from "../engine/sfx.js"

// "start over", "from scratch": the one way a request after a make isn't a change to that cut
// "callout this", "circle it", "put an arrow on this": a drawn box asked to be marked (TP9)
const CALLOUT_ASKED = /\b(?:call ?out|circle|ring|highlight|arrow|point (?:at|to)|mark (?:this|it|that|here))\b/i
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
// The tiers this person's plan lists, exactly as Kriya says (GET /models): never a guess, so a slot is
// only ever sent on one of them (EH-65). Signed out or unanswered: none, and nothing escalates
const askTiers = async () => {
  const device = readDevice()
  if (!device) return null
  const answer = await models(device.url, device.token)
  return Array.isArray(answer?.data) ? answer.data.map((m) => m?.id).filter((id) => typeof id === "string") : null
}
const NOTHING_FOUND = { items: {}, definitions: {} }

/** Where the Plan Card shows a motion kit 2 graphic (EH-92): its region's box, as core/layout.js shapes it, on an empty frame. */
function regionPlacement(graphic, { width, height }) {
  const region = REGIONS[graphic.kind]
  if (!region) return null
  if (region.region === "full" || region.region === "frame") return { x: 0, y: 0, w: width, h: height }
  const margin = Math.round(Math.min(width, height) * 0.05)
  const w = Math.floor((region.region === "corner" ? width : width - 2 * margin) * region.w)
  const h = Math.floor(height * region.h)
  if (region.region === "third") return { x: Math.round((width - w) / 2), y: height - h - Math.round(height * 0.12), w, h }
  if (region.region === "corner") {
    const corner = graphic.corner ?? "tr"
    return { x: corner.endsWith("l") ? margin : width - w - margin, y: corner.startsWith("t") ? margin : height - h - margin, w, h }
  }
  const side = Math.min(w, h)
  const p = graphic.point ?? { x: Math.round(width / 2), y: Math.round(height / 2) }
  return { x: Math.min(Math.max(0, Math.round(p.x - side / 2)), width - side), y: Math.min(Math.max(0, Math.round(p.y - side / 2)), height - side), w: side, h: side }
}

/** TP9: the custom animations a project holds, by clip, so chat can place one again with no model call. */
function customBlocksOf(project) {
  return project.sequences.flatMap((q) => q.clips).flatMap((clip) => {
    const block = clip.effects.find((e) => e.type === "block" && e.blockId === CUSTOM_BLOCK && e.version === CUSTOM_VERSION)
    return block && !partsProblems(block.variables).problems.length ? [{ clip: clip.id, ...(block.variables.name ? { name: block.variables.name } : {}), variables: block.variables }] : []
  })
}

export function createProjects({ home, roots, scheduler, tools, governor = null, features = askServer, tiers = askTiers, confinement = osConfinement, gateTile = gateCustomTile }) {
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
    // TP9: a custom animation is drawn only while Kriya says editing.customMotion is on and the OS confines Chrome
    const engine = createEngine({ folder, roots: [...roots, folder], cache: join(dir, "cache"), exports: join(folder, "exports"), journal, toolVersion: version, capabilities, scheduler, motion: () => motionRuntime(activeRuntime(home)), customMotion: () => known?.value?.customMotion === true && !!confinement().kind })
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
    askFor(state, job = 0, { tiers: listed = null } = {}) {
      if (!governor) throw new EngineFailure("environment", "no_director", "This Host has no Director.")
      let left = JOB_CALLS
      // listed: the plan's tiers, only with editing.directorLoop on (TP8); absent, no slot escalates
      const ask = createAsk({ governor, record: (row) => state.journal.call({ job, ...row }), budget: { take: () => left-- > 0 }, ...(listed ? { tiers: listed } : {}) })
      // Each slot's final answer, so the job can be replayed with no model call
      return async (slot) => {
        const answer = await ask(slot)
        state.journal.answer({ job, task: slot.task, source: answer.source, value: answer.value })
        return answer
      }
    },

    /** Whether this computer can turn speech into text locally: the Media Runtime's recogniser and its weights (EB-11). */
    canDictate: () => !recogniser(activeRuntime(home)).missing,

    /**
     * Hold to talk (TP4, ASSEMBLY_AND_INTENT §7.4): a few seconds of the person's microphone to text, by the local
     * recogniser only; no audio leaves the computer. It waits for the recogniser's slot behind an index job (EH-75).
     * @param {Buffer} audio what the Studio recorded
     */
    async dictate(state, audio, { signal } = {}) {
      const engine = recogniser(activeRuntime(home))
      if (engine.missing) throw new EngineFailure("environment", "no_recogniser", engine.missing)
      const dir = join(dirOf(state.id), "cache", "dictation", randomBytes(6).toString("hex"))
      mkdirSync(dir, { recursive: true })
      const release = scheduler ? await scheduler.acquire(["gpu"], { signal }) : () => {}
      try {
        const input = join(dir, "said.media")
        writeFileSync(input, audio)
        const wav = join(dir, "said.wav")
        await runTool("ffmpeg", speechArgs(input, wav), { signal, timeoutMs: 60_000 })
        const env = { ...childEnv(), HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" }
        const words = readWords(await runTool(engine.python, transcribeArgs(engine, wav, state.log.current.brief?.language ?? "en"), { signal, env, timeoutMs: 120_000 }))
        return { text: words.map((w) => w.text).join(" ").replace(/[\u0000-\u001f<>]/g, " ").slice(0, 2000) }
      } finally {
        release()
        rmSync(dir, { recursive: true, force: true })
      }
    },

    /** The console: words → a proposal, applied to a copy, nothing landing yet (UX_SPEC §4, §5). */
    async ask(state, { text, selection, history = [], mentions, mark, job = 0 }) {
      const chosen = cleanSelection(selection, state.log.current, state.index)
      const { motion, intent, craft, typeKit, customMotion } = await this.features()
      // TP9: a drawn box and custom motion only with editing.customMotion on; off, the request is asked as it always was
      const pointing = customMotion === true ? { customMotion: true, ...(mark ? { mark } : {}), customBlocks: customBlocksOf(state.log.current) } : {}
      const result = await revise({ ask: this.askFor(state, job), project: state.log.current, index: state.index, text, selection: chosen, history, motion: motion && !state.engine.motion().missing, pointed: await this.pointed(state, mentions, text), intent, craft, ...(typeKit ? { typeKit } : {}), ...pointing })
      // A custom animation the console asked for: written by its own slot, gated on its rendered tile, then proposed
      let motionOf = null
      if (result.custom?.length) {
        const made = await this.customMotionOp(state, result.custom[0], { text, history, job })
        if (made.op) {
          const tried = apply(state.log.current, [...result.ops, made.op], { index: state.index, author: "agent" })
          if (tried.applied) {
            result.ops = [...result.ops, made.op]
            result.changes = [...result.changes, describe(made.op, state.index)]
            result.project = tried.project
            motionOf = { op: result.ops.length - 1, ...(made.gates ? { gates: made.gates } : {}) }
          } else result.say = `${result.say ? `${result.say} ` : ""}The custom animation couldn't go there: ${tried.diagnostics[0].message}.`.trim()
        } else result.say = `${result.say ? `${result.say} ` : ""}${made.say}`.trim()
      }
      // TP4: what the change couldn't do, in the person's words; only with editing.intent on
      const cannot = result.cannot?.length ? { cannot: result.cannot } : {}
      // A request about the whole video goes to the Director's make job; the Studio offers it
      const direct = result.direct ? { brief: { ...(result.direct.seconds ? { seconds: result.direct.seconds } : {}), ...(result.direct.captions ? { captions: result.direct.captions } : {}) } } : null
      if (!result.ops.length && !result.corrections.length) return { proposal: null, direct, say: result.say, source: result.source, reason: direct || result.say || cannot.cannot ? null : (result.reason ?? "Kriya couldn't turn that into an edit. Try saying it another way."), ...cannot }
      const id = randomBytes(6).toString("hex")
      state.proposals.set(id, { ops: result.ops, corrections: result.corrections, head: state.log.head })
      const { picture, duration } = solve(result.project ?? state.log.current, state.index)
      // Changes in one list, operations first, then corrections: "Only this" counts across both
      return { proposal: { id, ops: result.ops, changes: [...result.changes, ...result.corrections.map((c) => c.change)], timeline: result.ops.length ? { picture, duration } : null, ...(motionOf ? { motion: motionOf } : {}) }, direct, say: result.say, source: result.source, ...(result.reason ? { reason: result.reason } : {}), ...cannot }
    },

    /**
     * MG2 (TP9): one custom animation for a proposal. A saved one is placed again with no model call; a new
     * one is written on `balanced` only when Kriya lists it (EH-65), at most two calls, then its tile is
     * rendered confined and must pass QG-08…11 before the person sees it. Refused, it says why and names
     * the nearest kit graphic; it never loops and never falls back to unchecked code.
     * @returns {Promise<{ op: object, gates?: object[] } | { say: string }>}
     */
    async customMotionOp(state, request, { text, history = [], job = 0 }) {
      const project = state.log.current
      const duration = motionLength(request.duration)
      if (request.reuse !== undefined) {
        const saved = customBlocksOf(project).find((b) => b.clip === request.reuse)
        if (!saved) return { say: "That saved animation isn't in this project any more." }
        return { op: { op: "add_motion", block: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables: saved.variables, at: request.at, duration } }
      }
      const person = [...history.filter((h) => h.who === "you").map((h) => h.text), text].join("\n")
      const words = state.index.words ?? []
      const runtime = state.engine.motion()
      const which = confinement()
      const nearestSay = (why, nearest) => `${why} The nearest the kit has is a ${nearest.label.toLowerCase()}: ask for one if it would do.`
      if (runtime.missing) return { say: nearestSay("A custom animation needs the Media Runtime's Chrome to be checked before you see it.", nearestKit(person)) }
      const canvas = { width: project.canvas.width, height: project.canvas.height }
      const made = await writeMotion({ ask: this.askFor(state, job), tiers: await this.allowedTiers(), allowed: (await this.features()).customMotion === true, which, person, describe: request.text, spoken: words.map((w) => w.text).join(" "), canvas, duration })
      if (!made.node) return { say: nearestSay(`I couldn't make that custom animation: ${made.reason.replace(/\.$/, "")}.`, made.nearest) }
      const fps = project.canvas.fps
      const zone = safeZoneFor(project)
      const work = join(dirOf(state.id), "cache", "custom", randomBytes(6).toString("hex"))
      try {
        const gated = await gateTile({ node: made.node, output: { ...canvas, fps }, canvas, safe: { top: zone.top ?? 0, right: zone.right ?? 0, bottom: zone.bottom ?? 0, left: zone.left ?? 0 }, runtime, work, which, binDir: join(base, "bin") })
        const failed = gated.results.find((r) => r.status === "failed")
        if (failed) return { say: nearestSay(`I wrote a custom animation, but its check failed (${failed.id}: ${failed.failures[0]?.kind?.replaceAll("_", " ") ?? "failed"}), so it isn't offered.`, made.nearest) }
        return { op: { op: "add_motion", block: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables: made.node.variables, at: request.at, duration }, gates: gated.results.map(({ id, status }) => ({ id, status })).sort((a, b) => (a.id < b.id ? -1 : 1)) }
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    },

    /** A proposal's custom animation as the render will draw it, for its sandboxed preview. @returns {string} a document */
    customPreview(state, proposalId, n) {
      const op = state.proposals.get(proposalId)?.ops?.[n]
      if (!op || op.op !== "add_motion" || op.block !== CUSTOM_BLOCK) throw new EngineFailure("input", "no_preview", "That proposal has no custom animation to show.")
      const canvas = { width: state.log.current.canvas.width, height: state.log.current.canvas.height }
      const html = customDocument({ blockId: CUSTOM_BLOCK, version: CUSTOM_VERSION, variables: op.variables, duration: op.duration }, { output: canvas, canvas }, { allowed: true, which: confinement() })
      return html.replace("html,body{margin:0;background:transparent", "html,body{margin:0;background:linear-gradient(160deg,#6b7b80,#2a3437)")
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

    /**
     * The clips a message points at, as the Director reads them (mentions.js). With
     * editing.assembly off no mention resolves: the message is asked as it always was.
     * @returns {Promise<string>} empty when there are none
     */
    async pointed(state, mentions, text) {
      if (mentions === undefined || !(await this.features()).assembly) return ""
      const clean = cleanMentions(state.log.current, mentions, text)
      if (!clean) throw new EngineFailure("input", "bad_mention", "That message points at a clip that isn't in this project. Pick the clip again.")
      return mentionsView(state.log.current, clean)
    },

    /** What this Kriya allows now. A failed question means off. */
    async features() {
      if (!known || Date.now() - known.at > FEATURES_MS) known = { at: Date.now(), value: await features().catch(() => ({ visuals: false, playbooks: false, mediaSearch: false })) }
      // A server from before editing.motion, editing.assembly or editing.livePreview says nothing of it: off
      return { motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft: false, typeKit: false, referenceIntent: false, directorLoop: false, taviOrder: false, ...known.value }
    },

    /** The tiers Kriya lists for this person now, or null when it can't say: then nothing escalates. */
    async allowedTiers() {
      try {
        return await tiers()
      } catch {
        return null
      }
    },

    /** One motion graphic as the render will draw it, for the Plan Card. @returns {string} a complete document */
    graphicPreview(state, raw, format, { typeKit = false, drawn = false } = {}) {
      // EH-92: motion kit 2 with editing.typeKit on; TP9: a callout round a drawn box with editing.customMotion on. Else MG1's kinds
      const graphic = cleanGraphic(raw, typeKit || (drawn && raw?.kind === "callout" && raw?.mark) ? ALL_GRAPHIC_KINDS : undefined)
      if (!graphic) throw new EngineFailure("input", "bad_graphic", "That isn't a graphic from this project's plan.")
      const shape = FORMATS[format] ?? FORMATS["9:16"]
      const canvas = { width: shape.width, height: shape.height }
      if (graphic.mark) return blockComposition({ blockId: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: graphic, placement: markPixels(graphic.mark, canvas), duration: graphicLength(graphic) }, { output: canvas, canvas }).replace("html,body{margin:0;background:transparent", "html,body{margin:0;background:linear-gradient(160deg,#6b7b80,#2a3437)")
      // Where a strap or a title usually lands; the make places each clear of the face and the captions
      const low = graphic.kind === "lower" || graphic.kind === "end"
      // EH-92: a motion kit 2 graphic in the place its region gives it (the make's solver places it clear of the face)
      const placement = regionPlacement(graphic, canvas) ?? { x: Math.round(canvas.width * 0.1), y: Math.round(canvas.height * (low ? 0.66 : 0.42)), w: Math.floor((canvas.width * DEFAULT_RULES.boxWidth) / 100), h: Math.floor((canvas.height * DEFAULT_RULES.boxHeight) / 100) }
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
    async plan(state, { text, history = [], previous = null, choices = {}, mentions, mark, job = 0, signal } = {}) {
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
        // TP6: a reference whose style was read gives the plan its brief's lines (code's own sentences over numbers),
        // less what the person unticked. The same one call as before: no slot, no extra call (EH-64)
        const style = aspect === "all" && (await this.features()).referenceIntent === true ? await this.styleBriefFor(state, id, choices.format) : null
        if (style) {
          const off = choices.styleBrief?.ref === id ? cleanOff(choices.styleBrief.off) : []
          references.push({ name, lines: style.lines.filter((line) => line.state !== "cannot" && !off.includes(line.id)).map((line) => `${line.text}${line.why ? ` (${line.why})` : ""}`) })
          continue
        }
        references.push({ name, lines: taken.lines.length ? taken.lines : [`nothing measured for ${ASPECTS[aspect].toLowerCase()}`] })
      }
      const { visuals, playbooks, mediaSearch, motion, assembly, intent, craft, typeKit } = await this.features()
      const device = mediaSearch ? readDevice() : null
      // What was found is kept here, so an approval names an id and never carries a URL or a licence from the browser
      const lookups = device ? { search: (queries) => searchMedia(device, queries), define: (terms) => defineTerms(device, terms), keep: (found) => this.keepFound(state, found) } : null
      const plan = await planCut({ ask: this.askFor(state, job), project: state.log.current, index: state.index, text, history, previous, references, choices, motion: motion && !state.engine.motion().missing, visuals: visuals && !state.engine.motion().missing, playbooks, lookups, pointed: await this.pointed(state, mentions, text), intent, craft, ...(typeKit ? { typeKit } : {}), signal })
      // The film's order (TP2, ASSEMBLY_AND_INTENT §4, §5), only with editing.assembly on: this message's mentions and
      // words, then the storyboard, then earlier messages, then the plan being revised, then the Director, then the
      // default. The Director's slot is asked only when something is open
      const ordered = assembly ? await this.order(state, { text, history, previous, mentions, job, signal, targetDuration: plan.settings.seconds ? Math.round(plan.settings.seconds * FLICKS) : undefined }) : null
      if (ordered?.assembly) plan.settings.assembly = ordered.assembly
      else delete plan.settings.assembly
      // TP9: a box drawn on the frame with a request to mark it becomes a callout among the plan's graphics, placed by
      // code where it was drawn, on the word under it; only with editing.customMotion and editing.motion on
      if (mark && motion && (await this.features()).customMotion === true && CALLOUT_ASKED.test(text)) {
        const word = noteWord(state.log.current, state.index, mark.at)
        const graphic = word ? cleanGraphic({ kind: "callout", style: mark.kind, mark: { x: mark.x, y: mark.y, w: mark.w, h: mark.h }, at: word }, ALL_GRAPHIC_KINDS) : null
        if (graphic) plan.settings.graphics = [...(plan.settings.graphics ?? []).filter((g) => !g.mark), graphic]
      }
      const scenes = plan.settings.scenes ?? []
      const brief = briefOf(plan.settings)
      // The exact brief an approval makes, so the Studio sends back what was shown
      return {
        ...plan,
        // The Order section of the card: each part as the person knows it, and each decision that wasn't theirs
        ...(ordered?.assembly ? { order: { source: ordered.source, lines: ordered.lines, parts: this.orderView(state, ordered.assembly) } } : ordered?.lines.length ? { order: { source: null, lines: ordered.lines, parts: [] } } : {}),
        brief: { ...brief, ...(fresh ? { fresh: true } : {}) },
        // Said by code from the two briefs, so the card shows what an approval changes in the cut that's there,
        // and whether its story stays (the same test the make route applies, in the make's own units)
        ...(last ? { revises: true, differs: last.plan ? planDiff(briefOf(last.plan.settings ?? {}), brief) : [], keepsStory: !!storyFor(last, { ...(brief.seconds ? { targetDuration: Math.round(brief.seconds * FLICKS) } : {}), ...(brief.cuts ? { cuts: brief.cuts.map((c) => ({ from: Math.round(c.from * FLICKS), to: Math.round(c.to * FLICKS) })) } : {}) }) } : {}),
        // What the card may restyle each graphic to: labels only, the colours and fonts stay in code
        // EH-92: with editing.typeKit on, the card knows motion kit 2's kinds and styles too
        ...(plan.settings.graphics?.length ? { graphicChoices: { kinds: Object.fromEntries(Object.entries(typeKit ? ALL_GRAPHIC_KINDS : GRAPHIC_KINDS).map(([id, kind]) => [id, { label: kind.label, styles: kind.styles }])), styles: typeKit ? { ...STYLE_LABELS, ...STYLE_LABELS_2 } : STYLE_LABELS, accents: Object.keys(GRAPHIC_ACCENTS), tones: Object.keys(GRAPHIC_TONES), fonts: Object.keys(GRAPHIC_FONTS) } } : {}),
        // What the card may swap each scene to; code says, so it can't offer what won't draw
        ...(scenes.length ? { sceneChoices: { kinds: Object.fromEntries(Object.entries(SCENE_KINDS).map(([id, kind]) => [id, kind.label])), themes: Object.fromEntries(Object.entries(SCENE_THEMES).map(([id, theme]) => [id, theme.label])), swaps: scenes.map(swapsFor) } } : {}),
      }
    },

    /** The film's order for a plan (director/assembly.js). The storyboard stored on the project is the Studio's own to read here. */
    async order(state, { text, history = [], previous = null, mentions, job = 0, signal, targetDuration }) {
      const project = state.log.current
      const pointed = mentions === undefined ? [] : (cleanMentions(project, mentions, text) ?? [])
      const storyboard = project.sequences.find((q) => q.id === project.active)?.assembly ?? null
      return decideAssembly({ project, index: state.index, text, mentions: pointed, storyboard, history, previous: previous?.settings?.assembly ?? null, ask: this.askFor(state, job), targetDuration, signal })
    },

    /** An assembly's parts as the card shows them: number, label, stretch in seconds, use, who decided. Labels are data. */
    orderView(state, assembly) {
      const clips = clipList(state.log.current, state.index)
      const words = new Map(state.index.words.map((w) => [w.id, w]))
      const edge = (ref, side) => (ref === undefined ? null : typeof ref === "number" ? ref : (words.get(ref.word)?.[ref.edge ?? side] ?? null))
      return assembly.parts.map((part) => {
        const clip = clips.find((c) => c.asset === part.asset)
        return { id: part.id, asset: part.asset, number: clip?.n ?? null, label: clip?.label || clip?.name || "", from: edge(part.from, "start"), to: edge(part.to, "end"), duration: clip?.duration ?? null, use: part.use, why: part.why ?? null, ...(part.at ? { at: part.at } : {}), ...(part.fit ? { fit: part.fit } : {}) }
      })
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

    /* TP6 (CRAFT_UPGRADE §4, EDD-65), behind editing.referenceIntent: Edit DNA 2 and the style brief */

    /** Where a reference's Edit DNA 2 is kept: its own name, so an older analysis is never read as this shape (EH-73). */
    dna2File(state, asset) {
      return join(dirOf(state.id), "cache", "refs", `${asset.fingerprint}.dna2.json`)
    },

    /**
     * A reference's measured Edit DNA 2, or null when it hasn't been measured. Never measures: a plan
     * and a make only read what the measuring job kept (EH-73). A file that isn't this version's
     * shape, or isn't numbers and fixed words, counts as not measured.
     */
    referenceDna(state, assetId) {
      const asset = state.log.current.assets.find((a) => a.id === assetId && a.kind === "reference")
      if (!asset) return null
      const file = this.dna2File(state, asset)
      return existsSync(file) ? readDna2(readFileSync(file, "utf8")) : null
    },

    /**
     * Measures a reference's Edit DNA 2 and keeps it. Only ever a job's work: it has progress and a
     * cancel, and anything without a job number is refused, so a plan or a make can't start it (EH-73).
     */
    async measureReference(state, assetId, { job, signal, onStep = () => {}, measure = extractDna2 } = {}) {
      if (!Number.isInteger(job) || job <= 0) throw new EngineFailure("input", "refused", "A reference is measured as its own job, never inside a plan or a make.")
      const asset = state.log.current.assets.find((a) => a.id === assetId && a.kind === "reference")
      if (!asset) throw new EngineFailure("input", "unknown_asset", "There is no such reference in this project.")
      if (!asset.facts.width || !asset.facts.duration) throw new EngineFailure("input", "refused", "Only a video reference has a style to read: an image gives its colour, music its tempo.")
      const dna = checkDna2(await measure(sourcesOf(state)(assetId), { signal, onStep }))
      const file = this.dna2File(state, asset)
      mkdirSync(dirname(file), { recursive: true })
      atomicWrite(file, JSON.stringify(dna))
      return { asset: assetId, traits: Object.values(dna).filter((v) => v?.read === "yes").length }
    },

    /** What this server and computer can do with a reference, for a cut of this shape. */
    async styleCan(state, format) {
      const { motion, craft, typeKit } = await this.features()
      const { width, height } = FORMATS[format] ?? state.log.current.canvas
      const tall = height > width
      const looks = typeKit ? ALL_LOOKS : LOOKS
      return { looks, lookLabels: Object.fromEntries(Object.keys(looks).map((id) => [id, `${id.charAt(0).toUpperCase()}${id.slice(1)}`])), moods: craft ? ALL_MOODS : MOODS, motion: motion && !state.engine.motion().missing, craft, tall, ...(tall ? { safe: { top: SAFE_ZONES["reel-9x16"].top, bottom: SAFE_ZONES["reel-9x16"].bottom } } : {}) }
    },

    /** A measured reference's style brief, or null when it hasn't been measured yet. */
    async styleBriefFor(state, assetId, format) {
      const dna = this.referenceDna(state, assetId)
      return dna ? styleBrief(dna, await this.styleCan(state, format)) : null
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
      // The film's order, only from this make's own brief (EH-63): never the storyboard stored on the project
      const order = isAssembly(request.brief?.assembly?.parts) ? request.brief.assembly : null
      const asset = request.asset ?? order?.parts.find((p) => ["story", "whole"].includes(p.use) && video.some((a) => a.id === p.asset))?.asset ?? video[0]?.id
      if (!asset || !video.some((a) => a.id === asset)) throw new EngineFailure("input", "no_take", "Add a video first.")
      if (!state.index.words.some((w) => w.asset === asset)) await this.indexAsset(state, asset, { signal })
      // An assembly's files: each is where it was, or it is left out; one asked for by name ends the make for the person (§8)
      const there = (id) => {
        try {
          return existsSync(sourcesOf(state)(id))
        } catch {
          return false
        }
      }
      const offline = order ? [...new Set(order.parts.map((p) => p.asset))].filter((id) => !there(id)) : []
      if (order && !replay) {
        const numbers = clipList(state.log.current, state.index)
        const asked = order.parts.filter((p) => offline.includes(p.asset) && (p.why === "person" || p.why === "storyboard"))
        if (asked.length) return { verdict: "needs_you", notes: [`${[...new Set(asked.map((p) => `Clip ${numbers.find((c) => c.asset === p.asset)?.n ?? "?"}`))].join(" and ")} ${asked.length === 1 ? "is" : "are"} in the order you gave, and ${asked.length === 1 ? "its file isn't" : "their files aren't"} where ${asked.length === 1 ? "it was" : "they were"}. Put ${asked.length === 1 ? "it" : "them"} back, or take ${asked.length === 1 ? "it" : "them"} out of the storyboard, and make it again.`], calls: 0, stop: "needs_you", changes: [], dropped: [], attempts: [], gates: [] }
        // Each part's file is read once, so its words and shots are there to cut by
        for (const id of new Set(order.parts.map((p) => p.asset))) if (!offline.includes(id) && !state.index.words.some((w) => w.asset === id) && !state.index.shots.some((s) => s.asset === id)) await this.indexAsset(state, id, { signal })
      }
      // References, classified (reference.js), numbers only and never placed on a track
      // (EDD-23): a video's pace and captions, an image's or video's colour, music's tempo and mood
      const styled = []
      // TP7: the type kit this make's own brief carries (the person's, or an approved plan's), stored as theirs;
      // a brief without one leaves the project's look alone (EH-69, audit §6 rule 4)
      const kit = request.brief?.typeKit
      if (kit && JSON.stringify(state.log.current.look.brand?.type ?? null) !== JSON.stringify(kit)) {
        const stored = change(state, { ops: [{ op: "set_type_kit", ...kit }], author: "person" })
        if (!stored.ok) styled.push(`The type kit wasn't used: ${stored.diagnostics[0]?.message ?? "it doesn't fit this project"}.`)
      }
      styled.push(...(request.brief?.packNotes ?? []))
      let captionsFromReference = false
      const fromRefs = {}
      // Each reference gives only what the person took it for (editing, sound, colour, graphics, or
      // all); one taken for an aspect goes first, so it wins that aspect over one taken for everything
      const refs = cleanRefs([request.brief?.reference, ...(request.brief?.references ?? [])].filter(Boolean)).sort((a, b) => (a.aspect === "all") - (b.aspect === "all"))
      const aspectOf = new Map()
      // TP6: the style brief this make's own brief carries (editing.referenceIntent; the Host drops the key without it).
      // Read from what the measuring job kept, never measured here (EH-73); unmeasured, the reference works as it did
      const styleOf = !replay && request.brief?.styleBrief ? { ...request.brief.styleBrief, dna: this.referenceDna(state, request.brief.styleBrief.ref) } : null
      if (styleOf && !styleOf.dna) styled.push("That reference's style hasn't been read yet (Read its style, in References), so this cut took only what a quick look gives.")
      // The key is the Host's own: no recipe, record or replay sees it
      if (styleOf) request = { ...request, brief: (({ styleBrief: _brief, ...rest }) => rest)(request.brief) }
      let fit = null
      for (const { id, aspect } of replay ? [] : refs) {
        const ref = state.log.current.assets.find((a) => a.id === id && a.kind === "reference")
        if (!ref) continue
        if (styleOf?.dna && id === styleOf.ref) continue
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
      if (styleOf?.dna) {
        const seconds = (request.brief.targetDuration ?? REEL_TALKING_HEAD.target.default) / FLICKS
        const style = styleBrief(styleOf.dna, await this.styleCan(state, request.brief.format))
        const applied = applyStyleBrief(request.brief, style, styleOf.off, { seconds })
        request = { ...request, brief: applied.brief }
        styled.push(...applied.notes)
        // Its colour, measured against this take and matched within limits: a LUT Kriya writes from two sets of numbers
        const take = state.log.current.assets.find((a) => a.id === asset)
        if (applied.colourMatch && (await tools()).capabilities.filters?.has("lut3d")) {
          try {
            const match = await referenceMatch(sourcesOf(state)(asset), (take.facts.duration ?? 0) / FLICKS, styleOf.dna.colour, { signal })
            const media = join(state.folder, "media")
            mkdirSync(media, { recursive: true })
            const name = `kriya-look-${sha256(match.cube).slice(0, 12)}.cube`
            const file = join(media, name)
            if (!existsSync(file)) atomicWrite(file, match.cube)
            const lut = state.log.current.assets.find((a) => a.kind === "lut" && a.path.endsWith(name)) ?? (await this.addAsset(state, file, { rights: "own", rightsNote: "A colour match Kriya computed from measurements: no one else's picture." }))
            request = { ...request, brief: { ...request.brief, lut: lut.id } }
            styled.push(`From your reference: its colour, matched to your footage by measurement${match.limited ? ". Your footage is further from it than a match may move, so it went part of the way" : ""}.`)
          } catch (error) {
            if (signal?.aborted) throw error
            styled.push(`The reference's colour wasn't matched (${error.message}).`)
          }
        } else if (applied.colourMatch) styled.push("The reference's colour wasn't matched: this computer's FFmpeg has no lut3d.")
        fit = { kept: applied.kept.map(({ id, text, target }) => ({ id, text, ...(target ? { target } : {}) })) }
      }
      // "generated:<mood>": a bed Kriya writes itself (music-bed.js), so a cut can have music with no file to find
      const mood = /^generated:(\w+)$/.exec(request.brief?.music ?? "")?.[1]
      // TP10: seven more moods and twenty sounds only with editing.craft on; off, the three moods and four sounds as before
      const crafted = (await this.features()).craft === true
      if (mood && Object.hasOwn(crafted ? ALL_MOODS : MOODS, mood) && !replay) {
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
        // An accent in the bed's own key for every join (TP10), written by code like the bed
        if (crafted && request.brief.arrange) {
          const name = `kriya-sfx-accent-${mood}.wav`
          const accentFile = join(media, name)
          const made = writeAccent(accentFile, mood, { fps: state.log.current.canvas.fps })
          const had = state.log.current.assets.find((a) => a.kind === "audio" && a.path.endsWith(name))
          const accent = had ?? (await this.addAsset(state, accentFile, { rights: "own", rightsNote: "Made by Kriya's sound generator: no one else's recording.", extraFacts: { peak: Math.round(made.peak * FLICKS) } }))
          request = { ...request, brief: { ...request.brief, accent: accent.id } }
        }
      } else if (crafted && request.brief?.arrange && !replay) styled.push("No accents on the joins: they are written in the key of a bed Kriya makes, and this cut has none.")
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
          if (!kind || !(crafted ? SOUNDS.includes(kind) : Object.hasOwn(SFX, kind))) continue
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
      // The assembly make (TP2): its own recipe, the same render and gates. A replay follows it too:
      // each part's story is answered from the recording, in the order it was asked
      if (order) {
        // shortcut: a file's speech is measured over the whole file, not only the stretch a part uses
        const loudness = {}
        for (const id of new Set(order.parts.filter((p) => ["story", "whole"].includes(p.use)).map((p) => p.asset))) {
          if (offline.includes(id) || state.log.current.assets.find((a) => a.id === id)?.facts.hasAudio === false) continue
          loudness[id] = (await measureLoudness(sourcePath(id), { run }).catch(() => ({ integrated: null }))).integrated
        }
        const { capabilities } = await tools()
        planner = () => planAssembly({ project: state.log.current, index: state.index, brief: direct, ask, signal, loudness, filters: capabilities.filters, offline })
        plannerRecipe = null
      }
      const runtime = activeRuntime(home)
      // TP8 (editing.directorLoop): escalation only to a tier the plan lists, the Director's watch-and-fix and B-roll by
      // meaning. Off, or a replay: the make as it was, with the same slots and calls (ET-DL-REG-01, EH-58)
      const directed = !replay && (await this.features()).directorLoop === true
      const ask = replay ? replayAsk(replay.answers) : this.askFor(state, job, directed ? { tiers: await this.allowedTiers() } : {})
      if (directed) stages.splice(2, 0, "watch")
      const genre = request.plan?.settings?.genre ?? null
      const watch = directed ? { view: async (attempt) => { const timeline = timelineOf(attempt.project, state.index); return { timeline, report: viewerReport({ timeline, measured: await measureDraft(attempt.file, { run, duration: attempt.plan.duration }), ...(genre ? { genre } : {}) }) } } } : null
      const parent = state.log.head
      // The person's edits to the last cut go onto this one, unless they asked to start over
      const last = replay || request.brief?.fresh ? null : this.lastMake(state)
      const result = await makeReel({
        edits: last?.edits ?? [],
        project: state.log.current,
        head: state.log.head,
        index: state.index,
        asset,
        brief: { ...extra, ...request.brief, ...(directed && (extra.broll ?? request.brief?.broll) === "own" ? { brollByMeaning: true } : {}) },
        ask,
        ...(watch ? { watch } : {}),
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
          // QG-15 runs only on a make that followed an assembly (EH-70)
          ...(order ? { assembly: { ...order, left: order.parts.filter((p) => offline.includes(p.asset)).map((p) => p.id) } } : {}),
          // QG-16 runs only on a make that followed a reference's style brief (TP6)
          ...(fit ? { referenceFit: fit } : {}),
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
      // What the Director's watch did: a kept fix as a change, a dropped one as a note with its reason
      const watched = result.best.watched ? sayWatch(result.best.watched.rounds) : []
      const notes = [...result.notes, ...watched.filter((line) => line.includes("kept the cut as it was")), ...(carried.length ? [`Kept ${carried.length} of your own edit${carried.length === 1 ? "" : "s"} to the last cut.`] : []), ...(lost.length ? [`${lost.length} of your edits no longer fit this cut and ${lost.length === 1 ? "was" : "were"} left out: ${lost.map((d) => describe(d.op, state.index)).join("; ")}.`] : []), ...person.map((p) => `${p.gate}: ${p.message} This is yours to decide.`), ...(gates?.gates.find((g) => g.id === "QG-16")?.message ? [gates.gates.find((g) => g.id === "QG-16").message] : [])]
      if (replay) return { replayOf: replay.of, verdict: gates?.verdict ?? "not_checked", gates: gates?.gates ?? [], planHash, notes, repairs, calls: result.calls, stop: result.outcome.stop }
      const { ops, dropped } = state.log.head === result.head ? { ops: result.best.ops, dropped: [] } : rebase(state.log.current, result.best.ops, state.index)
      const landed = change(state, { ops, author: "agent" })
      if (!landed.ok) throw new EngineFailure("plan", "refused", landed.diagnostics[0].message)
      // What the next change to this cut starts from
      atomicWrite(join(dirOf(state.id), "last-make.json"), JSON.stringify({ head: state.log.head, brief: request.brief ?? {}, story: result.best.story ?? null, carried, plan: request.plan ?? (request.brief?.fresh ? null : (last?.plan ?? null)) }))
      // A caption per spoken line is one change to a person: said once, with the count
      const captioned = ops.filter((op) => op.op === "caption_style" && op.words?.length)
      // A cutaway the Director's watch took out again isn't something this make did: only what is in the cut is listed
      const final = result.best.watched ? state.log.current.sequences.find((q) => q.id === state.log.current.active).clips : null
      const stays = (op) => op.op !== "place_broll" || !final || final.some((c) => c.source?.asset === op.asset && c.source.in === (op.in ?? 0) && JSON.stringify(c.at) === JSON.stringify(op.at))
      const changes = [...usedRules, ...watched.filter((line) => !line.includes("kept the cut as it was")), ...ops.filter((op) => stays(op) && (!["ripple_delete", "reframe", "caption_style", "apply_lut"].includes(op.op) || (op.op === "caption_style" && !op.words?.length))).map((op) => describe(op, state.index)), ...(captioned.length ? [`Captioned ${captioned.length} line${captioned.length === 1 ? "" : "s"} (${captioned[0].look})`] : [])]
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
        ...(result.best.watched ? { watch: { score: result.best.watched.score, rounds: result.best.watched.rounds.map(({ round, kept, was, score, reason, fixes }) => ({ round, kept, was: was ?? null, score: score ?? null, ...(reason ? { reason } : {}), fixes: fixes.map((f) => f.kind) })), left: result.best.watched.left.map((f) => f.kind) } } : {}),
      }
    },

    /**
     * "Give me three openings" (TP8, editing.directorLoop): three low-fidelity drafts of the first eight seconds,
     * each opening on a different line, chosen by code. Nothing lands on the project: the person's pick becomes
     * the next make's hook. Each film is in the project's exports, named by what it shows.
     */
    async openings(state, request, { job = 0, signal, onStep = () => {} } = {}) {
      if ((await this.features()).directorLoop !== true) throw new EngineFailure("input", "refused", "Openings to choose from aren't switched on.")
      const video = state.log.current.assets.filter((a) => a.kind === "video")
      const asset = request.asset ?? video[0]?.id
      if (!asset || !video.some((a) => a.id === asset)) throw new EngineFailure("input", "no_take", "Add a video first.")
      if (!state.index.words.some((w) => w.asset === asset)) await this.indexAsset(state, asset, { signal })
      const planned = await planOpenings({ project: state.log.current, index: state.index, asset, brief: request.brief ?? {}, signal })
      if (!planned.length) throw new EngineFailure("input", "no_lines", "There aren't enough spoken lines in this take to open on.")
      const openings = []
      for (const [n, { hook, project }] of planned.entries()) {
        onStep(n, planned.length)
        const deliverable = project.deliverables.find((d) => d.preset === REEL_TALKING_HEAD.deliverable.preset) ?? project.deliverables[0]
        const { file, plan } = await state.engine.render({ quality: "draft", deliverable: deliverable.id, project, job, signal })
        openings.push({ n, hook: hook.id, words: hook.words, seconds: Math.round((plan.duration / FLICKS) * 10) / 10, file: file.split(/[\\/]/).at(-1) })
      }
      return { asset, openings }
    },

    /** One opening's film, only by the job's own record and only from this project's exports: never a path the browser names. */
    openingFile(state, number, n) {
      const row = state.journal.job(number)
      if (row?.kind !== "openings" || row.status !== "done") return null
      let found = null
      try {
        found = JSON.parse(row.dispatch ?? "{}").openings?.[n]?.file ?? null
      } catch {}
      if (typeof found !== "string" || /[\\/]/.test(found)) return null
      const file = join(state.folder, "exports", found)
      return existsSync(file) ? file : null
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

