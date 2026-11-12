import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { segmentArgs } from "../src/edit/core/ffmpeg.js"
import { EFFECTS, fxSteps, regionOf, regionPixels } from "../src/edit/core/effects.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { newProject } from "../src/edit/core/project.js"
import { markPixels, solve } from "../src/edit/core/solver.js"
import { consoleSchema, expandMark, markView, pointingSchema, revise } from "../src/edit/director/revise.js"
import { blockComposition } from "../src/edit/engine/motion.js"
import { cleanGraphic, ALL_GRAPHIC_KINDS, GRAPHIC_BLOCK, GRAPHIC_VERSION } from "../src/edit/engine/graphics.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { hostHeaders, socketPath } from "../src/edit/host/paths.js"
import { cleanMark } from "../src/edit/host/server.js"
import { markFromDrag, toFrame, toShown } from "../studio/src/draw.js"
import { startFakeKriya } from "./fake-kriya.js"
import { ROOT } from "./helpers.js"
import { indexOf, lengthOf, wordId } from "./edit/script.js"

// TP9 (CRAFT_UPGRADE §7): a box, ring or arrow drawn on the monitor goes with a message as typed data,
// { kind, x, y, w, h, at } in thousandths of the frame and flicks, checked by the Host, and becomes Edit
// Core operations placed by code: a callout round it, a blur or a mask in it, a punch-in on it. The
// model chooses what to do and never sees a coordinate. Real renders: tests/edit/media/custom-motion-pointing.test.js.

const F = 705_600_000
const index = indexOf("a1")
const MARK = { kind: "ring", x: 600, y: 200, w: 250, h: 200, at: Math.round(3 * F) }

