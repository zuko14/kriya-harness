// A job from Kriya, in the Host (TAVI_INTEGRATION §4). The daemon only hands it over
// (EH-02); from then on this file reports it, so a closed harness or a restarted daemon
// doesn't matter. Plain code with no agent loop. What leaves for Kriya is of a fixed
// shape: a stage, a percent, gate ids and a reason code. No transcript and no file
// names (CC-D8). The one file that leaves is a preview of this job's own output.

import { createHash } from "node:crypto"
import { createReadStream, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import { Readable } from "node:stream"

import { call, KriyaError } from "../../api.js"
import { readDevice } from "../../store.js"
import { clipArgs, previewArgs } from "../core/ffmpeg.js"
import { encoderFor } from "../engine/capabilities.js"
import { probe } from "../engine/probe.js"
import { runTool } from "../engine/tool.js"
import { editHome } from "./paths.js"
import { clipList, decideAssembly, resolveRefs } from "../director/assembly.js"
import { cleanLabel } from "../core/project.js"

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"])
const REPORT_MS = 10_000 // At most this often (TOOLS_AND_CONTRACTS §5)
const BEAT_MS = 60_000 // A long render with nothing new still says it's alive
const RETRY_MS = 30_000
const OUTBOX_DAYS = 7
export const PREVIEW_MAX_BYTES = 47_185_920 // 45 MiB (EH-23)
const PREVIEW_TARGET_BYTES = 40 * 1024 * 1024
const AUDIO_KBPS = 96
const FLICKS = 705_600_000
const FILE_QUESTION_S = 600
const TAKE_QUESTION_S = 300
const TASTE_QUESTION_S = 3600
const ORDER_QUESTION_S = 600
const ORDER_OPTIONS = 4
const TAKE_MARGIN = 0.1
const CLIP_SECONDS = 5
const WAIT_S = 25

// The Host's reasons, in Kriya's words (TOOLS_AND_CONTRACTS §9)
const CODES = { low_disk: "disk_low", no_take: "no_media", missing_feature: "runtime_missing", signed_out: "model_unavailable" }
const codeOf = (error) => {
  const reason = CODES[error?.reason] ?? error?.reason
  return typeof reason === "string" && /^[a-z_]{1,32}$/.test(reason) ? reason : "failed"
}

/** A number that changes with every report: how the worker hears the computer is alive. */
const beat = () => Math.floor(Date.now() / 1000) % 2_000_000_000

/** The videos the brief could mean: most words of the brief in the name, then the newest. */
export function rankFiles(folder, brief) {
  const words = brief.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && VIDEO.has(extname(entry.name).toLowerCase()))
    .map((entry) => {
      const path = join(folder, entry.name)
      const name = entry.name.toLowerCase()
      return { path, name: entry.name, hits: words.filter((word) => name.includes(word)).length, at: statSync(path).mtimeMs }
    })
    .sort((a, b) => b.hits - a.hits || b.at - a.at)
}

export const chooseFile = (folder, brief) => rankFiles(folder, brief)[0]?.path ?? null

/** Two takes the index can't tell apart: a real choice, at most two per job (TAVI §5). */
export function closeTakes(index, asset, margin = TAKE_MARGIN) {
  const sentences = new Map(index.sentences.filter((s) => s.asset === asset).map((s) => [s.id, s]))
  const groups = new Map()
  for (const take of index.takes ?? []) {
    if (sentences.has(take.sentence) && take.rank <= 2) groups.set(take.group, [...(groups.get(take.group) ?? []), take])
  }
  const close = []
  for (const [group, takes] of groups) {
    if (takes.length !== 2) continue
    const [first, second] = takes.sort((x, y) => x.rank - y.rank).map((t) => sentences.get(t.sentence))
    if (first.score > 0 && second.score > 0 && Math.abs(first.score - second.score) <= margin * Math.max(first.score, second.score)) close.push({ group, first, second })
  }
  return close.slice(0, 2)
}

