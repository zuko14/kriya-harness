import assert from "node:assert/strict"
import { test } from "node:test"

import { AGENT_CAP_PER_MINUTE, EFFECTS, expandMove, fxSteps, keyExpression, keysProblem, MAX_POINTS, MOVES, skinEase, valuesOf } from "../src/edit/core/effects.js"
import { segmentArgs } from "../src/edit/core/ffmpeg.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { EFFECTS as STORED } from "../src/edit/core/project.js"
import { solve } from "../src/edit/core/solver.js"
import { consoleSchema, craftSchema } from "../src/edit/director/revise.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"

// TP5 (CRAFT_UPGRADE §3, TOP_TIER_PLAN §5): the effects registry, its refusal at the operation,
// adjustments across segments, keyframes to expressions, named moves, restraint, the skin guard,
// and the switch off. No media here: tests/edit/media/effects.test.js renders every row.

const FLICKS = 705_600_000
const VERSIONS = { engineVersion: "e", runtimeVersion: "r" }
const index = makeIndex()
const io = { input: () => "/a.mov", tile: () => "/t.mov", output: "/o.mov", encoder: [] }
const graph = (args) => args[args.indexOf("-filter_complex") + 1]
// This computer's FFmpeg 9.0.2 filters each row needs, measured in spike TPX-02 (SPIKES.md §6)
const MEASURED = new Set(["gblur", "unsharp", "vignette", "noise", "curves", "hue", "eq", "colorchannelmixer", "negate", "hflip", "rgbashift", "crop", "scale", "pad", "drawbox", "fade", "deshake", "reverse", "split", "blend", "colorbalance", "lut3d", "zoompan", "geq", "colorize", "pseudocolor", "lutrgb"])
const cut = (ops = [], author = "person") => {
  const base = apply(makeProject(), [{ op: "keep_range", asset: "a1", from: 0, to: ms(14000) }], { index, author: "person" })
  assert.deepEqual(base.diagnostics, [])
  return apply(base.project, ops, { index, author })
}
const refused = (ops, author = "person") => {
  const r = cut(ops, author)
  assert.equal(r.applied, false, JSON.stringify(ops))
  return r.diagnostics[0].code
}
const clipOf = (project) => project.sequences[0].clips.find((c) => c.source && !c.at).id

test("ET-FX-01: every row's values have ranges with the default inside; the same values build the same steps twice", () => {
  assert.ok(Object.keys(EFFECTS).length >= 20, `${Object.keys(EFFECTS).length} rows`)
  for (const [id, row] of Object.entries(EFFECTS)) {
    for (const [name, [min, max, fallback]] of Object.entries(row.params)) assert.ok(min < max && fallback >= min && fallback <= max, `${id}.${name}`)
    assert.ok(["light", "heavy"].includes(row.weight), id)
    const { values } = valuesOf(id)
    let k = 0
    const ctx = () => ({ width: 1080, height: 1920, uid: () => k++, origin: 0, span: FLICKS })
    const once = fxSteps({ type: "fx", id }, ctx())
    k = 0
    assert.deepEqual(fxSteps({ type: "fx", id }, ctx()), once, `${id}: deterministic`)
    assert.ok(once.length > 0, `${id}: draws something at its defaults`)
    assert.equal(typeof row.preview(values), row.preview(values) === null ? "object" : "string")
  }
  assert.match(valuesOf("blur", { amount: 41 }).problem, /between 0.5 and 40/)
  assert.match(valuesOf("blur", { radius: 2 }).problem, /no value "radius"/)
  assert.match(valuesOf("sparkles").problem, /no "sparkles" effect/)
})

test("ET-FX-02: each row's needs are filters this runtime has (TPX-02); one it lacks drops the effect at compile, with a note", () => {
  for (const [id, row] of Object.entries(EFFECTS)) for (const name of row.needs) assert.ok(MEASURED.has(name), `${id} needs ${name}, measured present`)
  const { project } = cut([])
  const withGrain = apply(project, [{ op: "add_effect", clip: clipOf(project), effect: "grain" }], { index, author: "person" }).project
  const lacking = compile(withGrain, index, { ...VERSIONS, filters: new Set([...MEASURED].filter((f) => f !== "noise")) })
  assert.equal(lacking.segments.some((s) => s.node.picture.some((p) => p.effects.some((e) => e.type === "fx"))), false)
  assert.ok(lacking.issues.some((i) => i.code === "effect_unavailable" && /noise/.test(i.message)))
  const having = compile(withGrain, index, { ...VERSIONS, filters: MEASURED })
  assert.match(graph(segmentArgs(having, having.segments[0], io)), /noise=alls=12:allf=t\+u:all_seed=1234/)
})

