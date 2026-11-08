// The Footage Index (PERCEPTION_AND_INDEX): runs each layer once per media and
// version, in the order that unblocks the edit, and writes what it found to
// index.sqlite. A missing or failed layer is recorded with a plain notice and
// lowers what's possible; it never stops the others that don't need it.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { probe } from "../engine/probe.js"
import { EngineFailure, runTool } from "../engine/tool.js"
import { activeRuntime, childEnv } from "../runtime/setup.js"
import { FACES_VERSION, faceHelper, frameArgs, readFaces } from "./layers/faces.js"
import { analyseMusic, MUSIC_VERSION, musicArgs, pcmCollector } from "./layers/music.js"
import { QUALITY_VERSION, qualityArgs, qualityCollector, scoreShots } from "./layers/quality.js"
import { RETAKES_VERSION, analyseDelivery } from "./layers/retakes.js"
import { SHOTS_VERSION, readShots, shotArgs } from "./layers/shots.js"
import { SOUND_VERSION, readSound, soundArgs } from "./layers/sound.js"
import { MODEL, WORDS_VERSION, readWords, recogniser, speechArgs, transcribeArgs } from "./layers/words.js"

export const PROBE_VERSION = "l0-1"
export const LAYERS = ["L0", "L1", "L2", "L5", "L6", "L7", "L8"]
/** The layers for an asset: a sound file also gets its beats (L12, ED9). */
export const layersFor = (kind) => (kind === "audio" ? [...LAYERS, "L12"] : LAYERS)
const FLICKS = 705_600_000
const timeout = (duration, perSecond) => Math.max(120_000, Math.ceil((duration ?? 0) / FLICKS) * perSecond)

class Unavailable extends Error {}
const unavailable = (message) => {
  throw new Unavailable(message)
}

/**
 * @param {{ db: ReturnType<import("./db.js").openIndexDb>, cache: string, binDir: string, language?: string, run?: typeof runTool, runtime?: () => object | null, acquire?: (resources: string[], signal?: AbortSignal) => Promise<() => void> }} options
 */
