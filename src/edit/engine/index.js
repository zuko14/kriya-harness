// The Engine (ARCHITECTURE §2): the graph's node implementations for one project.
// Every expensive thing is a node, cached by what produced it. Sources are read,
// never written; everything goes to the cache or exports/.

import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, sep } from "node:path"

import { BUSES, busOf, duckEnvelope, MUSIC_UNDER_VOICE, SFX_UNDER_VOICE } from "../core/audio.js"
import { animatedZoom, audioArgs, joinArgs, muxArgs, peakArgs, proxyArgs, segmentArgs, stemsMixArgs, thumbArgs } from "../core/ffmpeg.js"
import { compile, wholeSegment } from "../core/plan.js"
import { toneMapCube } from "../core/tonemap.js"
import { createGraph, hashOf } from "../graph/index.js"
import { activeRuntime } from "../runtime/setup.js"
import { captionComposition } from "./captions.js"
import { cubeText, matchCube, measureColour } from "./color.js"
import { encoderFor } from "./capabilities.js"
import { masterFilter, measureLoudness } from "./loudness.js"
import { fingerprint, peakCollector } from "./media.js"
import { compositionFor, motionRuntime, renderTile, tileSeconds } from "./motion.js"
import { packsForPlan, packStatus, requirePack } from "./packs.js"
import { EngineFailure, runTool } from "./tool.js"

export const ENGINE_VERSION = "ed8-1"
const LOUDNESS_TOLERANCE = 0.3 // LU the master step aims inside; QG-06 allows 0.5

const FLICKS = 705_600_000
const GB = 1e9
// What a render made and can make again
const PRUNABLE = new Set(["out", "master", "segments", "tiles", "match", "audio"])
// Disk one second of output may take: a draft segment, its join and a master's encode
const BYTES_PER_SECOND = 3_000_000
const STALL_MS = 120_000
const timeoutFor = (flicks) => Math.max(180_000, Math.ceil(flicks / FLICKS) * 60_000)

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * The one check every path goes through (ES-01): the real path, after symlinks,
 * must sit inside a root. @returns {string} the real path
 */
export function guardPath(path, roots) {
  let real
  try {
    real = realpathSync(path)
  } catch {
    throw new EngineFailure("input", "missing_file", "A source file is missing. It may have moved.")
  }
  if (!roots.some((root) => inside(real, realpathSync(root)))) throw new EngineFailure("input", "outside_project", "That file isn't in this project's folders.")
  return real
}

const defaultFree = (dir) => {
  let at = dir
  while (!existsSync(at)) at = dirname(at)
  const { bavail, bsize } = statfsSync(at)
  return Number(bavail) * Number(bsize)
}

/** Writes through a temporary name, so a cancelled or crashed step leaves no half file. */
async function produce(file, work) {
  mkdirSync(dirname(file), { recursive: true })
  const ext = extname(file)
  // Named per process: a killed Host's FFmpeg can run on, and must not share this file
  const part = `${file.slice(0, -ext.length)}.${process.pid}.part${ext}`
  try {
    await work(part)
    renameSync(part, file)
  } catch (error) {
    rmSync(part, { force: true })
    throw error
  }
  return file
}

// DATA_MODEL §5.2: idempotent steps retry at most once
async function onceMore(work) {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof EngineFailure) || error.kind !== "render" || error.reason === "timeout") throw error
    return work()
  }
}

/**
 * @param {{ folder: string, roots: string[], cache: string, exports: string, journal: object, toolVersion: string, capabilities: { filters: Set<string>, encoders: Set<string> }, scheduler?: object, free?: (dir: string) => number, run?: typeof runTool, onTool?: (command: string, args: string[]) => void, motion?: () => ReturnType<typeof motionRuntime> }} options
 *   motion: HyperFrames and Chrome for the motion layer, from the Media Runtime
 *   cacheBytes: the cache's cap (ES-17); KRIYA_EDIT_CACHE_BYTES, else 20 GB
 */