test("ET-FX-03: the operation refuses what the render can't draw; every picture effect the schema allows an operation to store is drawn", () => {
  const { project } = cut([])
  const clip = clipOf(project)
  assert.equal(refused([{ op: "add_effect", clip, effect: "sparkles" }]), "bad_effect")
  assert.equal(refused([{ op: "add_effect", clip, effect: "blur", params: { amount: 99 } }]), "bad_effect")
  assert.equal(refused([{ op: "add_effect", clip, effect: "blur", params: { amount: "8" } }]), "bad_effect")
  assert.equal(refused([{ op: "add_effect", clip, effect: "blur", keys: [{ param: "amount", points: [{ at: 0, value: 1 }, { at: ms(500), value: 9 }] }] }]), "bad_keyframes", "blur can't be keyed")
  const many = Array.from({ length: MAX_POINTS + 1 }, (_, i) => ({ at: ms(i * 100), value: 0.5 }))
  assert.equal(refused([{ op: "add_effect", clip, effect: "vignette", keys: [{ param: "strength", points: many }] }]), "bad_keyframes")
  assert.equal(refused([{ op: "add_effect", clip, effect: "vignette", keys: [{ param: "strength", points: [{ at: ms(500), value: 0 }, { at: ms(100), value: 1 }] }] }]), "bad_keyframes", "out of order")
  assert.equal(refused([{ op: "add_effect", clip, effect: "vignette", keys: [{ param: "strength", points: [{ at: 0, value: 0, ease: "bounce" }, { at: ms(100), value: 1 }] }] }]), "bad_keyframes")
  assert.equal(refused([{ op: "add_effect", clip, effect: "vignette", keys: [{ param: "strength", points: [{ at: 0, value: 0 }, { at: ms(99000), value: 1 }] }] }]), "bad_keyframes", "after the clip ends")
  assert.equal(refused([{ op: "add_effect", clip, effect: "vignette", move: "drain" }]), "bad_move", "drain is black and white's")
  assert.equal(refused([{ op: "add_effect", clip, effect: "blackWhite", move: "drain", keys: [] }]), "bad_effect")
  assert.equal(refused([{ op: "add_adjustment", at: 0, effect: "blur" }]), "needs_duration")
  // Walk every effect type the project schema allows on a picture and every registry row: each draws
  const ways = {
    reframe: { op: "reframe", clip, mode: "fixed", x: 0 },
    grade: { op: "grade", clip, saturation: 1.2 },
    stabilize: { op: "stabilize", clip },
    frame: null, // behind editing.assembly, drawn since TP2 (ET-ASM-M3)
    lut: null, // needs a .cube asset; drawn since ED13 (ET-ENG lut tests)
    fx: { op: "add_effect", clip, effect: "grain" },
  }
  for (const [type, op] of Object.entries(ways)) {
    assert.ok(Object.hasOwn(STORED, type), type)
    if (!op) continue
    const made = apply(project, [op], { index, author: "person" })
    assert.deepEqual(made.diagnostics, [], type)
    const plan = compile(made.project, index, VERSIONS)
    assert.doesNotThrow(() => segmentArgs(plan, plan.segments[0], io), type)
  }
  for (const id of Object.keys(EFFECTS)) {
    const plan = compile(apply(project, [{ op: "add_effect", clip, effect: id }], { index, author: "person" }).project, index, VERSIONS)
    assert.doesNotThrow(() => segmentArgs(plan, plan.segments[0], io), id)
  }
})

test("ET-FX-04: an adjustment over a stretch is compiled into each segment it crosses, at its own times there, and nowhere else", () => {
  const { project } = cut([{ op: "add_adjustment", at: ms(4000), duration: ms(4000), effect: "blackWhite" }])
  const timeline = solve(project, index)
  assert.equal(timeline.adjustments.length, 1)
  const plan = compile(project, index, VERSIONS)
  const crossed = plan.segments.filter((s) => s.node.adjust)
  assert.ok(crossed.length >= 2, `it crosses ${crossed.length} segments`)
  for (const s of crossed) {
    const [a] = s.node.adjust
    assert.equal(a.at, Math.max(0, ms(4000) - s.start))
    assert.equal(a.end, Math.min(s.end, ms(8000)) - s.start)
    assert.match(graph(segmentArgs(plan, s, io)), /split\[aj0\]\[ak0\];\[ak0\]hue=s=0\[al0\]/)
  }
  assert.ok(plan.segments.filter((s) => !s.node.adjust).every((s) => s.start >= ms(8000) || s.end <= ms(4000)), "only where it plays")
})