/** The length in the brief's own words: "45 s", "90 seconds", "2 minutes". */
export function secondsIn(brief) {
  const found = /\b(\d{1,3})\s*-?\s*(s|sec|secs|second|seconds|min|mins|minute|minutes)\b/i.exec(brief)
  if (!found) return undefined
  const seconds = Number(found[1]) * (/^m/i.test(found[2]) ? 60 : 1)
  return seconds >= 5 && seconds <= 600 ? seconds : undefined
}

const SPINE = ["story", "whole"]
/** One order as the person reads it on a card: "Clip 2 (Intro), then clip 1". Numbers and their own labels, no file names. */
export function orderLine(assembly, project) {
  const numbered = new Map(clipList(project).map((c) => [c.asset, c.n]))
  const label = (asset) => cleanLabel(project.assets.find((a) => a.id === asset)?.label)
  const line = assembly.parts
    .filter((p) => SPINE.includes(p.use))
    .map((p, i) => `${i ? "clip" : "Clip"} ${numbered.get(p.asset) ?? "?"}${label(p.asset) ? ` (${label(p.asset)})` : ""}`)
    .join(", then ")
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/**
 * The order a Tavi brief names across the folder's clips (TP11), by code only: no model call, never the
 * storyboard stored on the project (EH-63), only the project's own numbered clips (no reference, no path).
 * @returns {Promise<{ assembly: object } | { options: { label: string, assembly: object }[] } | null>}
 *   null: the brief names no order (one file, or one clip), and the job is the reel it always was
 */
export async function orderIn(brief, state) {
  const project = state.log.current
  const index = state.index ?? {}
  const clips = clipList(project, index)
  if (clips.filter((c) => c.picture && c.duration > 0).length < 2) return null
  const said = resolveRefs(brief, clips, { index })
  if (said.refs.length < 2) return null
  const decided = await decideAssembly({ project, index, text: brief })
  if (decided.assembly && !decided.open.length) return { assembly: decided.assembly }
  // What code couldn't settle: each clip that fits the first open place, as its own order, for the person to pick
  const open = decided.open.find((item) => item.candidates?.length >= 2)
  if (!open) return null
  const options = []
  for (const asset of open.candidates.slice(0, ORDER_OPTIONS)) {
    const n = clips.find((c) => c.asset === asset)?.n
    // The place said ("the beach clip") becomes that clip's number, its own "clip" or "file" word with it
    const place = new RegExp(`${open.said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+(?:clip|file|video|one))?`, "i")
    const tried = await decideAssembly({ project, index, text: brief.replace(place, `clip ${n}`) })
    if (tried.assembly && !tried.open.length && !options.some((o) => JSON.stringify(o.assembly.parts) === JSON.stringify(tried.assembly.parts))) options.push({ label: orderLine(tried.assembly, project), assembly: tried.assembly })
  }
  if (options.length === 1) return { assembly: options[0].assembly }
  return options.length >= 2 ? { options } : null
}

/**
 * A file small enough to upload: the master when it fits, else a lower bitrate that
 * does. @returns {Promise<string | null>} null when even that won't fit
 */
export async function previewOf(file, { durationSeconds, capabilities, work, run = runTool, signal, maxBytes = PREVIEW_MAX_BYTES }) {
  if (statSync(file).size <= maxBytes) return file
  const kbps = Math.floor((PREVIEW_TARGET_BYTES * 8) / 1000 / Math.max(1, durationSeconds)) - AUDIO_KBPS
  if (!(kbps >= 100)) return null
  mkdirSync(work, { recursive: true })
  const output = join(work, `preview-${basename(file)}`)
  await run("ffmpeg", previewArgs({ source: file, output, encoder: encoderFor(capabilities, "proxy"), videoKbps: kbps, audioKbps: AUDIO_KBPS }), { signal })
  return statSync(output).size <= maxBytes ? output : null
}

function sha256Of(file) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256")
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")))
  })
}

