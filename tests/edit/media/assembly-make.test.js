import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { sameAssembly, withIds } from "../../../src/edit/director/assembly.js"
import { ensureHost, hostCall, stopHost } from "../../../src/edit/host/client.js"
import { ROOT } from "../../helpers.js"
import { startFakeKriya } from "../../fake-kriya.js"
import { indexOf, wordId } from "../script.js"
import { fakeRuntime, rawTake } from "../take.js"
import { duration, ffmpeg, film, FLICKS, FRAME, orderOf, world } from "./assembly-world.js"
import { barcodeVideo, readBarcodes } from "./barcode.js"

// TP2's media checks (TOP_TIER_PLAN §5): ET-ASM-M1…M5 on the real FFmpeg with synthetic files.
// Every picture clip carries its frame number as a barcode, each clip from its own thousand,
// so a frame of the film says which file and which frame it came from. A function stands in
// for the model; no real person's face or voice is in any file.

// The barcode numbers of the film's frames while one piece plays
const framesOf = (numbers, piece) => numbers.slice(Math.round(piece.at / FRAME), Math.round(piece.end / FRAME))
const steps = (list) => list.slice(1).map((n, i) => n - list[i])

test("ET-ASM-M1 (Engine): three files in an order: the film's joins are the right files at the right times, and QG-15 passes", { timeout: 240_000 }, async () => {
  const w = await world({ talk: false, clips: { a: [90, 0], b: [150, 1000], c: [60, 2000] } })
  const made = await film(w, orderOf(w, "clip 3 first, then clip 1, then clip 2"))
  const numbers = readBarcodes(made.file)
  assert.equal(numbers.length, 300)
  assert.deepEqual([numbers.slice(0, 60), numbers.slice(60, 150), numbers.slice(150)].map((run) => [run[0], run.at(-1), run.every((n, i) => n === run[0] + i)]), [[2000, 2059, true], [0, 89, true], [1000, 1149, true]], "clip 3 whole, then clip 1 whole, then clip 2 whole, frame for frame")
  const gate = await made.gate()
  console.log(`ET-ASM-M1 QG-15 ${gate.status} (${gate.severity}): ${JSON.stringify(gate.numbers)}`)
  assert.deepEqual([gate.status, gate.severity, gate.numbers.joins, gate.numbers.framesChecked], ["passed", "note", 2, 9])
  assert.match(made.notes[0], /^The film's order: 1\. clip 3, whole, 2\.0 s; 2\. clip 1, whole, 3\.0 s; 3\. clip 2, whole, 5\.0 s/)
})

test("ET-ASM-M2: a part in the middle of another; an over part on its word; a voice-over as the clock", { timeout: 400_000 }, async () => {
  const w = await world()
  // In the middle: the talk, the barcoded clip whole, the rest of the talk
  const middle = await film(w, orderOf(w, "put clip 2 in the middle of clip 1, and don't use clip 3"))
  const numbers = readBarcodes(middle.file)
  const inserted = middle.timeline.picture.find((p) => p.asset === "a2")
  const [before, after] = [middle.timeline.picture.filter((p) => p.asset === "a1" && p.end <= inserted.at), middle.timeline.picture.filter((p) => p.asset === "a1" && p.at >= inserted.end)]
  assert.ok(before.length && after.length, "the talk plays on both sides")
  assert.ok(Math.max(...before.map((p) => p.out)) <= Math.min(...after.map((p) => p.in)), "and no word of it plays twice")
  const shown = framesOf(numbers, inserted)
  assert.deepEqual([shown[0], shown.at(-1), shown.length, steps(shown).every((d) => d === 1)], [1000, 1149, 150, true], "clip 2, whole, exactly where the plan put it")
  assert.equal(Math.abs(duration(middle.file) - middle.plan.duration / FLICKS) < 0.1, true)
  assert.equal((await middle.gate()).status, "passed")

  // Over: clip 2's picture starts on the word, the talk's sound carries on under it
  const over = await film(w, orderOf(w, "show clip 2 over clip 1 while I say fifty thousand, and leave out clip 3"))
  const cutaway = over.timeline.overlays.find((o) => !o.block)
  const fifty = w.index.words.find((x) => x.text === "fifty")
  const host = over.timeline.picture.find((p) => p.asset === "a1" && fifty.start >= p.in && fifty.end <= p.out)
  assert.ok(Math.abs(cutaway.at - (host.at + (fifty.start - host.in))) <= FRAME, "the cutaway starts on the word")
  // The Engine shows any overlay a frame after its start (its B-roll does the same, before TP2): so from the second frame on
  const seen = framesOf(readBarcodes(over.file), cutaway).slice(1)
  assert.deepEqual([seen[0], steps(seen.slice(0, -1)).every((d) => d === 1), seen.length >= 15], [1001, true, true], `clip 2 from its start, for ${seen.length} frames`)
  assert.equal(over.timeline.audio.some((a) => a.asset === "a2"), false, "it is seen, not heard")
  const overGate = await over.gate()
  assert.deepEqual([overGate.status, overGate.numbers.framesUnread], ["passed", 0], JSON.stringify(overGate))

  // A voice-over is the clock: the pictures share its length in order, and it is what is heard
  const v = await world({ talk: false, told: true })
  const voiced = await film(v, { version: 1, parts: withIds([{ asset: "a1", use: "whole" }, { asset: "a2", use: "whole" }, { asset: "a3", use: "sound" }]) })
  const told = readBarcodes(voiced.file)
  const [first, second] = voiced.timeline.picture
  assert.deepEqual([first.asset, second.asset, framesOf(told, first)[0], framesOf(told, second)[0]], ["a1", "a2", 1000, 2000])
  assert.ok(voiced.timeline.duration <= 7 * FLICKS + FRAME && Math.abs(duration(voiced.file) - voiced.timeline.duration / FLICKS) < 0.1, "as long as the pictures it has, never longer than the voice-over")
  const narration = voiced.timeline.audio.find((a) => a.asset === "a3")
  assert.deepEqual([narration.at, narration.effects.find((e) => e.type === "level").db], [0, 0])
  // FFmpeg prints volumedetect on stderr
  const heard = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", voiced.file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr
  assert.ok(Number(/mean_volume: (-?[\d.]+) dB/.exec(heard)[1]) > -40, "the narration is heard")
  assert.equal((await voiced.gate()).status, "passed")
})

test("ET-ASM-M3: a wide clip in a tall film, in each frame mode: fill crops, fit has bars, blur has a blurred copy behind", { timeout: 240_000 }, async () => {
  const w = await world({ talk: false, clips: { a: [45, 3000], b: [45, 1000] } })
  const tall = { width: 360, height: 640 }
  // The top row of one frame, and the row through the middle, as luma
  const rows = (file) => {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 28 })
    return { top: [...out.subarray(20 * tall.width, 21 * tall.width)], middle: [...out.subarray(320 * tall.width, 321 * tall.width)] }
  }
  const made = {}
  for (const fit of ["fill", "fit", "blur"]) {
    made[fit] = await film(w, { version: 1, parts: withIds([{ asset: "a1", use: "whole", fit }, { asset: "a2", use: "whole", fit }]) }, {}, tall)
    const gate = await made[fit].gate()
    assert.equal(gate.status, "passed", `${fit}: ${JSON.stringify(gate)}`)
  }
  const [fill, fit, blur] = ["fill", "fit", "blur"].map((mode) => rows(made[mode].file))
  // The barcode's bars are hard edges: a row of the picture itself has near-black and near-white
  const sharp = (row) => Math.min(...row) < 40 && Math.max(...row) > 200
  assert.ok(sharp(fill.top) && sharp(fill.middle), "fill: the picture covers the whole frame")
  assert.ok(fit.top.every((v) => v < 40) && sharp(fit.middle), "fit: bars above, the picture in the middle")
  assert.ok(!fit.top.every((v) => v === fit.top[0]) || fit.top[0] < 40, "the bars are the plate colour")
  assert.ok(sharp(blur.middle) && Math.max(...blur.top) > 60 && !sharp(blur.top), "blur: a soft, darker copy behind the picture")
  // Fit and blur show the whole picture: the barcode reads across the full width, as clip 1's frames
  for (const mode of ["fit", "blur"]) {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", made[mode].file, "-frames:v", "20", "-vf", "crop=360:202:0:219,scale=640:360,format=gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 1 << 28 })
    const numbers = []
    for (let at = 0; at + 640 * 360 <= out.length; at += 640 * 360) {
      let n = 0
      for (let bit = 0; bit < 12; bit++) if (out[at + 180 * 640 + bit * 53 + 26] > 128) n |= 1 << bit
      numbers.push(n)
    }
    assert.deepEqual([numbers[0], steps(numbers).every((d) => d === 1)], [3000, true], `${mode}: the whole picture, frame for frame`)
  }
  // A plan for a clip that fills has no new key
  assert.equal(JSON.stringify(made.fill.plan).includes('"type":"frame"'), false)
  assert.equal(made.fit.plan.segments[0].node.picture[0].effects.some((e) => e.type === "frame" && e.mode === "fit"), true)
})

