import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { duckEnvelope } from "../src/edit/core/audio.js"
import { apply } from "../src/edit/core/ops.js"
import { compile } from "../src/edit/core/plan.js"
import { ensureHost, hostCall, stopHost } from "../src/edit/host/client.js"
import { socketPath } from "../src/edit/host/paths.js"
import { DUCK_RATE, previewOf, tileDocument } from "../src/edit/host/preview.js"
import { ENGINE_VERSION } from "../src/edit/engine/index.js"
import { fetchFeatures } from "../src/edit/runtime/fetch.js"
import { blurFilter, duckAt, frameRects, gainAt, gainOf, gradeFilter, itemAt, sourceOf, transitionAt, transitionMix } from "../studio/src/preview.js"
import { handleAt, HANDLE, snapTo } from "../studio/src/timeline.js"
import { makeIndex, makeProject, ms } from "./edit/fixture.js"
import { startFakeKriya } from "./fake-kriya.js"
import { ROOT } from "./helpers.js"

// TP3 (CRAFT_UPGRADE §2, TOP_TIER_PLAN §5): the live preview's arithmetic against the render's
// own builder and FFmpeg's measured xfade, the timeline's edge handles beside its scrub, and the
// Host's preview routes with editing.livePreview off and on. No model, no media here: the -M
// tests in tests/edit/media/live-preview.test.js draw and render for real.

const FLICKS = 705_600_000
const close = (a, b, within = 1e-9) => Math.abs(a - b) <= within

test("ET-PV-02 (unit): each transition mixes as FFmpeg's xfade measured on flat frames (A=200, B=50, ten frames over one second)", () => {
  // Measured 2026-11-11 with the runtime's FFmpeg: xfade=transition=<kind>:duration=1:offset=0, mean luma per frame
  const measured = { fade: [200, 185, 170, 155, 140, 125, 110, 95, 80, 65], dip: [200, 90, 1, 4, 9, 17, 25, 33, 40, 45], flash: [200, 229, 248, 235, 214, 184, 151, 117, 91, 70] }
  const backdrop = { fade: 0, dip: 0, flash: 255 }
  for (const [kind, frames] of Object.entries(measured)) {
    frames.forEach((want, i) => {
      const m = transitionMix(kind, i / 10)
      assert.ok(close(m.a + m.b + m.bg, 1, 1e-9), `${kind}: the weights sum to one`)
      const got = 200 * m.a + 50 * m.b + backdrop[kind] * m.bg
      assert.ok(Math.abs(got - want) <= 3, `${kind} frame ${i}: ${got.toFixed(1)} against FFmpeg's ${want}`)
    })
  }
  // zoomin: [200 ×6, 184, 147, 102, 65]; the held frame is flat, so magnifying it changes nothing
  ;[200, 200, 200, 200, 200, 200, 184, 147, 102, 65].forEach((want, i) => {
    const m = transitionMix("zoom", i / 10)
    assert.ok(Math.abs(200 * m.a + 50 * m.b - want) <= 3, `zoom frame ${i}`)
  })
  // wipeleft and slideleft at p = 0.3: the incoming picture from 0.7 of the width, as measured (x ≥ 44.8 of 64)
  assert.ok(close(transitionMix("wipe", 0.3).edge, 0.7))
  assert.ok(close(transitionMix("slide", 0.3).shift, 0.3))
  assert.ok(close(transitionMix("zoom", 0.3).magnify, 0.352, 1e-3), "smoothstep(0.5, 1, 0.7)")
  // Which transition is drawn when: the plan's own window, from the cut, with the piece before
  const picture = [{ asset: "a1", at: 0, end: ms(2000) }, { asset: "a1", at: ms(2000), end: ms(4000), enter: { kind: "fade", duration: ms(300), asset: "a1", source: ms(1967) } }]
  assert.equal(transitionAt(picture, ms(1999)), null)
  const mid = transitionAt(picture, ms(2150))
  assert.deepEqual([mid.kind, mid.before, close(mid.progress, 0.5)], ["fade", picture[0], true])
  assert.equal(transitionAt(picture, ms(2300)), null, "over when its length is")
  assert.equal(itemAt(picture, ms(2000)), picture[1])
})