/** @param {{ home: string, projects: object, jobs: () => object, tools: () => Promise<any>, log: (line: string) => void, device?: () => any, send?: Function, put?: typeof fetch, probeFile?: typeof probe, reportMs?: number, beatMs?: number, retryMs?: number }} options */
export function createTavi({ home, projects, taste = projects.taste, jobs, tools, log, device = readDevice, send, put = fetch, probeFile = probe, runClip = runTool, reportMs = REPORT_MS, beatMs = BEAT_MS, retryMs = RETRY_MS }) {
  const request =
    send ??
    ((path, body, { method = "POST", signal } = {}) => {
      const signedIn = device()
      if (!signedIn) throw new KriyaError(401, "signed_out", "This computer isn't signed in to Kriya.")
      return call(signedIn.url, method, path, { token: signedIn.token, ...(body && { body }), ...(signal && { signal }) })
    })
  const post = (path, body) => request(path, body)

  const tracked = new Map() // dispatch id → { hostJob, canceling, sentAt, percent, defaulted, abort }
  const outboxFile = join(editHome(home), "tavi-outbox.json")

  // A final report survives a closed lid and a restart: it's written before it's sent
  const readOutbox = () => {
    try {
      return JSON.parse(readFileSync(outboxFile, "utf8"))
    } catch {
      return {}
    }
  }
  const writeOutbox = (box) => {
    mkdirSync(dirname(outboxFile), { recursive: true })
    const temporary = `${outboxFile}.tmp`
    writeFileSync(temporary, JSON.stringify(box), { mode: 0o600 })
    renameSync(temporary, outboxFile)
  }
  let flushing = null
  const flush = () =>
    (flushing ??= (async () => {
      const box = readOutbox()
      for (const [id, entry] of Object.entries(box)) {
        try {
          await post(`/dispatch/${id}`, { status: entry.status, result: entry.result })
          delete box[id]
        } catch (error) {
          // Refused for good (finished, revoked), or kept so long nobody is waiting
          if (error instanceof KriyaError && [400, 404].includes(error.status)) delete box[id]
          else if (Date.now() - entry.at > OUTBOX_DAYS * 86_400_000) delete box[id]
          else log(`couldn't report a job: ${error.code ?? error.name}`)
        }
      }
      writeOutbox(box)
    })().finally(() => (flushing = null)))
  const final = async (id, status, result) => {
    tracked.delete(id)
    writeOutbox({ ...readOutbox(), [id]: { status, result, at: Date.now() } })
    await flush()
  }

  const progress = (id, entry, percent) => {
    entry.percent = percent ?? entry.percent
    entry.sentAt = Date.now()
    post(`/dispatch/${id}`, { status: "running", result: { stage: entry.waiting ? "waiting_for_you" : "editing", percent: entry.percent ?? 0, beat: beat() } }).catch((error) => log(`couldn't report progress: ${error.code ?? error.name}`))
  }

  async function upload(jobId, file, durationFlicks, kind = "preview") {
    const { size: bytes } = statSync(file)
    const sha256 = await sha256Of(file)
    const { id, uploadUrl } = await post(`/editing/jobs/${jobId}/previews`, { kind, bytes, sha256, ...(Number.isSafeInteger(durationFlicks) && { durationFlicks }) })
    const url = new URL(uploadUrl)
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("not a safe upload link")
    const res = await put(uploadUrl, { method: "PUT", body: Readable.toWeb(createReadStream(file)), duplex: "half", headers: { "content-type": "video/mp4", "content-length": String(bytes) } })
    if (!res.ok) throw new Error(`upload answered ${res.status}`)
    await post(`/editing/jobs/${jobId}/previews/${id}`)
    return id
  }

  /**
   * A decision card, and its answer. Each has a default and a timeout, so a person who
   * never answers still gets an edit, with the default counted for the report. With the
   * cards off on this Kriya, or no way to reach it, the default stands at once.
   */
  // Waits for a card's answer; undefined when it closed without one
  async function answerOf(questionId, deadline, signal) {
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      try {
        const limit = AbortSignal.timeout((WAIT_S + 15) * 1000)
        const answer = await request(`/editing/questions/${questionId}?wait=${WAIT_S}`, undefined, { method: "GET", signal: signal ? AbortSignal.any([signal, limit]) : limit })
        if (answer.status === "answered" && Number.isInteger(answer.option)) return answer.option
        if (answer.status !== "open") return undefined
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof KriyaError && [400, 404].includes(error.status)) return undefined
        await new Promise((done) => setTimeout(done, Math.min(retryMs, 5_000)))
      }
    }
    return undefined
  }

  // "Remember this?" (TAVI §5): asked once, while the job is open, and never waited on. Only
  // the person's yes on the card confirms; silence leaves it for the Studio's Taste screen
  let offers = 0
  async function offerTaste(jobId) {
    const proposal = taste?.nextToAsk()
    if (!proposal) return
    let asked
    try {
      asked = await post(`/editing/jobs/${jobId}/questions`, { kind: "taste", prompt: proposal.sentence, options: [{ label: "Yes, use it" }, { label: "Not now" }], defaultOption: 1, timeoutSeconds: TASTE_QUESTION_S })
    } catch (error) {
      log(`no taste card: ${error.code ?? error.name}`)
      return
    }
    offers++
    void answerOf(asked.id, Date.now() + (TASTE_QUESTION_S + 30) * 1000)
      .then((option) => option === 0 && taste.confirm(proposal.key))
      .catch(() => {})
      .finally(() => offers--)
  }

  async function askPerson(id, entry, jobId, card) {
    const fallback = card.defaultOption
    let asked
    try {
      asked = await post(`/editing/jobs/${jobId}/questions`, card)
    } catch (error) {
      log(`no card: ${error.code ?? error.name}`)
      return fallback
    }
    entry.waiting = true
    progress(id, entry)
    try {
      const option = await answerOf(asked.id, Date.now() + card.timeoutSeconds * 1000 + 30_000, entry.abort?.signal)
      if (option !== undefined && option < card.options.length) return option
    } finally {
      entry.waiting = false
    }
    entry.defaulted = (entry.defaulted ?? 0) + 1
    return fallback
  }

  async function clipOf(jobId, source, sentence, capabilities) {
    const work = join(editHome(home), "tavi-previews")
    mkdirSync(work, { recursive: true })
    const output = join(work, `clip-${jobId}-${sentence.id.replace(/[^\w-]/g, "_")}.mp4`)
    const fromSeconds = sentence.start / FLICKS
    const seconds = Math.min(CLIP_SECONDS, Math.max(1, (sentence.end - sentence.start) / FLICKS))
    await runClip("ffmpeg", clipArgs({ source, output, encoder: encoderFor(capabilities, "proxy"), fromSeconds, seconds }))
    return upload(jobId, output, Math.round(seconds * FLICKS), "clip")
  }

  // A verdict without a preview is still a verdict: the card says where the file is
  async function sendPreview(request, result) {
    try {
      const { capabilities } = await tools()
      const { facts } = await probeFile(result.file)
      const file = await previewOf(result.file, { durationSeconds: facts.duration / FLICKS, capabilities, work: join(editHome(home), "tavi-previews") })
      if (file) await upload(request.dispatchJob, file, facts.duration)
    } catch (error) {
      log(`no preview: ${error.code ?? error.name}`)
    }
  }

  // What the person sent for this revision, and an agent's approved change
  async function notesFor(jobId, change) {
    const sent = await request(`/editing/jobs/${jobId}/notes`, undefined, { method: "GET" }).catch((error) => {
      log(`no notes: ${error.code ?? error.name}`)
      return { notes: [] }
    })
    return [...(sent.notes ?? []).map((n) => ({ at: n.atFlicks, text: n.body })), ...(change ? [{ text: change }] : [])]
  }

  const heartbeat = setInterval(() => {
    for (const [id, entry] of tracked) if (Date.now() - entry.sentAt >= beatMs) progress(id, entry)
  }, Math.max(50, Math.min(beatMs, reportMs)))
  heartbeat.unref?.()
  const retry = setInterval(() => {
    if (Object.keys(readOutbox()).length) flush().catch(() => {})
  }, retryMs)
  retry.unref?.()

  return {
    post,

    /** The daemon's handover. Answers at once; a question about the file waits in the background. */
    async accept({ dispatch, folder, job, brief, recipe, effort, revisionOf, change }) {
      if (tracked.has(dispatch)) return { accepted: true }
      const entry = { hostJob: null, canceling: false, sentAt: 0, abort: new AbortController() }
      const refuse = (code) => final(dispatch, "failed", { code }).then(() => ({ accepted: false, code }))
      tracked.set(dispatch, entry)
      const begin = async (file) => {
        const known = projects.list().find((p) => dirname(p.file) === folder)
        const state = known ? await projects.get(known.id) : await projects.create({ name: basename(folder), folder, offered: true })
        // A revision of a cut this project holds; anything else is a new cut
        const notes = revisionOf ? await notesFor(job, change) : []
        if (revisionOf && notes.length && state.log.current.deliverables.length) {
          const started = jobs().start(state, { kind: "revise", notes, dispatch, dispatchJob: job })
          entry.hostJob = started.id
          return { accepted: true }
        }
        const asset = state.log.current.assets.find((a) => a.kind === "video" && (a.path === file || join(state.folder, a.path) === file)) ?? (await projects.addAsset(state, file))
        const seconds = secondsIn(brief)
        const started = jobs().start(state, { kind: "make", asset: asset.id, brief: { effort, ...(seconds && { targetDuration: seconds * FLICKS }) }, dispatch, dispatchJob: job })
        entry.hostJob = started.id
        return { accepted: true }
      }
      const failed = (error) => {
        log(`a job from Kriya didn't start: ${error.reason ?? error.name}`)
        return refuse(codeOf(error))
      }
      // Only this recipe reaches a make job so far (ED11, ED12)
      if (recipe && recipe !== "reel-talking-head") return refuse("not_allowed")
      // TP11: an order across the folder's clips, only with editing.assembly on and Kriya's taviOrder (rule 17);
      // otherwise, and for a brief that names one file, everything below is as it was (ET-TP-REG-04)
      const ordered = (state, assembly) => {
        const seconds = secondsIn(brief)
        const started = jobs().start(state, { kind: "make", brief: { effort, ...(seconds && { targetDuration: seconds * FLICKS }), assembly }, dispatch, dispatchJob: job })
        entry.hostJob = started.id
        return { accepted: true }
      }
      try {
        const features = revisionOf ? null : await projects.features?.().catch(() => null)
        const known = features?.assembly === true && features?.taviOrder === true ? projects.list().find((p) => dirname(p.file) === folder) : null
        if (known) {
          const state = await projects.get(known.id)
          const order = await orderIn(brief, state)
          if (order?.assembly) return ordered(state, order.assembly)
          if (order?.options) {
            void askPerson(dispatch, entry, job, {
              kind: "order",
              prompt: "Which order did you mean?",
              options: order.options.map((o) => ({ label: o.label })),
              defaultOption: 0,
              timeoutSeconds: ORDER_QUESTION_S,
            })
              .then((option) => (entry.abort.signal.aborted ? final(dispatch, "canceled", { code: "canceled" }) : ordered(state, order.options[option].assembly)))
              .catch((error) => (entry.abort.signal.aborted ? final(dispatch, "canceled", { code: "canceled" }) : failed(error)))
            return { accepted: true }
          }
        }
      } catch (error) {
        return failed(error)
      }
      try {
        const files = rankFiles(folder, brief)
        if (!files.length && !revisionOf) return await refuse("no_media")
        // Two that fit the brief equally: it asks rather than guesses (TAVI §3). A revision has its file
        if (!revisionOf && files.length > 1 && files[0].hits === files[1].hits) {
          const options = files.slice(0, 4)
          void askPerson(dispatch, entry, job, {
            kind: "file",
            prompt: "Which recording did you mean?",
            options: options.map((f) => ({ label: f.name.slice(0, 200) })),
            defaultOption: 0,
            timeoutSeconds: FILE_QUESTION_S,
          })
            .then((option) => begin(options[option].path))
            .catch((error) => (entry.abort.signal.aborted ? final(dispatch, "canceled", { code: "canceled" }) : failed(error)))
          return { accepted: true }
        }
        return await begin(files[0]?.path)
      } catch (error) {
        return failed(error)
      }
    },

    /** The make job's question about its takes, once the footage is indexed. @returns picks by group */
    async chooseTakes(request, state, asset, { sourcePath }) {
      const entry = tracked.get(request.dispatch)
      if (!entry) return null
      entry.abort ??= new AbortController()
      const close = closeTakes(state.index, asset)
      if (!close.length) return null
      const picks = {}
      const { capabilities } = await tools()
      for (const { group, first, second } of close) {
        let clips
        try {
          // No clips, no card: a choice between two words on a screen isn't worth asking
          clips = [await clipOf(request.dispatchJob, sourcePath(asset), first, capabilities), await clipOf(request.dispatchJob, sourcePath(asset), second, capabilities)]
        } catch (error) {
          log(`no clips for a card: ${error.code ?? error.name}`)
          continue
        }
        const option = await askPerson(request.dispatch, entry, request.dispatchJob, {
          kind: "take",
          prompt: "Which take?",
          options: [
            { label: "Take 1", clip: clips[0] },
            { label: "Take 2", clip: clips[1] },
          ],
          defaultOption: 0,
          timeoutSeconds: TAKE_QUESTION_S,
        })
        picks[group] = (option === 1 ? second : first).id
      }
      return picks
    },

    /** Kriya said canceling. false when this Host doesn't know the job: the daemon closes it (EH-04). */
    cancel({ dispatch }) {
      if (Object.hasOwn(readOutbox(), dispatch)) return true // Already over; its report is on the way
      const entry = tracked.get(dispatch)
      if (!entry) return false
      entry.canceling = true
      // Still waiting on a question: nothing is running yet
      if (!entry.hostJob) {
        entry.abort?.abort(new Error("Canceled"))
        return true
      }
      return jobs().cancel(entry.hostJob) || (tracked.delete(dispatch), false)
    },

    /** Every update of a job with a dispatch id, including one resumed after a crash. */
    async onUpdate(request, view, error) {
      const id = request.dispatch
      const entry = tracked.get(id) ?? { hostJob: view.id, canceling: false, sentAt: 0, abort: new AbortController() }
      tracked.set(id, entry)
      if (view.status === "running") {
        if (Date.now() - entry.sentAt >= reportMs) progress(id, entry, view.progress)
        else entry.percent = view.progress
        return
      }
      if (view.status === "canceled") {
        // Only after Kriya said canceling: from running it would be refused (EH-17)
        return final(id, entry.canceling ? "canceled" : "failed", entry.canceling ? { code: "canceled" } : { code: "stopped_on_computer" })
      }
      if (view.status === "failed") return final(id, "failed", { code: codeOf(error) })
      if (view.status !== "done") return
      const result = JSON.parse(view.output ?? "{}")
      if (!result.file || !["delivered", "delivered_with_notes", "blocked"].includes(result.verdict)) return final(id, "failed", { code: "not_checked" })
      await sendPreview(request, result)
      await offerTaste(request.dispatchJob)
      const gates = (result.gates ?? []).slice(0, 60).flatMap((g) => (/^[A-Za-z0-9_-]{1,32}$/.test(g.id ?? "") ? [{ gate: g.id, level: g.status === "passed" ? "pass" : g.status === "not_checked" ? "unchecked" : g.severity === "note" ? "note" : g.status === "failed" ? "fail" : "skipped" }] : []))
      const count = (n) => (Number.isInteger(n) && n > 0 ? Math.min(n, 100) : undefined)
      const facts = { applied: count(result.applied), skipped: count(result.skipped), defaulted: count(entry.defaulted) }
      return final(id, "done", { outcome: result.verdict, gates, notes: Math.min(result.notes?.length ?? 0, 1000), ...Object.fromEntries(Object.entries(facts).filter(([, n]) => n)) })
    },

    /** Anything still to say: the Host doesn't go idle before it's said. */
    pending: () => tracked.size + offers + Object.keys(readOutbox()).length,
    flush,
    close() {
      clearInterval(heartbeat)
      clearInterval(retry)
    },
  }
}