function world() {
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round((lengthOf() + 2) * F), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  let made = apply(newProject({ id: "p", name: "Point" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f-a1", path: "a1.mov", linked: true, rights: "own", facts }], { author: "code" })
  made = apply(made.project, [{ op: "keep_range", asset: "a1", from: 0, to: Math.round(12 * F) }], { index, author: "agent" })
  return made.project
}

test("the Host never trusts a drawing: whole thousandths inside the frame, a known kind, whole flicks; anything else is refused", () => {
  assert.equal(cleanMark(undefined), undefined)
  assert.equal(cleanMark(null), undefined)
  assert.deepEqual(cleanMark(MARK), MARK)
  for (const bad of [
    { ...MARK, x: 600.5 },
    { ...MARK, x: -1 },
    { ...MARK, w: 401 + 600 },
    { ...MARK, h: 9 },
    { ...MARK, kind: "star" },
    { ...MARK, at: -1 },
    { ...MARK, at: 1.5 },
    { ...MARK, at: Number.MAX_SAFE_INTEGER },
    { ...MARK, x: "600" },
    { ...MARK, extra: 1 },
    "box",
    [MARK],
  ])
    assert.equal(cleanMark(bad), null, JSON.stringify(bad))
  assert.deepEqual(regionOf({ x: 0, y: 0, w: 1000, h: 1000 }), { x: 0, y: 0, w: 1000, h: 1000 })
  assert.equal(regionOf({ x: 995, y: 0, w: 10, h: 10 }), null)
})

test("the monitor maps a drag to the frame through its zoom, clamps to the frame, and drops a slip", () => {
  assert.deepEqual(markFromDrag("box", { u: 0.1, v: 0.2 }, { u: 0.4, v: 0.5 }, { at: 1234 }), { kind: "box", x: 100, y: 200, w: 300, h: 300, at: 1234 })
  // Dragged up and left: the same box
  assert.deepEqual(markFromDrag("box", { u: 0.4, v: 0.5 }, { u: 0.1, v: 0.2 }, { at: 1234 }), { kind: "box", x: 100, y: 200, w: 300, h: 300, at: 1234 })
  // At 2× the monitor shows the frame's middle half: the whole shown picture is 250…750 of the frame
  assert.deepEqual(markFromDrag("ring", { u: 0, v: 0 }, { u: 1, v: 1 }, { zoom: 2, at: 0 }), { kind: "ring", x: 250, y: 250, w: 500, h: 500, at: 0 })
  assert.equal(toFrame(-0.5, 1), 0)
  assert.ok(Math.abs(toShown(toFrame(0.3, 1.7), 1.7) - 0.3) < 1e-12)
  assert.equal(markFromDrag("box", { u: 0.5, v: 0.5 }, { u: 0.505, v: 0.6 }, { at: 0 }), null, "under 10 thousandths wide")
  assert.equal(markFromDrag("box", { u: 0.1, v: 0.1 }, { u: 0.5, v: 0.5 }, { at: -1 }), null)
})

test("callout this: a callout round exactly the drawn box, its kind from the drawing, its label grounded; placed by the solver to the pixel", () => {
  const project = world()
  const { ops, problems } = expandMark([{ op: "use_mark", use: "callout", text: "the whole thing" }], { mark: MARK, project, index, person: "callout this" })
  assert.deepEqual(problems, [])
  assert.equal(ops[0].op, "add_motion")
  assert.deepEqual(ops[0].variables.mark, { x: 600, y: 200, w: 250, h: 200 })
  assert.equal(ops[0].variables.style, "ring")
  assert.equal(ops[0].at, MARK.at)
  assert.equal(ops[0].duration, 3 * F)
  const made = apply(project, ops, { index, author: "agent" })
  assert.ok(made.applied, JSON.stringify(made.diagnostics))
  const solved = solve(made.project, index)
  const overlay = solved.overlays.find((o) => o.block?.blockId === GRAPHIC_BLOCK)
  assert.deepEqual(overlay.placement, markPixels(MARK, { width: 1080, height: 1920 }))
  assert.deepEqual(overlay.placement, { x: 648, y: 384, w: 270, h: 384 })
  // The tile draws round that box: a ring as an ellipse filling it
  const html = blockComposition({ blockId: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: ops[0].variables, placement: overlay.placement, duration: 3 * F }, { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } })
  assert.match(html, /#a\{position:absolute;left:648px;top:384px;width:270px;height:384px\}/)
  assert.match(html, /#k\{position:absolute;inset:0;border-radius:50%/)
  // A label the speaker never said isn't shown
  const bad = expandMark([{ op: "use_mark", use: "callout", text: "best product ever" }], { mark: MARK, project, index, person: "callout this" })
  assert.match(bad.problems[0], /isn't in the speaker's words/)
  // An arrow, and no label: still a callout
  const arrow = expandMark([{ op: "use_mark", use: "callout" }], { mark: { ...MARK, kind: "arrow" }, project, index, person: "" })
  assert.equal(arrow.ops[0].variables.style, "arrow")
  // A callout from TP7 with a point and no mark is drawn as before
  const old = cleanGraphic({ kind: "callout", style: "ring", text: "", point: { x: 500, y: 500 } }, ALL_GRAPHIC_KINDS)
  assert.equal(old.mark, undefined)
  assert.doesNotMatch(blockComposition({ blockId: GRAPHIC_BLOCK, version: GRAPHIC_VERSION, variables: old, placement: { x: 400, y: 400, w: 200, h: 200 }, duration: 3 * F }, { output: { width: 1080, height: 1920 }, canvas: { width: 1080, height: 1920 } }), /inset:0;border-radius:50%/)
})

test("blur this, mask this: the effect inside (or outside) the drawn region, crop → effect → overlay in even pixels; whole-frame blur is unchanged", () => {
  const project = world()
  const { ops } = expandMark([{ op: "use_mark", use: "blur" }, { op: "use_mark", use: "mask" }], { mark: MARK, project, index, person: "" })
  assert.deepEqual(ops.map((op) => [op.op, op.effect, op.region]), [["add_adjustment", "blur", { x: 600, y: 200, w: 250, h: 200 }], ["add_adjustment", "mask", { x: 600, y: 200, w: 250, h: 200 }]])
  assert.equal(ops[0].at, MARK.at)
  assert.equal(ops[0].duration, Math.round(12 * F) - MARK.at, "to the end of the shot under the drawing")
  const made = apply(project, ops, { index, author: "agent" })
  assert.ok(made.applied, JSON.stringify(made.diagnostics))
  const uid = (() => {
    let n = 0
    return () => n++
  })()
  assert.deepEqual(regionPixels({ x: 600, y: 200, w: 250, h: 200 }, 1080, 1920), { x: 648, y: 384, w: 270, h: 384 })
  assert.deepEqual(regionPixels({ x: 1, y: 1, w: 999, h: 999 }, 640, 360), { x: 0, y: 0, w: 640, h: 360 })
  const blur = fxSteps({ type: "fx", id: "blur", params: { amount: 20 }, region: { x: 600, y: 200, w: 250, h: 200 } }, { width: 1080, height: 1920, uid })
  assert.deepEqual(blur, ["split[ra0][rb0];[rb0]crop=w=270:h=384:x=648:y=384,gblur=sigma=20[rc0];[ra0][rc0]overlay=x=648:y=384"])
  const mask = fxSteps({ type: "fx", id: "mask", region: { x: 600, y: 200, w: 250, h: 200 } }, { width: 1080, height: 1920, uid })
  assert.deepEqual(mask, ["split[ra1][rb1];[ra1]eq=brightness=-0.2700:saturation=0.5800[rc1];[rb1]crop=w=270:h=384:x=648:y=384[rd1];[rc1][rd1]overlay=x=648:y=384"])
  // No region: exactly the filter it always was
  assert.deepEqual(fxSteps({ type: "fx", id: "blur", params: { amount: 20 } }, { width: 1080, height: 1920, uid }), ["gblur=sigma=20"])
  // The compiled film draws them in its own graph
  const plan = compile(made.project, index, { engineVersion: "e", runtimeVersion: "r", filters: new Set(["gblur", "eq", "crop", "split"]) })
  const args = segmentArgs(plan, plan.segments.at(-1), { input: () => "/in.mov", tile: () => "/t.mov", output: "/o.mp4", encoder: [] })
  const graph = args[args.indexOf("-filter_complex") + 1]
  // A draft is 720×1280: the same thousandths land on its own pixels
  assert.match(graph, /\[rb0\]crop=w=180:h=256:x=432:y=256,gblur=sigma=20\[rc0\];\[ra0\]\[rc0\]overlay=x=432:y=256/)
  assert.match(graph, /eq=brightness=-0\.2700:saturation=0\.5800/)
})

test("the operation refuses a region it can't draw: off the frame, on a whole-frame effect, a mask with none; old effects store no region key", () => {
  const project = world()
  const clip = project.sequences[0].clips.find((c) => c.source).id
  const tryOp = (op, author = "person") => apply(project, [op], { index, author })
  const code = (op) => tryOp(op).diagnostics[0]?.code
  assert.equal(code({ op: "add_effect", clip, effect: "blur", region: { x: 900, y: 0, w: 200, h: 100 } }), "bad_region")
  assert.equal(code({ op: "add_effect", clip, effect: "blur", region: { x: 0, y: 0, w: 100, h: 100, extra: 1 } }), "bad_region")
  assert.equal(code({ op: "add_effect", clip, effect: "grain", region: { x: 0, y: 0, w: 100, h: 100 } }), "bad_region")
  assert.equal(code({ op: "add_effect", clip, effect: "mask" }), "needs_region")
  assert.equal(code({ op: "add_effect", clip, effect: "pixelate", region: { x: 0, y: 0, w: 100, h: 100 } }), undefined)
  const plain = tryOp({ op: "add_effect", clip, effect: "blur" })
  assert.deepEqual(plain.project.sequences[0].clips.find((c) => c.id === clip).effects.at(-1), { type: "fx", id: "blur" })
  assert.deepEqual(Object.entries(EFFECTS).filter(([, row]) => row.region).map(([id]) => id), ["blur", "pixelate", "mask"])
})

test("zoom here: a smooth punch-in centred on the drawn box, scaled to fit it, between 1.1× and 3×", () => {
  const project = world()
  const { ops } = expandMark([{ op: "use_mark", use: "zoom" }], { mark: MARK, project, index, person: "" })
  assert.deepEqual(ops[0], { op: "punch_in", at: MARK.at, duration: 3 * F, scale: 3, ease: "smooth", x: 725, y: 300 })
  const wide = expandMark([{ op: "use_mark", use: "zoom", duration: Math.round(1.5 * F) }], { mark: { ...MARK, x: 100, w: 800, y: 100, h: 600 }, project, index, person: "" })
  assert.deepEqual([wide.ops[0].scale, wide.ops[0].x, wide.ops[0].y, wide.ops[0].duration], [1.13, 500, 400, Math.round(1.5 * F)])
  assert.ok(apply(project, ops, { index, author: "agent" }).applied)
  const late = expandMark([{ op: "use_mark", use: "blur" }], { mark: { ...MARK, at: Math.round(13 * F) }, project, index, person: "" })
  assert.match(late.problems[0], /past the end of the cut/)
})

test("chat with a drawing: the model reads where it is in words, picks use_mark, and code turns it into the operation; without a drawing the schema is what it was", async () => {
  const project = world()
  assert.equal(pointingSchema(consoleSchema(true), { customMotion: false, mark: false }), consoleSchema(true))
  let seen = null
  const ask = async (slot) => {
    seen = slot
    const value = { ops: [{ op: "use_mark", use: "blur" }], say: "Blurred it." }
    assert.deepEqual(slot.check(value), [])
    return { value, source: "model", calls: 1 }
  }
  const result = await revise({ ask, project, index, text: "blur this", customMotion: true, mark: MARK })
  assert.match(seen.view, /drew a ring on the frame at 0:03\.0, in the top right, about 5% of the frame/)
  assert.doesNotMatch(seen.view, /600|250/, "no coordinate reaches the model")
  assert.ok(seen.schema.properties.ops.items.properties.op.enum.includes("use_mark"))
  assert.deepEqual(result.ops.map((op) => op.op), ["add_adjustment"])
  assert.match(result.changes[0], /^Blurred what you drew, from 3\.00 s for 9\.00 s$/)
  assert.match(markView({ ...MARK, kind: "box" }), /drew a box/)
  // A use_mark without a drawing isn't in the schema, and its check refuses it
  const plain = await revise({ ask: async (slot) => ({ value: { ops: [{ op: "use_mark", use: "blur" }] }, source: "model", calls: 1, problems: slot.check({ ops: [{ op: "use_mark", use: "blur" }] }) }), project, index, text: "blur this" })
  assert.deepEqual(plain.ops, [])
})

/* The Host, with editing.customMotion off and on: a real Host process, fake Kriya, no media */

async function hostWorld(customMotion, chat) {
  const models = []
  const fake = await startFakeKriya({ models: ["budget"], features: { visuals: false, playbooks: false, mediaSearch: false, motion: true, customMotion, assembly: false, livePreview: false, intent: false, craft: false }, chat: (body) => (models.push(body.model), chat(body)) })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const bin = join(home, "bin")
  const folder = join(home, "work", "film")
  mkdirSync(folder, { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. gblur V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) exit 1;;\nesac\n`)
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"video","width":1080,"height":1920,"r_frame_rate":"30/1","avg_frame_rate":"30/1","duration_ts":300,"time_base":"1/30","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"}],"format":{"format_name":"mov","duration":"10.0"}}'\n`)
  for (const tool of ["ffmpeg", "ffprobe"]) chmodSync(join(bin, tool), 0o755)
  // No Media Runtime here: a custom animation can't be checked, so it is never offered
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body).catch((error) => error)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  writeFileSync(join(folder, "take.mov"), "take")
  const a = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
  await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: a.id, from: 0, to: 8 * F }] })
  const raw = (method, path, body) =>
    new Promise((done, fail) => {
      const req = request({ socketPath: socketPath(home), method, path, headers: { ...hostHeaders(home), ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }))
      })
      req.on("error", fail)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  return { home, fake, id, call, raw, models, close: async () => (await stopHost(home), await fake.close()) }
}