test("ET-ASM-M4: QG-15 seeded: a swap, a missing part and a wrong stretch are each caught from the file; clean films pass", { timeout: 900_000 }, async () => {
  const w = await world({ talk: false, clips: { a: [90, 0], b: [90, 1000], c: [90, 2000], d: [90, 3000] } })
  const whole = (asset, more = {}) => ({ asset, use: "whole", ...more })
  const asked = { version: 1, parts: withIds(["a1", "a2", "a3", "a4"].map((asset) => whole(asset))) }
  const clean = await film(w, asked)
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const caught = { swap: 0, missing: 0, stretch: 0 }
  const missed = []
  const kinds = { swap: new Set(), missing: new Set(), stretch: new Set() }
  const N = 10
  for (let i = 0; i < N; i++) {
    // A swap: the same four files in another order
    let other
    do other = ["a1", "a2", "a3", "a4"].map((asset) => [random(), asset]).sort().map(([, asset]) => asset)
    while (other.join() === "a1,a2,a3,a4")
    const swapped = await film(w, { version: 1, parts: withIds(other.map((asset) => whole(asset))) })
    // A missing part: one file left out
    const gone = `a${1 + Math.floor(random() * 4)}`
    const missing = await film(w, { version: 1, parts: withIds(["a1", "a2", "a3", "a4"].filter((asset) => asset !== gone).map((asset) => whole(asset))) })
    // A wrong stretch: one file plays from a second or more later than asked, for as long
    const off = `a${1 + Math.floor(random() * 4)}`
    const shift = Math.round((1 + random()) * 30) * FRAME
    const narrow = { version: 1, parts: withIds(["a1", "a2", "a3", "a4"].map((asset) => whole(asset, { from: 0, to: 30 * FRAME }))) }
    const shifted = await film(w, { version: 1, parts: withIds(["a1", "a2", "a3", "a4"].map((asset) => whole(asset, asset === off ? { from: shift, to: shift + 30 * FRAME } : { from: 0, to: 30 * FRAME }))) })
    const right = await film(w, narrow)
    for (const [kind, file, gate] of [["swap", swapped.file, clean.gate], ["missing", missing.file, clean.gate], ["stretch", shifted.file, right.gate]]) {
      // The right project, plan and order; the wrong file. Only reading the file can catch it
      const result = await gate(file)
      if (result.status === "failed") caught[kind]++
      else missed.push(`${kind}${kind === "stretch" ? ` (${off} from ${shift / FRAME} frames later)` : ""}: unlike by ${result.numbers.worstDistance} at most, ${result.numbers.allowed} allowed`)
      for (const f of result.failures ?? []) kinds[kind].add(f.kind)
    }
  }
  // Clean: the same film re-encoded to other qualities must not be flagged
  let alarms = 0
  let cleanWorst = 0
  for (let i = 0; i < N; i++) {
    const out = join(w.root, `clean-${i}.mp4`)
    ffmpeg("-i", clean.file, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(16 + i), "-preset", ["veryfast", "medium", "fast"][i % 3], "-c:a", "copy", out)
    const result = await clean.gate(out)
    cleanWorst = Math.max(cleanWorst, result.numbers.worstDistance)
    if (result.status !== "passed") alarms++
  }
  console.log(`EG-4 QG-15 (barcoded synthetic files, threshold unmeasured on natural footage): swap ${caught.swap}/${N}, missing part ${caught.missing}/${N}, wrong stretch ${caught.stretch}/${N}; false alarms ${alarms}/${N}; clean re-encodes unlike by ${cleanWorst} at most${missed.length ? `\nEG-4 QG-15 missed: ${missed.join("; ")}` : ""}`)
  // A swap and a missing part are always caught. A wrong stretch can be missed when the two moments differ by one
  // bar of the barcode (a twelfth of the picture), which reads under the allowed difference: that is why QG-15
  // is a note until TPX-04 measures its threshold, and this number is written down, not hidden
  assert.deepEqual([caught.swap, caught.missing, alarms], [N, N, 0])
  assert.ok(caught.stretch >= N - 1, `wrong stretch ${caught.stretch}/${N}`)
  assert.deepEqual([...kinds.swap, ...kinds.missing, ...kinds.stretch].every((kind) => kind === "frame_mismatch" || kind === "frame_missing"), true, "each was read from the file's own frames")
  // And the cut itself against the order asked: no file needed
  const wrongOrder = await clean.gate(clean.file, { version: 1, parts: withIds(["a2", "a1", "a3", "a4"].map((asset) => whole(asset))) })
  assert.deepEqual([wrongOrder.status, wrongOrder.severity, wrongOrder.failures[0].kind], ["failed", "note", "order"])
  assert.match(wrongOrder.message, /The parts play as clip 1, clip 2, clip 3, clip 4; the order asked for was clip 2, clip 1, clip 3, clip 4/)
})