test("ET-PV-02 (unit): framing follows core/ffmpeg.js: fill covers, fit is whole on bars, blur is whole over a covering copy", () => {
  // A 1920×1080 clip in a 720×1280 draft frame
  const fill = frameRects(undefined, 1920, 1080, 720, 1280)
  assert.ok(close(fill.picture.h, 1280) && fill.picture.w > 720, "cover: scaled up to the height and cropped")
  const fit = frameRects("fit", 960, 540, 720, 1280)
  // Measured with FFmpeg 9.0.2: scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2 of
  // 960×540 is 720×406 (405 to the nearest even), and pad puts its first row at 436 ((1280−406)/2 = 437, floored to even)
  assert.deepEqual(fit.picture, { x: 0, y: 436, w: 720, h: 406 })
  // 1000×562 → 404.64 → 404; 1000×563 → 405.36 → 406; 1000×559 → 402.48 → 402 (each measured the same way)
  assert.deepEqual([562, 563, 559].map((h) => frameRects("fit", 1000, h, 720, 1280).picture.h), [404, 406, 402])
  // On a monitor half the output's size, the same rectangle halved
  assert.deepEqual(frameRects("fit", 960, 540, 360, 640, 1, { width: 720, height: 1280 }).picture, { x: 0, y: 218, w: 360, h: 203 })
  assert.equal(fit.plate, true)
  const blur = frameRects("blur", 960, 540, 720, 1280)
  assert.deepEqual(blur.picture, fit.picture)
  assert.ok(close(blur.behind.h, 1280) && blur.behind.w > 720)
  // The blur's radius is the render's (min(W,H)/24 = 30 at 720 wide), scaled to the monitor
  assert.equal(blurFilter(720, 1280), "blur(24.60px) brightness(0.88) saturate(0.9)")
  assert.equal(blurFilter(720, 1280, 0.5), "blur(12.30px) brightness(0.88) saturate(0.9)")
  assert.equal(gradeFilter(undefined), "none")
  assert.equal(gradeFilter({ saturation: 1.2, gain: 1.1, ev: 0.8 }), "brightness(1.100) contrast(1.1) saturate(1.200)")
})

test("ET-PV-03 (unit): each sound's gain follows the plan: its level, its fades, the edge fade, and the duck on music only", () => {
  const duck = { rate: DUCK_RATE, curve: [...duckEnvelope([{ at: ms(1000), end: ms(2000) }], { duration: ms(4000), depth: -12, attack: ms(80), release: ms(300), rate: DUCK_RATE })] }
  const music = { asset: "m1", bus: "music", at: 0, end: ms(4000), in: 0, out: ms(4000), db: -6, fadeOut: ms(1000) }
  assert.equal(gainAt(music, ms(4000), duck), 0, "nothing after its end")
  assert.ok(close(gainAt(music, ms(500), duck), gainOf(-6), 1e-6), "its level, the duck open")
  assert.ok(close(gainAt(music, ms(1500), duck), gainOf(-6) * gainOf(-12), 1e-4), "under the voice, ducked by its depth")
  assert.ok(close(gainAt(music, ms(3500), duck), gainOf(-6) * 0.5, 1e-6), "half way through its fade out")
  assert.ok(close(gainAt(music, ms(5), duck), gainOf(-6) * (ms(5) / (0.015 * FLICKS)), 1e-6), "the 15 ms edge fade every boundary has")
  const sfx = { asset: "s1", bus: "sfx", at: ms(1000), end: ms(2000), in: 0, out: ms(1000) }
  assert.ok(close(gainAt(sfx, ms(1500), duck), gainOf(-6), 1e-6), "a sound with no level: the estimate 6 dB under, never ducked")
  assert.equal(duckAt(null, ms(1500)), 1)
  // Where in its file a sound is: straight, looped, and a bed fitted from two pieces joined by a crossfade
  assert.deepEqual(sourceOf(sfx, ms(1500)), { source: ms(500), until: ms(2000) })
  assert.deepEqual(sourceOf({ ...sfx, loop: true, out: ms(300) }, ms(1500)), { source: ms(200), until: ms(1600) })
  const fitted = { asset: "m1", bus: "music", at: 0, end: ms(3950), in: 0, out: ms(8000), fit: { segments: [{ in: 0, out: ms(2000) }, { in: ms(6000), out: ms(8000) }], crossfade: ms(50) } }
  assert.deepEqual(sourceOf(fitted, ms(1000)), { source: ms(1000), until: ms(1975) })
  assert.deepEqual(sourceOf(fitted, ms(2975)), { source: ms(7025), until: ms(3950) })
})