test("ET-TP-REG / off: with editing.customMotion off a drawing isn't read, the preview route is 404 and the project view has no flag", async () => {
  const w = await hostWorld(false, () => ({ content: JSON.stringify({ ops: [], say: "Nothing to change." }) }))
  try {
    const view = await w.call("GET", `/projects/${w.id}`)
    assert.equal(view.customMotion, undefined)
    // A drawing, even a bad one, is simply not read: the message is asked as it always was
    const reply = await w.raw("POST", `/projects/${w.id}/ask`, { text: "blur this", mark: { kind: "star", x: -5 } })
    assert.equal(reply.status, 200)
    assert.equal((await w.raw("GET", `/projects/${w.id}/custom-preview?proposal=x&op=0`)).status, 404)
  } finally {
    await w.close()
  }
})

test("on: a bad drawing is refused at the Host; a good one with \"blur this\" becomes a proposal with the region; custom motion with no runtime is never offered and no stronger model is asked", async () => {
  const w = await hostWorld(true, (body) => {
    const text = body.messages.at(-1).content
    if (/blur this/.test(text)) return { content: JSON.stringify({ ops: [{ op: "use_mark", use: "blur" }], say: "Blurred what you drew." }) }
    return { content: JSON.stringify({ ops: [{ op: "custom_motion", text: "a spinning badge", at: 0 }], say: "A spinning badge." }) }
  })
  try {
    assert.equal((await w.call("GET", `/projects/${w.id}`)).customMotion, true)
    for (const bad of [{ ...MARK, x: 999 }, { ...MARK, kind: "star" }, { ...MARK, at: -3 }, { ...MARK, w: 2.5 }]) {
      const reply = await w.raw("POST", `/projects/${w.id}/ask`, { text: "blur this", mark: bad })
      assert.equal(reply.status, 400, JSON.stringify(bad))
    }
    const plan = await w.raw("POST", `/projects/${w.id}/plan`, { text: "callout this", mark: { ...MARK, h: 0 } })
    assert.equal(plan.status, 400, "the plan's route checks a drawing too")
    const reply = JSON.parse((await w.raw("POST", `/projects/${w.id}/ask`, { text: "blur this", mark: MARK })).body)
    const op = reply.proposal.ops[0]
    assert.deepEqual([op.op, op.effect, op.region], ["add_adjustment", "blur", { x: 600, y: 200, w: 250, h: 200 }])
    assert.equal(reply.proposal.motion, undefined)
    assert.equal((await w.raw("GET", `/projects/${w.id}/custom-preview?proposal=${reply.proposal.id}&op=0`)).status, 404, "no custom animation in that proposal")
    const accepted = await w.call("POST", `/projects/${w.id}/proposals/${reply.proposal.id}`, { accept: true })
    assert.equal(accepted.applied, 1)
    // Custom motion with no Media Runtime: refused in words, the nearest kit graphic named, `balanced` never asked
    const custom = await w.call("POST", `/projects/${w.id}/ask`, { text: "add a spinning badge" })
    assert.equal(custom.proposal, null)
    assert.match(custom.say, /needs the Media Runtime's Chrome.*nearest the kit has is a/)
    assert.deepEqual([...new Set(w.models)], ["budget"])
  } finally {
    await w.close()
  }
})