export function createIndexer({ db, cache, binDir, language = "en", run = runTool, runtime = () => activeRuntime(), acquire = async () => () => {} }) {
  const layers = {
    L0: {
      version: PROBE_VERSION,
      async run({ path }) {
        const { facts, timestamps } = await probe(path, { run })
        return { data: { facts, ...(timestamps ? { timestamps } : {}) } }
      },
    },
    L1: {
      version: SOUND_VERSION,
      needs: ["L0"],
      async run({ path, facts, signal, fingerprint }) {
        if (!facts.hasAudio) unavailable("This file has no sound.")
        const { data, silences } = readSound(await run("ffmpeg", soundArgs(path), { signal, timeoutMs: timeout(facts.duration, 2_000) }), facts.duration)
        return { data, write: (sql) => silences.forEach((s) => sql.prepare("insert into events (media, start, \"end\", kind, conf) values (?, ?, ?, 'silence', null)").run(fingerprint, s.start, s.end)) }
      },
    },
    L2: {
      version: `${WORDS_VERSION}:${MODEL}:${language}`,
      needs: ["L0"],
      resources: ["gpu"],
      async run({ path, facts, signal, fingerprint }) {
        if (!facts.hasAudio) unavailable("This file has no sound, so it has no words.")
        const engine = recogniser(runtime())
        if (engine.missing) unavailable(engine.missing)
        const audio = join(cache, "speech", `${fingerprint}.wav`)
        mkdirSync(join(cache, "speech"), { recursive: true })
        try {
          await run("ffmpeg", speechArgs(path, audio), { signal, timeoutMs: timeout(facts.duration, 1_000) })
          // Offline: the model reads only its installed weights
          const env = { ...childEnv(), HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" }
          const words = readWords(await run(engine.python, transcribeArgs(engine, audio, language), { signal, env, timeoutMs: timeout(facts.duration, 2_000) }))
          return {
            data: { count: words.length, language, model: MODEL },
            write: (sql) => {
              const insert = sql.prepare('insert into words (media, n, start, "end", text, lang, conf) values (?, ?, ?, ?, ?, ?, ?)')
              const search = sql.prepare("insert into words_fts (text, media, n) values (?, ?, ?)")
              words.forEach((w, n) => {
                insert.run(fingerprint, n, w.start, w.end, w.text, language, w.conf)
                search.run(w.text, fingerprint, n)
              })
            },
          }
        } finally {
          rmSync(audio, { force: true })
        }
      },
    },
    L5: {
      version: RETAKES_VERSION,
      needs: ["L2"],
      async run({ fingerprint }) {
        const words = db.db.prepare('select n, start, "end", text, conf from words where media = ? order by n').all(fingerprint)
        if (!words.length) return { data: { sentences: 0, groups: 0 } }
        const { flags, sentences, takes } = analyseDelivery(words, { language })
        return {
          data: { sentences: sentences.length, groups: new Set(takes.map((t) => t.group)).size },
          write: (sql) => {
            const flag = sql.prepare("update words set flags = ? where media = ? and n = ?")
            flags.forEach((list, i) => flag.run([...new Set(list)].join(","), fingerprint, words[i].n))
            const sentence = sql.prepare('insert into sentences (media, n, start, "end", first_word, last_word, take_group, score) values (?, ?, ?, ?, ?, ?, ?, ?)')
            sentences.forEach((s, n) => sentence.run(fingerprint, n, s.start, s.end, words[s.first].n, words[s.last].n, s.group, s.score))
            const take = sql.prepare('insert into takes (media, "group", sentence, rank, signals) values (?, ?, ?, ?, ?)')
            for (const t of takes) take.run(fingerprint, t.group, t.sentence, t.rank, JSON.stringify(t.signals))
          },
        }
      },
    },
    L6: {
      version: SHOTS_VERSION,
      needs: ["L0"],
      async run({ path, facts, signal, fingerprint }) {
        if (!facts.width) unavailable("This file has no picture.")
        const shots = readShots(await run("ffmpeg", shotArgs(path), { signal, timeoutMs: timeout(facts.duration, 2_000) }), facts.duration)
        return {
          data: { shots: shots.length, transitions: "hard cuts only" },
          write: (sql) => {
            const insert = sql.prepare('insert into shots (media, n, start, "end", kind) values (?, ?, ?, ?, ?)')
            shots.forEach((s, n) => insert.run(fingerprint, n, s.start, s.end, s.kind))
          },
        }
      },
    },
    L7: {
      version: QUALITY_VERSION,
      needs: ["L6"],
      async run({ path, facts, signal, fingerprint }) {
        const collector = qualityCollector()
        await run("ffmpeg", qualityArgs(path), { signal, timeoutMs: timeout(facts.duration, 2_000), onStdout: (chunk) => collector.add(chunk) })
        const shots = db.db.prepare('select n, start, "end" from shots where media = ? order by n').all(fingerprint)
        const scores = scoreShots(collector.finish(), shots)
        return {
          data: { shots: shots.length, calibrated: false },
          write: (sql) => {
            const update = sql.prepare("update shots set blur = ?, exposure = ?, shake = ?, motion = ? where media = ? and n = ?")
            scores.forEach((s, i) => update.run(s.blur, s.exposure, s.shake, s.motion, fingerprint, shots[i].n))
          },
        }
      },
    },
    L8: {
      version: FACES_VERSION,
      needs: ["L6"],
      async run({ path, facts, signal, fingerprint }) {
        if (!facts.width) unavailable("This file has no picture.")
        const helper = await faceHelper(binDir, run)
        if (helper.missing) unavailable(helper.missing)
        const folder = join(cache, "faces", fingerprint)
        rmSync(folder, { recursive: true, force: true })
        mkdirSync(folder, { recursive: true })
        try {
          await run("ffmpeg", frameArgs(path, folder), { signal, timeoutMs: timeout(facts.duration, 1_000) })
          const sampled = existsSync(folder) ? readdirSync(folder).length : 0
          const faces = readFaces(await run(helper.path, [folder], { signal, timeoutMs: timeout(facts.duration, 1_000) }), facts)
          const shots = db.db.prepare('select n, start, "end" from shots where media = ? order by n').all(fingerprint)
          const shotAt = (t) => shots.find((s) => t >= s.start && t < s.end)?.n ?? null
          return {
            data: { sampled, faces: faces.length, tracks: new Set(faces.map((f) => f.identity)).size },
            write: (sql) => {
              const insert = sql.prepare("insert into faces (media, shot, t, box, identity) values (?, ?, ?, ?, ?)")
              for (const f of faces) insert.run(fingerprint, shotAt(f.t), f.t, JSON.stringify(f.box), f.identity)
            },
          }
        } finally {
          rmSync(folder, { recursive: true, force: true })
        }
      },
    },
    L12: {
      version: MUSIC_VERSION,
      needs: ["L0"],
      async run({ path, facts, signal, fingerprint }) {
        if (!facts.hasAudio) unavailable("This file has no sound.")
        if (facts.width) unavailable("Beats are read from sound files.")
        const pcm = pcmCollector()
        await run("ffmpeg", musicArgs(path), { signal, timeoutMs: timeout(facts.duration, 2_000), onStdout: (chunk) => pcm.add(chunk) })
        const { bpm, beats, bars } = analyseMusic(pcm.finish())
        if (!beats.length) unavailable("No steady beat was found in this sound.")
        return {
          data: { bpm, beats: beats.length, bars: bars.length, meter: "4/4 assumed" },
          write: (sql) => {
            const beat = sql.prepare("insert into beats (media, n, t, downbeat, strength) values (?, ?, ?, ?, ?)")
            beats.forEach((b, n) => beat.run(fingerprint, n, b.t, b.downbeat ? 1 : 0, b.strength))
            const bar = sql.prepare('insert into bars (media, n, start, "end", energy) values (?, ?, ?, ?, ?)')
            bars.forEach((b, n) => bar.run(fingerprint, n, b.start, b.end, b.energy))
          },
        }
      },
    },
  }

  // A layer's key: its own version, and when each layer it reads last changed
  const keyOf = (fingerprint, name) => [layers[name].version, ...(layers[name].needs ?? []).map((dep) => `${dep}@${db.layer(fingerprint, dep)?.updated_at ?? "none"}`)].join("|")

  return {
    layers,

    /**
     * Runs what's missing for one asset. Identical media re-added does no work (ET-IDX-01).
     * @param {{ id: string, kind: string, fingerprint: string, facts: object }} asset
     * @param {string} path the real source path, already through guardPath
     * @returns {Promise<{ layer: string, status: string, notice: string | null, ran: boolean }[]>}
     */
    async indexAsset(asset, path, { signal, only = LAYERS, onStep = () => {} } = {}) {
      const fingerprint = asset.fingerprint
      db.setAsset(asset.id, fingerprint, asset.kind)
      const report = []
      for (const [step, name] of only.entries()) {
        const layer = layers[name]
        const key = keyOf(fingerprint, name)
        const before = db.layer(fingerprint, name)
        if (before?.model_version === key && before.status === "ok") {
          report.push({ layer: name, status: "ok", notice: before.notice, ran: false })
          onStep(step + 1, only.length)
          continue
        }
        const blocked = (layer.needs ?? []).find((dep) => db.layer(fingerprint, dep)?.status !== "ok")
        let result
        if (blocked) result = { status: "unavailable", notice: `Needs ${blocked}, which isn't available.` }
        else {
          const release = await acquire(layer.resources ?? ["cpu"], signal)
          try {
            const facts = db.layer(fingerprint, "L0")?.data?.facts ?? asset.facts
            const done = await layer.run({ path, facts, signal, fingerprint })
            result = { status: "ok", notice: null, ...done }
          } catch (error) {
            if (signal?.aborted) throw error
            if (error instanceof Unavailable) result = { status: "unavailable", notice: error.message }
            else result = { status: "failed", notice: error instanceof EngineFailure ? error.message : `This layer failed: ${error.message}` }
          } finally {
            release()
          }
        }
        db.saveLayer(fingerprint, name, { version: key, status: result.status, notice: result.notice, data: result.data ?? null, write: result.write })
        report.push({ layer: name, status: result.status, notice: result.notice, ran: !blocked })
        onStep(step + 1, only.length)
      }
      return report
    },
  }
}