test("ET-PV-06 (unit): an edge handle is a narrow strip at each end of a picture clip; anywhere else is a scrub", () => {
  const picture = [
    { clip: "c1", at: 0, end: ms(2000) },
    { clip: "c1", at: ms(2000), end: ms(3000) }, // one clip in two pieces: its handles are at 0 and 3 s
    { clip: "c2", at: ms(3000), end: ms(10000) },
  ]
  const where = { width: 1000, duration: ms(10000) }
  assert.deepEqual(handleAt(picture, 300, where), { clip: "c2", edge: "in", at: ms(3000) }, "on a cut, the clip that starts there")
  assert.deepEqual(handleAt(picture, 2, where), { clip: "c1", edge: "in", at: 0 })
  assert.equal(handleAt(picture, 200, where), null, "inside a clip, even where two of its pieces meet, it scrubs")
  assert.equal(handleAt(picture, 300 + HANDLE.mouse + 1, where), null, "a mouse handle is 6 px wide")
  assert.deepEqual(handleAt(picture, 300 + 20, { ...where, pointer: "touch" }), { clip: "c2", edge: "in", at: ms(3000) }, "a finger gets 22 px inside each clip: 44 across a cut")
  assert.deepEqual(handleAt(picture, 300 - 20, { ...where, pointer: "touch" }), { clip: "c1", edge: "out", at: ms(3000) })
  assert.deepEqual(handleAt(picture, 299, where), { clip: "c1", edge: "out", at: ms(3000) }, "just left of a cut is the clip before's end")
  assert.equal(handleAt([{ clip: "c3", at: 0, end: ms(100) }], 1, where), null, "a clip too narrow for both handles has none")
  assert.equal(snapTo(ms(3050), [ms(3000), ms(6000)], where), ms(3000), "within 8 px it snaps")
  assert.equal(snapTo(ms(3200), [ms(3000)], where), ms(3200), "further, it doesn't")
})

test("the Host's preview of a plan: tiles from the draft's own plan, documents with only the time listener added, sound as the plan has it", () => {
  const index = makeIndex()
  const { project } = apply(makeProject(), [
    { op: "keep_range", asset: "a1", from: ms(1000), to: ms(9000) },
    { op: "add_title", text: "Fifty thousand", at: ms(2000), duration: ms(2000) },
    { op: "set_music", asset: "m1" },
  ], { index })
  const tiles = new Map()
  const preview = previewOf(project, index, { runtimeVersion: "9", tiles })
  const plan = compile(project, index, { engineVersion: ENGINE_VERSION, runtimeVersion: "9" })
  assert.deepEqual(preview.tiles.map((t) => [t.key, t.at, t.end]), plan.tiles.map((t) => [t.key, t.at, t.end]), "the plan's own tiles, at their own times")
  assert.deepEqual(preview.output, plan.output)
  assert.equal(preview.duration, plan.duration)
  assert.deepEqual(preview.audio.items.map((i) => [i.asset, i.at, i.end, i.in, i.out]), plan.audio.items.map((i) => [i.asset, i.at, i.end, i.in, i.out]))
  const block = preview.tiles.find((t) => t.kind === "block")
  const html = tileDocument(tiles, block.key)
  assert.match(html, /Fifty thousand/)
  assert.match(html, /addEventListener\("message"/, "it seeks when the monitor posts")
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/, "the render's own policy: no network")
  assert.equal(html.includes("fetch") || html.includes("setTimeout") || html.includes("Date"), false, "no clock and no network of its own")
  assert.equal(tileDocument(tiles, "../etc"), null)
  assert.equal(tileDocument(tiles, "f".repeat(64)), null, "only a tile of a preview it served")
})