// The expression a keyframe compiles to, read back at a time: FFmpeg's if/lt as JavaScript, numbers only
const at = (expr, t) => Function("t", `const iff=(c,a,b)=>c?a:b, lt=(a,b)=>a<b; return ${expr.replaceAll("if(", "iff(")}`)(t)

test("ET-FX-05: keyframes become one piecewise expression from numbers, eased as asked, held before the first and after the last", () => {
  const points = [{ at: ms(1000), value: 0, ease: "linear" }, { at: ms(2000), value: 1, ease: "inOut" }, { at: ms(3000), value: 0.5, ease: "hold" }, { at: ms(4000), value: 0.2 }]
  const expr = keyExpression(points)
  assert.equal(/[a-df-su-z]{3,}/i.test(expr.replace(/if|lt/g, "")), false, "no names but t, if and lt")
  assert.equal(at(expr, 0.5), 0)
  assert.equal(at(expr, 1.5), 0.5, "linear half way")
  assert.ok(Math.abs(at(expr, 2.25) - (1 + -0.5 * (0.25 * 0.25 * (3 - 0.5)))) < 1e-9, "smoothstep a quarter in")
  assert.equal(at(expr, 3.5), 0.5, "a hold keeps its value")
  assert.equal(at(expr, 9), 0.2)
  assert.equal(at(keyExpression(points, 2), 2.5), 0, "shifted by the effect's start in its chain")
  assert.equal(keysProblem("vignette", [{ param: "strength", points }]), null)
  assert.match(fxSteps({ type: "fx", id: "vignette", keys: [{ param: "strength", points }] }, { width: 10, height: 10, uid: () => 0 })[0], /vignette=angle=0\.25\+0\.45\*\(if\(lt\(t\\,1\)\\,0/)
})

test("ET-FX-06: a named move expands over the effect's own span into keyframes, so the same move is the same expression every render", () => {
  for (const [name, move] of Object.entries(MOVES)) {
    const keys = expandMove(name, move.effect, valuesOf(move.effect).values, ms(2000))
    assert.equal(keysProblem(move.effect, keys), null, name)
    assert.equal(keys[0].points.at(-1).at, ms(2000), `${name} ends with its span`)
  }
  const { project } = cut([])
  const moved = apply(project, [{ op: "add_effect", clip: clipOf(project), effect: "blackWhite", move: "drain" }], { index, author: "person" }).project
  const a = graph(segmentArgs(compile(moved, index, VERSIONS), compile(moved, index, VERSIONS).segments[0], io))
  const b = graph(segmentArgs(compile(moved, index, VERSIONS), compile(moved, index, VERSIONS).segments[0], io))
  assert.equal(a, b)
  assert.match(a, /hue=s=1-\(if\(lt\(t\\,/, "the saturation follows the move")
})

test("ET-FX-07: restraint: an agent adds at most a few a minute and never two heavy effects at once; the person is never capped", () => {
  const { project } = cut([])
  const clip = clipOf(project)
  const agent = (p, ops) => apply(p, ops, { index, author: "agent" })
  let p = project
  for (const effect of ["grain", "vignette", "sharpen"].slice(0, AGENT_CAP_PER_MINUTE)) p = agent(p, [{ op: "add_effect", clip, effect }]).project
  const fourth = agent(p, [{ op: "add_effect", clip, effect: "blur" }])
  assert.equal(fourth.diagnostics[0].code, "restraint", "a fourth in under a minute")
  assert.equal(apply(p, [{ op: "add_effect", clip, effect: "blur" }], { index, author: "person" }).applied, true, "the person may")
  const heavy = agent(project, [{ op: "add_effect", clip, effect: "invert" }]).project
  assert.equal(agent(heavy, [{ op: "add_effect", clip, effect: "pixelate" }]).diagnostics[0].code, "restraint", "two heavy on one clip")
  assert.equal(heavy.sequences[0].clips.find((c) => c.id === clip).effects.at(-1).by, "agent", "marked, so the next count sees it")
})

test("ET-FX-08: the skin guard eases a look that moves skin too far, only on a clip with faces, and says so", () => {
  assert.equal(skinEase({ id: "tint", params: { amount: 0.5 } }), 12 / 90)
  assert.equal(skinEase({ id: "punchy" }), 1, "within the limit")
  assert.equal(skinEase({ id: "blackWhite" }), 1, "black and white moves no hue")
  const { project } = cut([])
  const tinted = apply(project, [{ op: "add_effect", clip: clipOf(project), effect: "tint", params: { amount: 0.5 } }], { index, author: "person" }).project
  const faced = compile(tinted, index, VERSIONS) // the fixture's take has a face at 2 s
  const first = faced.segments[0].node.picture[0].effects.find((e) => e.type === "fx")
  assert.equal(first.ease, 0.133)
  assert.ok(faced.issues.some((i) => i.code === "skin_guard"))
  assert.match(graph(segmentArgs(faced, faced.segments[0], io)), /blend=all_mode=normal:all_opacity=0\.1330/)
  const faceless = compile(tinted, { ...index, faces: [] }, VERSIONS)
  assert.equal(faceless.segments[0].node.picture[0].effects.find((e) => e.type === "fx").ease, undefined, "no face, no easing")
})

test("ET-FX-REG-01: switch off, today's cuts compile to plans and timelines with no new key, and the console's schema is the object it was", () => {
  const { project } = cut([{ op: "grade", clip: "c1", saturation: 1.1 }])
  assert.equal("adjustments" in solve(project, index), false)
  const plan = compile(project, index, VERSIONS)
  assert.equal("adjustments" in plan, false)
  assert.equal(JSON.stringify(plan).includes('"fx"'), false)
  assert.deepEqual(compile(project, index, { ...VERSIONS, filters: MEASURED }).segments.map((s) => s.key), plan.segments.map((s) => s.key), "the runtime's filters change no key of a cut with no effect")
  assert.equal(craftSchema(consoleSchema(false), false), consoleSchema(false))
  assert.equal(craftSchema(consoleSchema(true), false), consoleSchema(true))
  assert.ok(craftSchema(consoleSchema(false), true).properties.ops.items.properties.op.enum.includes("add_effect"))
})

test("ET-FX-REG-01 (Host): switch off, the Host takes no effect operation; on, it stores one the registry allows", async () => {
  const { spawn } = await import("node:child_process")
  const { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { ensureHost, hostCall, stopHost } = await import("../src/edit/host/client.js")
  const { startFakeKriya } = await import("./fake-kriya.js")
  const { ROOT } = await import("./helpers.js")
  for (const craft of [false, true]) {
    const fake = await startFakeKriya({ features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview: false, intent: false, craft } })
    const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
    try {
      const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
      assert.equal(await new Promise((done) => login.on("exit", done)), 0)
      const bin = join(home, "bin")
      const folder = join(home, "work", "film")
      mkdirSync(folder, { recursive: true })
      mkdirSync(bin)
      writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. noise V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) exit 1;;\nesac\n`)
      writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"video","width":640,"height":360,"r_frame_rate":"30/1","avg_frame_rate":"30/1","duration_ts":90,"time_base":"1/30","color_primaries":"bt709","color_transfer":"bt709","color_space":"bt709","color_range":"tv"}],"format":{"format_name":"mov","duration":"3.0"}}'\n`)
      for (const tool of ["ffmpeg", "ffprobe"]) chmodSync(join(bin, tool), 0o755)
      const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: join(home, "work"), KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
      await ensureHost({ env, home })
      const call = (method, path, body) => hostCall(home, method, path, body).catch((error) => error)
      const { id } = await call("POST", "/projects", { name: "Film", folder })
      writeFileSync(join(folder, "take.mov"), "take")
      const a = await call("POST", `/projects/${id}/assets`, { path: join(folder, "take.mov") })
      const kept = await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: a.id, from: 0, to: 2 * FLICKS }] })
      const clip = kept.project.sequences[0].clips[0].id
      // The body too: hostCall keeps only the message of a refusal
      const { request } = await import("node:http")
      const { hostHeaders, socketPath } = await import("../src/edit/host/paths.js")
      const result = await new Promise((done, fail) => {
        const req = request({ socketPath: socketPath(home), method: "PATCH", path: `/projects/${id}`, headers: { ...hostHeaders(home), "content-type": "application/json" } }, (res) => {
          const chunks = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () => done({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }))
        })
        req.on("error", fail)
        req.end(JSON.stringify({ ops: [{ op: "add_effect", clip, effect: "grain" }] }))
      })
      if (craft) assert.deepEqual([result.status, result.project.sequences[0].clips[0].effects.at(-1).id], [200, "grain"])
      else assert.deepEqual([result.status, result.diagnostics[0].code, result.project.sequences[0].clips[0].effects.length], [422, "switched_off", 0])
    } finally {
      await stopHost(home)
      await fake.close()
    }
  }
})
