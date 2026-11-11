import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { apply } from "../../../src/edit/core/ops.js"
import { newProject } from "../../../src/edit/core/project.js"
import { solve } from "../../../src/edit/core/solver.js"
import { applyMoves, clipList, defaultParts, resolveRefs } from "../../../src/edit/director/assembly.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { planAssembly } from "../../../src/edit/recipes/assembly.js"
import { indexOf, lengthOf } from "../script.js"
import { barcodeVideo } from "./barcode.js"

// Shared by the TP2 media tests and Bench-A-M: synthetic files on disk, a project that holds
// them, and one call that makes an assembly, renders it as a master and asks QG-15 about it.

export const FLICKS = 705_600_000
export const FRAME = FLICKS / 30
export const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-asm-")))
export const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] })
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
export const duration = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }))
export const TALK = ["Today I want to show you how we built this.", "It cost us fifty thousand rupees in total.", "Our users loved it and told their friends.", "Thanks for watching, and see you next time."]
export const TOLD = ["This is the story of one small shop.", "It opened on a quiet street in spring."]

export const ask = async (slot) => ({ value: slot.fallback(), source: "model", calls: 1 })

/** Files on disk and a project that holds them: `talk` (a chart with a tone, and a transcript), barcoded clips, a narration. */
export async function world({ clips = { b: [150, 1000], c: [60, 2000] }, talk = true, told = false, song = false } = {}) {
  const root = realpathSync(mkdtempSync(join(dir, "w-")))
  const ops = []
  const files = {}
  const add = async (id, name, more = {}) => {
    files[id] = join(root, name)
    ops.push({ op: "add_asset", id, kind: name.endsWith(".wav") ? "audio" : "video", fingerprint: sha(files[id]), path: files[id], linked: true, rights: "own", facts: (await probe(files[id])).facts, ...more })
  }
  let index = { words: [], sentences: [], takes: [], shots: [], faces: [], silences: [], timestamps: {}, subjects: {} }
  const merge = (more) => (index = { ...index, words: [...index.words, ...more.words], sentences: [...index.sentences, ...more.sentences], takes: [...index.takes, ...more.takes] })
  if (talk) {
    const seconds = lengthOf(TALK).toFixed(3)
    ffmpeg("-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${seconds}`, "-f", "lavfi", "-i", `sine=f=220:r=48000:d=${seconds}`, "-c:v", "libx264", "-crf", "16", "-g", "30", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-shortest", join(root, "talk.mov"))
    await add("a1", "talk.mov")
    merge(indexOf("a1", TALK))
  }
  let n = talk ? 2 : 1
  for (const [name, [frames, start]] of Object.entries(clips)) {
    await barcodeVideo(join(root, `${name}.mov`), { frames, start })
    await add(`a${n++}`, `${name}.mov`)
  }
  if (song) {
    ffmpeg("-f", "lavfi", "-i", "sine=f=440:r=48000:d=30", "-c:a", "pcm_s16le", join(root, "song.wav"))
    await add(`a${n++}`, "song.wav", { role: "music" })
  }
  if (told) {
    const seconds = lengthOf(TOLD).toFixed(3)
    ffmpeg("-f", "lavfi", "-i", `sine=f=180:r=48000:d=${seconds}`, "-c:a", "pcm_s16le", join(root, "narration.wav"))
    await add(`a${n}`, "narration.wav")
    merge(indexOf(`a${n}`, TOLD))
  }
  const made = apply(newProject({ id: "p", name: "Film", width: 640, height: 360 }), ops, { author: "code" })
  assert.deepEqual(made.diagnostics, [])
  const capabilities = await readCapabilities()
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities })
  return { root, files, project: made.project, index, engine, capabilities, sourcePath: (id) => files[id] }
}

/** Words to an assembly, by code alone. */
export function orderOf(w, text) {
  const clips = clipList(w.project, w.index)
  const read = resolveRefs(text, clips, { index: w.index })
  const made = applyMoves(defaultParts(clips), read.moves, { clips, index: w.index })
  assert.deepEqual([...read.open, ...made.open], [], text)
  return { version: 1, parts: made.parts }
}

/** The assembly made, rendered as a master, with QG-15's verdict. `canvas`: the film's frame, small so the test is quick. */
export async function film(w, assembly, brief = {}, canvas = { width: 640, height: 360 }, asker = ask) {
  // The recipe decides each part's frame against the film's shape, so the brief names the shape the small canvas has
  const planned = await planAssembly({ project: w.project, index: w.index, ask: asker, brief: { assembly, format: canvas.width > canvas.height ? "16:9" : "9:16", ...brief }, filters: w.capabilities.filters })
  // The recipe's frame is a full-size one; the same film on a small canvas renders in seconds
  const sized = structuredClone(planned.project)
  sized.canvas = { ...sized.canvas, ...canvas }
  sized.deliverables = sized.deliverables.map((d) => ({ ...d, size: canvas }))
  w.engine.load(sized, w.index)
  const { file, plan } = await w.engine.render({ quality: "master", deliverable: sized.deliverables[0].id })
  const gate = async (wrong = file, asked = assembly) => (await runGates({ file: wrong, plan, project: sized, index: w.index, sourcePath: w.sourcePath, only: ["QG-15"], assembly: asked })).gates[0]
  return { file, plan, project: sized, notes: planned.notes, timeline: solve(sized, w.index), gate }
}