/* ───────────── through a real Host: three ways in, one film; a file gone ───────────── */

const until = async (check, limit = 400_000, what = "a condition") => {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    assert.ok(Date.now() - start < limit, `timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

async function hostWorld({ chat, runtime = false } = {}) {
  const tasks = []
  const fake = await startFakeKriya({
    models: ["budget"],
    features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: true },
    chat(body) {
      tasks.push(body.response_format?.json_schema?.name)
      return chat?.(body) ?? { content: "{}" }
    },
  })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-asmh-")))
  if (runtime) fakeRuntime(home)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "600000" }
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const project = async (name) => {
    const folder = join(home, "work", name)
    mkdirSync(folder, { recursive: true })
    const { id } = await call("POST", "/projects", { name, folder })
    const assets = []
    // Clip 1 starts at 100: barcode number 0 is an all-black frame, which QG-07 rightly calls black
    for (const [file, frames, start] of [["walk-in.mov", 90, 100], ["beach final.mov", 150, 1000], ["outro.mov", 60, 2000]]) {
      await barcodeVideo(join(folder, file), { frames, start })
      assets.push(await call("POST", `/projects/${id}/assets`, { path: join(folder, file) }))
    }
    return { id, folder, assets }
  }
  const make = async (id, body) => {
    const job = await call("POST", `/projects/${id}/make`, body)
    const done = await until(async () => {
      const row = (await call("GET", "/jobs")).jobs.find((j) => j.id === job.id)
      return ["done", "failed"].includes(row.status) ? row : null
    }, 400_000, "the film")
    assert.equal(done.status, "done", done.error)
    return { job, result: JSON.parse(done.output) }
  }
  return { home, call, project, make, tasks, fake }
}

test("ET-TP-REG-04 (Host): a project with a stored storyboard, made with no order in the brief, makes the plan the same take makes without one", { timeout: 900_000 }, async () => {
  const index = indexOf()
  const w = await hostWorld({
    runtime: true,
    chat(body) {
      const task = body.response_format?.json_schema?.name
      if (task === "story") return { content: JSON.stringify({ hook: null, drop: [] }) }
      if (task === "emphasis") return { content: JSON.stringify({ emphasis: [wordId(index, "fifty")] }) }
      return { content: "{}" }
    },
  })
  try {
    const take = join(w.home, "take.mov")
    rawTake(take)
    const made = {}
    for (const name of ["plain", "boarded"]) {
      const folder = join(w.home, "work", name)
      mkdirSync(folder, { recursive: true })
      // The same bytes in both projects, so a plan's hash can be compared
      execFileSync("cp", [take, join(folder, "take.mov")])
      await barcodeVideo(join(folder, "beach.mov"), { frames: 90, start: 1000 })
      const { id } = await w.call("POST", "/projects", { name, folder })
      const a1 = await w.call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
      const a2 = await w.call("POST", `/projects/${id}/assets`, { path: join(folder, "beach.mov") })
      // One project has a storyboard that would put the other clip first; nothing sends it with the make
      if (name === "boarded") await w.call("PATCH", `/projects/${id}`, { ops: [{ op: "describe_asset", asset: a1.id, label: "the talk" }, { op: "set_assembly", assembly: { version: 1, parts: [{ id: "p1", asset: a2.id, use: "whole", why: "storyboard" }, { id: "p2", asset: a1.id, use: "whole", why: "storyboard" }] } }] })
      // As Tavi, a watch folder, the command line and the bench call it: an asset and a brief, no order
      made[name] = (await w.make(id, { asset: a1.id, brief: { seconds: 45 } })).result
      made[name].project = (await w.call("GET", `/projects/${id}`)).project
    }
    // A plan's hash carries its own project's ids, so two projects never share one (two plain ones differ too):
    // what is compared is the cut itself, everything a render is made from
    const cut = ({ project }) => ({ canvas: project.canvas, brief: project.brief, deliverables: project.deliverables, tracks: project.sequences[0].tracks, clips: project.sequences[0].clips, look: project.look })
    console.log(`ET-TP-REG-04: plain ${made.plain.verdict}, ${made.plain.project.sequences[0].clips.length} clips; with a stored storyboard ${made.boarded.verdict}, ${made.boarded.project.sequences[0].clips.length} clips`)
    assert.deepEqual(cut(made.boarded), cut(made.plain), "the same cut, clip for clip (EH-63)")
    assert.deepEqual(made.boarded.changes, made.plain.changes, "and the same What I did")
    assert.equal(made.boarded.verdict, made.plain.verdict)
    assert.deepEqual(made.boarded.gates.map((g) => [g.id, g.status]), made.plain.gates.map((g) => [g.id, g.status]))
    assert.equal(made.boarded.gates.length, 14, "no QG-15: it followed no assembly")
    assert.ok(made.boarded.project.sequences[0].clips.every((c) => !c.source || c.source.asset === "a1"), "only the take it was given is in the cut")
    assert.equal(made.boarded.project.sequences[0].assembly.parts.length, 2, "and the storyboard is still the person's, untouched")
    assert.deepEqual(w.tasks.filter((t) => t === "assembly"), [], "no slot was added to this path")
  } finally {
    await stopHost(w.home)
    await w.fake.close?.()
  }
})

test("ET-ASM-M1 (Host): one order given three ways (a storyboard, mentions, words) makes the same assembly, and each is delivered with the right files at the right times", { timeout: 900_000 }, async () => {
  const w = await hostWorld()
  try {
    const assemblies = []
    const films = []
    const check = (result, way) => {
      const gates = Object.fromEntries(result.gates.map((g) => [g.id, g]))
      console.log(`ET-ASM-M1 ${way}: ${result.verdict}; QG-15 ${gates["QG-15"]?.status} ${JSON.stringify(gates["QG-15"]?.numbers)}; not passed: ${result.gates.filter((g) => !["passed", "not_applicable"].includes(g.status)).map((g) => `${g.id} ${g.status}${g.message ? ` (${g.message})` : ""}`).join("; ") || "none"}`)
      assert.ok(["delivered", "delivered_with_notes"].includes(result.verdict), `${way}: ${result.verdict}`)
      assert.equal(result.gates.length, 15, "the 14 gates and QG-15")
      assert.deepEqual([gates["QG-15"].status, gates["QG-15"].severity], ["passed", "note"])
      for (const id of ["QG-01", "QG-02", "QG-06"]) assert.equal(gates[id].status, "passed", `${way} ${id}: ${gates[id].message}`)
      const numbers = readBarcodes(result.file)
      assert.deepEqual([numbers.length, numbers[0], numbers[59], numbers[60], numbers[149], numbers[150], numbers[299]], [300, 2000, 2059, 100, 189, 1000, 1149], `${way}: clip 3, clip 1, clip 2, frame for frame`)
      assert.ok(result.notes.some((n) => /^The film's order: 1\. clip 3.*2\. clip 1.*3\. clip 2/.test(n)), "What I did says the order")
      films.push(result.file)
    }
    // 1. Drag: the storyboard, sent with Make it as the Studio sends it
    const drag = await w.project("drag")
    const [a1, a2, a3] = drag.assets.map((a) => a.id)
    const parts = [a3, a1, a2].map((asset, i) => ({ id: `p${i + 1}`, asset, use: "whole", why: "storyboard" }))
    await w.call("PATCH", `/projects/${drag.id}`, { ops: [{ op: "set_assembly", assembly: { version: 1, parts } }] })
    const stored = (await w.call("GET", `/projects/${drag.id}`)).project.sequences[0].assembly
    const dragged = await w.make(drag.id, { brief: { format: "16:9", assembly: stored } })
    assemblies.push(stored)
    check(dragged.result, "storyboard")
    // 2. Point: mentions in a message, through the plan the card shows
    const point = await w.project("point")
    const ids = point.assets.map((a) => a.id)
    const pointed = await w.call("POST", `/projects/${point.id}/plan`, { text: "⟦1⟧ first, then ⟦2⟧, then ⟦3⟧, in 16:9", mentions: [{ asset: ids[2] }, { asset: ids[0] }, { asset: ids[1] }] })
    assert.deepEqual(pointed.order.parts.map((p) => [p.number, p.use, p.why]), [[3, "whole", "person"], [1, "whole", "person"], [2, "whole", "person"]], "the card's Order")
    assemblies.push(pointed.brief.assembly)
    check((await w.make(point.id, { brief: pointed.brief, plan: { say: pointed.say, steps: pointed.steps, settings: pointed.settings } })).result, "mentions")
    // 3. Say: words alone
    const say = await w.project("say")
    const worded = await w.call("POST", `/projects/${say.id}/plan`, { text: "clip 3 first, then clip 1, then clip 2, in 16:9" })
    assemblies.push(worded.brief.assembly)
    check((await w.make(say.id, { brief: worded.brief })).result, "words")
    assert.equal(sameAssembly(assemblies[0], assemblies[1]) && sameAssembly(assemblies[1], assemblies[2]), true, "each way makes the same assembly")
    assert.equal(w.tasks.includes("assembly"), false, "code read every one of them: the Director's slot was never asked")
    assert.equal(w.tasks.includes("story"), false, "and nobody speaks in these files, so no story was asked either")

    // A second make of the same order: the same film, nothing placed twice
    const again = await w.make(say.id, { brief: worded.brief })
    assert.deepEqual(readBarcodes(again.result.file).length, 300)
    const view = (await w.call("GET", `/projects/${say.id}`)).project.sequences[0]
    assert.equal(view.clips.filter((c) => c.source && c.at === null).length, 3)
    assert.equal(view.assembly, undefined, "a make writes no storyboard onto the project")
  } finally {
    await stopHost(w.home)
    await w.fake.close?.()
  }
})

test("ET-ASM-M5: a file gone offline: asked for by the person, the make ends needs_you; not asked for, it is left out with a note and the rest is delivered", { timeout: 600_000 }, async () => {
  const w = await hostWorld()
  try {
    const p = await w.project("gone")
    const [a1, a2, a3] = p.assets.map((a) => a.id)
    renameSync(join(p.folder, "beach final.mov"), join(p.folder, "moved-away.mov"))
    const part = (id, asset, why) => ({ id, asset, use: "whole", why })
    // The storyboard names it: the person's to settle
    const asked = await w.make(p.id, { brief: { format: "16:9", assembly: { version: 1, parts: [part("p1", a3, "storyboard"), part("p2", a2, "storyboard"), part("p3", a1, "storyboard")] } } })
    assert.equal(asked.result.verdict, "needs_you")
    assert.match(asked.result.notes[0], /Clip 2 is in the order you gave, and its file isn't where it was/)
    assert.equal(asked.result.file, undefined, "nothing was rendered, nothing delivered")
    assert.equal((await w.call("GET", `/projects/${p.id}`)).project.sequences[0].clips.length, 0, "and the project is untouched")
    // Nobody named it (the default order): left out, said, and the rest is made
    const rest = await w.make(p.id, { brief: { format: "16:9", assembly: { version: 1, parts: [part("p1", a3, "default"), part("p2", a2, "default"), part("p3", a1, "default")] } } })
    assert.ok(["delivered", "delivered_with_notes"].includes(rest.result.verdict), rest.result.verdict)
    assert.ok(rest.result.notes.some((n) => /Left out clip 2: its file isn't where it was/.test(n)))
    const numbers = readBarcodes(rest.result.file)
    assert.deepEqual([numbers.length, numbers[0], numbers[59], numbers[60], numbers[149]], [150, 2000, 2059, 100, 189], "clip 3 then clip 1")
    assert.equal(rest.result.gates.find((g) => g.id === "QG-15").status, "passed", "the part left out with a note isn't held against the film")
  } finally {
    await stopHost(w.home)
    await w.fake.close?.()
  }
})