async function world({ livePreview }) {
  const fake = await startFakeKriya({ models: ["budget"], features: { visuals: false, playbooks: false, mediaSearch: false, motion: false, customMotion: false, assembly: false, livePreview } })
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kh-")))
  const login = spawn(process.execPath, [join(ROOT, "bin", "kriya.js"), "login", "--url", fake.url, "--no-browser"], { env: { ...process.env, KRIYA_HOME: home }, stdio: "ignore" })
  assert.equal(await new Promise((done) => login.on("exit", done)), 0)
  const root = join(home, "work")
  const bin = join(home, "bin")
  const folder = join(root, "film")
  mkdirSync(folder, { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n*-filters*) echo " .S. lut3d V->V x";;\n*-encoders*) echo " V....D libx264 x";;\n*-version*) echo "ffmpeg version 9.0.2";;\n*) echo failed >&2; exit 1;;\nesac\n`)
  writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\necho '{"streams":[{"index":0,"codec_type":"audio","sample_rate":"48000","channels":2,"duration_ts":480000,"time_base":"1/48000"}],"format":{"format_name":"wav","duration":"10.0"}}'\n`)
  for (const tool of ["ffmpeg", "ffprobe"]) chmodSync(join(bin, tool), 0o755)
  const env = { ...process.env, KRIYA_HOME: home, KRIYA_EDIT_ROOTS: root, KRIYA_EDIT_IDLE_MS: "60000", PATH: `${bin}:${process.env.PATH}` }
  await ensureHost({ env, home })
  const call = (method, path, body) => hostCall(home, method, path, body)
  const { id } = await call("POST", "/projects", { name: "Film", folder })
  writeFileSync(join(folder, "talk.wav"), "talk")
  const a1 = await call("POST", `/projects/${id}/assets`, { path: join(folder, "talk.wav") })
  await call("PATCH", `/projects/${id}`, { ops: [{ op: "keep_range", asset: a1.id, from: 0, to: ms(5000) }, { op: "add_title", text: "Fifty thousand", at: ms(1000), duration: ms(2000) }] })
  return { home, call, id, fake }
}
const raw = (home, path) =>
  new Promise((done, fail) => {
    const req = request({ socketPath: socketPath(home), method: "GET", path, headers: { host: "kriya-edit" } }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on("error", fail)
    req.end()
  })

test("ET-PV-REG-01 (Host): switch off, the view has the keys it had and neither preview route exists; on, they serve the draft's plan", async () => {
  const off = await world({ livePreview: false })
  try {
    const view = await off.call("GET", `/projects/${off.id}`)
    assert.equal("livePreview" in view, false, "the project view is the object it was")
    assert.equal((await raw(off.home, `/projects/${off.id}/preview`)).status, 404)
    assert.equal((await raw(off.home, `/projects/${off.id}/tile-preview?key=${"a".repeat(64)}`)).status, 404)
  } finally {
    await stopHost(off.home)
    await off.fake.close()
  }
  const on = await world({ livePreview: true })
  try {
    assert.equal((await on.call("GET", `/projects/${on.id}`)).livePreview, true)
    const preview = await on.call("GET", `/projects/${on.id}/preview`)
    assert.equal(preview.tiles.length, 1)
    const tile = await raw(on.home, `/projects/${on.id}/tile-preview?key=${preview.tiles[0].key}`)
    assert.equal(tile.status, 200)
    assert.match(tile.headers["content-security-policy"], /^default-src 'none';.*sandbox allow-scripts$/)
    assert.match(tile.body, /Fifty thousand/)
    assert.equal((await raw(on.home, `/projects/${on.id}/tile-preview?key=${"a".repeat(64)}`)).status, 404, "only a tile of a preview it served")
    assert.equal((await raw(on.home, `/projects/${on.id}/preview?proposal=nope`)).status, 404)
  } finally {
    await stopHost(on.home)
    await on.fake.close()
  }
})

test("fetchFeatures reads livePreview: a server from before it says nothing, which is off", async () => {
  const saved = globalThis.fetch
  const answer = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  try {
    globalThis.fetch = answer({ visuals: false, assembly: true })
    assert.equal((await fetchFeatures({ url: "http://kriya.test", token: "t" })).livePreview, false)
    globalThis.fetch = answer({ livePreview: true })
    assert.equal((await fetchFeatures({ url: "http://kriya.test", token: "t" })).livePreview, true)
    globalThis.fetch = answer({ livePreview: "on" })
    assert.equal((await fetchFeatures({ url: "http://kriya.test", token: "t" })).livePreview, false, "only true is on")
  } finally {
    globalThis.fetch = saved
  }
})