export function createEngine({ folder, roots, cache, exports: exportsDir, journal, toolVersion, capabilities, scheduler, free = defaultFree, run, onTool, motion = () => motionRuntime(activeRuntime()), customMotion = () => false, cacheBytes = Number(process.env.KRIYA_EDIT_CACHE_BYTES) || 20 * GB }) {
  const tool = (command, args, options) => {
    onTool?.(command, args)
    return (run ?? runTool)(command, args, options)
  }
  let project = null
  let index = {}

  const assetOf = (id) => project.assets.find((asset) => asset.id === id)
  const sourcePath = (asset) => guardPath(isAbsolute(asset.path) ? asset.path : join(folder, asset.path), roots)
  const durationOf = (asset) => asset.facts.duration ?? 0
  const cached = (kind, name) => join(cache, kind, name)
  const exists = (value) => existsSync(value.file)

  function checkOutput(file) {
    for (const asset of project.assets) {
      const source = isAbsolute(asset.path) ? asset.path : join(folder, asset.path)
      if (file === source) throw new EngineFailure("plan", "would_overwrite_source", "A render can't write over a source file.")
    }
  }

  function toneMap(transfer) {
    const file = cached("lut", `${transfer}.cube`)
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, toneMapCube(transfer))
    }
    return file
  }

  const timed = (flicks, signal) => ({ timeoutMs: timeoutFor(flicks), stallMs: STALL_MS, signal })

  // Paths for one node's inputs: proxies for a draft, sources for a master
  async function inputsFor(ids, useProxy, need) {
    const paths = new Map()
    for (const id of new Set(ids)) {
      const asset = assetOf(id)
      // Only pictures have proxies: a sound file is read as it is, even for a draft (found in ED9)
      paths.set(id, useProxy && asset.kind === "video" ? (await need("proxy", id)).file : sourcePath(asset))
    }
    return paths
  }

  // A node's inputs: footage, LUT files, and the baked .cube of each colour match
  async function pathsFor(node, useProxy, need) {
    const effects = node.picture.flatMap((item) => item.effects)
    const luts = effects.filter((effect) => effect.type === "lut").map((effect) => effect.asset)
    const paths = await inputsFor([...node.picture, ...node.overlays].map((item) => item.asset).concat(luts), useProxy, need)
    // TP7: the type kit's logo, always its own file: a draft proxy would lose its transparency
    if (node.brand?.bug) paths.set(node.brand.bug.asset, sourcePath(assetOf(node.brand.bug.asset)))
    for (const key of new Set(effects.filter((effect) => effect.type === "grade" && effect.match).map((effect) => effect.match.key))) paths.set(key, (await need("match", key)).file)
    return paths
  }

  const nodes = {
    // A colour match baked into a .cube (EDITOR_WORKFLOWS §6): both ranges measured from their sources
    match: {
      version: 1,
      resources: ["cpu"],
      valid: exists,
      async run({ input, key, signal }) {
        const { from, to } = await input(`match:${key}`)
        const measure = (range) => measureColour(sourcePath(assetOf(range.asset)), { from: range.in / FLICKS, to: range.out / FLICKS, run: tool, signal })
        const lut = matchCube(await measure(from), await measure(to))
        const file = cached("match", `${key}.cube`)
        await produce(file, async (output) => writeFileSync(output, cubeText(lut)))
        return { file }
      },
    },
    proxy: {
      version: 1,
      resources: ["encoder"],
      valid: exists,
      async run({ input, key, signal }) {
        const { fingerprint: id, duration, color } = await input(`asset:${key}`)
        const file = cached("proxy", `${id}.mp4`)
        const source = sourcePath(assetOf(key))
        await onceMore(() => produce(file, (output) => tool("ffmpeg", proxyArgs({ source, output, encoder: encoderFor(capabilities, "proxy"), color, toneMap }), timed(duration, signal))))
        return { file }
      },
    },
    peaks: {
      version: 1,
      resources: ["cpu"],
      valid: exists,
      async run({ input, key, signal }) {
        const { fingerprint: id, duration } = await input(`asset:${key}`)
        const file = cached("peaks", `${id}.json`)
        const source = sourcePath(assetOf(key))
        await produce(file, async (output) => {
          const peaks = peakCollector()
          await tool("ffmpeg", peakArgs({ source, rate: peaks.rate }), { ...timed(duration, signal), onStdout: (chunk) => peaks.add(chunk) })
          writeFileSync(output, JSON.stringify(peaks.finish()))
        })
        return { file }
      },
    },
    thumbs: {
      version: 1,
      resources: ["cpu"],
      valid: exists,
      async run({ input, key, signal }) {
        const { fingerprint: id, duration } = await input(`asset:${key}`)
        const file = cached("thumbs", `${id}.jpg`)
        const source = sourcePath(assetOf(key))
        const every = Math.max(1, Math.ceil(duration / FLICKS / 100))
        await produce(file, (output) => tool("ffmpeg", thumbArgs({ source, output, every, columns: 10, rows: 10 }), timed(duration, signal)))
        return { file }
      },
    },
    // A caption or block as a transparent tile (EDIT_ENGINE §6): its own short composition, confined
    tile: {
      version: 1,
      resources: ["chrome"],
      valid: exists,
      async run({ input, key, signal }) {
        const { tile, output, canvas } = await input(`tile:${key}`)
        const html = compositionFor(tile, { output, canvas }, captionComposition)
        const file = cached("tiles", `${key}.mov`)
        const work = cached("tiles", `${key}.work`)
        try {
          await produce(file, (out) => renderTile({ html, work, output: out, fps: output.fps, runtime: motion(), run: tool, signal, seconds: tileSeconds(tile.end - tile.at, output.fps) }))
        } finally {
          rmSync(work, { recursive: true, force: true })
        }
        return { file }
      },
    },
    segment: {
      version: 1,
      resources: ["encoder"],
      valid: exists,
      async run({ input, need, key, signal }) {
        const { plan, segment } = await input(`segment:${key}`)
        const { node } = segment
        const paths = await pathsFor(node, plan.input === "proxy", need)
        const file = cached("segments", `${key}.mp4`)
        await onceMore(() => produce(file, (output) => tool("ffmpeg", segmentArgs(plan, segment, { input: (id) => paths.get(id), tile: (id) => cached("tiles", `${id}.mov`), output, encoder: encoderFor(capabilities, "draft"), toneMap }), timed(segment.end - segment.start, signal))))
        return { file }
      },
    },
    // The sound as stems, then one mix (EDIT_ENGINE §10, ED9): the dialogue first, since
    // its measured loudness sets where music and effects sit; mastered when a deliverable asks
    audio: {
      version: 2,
      resources: ["cpu"],
      // The stems too: the gates read them, and the cache may prune one alone (ES-17)
      valid: (value) => existsSync(value.file) && Object.values(value.stems ?? {}).every((stem) => existsSync(stem)),
      async run({ input, need, key, signal }) {
        const plan = await input(`audio:${key}`)
        const paths = await inputsFor(plan.audio.items.map((item) => item.asset), plan.input === "proxy", need)
        const io = { input: (id) => paths.get(id) }
        const file = cached("audio", `${key}.m4a`)
        const pcm = ["-c:a", "pcm_s24le", "-ar", "48000"]
        const encoder = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
        const buses = BUSES.filter((bus) => plan.audio.items.some((item) => busOf(item.role) === bus))
        const stem = (bus) => cached("audio", `${key}.${bus}.wav`)
        const time = timed(plan.duration, signal)
        let envelope
        if (plan.audio.duck && buses.includes("music")) {
          envelope = cached("audio", `${key}.duck.f32`)
          mkdirSync(dirname(envelope), { recursive: true })
          const curve = duckEnvelope(plan.audio.duck.speech, { duration: plan.duration, ...plan.audio.duck })
          writeFileSync(envelope, Buffer.from(curve.buffer, curve.byteOffset, curve.byteLength))
        }
        const render = (bus, gains) => onceMore(() => produce(stem(bus), (output) => tool("ffmpeg", audioArgs(plan, { ...io, output, encoder: pcm, bus, envelope, gains }), time)))
        if (buses.includes("dialogue")) await render("dialogue")
        const voice = buses.includes("dialogue") ? (await measureLoudness(stem("dialogue"), { run: tool, signal })).integrated : null
        // Music and effects levelled against this voice, unless the person set a level
        const gains = {}
        for (const item of plan.audio.items) {
          const under = busOf(item.role) === "music" ? MUSIC_UNDER_VOICE : busOf(item.role) === "sfx" ? SFX_UNDER_VOICE : null
          if (under === null || voice === null || item.asset in gains || item.effects.some((e) => e.type === "level")) continue
          const own = (await measureLoudness(paths.get(item.asset), { run: tool, signal })).integrated
          if (own !== null) gains[item.asset] = Math.max(-40, Math.min(20, voice - under - own))
        }
        for (const bus of buses) if (bus !== "dialogue") await render(bus, gains)
        const stems = buses.map(stem)
        if (!plan.audio.loudness) {
          await onceMore(() => produce(file, (output) => tool("ffmpeg", stems.length ? stemsMixArgs({ stems, duration: plan.duration, output, encoder }) : audioArgs(plan, { ...io, output, encoder }), time)))
          return { file, stems: Object.fromEntries(buses.map((bus) => [bus, stem(bus)])), voice }
        }
        // Mastered to the deliverable: mix losslessly, measure, gain and limit, measure again
        const mix = cached("audio", `${key}.mix.wav`)
        await onceMore(() => produce(mix, (output) => tool("ffmpeg", stems.length ? stemsMixArgs({ stems, duration: plan.duration, output, encoder: pcm }) : audioArgs(plan, { ...io, output, encoder: pcm }), time)))
        const { lufs, tp } = plan.audio.loudness
        const first = await measureLoudness(mix, { run: tool, signal })
        let gain = first.integrated === null ? 0 : lufs - first.integrated
        let margin = 1.5
        for (let pass = 0; pass < 4; pass++) {
          await produce(file, (output) => tool("ffmpeg", ["-nostdin", "-hide_banner", "-i", mix, "-af", masterFilter({ gain, ceiling: tp, margin }), ...encoder, "-y", output], time))
          const now = await measureLoudness(file, { run: tool, signal })
          const loud = first.integrated === null || now.integrated === null || Math.abs(now.integrated - lufs) <= LOUDNESS_TOLERANCE
          // A transient the encoder pushes past the ceiling: limit lower and go again (found in ED9)
          const peak = now.truePeak === null || now.truePeak <= tp - 0.1
          if (loud && peak) break
          if (!loud) gain += lufs - now.integrated
          if (!peak) margin += now.truePeak - tp + 0.3
        }
        rmSync(mix, { force: true })
        return { file, stems: Object.fromEntries(buses.map((bus) => [bus, stem(bus)])), voice }
      },
    },
    join: {
      version: 1,
      valid: exists,
      async run({ input, need, key, signal }) {
        const { segments, audio } = await input(`join:${key}`)
        const [parts, sound] = await Promise.all([Promise.all(segments.map((id) => need("segment", id))), need("audio", audio)])
        const list = cached("segments", `${key}.ffconcat`)
        // Our own list, of our own hex names beside it: nothing here comes from a person
        writeFileSync(list, `ffconcat version 1.0\n${parts.map(({ file }) => `file '${file.slice(file.lastIndexOf(sep) + 1)}'`).join("\n")}\n`)
        const file = cached("out", `${key}.mp4`)
        await produce(file, (output) => tool("ffmpeg", joinArgs({ list, audio: sound.file, output }), { timeoutMs: 600_000, signal }))
        return { file }
      },
    },
    master: {
      version: 1,
      resources: ["encoder"],
      valid: exists,
      async run({ input, need, key, signal }) {
        const { plan, audio } = await input(`master:${key}`)
        const sound = await need("audio", audio)
        const segment = wholeSegment(plan)
        // LUTs too: a master with apply_lut once got no path for its .cube (found in ED13)
        const paths = await pathsFor(segment.node, false, need)
        const picture = cached("master", `${key}.mp4`)
        await produce(picture, (output) => tool("ffmpeg", segmentArgs(plan, segment, { input: (id) => paths.get(id), tile: (id) => cached("tiles", `${id}.mov`), output, encoder: encoderFor(capabilities, "master"), toneMap }), timed(plan.duration * 4, signal)))
        const file = cached("out", `${key}.mp4`)
        await produce(file, (output) => tool("ffmpeg", muxArgs({ video: picture, audio: sound.file, output }), { timeoutMs: 600_000, signal }))
        rmSync(picture, { force: true })
        return { file }
      },
    },
  }

  const graph = createGraph({ journal, nodes, ...(scheduler ? { scheduler } : {}) })

  // What a crash left half written; nothing finished has this name
  for (const kind of existsSync(cache) ? readdirSync(cache) : []) {
    const dir = join(cache, kind)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) if (/\.part\.\w+$/.test(name)) rmSync(join(dir, name), { force: true })
  }

  // ES-17: after a render the cache is cut to its cap, oldest renders first, never what
  // that render used (its audio stems included: the gates read them next). Per-source
  // proxies, peaks and thumbnails stay. A pruned file is only
  // made again: every node checks its file exists, and touch() makes the graph look again.
  // Oldest made goes first; a reused file isn't touched (a finished step's file keeps its time).
  // Only when no other render of this project is running, so none loses a file mid-join.
  // The cap is per project: each has its own cache.
  // shortcut: a make job's gates still reading its tiles after its render could lose them to
  // another render's prune when over the cap; upgrade to a lease on the files if that's seen
  let rendering = 0
  function prune(keep, audioOf) {
    const files = []
    let total = 0
    for (const kind of existsSync(cache) ? readdirSync(cache) : []) {
      const dir = join(cache, kind)
      if (!statSync(dir).isDirectory()) continue
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stat = statSync(path, { throwIfNoEntry: false })
        if (!stat?.isFile()) continue
        total += stat.size
        if (PRUNABLE.has(kind) && !keep.has(path) && !path.startsWith(audioOf)) files.push({ path, size: stat.size, at: stat.mtimeMs })
      }
    }
    if (total <= cacheBytes) return
    for (const file of files.sort((a, b) => a.at - b.at)) {
      rmSync(file.path, { force: true })
      total -= file.size
      if (total <= cacheBytes) break
    }
    graph.touch()
  }

  function setAsset(asset) {
    graph.set(`asset:${asset.id}`, { fingerprint: asset.fingerprint, duration: durationOf(asset), color: asset.facts.color ?? null })
  }

  function preflight(plan) {
    const used = new Set(plan.segments.flatMap((s) => [...s.node.picture, ...s.node.overlays].map((item) => item.asset)).concat(plan.audio.items.map((item) => item.asset)))
    for (const id of used) sourcePath(assetOf(id))
    for (const tile of plan.tiles) {
      if (tile.kind === "caption" && tile.node.style?.burn === true) {
        if (!capabilities.filters.has("drawtext")) throw new EngineFailure("environment", "missing_feature", "This FFmpeg has no drawtext filter, so captions can't be burned in directly.")
      } else if (!existsSync(cached("tiles", `${tile.key}.mov`))) {
        const runtime = motion()
        if (runtime.missing) throw new EngineFailure("environment", "missing_feature", runtime.missing)
      }
    }
    // A pack the plan needs, checked before anything renders (CAPABILITY_PACKS §3); the colour pack needs only FFmpeg
    const packs = packsForPlan(plan)
    if (packs.length) {
      const status = packStatus({ runtime: null, capabilities })
      for (const id of packs) requirePack(id, status)
    }
    if (plan.segments.some((s) => s.node.picture.some((item) => animatedZoom(item.zoom))) && !capabilities.filters.has("zoompan")) throw new EngineFailure("environment", "missing_feature", "This FFmpeg has no zoompan filter, so focused or smooth zooms can't be drawn.")
    const seconds = plan.duration / FLICKS
    const proxies = plan.input === "proxy" ? [...used].reduce((sum, id) => sum + (durationOf(assetOf(id)) / FLICKS) * 200_000, 0) : 0
    const needed = seconds * BYTES_PER_SECOND + proxies
    const available = free(cache)
    if (available < needed) throw new EngineFailure("environment", "low_disk", `This render needs about ${(needed / GB).toFixed(1)} GB free, and there are ${(available / GB).toFixed(1)} GB free. Nothing was written.`)
  }

  const unsupported = (error) => (error instanceof RangeError ? new EngineFailure("plan", "unsupported", error.message) : error)

  return {
    graph,
    checkOutput,

    /** The project and index everything below works from. */
    load(nextProject, nextIndex = {}) {
      project = nextProject
      index = nextIndex
      for (const asset of project.assets) if (asset.kind === "video" || asset.kind === "audio") setAsset(asset)
    },

    fingerprint: (path) => fingerprint(path),
    /** The stems of a rendered mix, by bus, and the voice's measured loudness (QG-06). */
    stems: async (audioKey) => {
      const value = await graph.demand("audio", audioKey)
      return { stems: value.stems ?? {}, voice: value.voice ?? null }
    },
    /** Where a rendered tile lives, for the gates that read it. */
    tilePath: (key) => cached("tiles", `${key}.mov`),
    motion,
    proxy: async (id, options) => (await graph.demand("proxy", id, options)).file,
    peaks: async (id, options) => (await graph.demand("peaks", id, options)).file,
    thumbs: async (id, options) => (await graph.demand("thumbs", id, options)).file,

    /**
     * @param {{ quality: "draft" | "master", deliverable?: string, job?: number, signal?: AbortSignal, onStep?: (done: number, total: number) => void, project?: object, partial?: boolean }} request
     * partial (editing.livePreview, TP3): each draft segment's input names only the tiles it draws, so a
     * change re-renders only the segments it touched. The picture only: the sound is always one mix of the
     * whole film (QG-06) and a master one encode (ET-TR-M2), EH-66
     * @returns {Promise<{ file: string, plan: object }>}
     */
    async render({ quality, deliverable, job, signal, onStep = () => {}, project: candidate, partial = false }) {
      // A candidate version (the Edit Loop's attempt) renders without becoming the project
      // TP7: which of the pack's fonts this computer has, so a type kit's tiles are keyed by what they draw with
      const fonts = motion().fonts
      const plan = compile(candidate ?? project, index, { engineVersion: ENGINE_VERSION, runtimeVersion: toolVersion, quality, deliverable, filters: capabilities.filters, ...(fonts ? { fonts: [...fonts.keys()] } : {}), ...(customMotion() === true ? { customMotion: true } : {}) })
      if (!plan.duration) throw new EngineFailure("plan", "empty", "There's nothing on the timeline to render.")
      preflight(plan)
      const shared = { canvas: plan.canvas, output: plan.output, input: plan.input, tiles: plan.tiles }
      const audio = { audio: plan.audio, duration: plan.duration, input: plan.input }
      graph.set(`audio:${plan.audio.key}`, audio)
      const options = { job, signal }
      const key = hashOf([plan.segments.map((s) => s.key), plan.audio.key, plan.input])
      let done = 0
      const step = (total) => onStep(++done, total)
      rendering++
      try {
        // Tiles first, one Chrome at a time (the scheduler's `chrome` slot); cached by content
        const drawn = plan.tiles.filter((tile) => !(tile.kind === "caption" && tile.node.style?.burn === true))
        for (const tile of drawn) graph.set(`tile:${tile.key}`, { tile, output: plan.output, canvas: plan.canvas })
        for (const segment of plan.segments) for (const item of segment.node.picture) for (const effect of item.effects) if (effect.type === "grade" && effect.match) graph.set(`match:${effect.match.key}`, { from: effect.match.from, to: effect.match.to })
        await Promise.all(drawn.map((tile) => graph.demand("tile", tile.key, options)))
        let value
        if (quality === "master") {
          graph.set(`master:${key}`, { plan, audio: plan.audio.key })
          value = await graph.demand("master", key, options)
          step(1)
        } else {
          const total = plan.segments.length + 1
          // Off, every segment reads the whole plan's tiles, as before: a caption change re-renders them all
          const tilesOf = (segment) => (partial === true ? plan.tiles.filter((tile) => segment.node.tiles.some((part) => part.key === tile.key)) : plan.tiles)
          for (const segment of plan.segments) graph.set(`segment:${segment.key}`, { plan: { ...shared, tiles: tilesOf(segment) }, segment })
          graph.set(`join:${key}`, { segments: plan.segments.map((s) => s.key), audio: plan.audio.key })
          // Demanded here, not only by the join, so progress can be seen and slots shared
          await Promise.all(plan.segments.map((segment) => graph.demand("segment", segment.key, options).then(() => step(total))))
          value = await graph.demand("join", key, options)
          step(total)
        }
        const name = `${project.name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}-${quality}-${key.slice(0, 8)}.mp4`
        const file = join(exportsDir, name)
        checkOutput(file)
        mkdirSync(exportsDir, { recursive: true })
        copyFileSync(value.file, file)
        if (rendering === 1) prune(new Set([value.file, ...plan.segments.map((s) => cached("segments", `${s.key}.mp4`)), ...plan.tiles.map((t) => cached("tiles", `${t.key}.mov`))]), cached("audio", `${plan.audio.key}.`))
        return { file, plan }
      } catch (error) {
        throw unsupported(error)
      } finally {
        rendering--
      }
    },
  }
}
