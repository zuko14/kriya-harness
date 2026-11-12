import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"

import { apply } from "../../../src/edit/core/ops.js"
import { solve } from "../../../src/edit/core/solver.js"
import { readCapabilities } from "../../../src/edit/engine/capabilities.js"
import { createEngine } from "../../../src/edit/engine/index.js"
import { ALL_MOODS, writeAccent, writeMusicBed } from "../../../src/edit/engine/music-bed.js"
import { probe } from "../../../src/edit/engine/probe.js"
import { runGates } from "../../../src/edit/gates/index.js"
import { openJournal } from "../../../src/edit/graph/journal.js"
import { splitOps } from "../../../src/edit/recipes/sound.js"
import { makeProject } from "../fixture.js"

// TP10 on real media (CRAFT_UPGRADE §8, TOP_TIER_PLAN §4): for every one of the ten moods, a bed Kriya wrote
// under a cut of three talking clips, an accent in its key on each join, J and L cuts through the silences,
// mastered to -14 LUFS. Measured on the files: each accent's loudest moment within 30 ms of its join, on the
// rendered effects stem; QG-06 passes on every bed; QG-05 passes with the J and L cuts. A tone stands in for
// speech: it sounds only while a word is said, so the silences are real silence.

const FLICKS = 705_600_000
const RATE = 48_000
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-sound-")))
const take = join(dir, "take.mov")
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
// Three lines of four words: 0.4 s each with 0.1 s between, 0.9 s between lines, from 0.5 s
const WORDS = []
for (let line = 0, t = 0.5; line < 3; line++, t += 0.8) for (let w = 0; w < 4; w++, t += 0.5) WORDS.push({ asset: "a1", id: `a1:w${WORDS.length}`, start: Math.round(t * FLICKS), end: Math.round((t + 0.4) * FLICKS), text: `word${WORDS.length}`, lang: "en", speaker: "s0", conf: 1, flags: [] })
const SECONDS = 10
let capabilities

before(async () => {
  capabilities = await readCapabilities()
  const voiced = WORDS.map((w) => `between(t,${(w.start / FLICKS).toFixed(3)},${(w.end / FLICKS).toFixed(3)})`).join("+")
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${SECONDS}`, "-f", "lavfi", "-i", `aevalsrc='0.4*sin(2*PI*220*t)*(${voiced})':s=${RATE}:d=${SECONDS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-y", take])
})

async function world(mood) {
  const root = realpathSync(mkdtempSync(join(dir, `${mood}-`)))
  const bed = writeMusicBed(join(root, "bed.wav"), { mood, seconds: SECONDS })
  const accent = writeAccent(join(root, "accent.wav"), mood, { fps: { n: 30, d: 1 } })
  const { facts } = await probe(take)
  const project = structuredClone(makeProject())
  project.canvas = { ...project.canvas, width: 640, height: 360, fps: { n: 30, d: 1 } }
  const audio = async (id, file, more = {}) => ({ ...project.assets.find((a) => a.kind === "audio"), id, path: file, fingerprint: sha(file), rights: "own", rightsNote: "Made by Kriya", facts: { ...(await probe(file)).facts, ...more } })
  project.assets = [{ ...project.assets[0], id: "a1", path: take, fingerprint: sha(take), facts }, await audio("m1", bed.file), await audio("x1", accent.file, { peak: Math.round(accent.peak * FLICKS) })]
  project.deliverables = []
  const index = { words: WORDS, sentences: [], shots: [], faces: [] }
  // One clip per line, from just before its first word to just after its last
  const lines = [0, 4, 8].map((i) => ({ from: WORDS[i].start - Math.round(0.15 * FLICKS), to: WORDS[i + 3].end + Math.round(0.15 * FLICKS) }))
  const cut = apply(project, [...lines.map((l) => ({ op: "keep_range", asset: "a1", from: l.from, to: l.to })), { op: "add_deliverable", preset: "reel-9x16", size: { width: 640, height: 360 }, fps: { n: 30, d: 1 }, codec: "h264", audio: "aac", loudness: { lufs: -14, tp: -1 }, burnCaptions: false }, { op: "set_music", asset: "m1" }, { op: "duck" }], { index, author: "agent" })
  assert.deepEqual(cut.diagnostics, [])
  const clips = cut.project.sequences[0].clips.filter((c) => c.source?.asset === "a1")
  const played = solve(cut.project, index).picture.map((p) => ({ clip: p.clip, asset: p.asset, in: p.in, out: p.out }))
  const splits = splitOps(played, WORDS)
  const done = apply(cut.project, [...clips.slice(1).map((c) => ({ op: "add_sfx", asset: "x1", peak_at: { clip: c.id, edge: "start" } })), ...splits], { index, author: "agent" })
  assert.deepEqual(done.diagnostics, [])
  const engine = createEngine({ folder: root, roots: [root, dir], cache: join(root, "cache"), exports: join(root, "exports"), journal: openJournal(":memory:"), toolVersion: "9", capabilities })
  engine.load(done.project, index)
  const joins = solve(done.project, index).picture.filter((p, i, all) => i > 0 && all[i - 1].clip !== p.clip).map((p) => p.at)
  return { engine, project: done.project, index, joins, splits, deliverable: done.project.deliverables[0].id, root }
}

/** The loudest 5 ms of a sound file within `reach` of `at`, in flicks. */
function loudestNear(file, at, reach = Math.round(0.15 * FLICKS)) {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 28 })
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
  const window = RATE / 200
  const [from, to] = [Math.max(0, Math.round(((at - reach) / FLICKS) * RATE)), Math.min(x.length, Math.round(((at + reach) / FLICKS) * RATE))]
  let [best, where] = [0, from]
  for (let s = from; s + window <= to; s += window / 5) {
    let sum = 0
    for (let i = s; i < s + window; i++) sum += x[i] * x[i]
    if (sum > best) [best, where] = [sum, s + window / 2]
  }
  return Math.round((where / RATE) * FLICKS)
}

test("TP10 exit: every mood's bed, an accent on each join within 30 ms, QG-06 passing, QG-05 passing with J and L cuts", { timeout: 280_000 }, async () => {
  const rows = []
  for (const mood of Object.keys(ALL_MOODS)) {
    const w = await world(mood)
    assert.ok(w.splits.length >= 1, `${mood}: the joins have J or L cuts`)
    const { file, plan } = await w.engine.render({ quality: "master", deliverable: w.deliverable })
    const { stems } = await w.engine.stems(plan.audio.key)
    const off = w.joins.map((join) => Math.round(((loudestNear(stems.sfx, join) - join) / FLICKS) * 1000))
    for (const ms of off) assert.ok(Math.abs(ms) <= 30, `${mood}: an accent ${ms} ms from its join`)
    const gates = await runGates({ file, plan, project: w.project, index: w.index, sourcePath: (id) => w.project.assets.find((a) => a.id === id).path, only: ["QG-05", "QG-06"], stems: w.engine.stems, work: join(w.root, "gates") })
    const by = Object.fromEntries(gates.gates.map((g) => [g.id, g]))
    assert.equal(by["QG-06"].status, "passed", `${mood}: QG-06 ${by["QG-06"].message ?? ""} ${JSON.stringify(by["QG-06"].numbers ?? {})}`)
    assert.equal(by["QG-05"].status, "passed", `${mood}: QG-05 ${by["QG-05"].message ?? ""} ${JSON.stringify(by["QG-05"].numbers ?? {})}`)
    rows.push(`${mood} ${by["QG-06"].numbers.integrated} LUFS, accents ${off.join("/")} ms`)
  }
  console.log(`TP10 per mood: ${rows.join("; ")}`)
})
