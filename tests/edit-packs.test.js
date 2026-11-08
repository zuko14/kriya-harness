import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { test } from "node:test"

import { PACKS, packFor, packStatus, packsForPlan, requirePack } from "../src/edit/engine/packs.js"
import { EngineFailure } from "../src/edit/engine/tool.js"
import { bundleLicenceProblems, licenceVerdict, manifestLicenceProblems } from "../src/edit/runtime/licences.js"
import { openManifest, RuntimeError } from "../src/edit/runtime/manifest.js"
import { activeRuntime, installPack, removePack } from "../src/edit/runtime/setup.js"
import { buildStudio } from "../studio/build.js"
import { freshHome, ROOT } from "./helpers.js"

// ED13 capability packs (CAPABILITY_PACKS) and the licence gate (SKILLS_AND_OPEN_SOURCE
// §2). Packs install from a signed fixture manifest served on this machine, beside a
// runtime made by hand; nothing reaches the internet or ~/.kriya.

const PLATFORM = "darwin-arm64"
const keys = generateKeyPairSync("ed25519")
const PUBLIC = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const signed = (manifest) => {
  const text = JSON.stringify(manifest)
  return { manifest: text, signature: sign(null, Buffer.from(text), keys.privateKey).toString("base64") }
}
const open = (manifest) => openManifest(signed(manifest), [PUBLIC])

async function fileServer(files) {
  const server = createServer((req, res) => (files[req.url] ? res.end(files[req.url]) : res.writeHead(404).end()))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}

function manifestWith(url, { weights, version = "2026.11.0", packLicence = "Apache-2.0", data }) {
  return {
    schema: 1,
    version,
    platforms: {
      [PLATFORM]: {
        system: [],
        artifacts: [{ id: "tool", tier: "core", version: "1.0.0", url: `${url}/tool.bin`, sha256: sha256("core"), bytes: 4, unpack: "none", entry: "tool.bin", licence: "MIT" }],
        python: { id: "speech", tier: "core", version: "3.12", check: "mlx_whisper", estimateBytes: 1000, requirements: "", packages: [{ name: "mlx-whisper", version: "0.4.3", licence: "MIT" }] },
        packs: { "pack-depth": { artifacts: [{ id: "depth-anything-v2-small", tier: "pack", version: "1.0.0", url: `${url}/depth.bin`, sha256: sha256(weights ?? data), bytes: data.length, unpack: "none", entry: "model.bin", licence: packLicence }] } },
      },
    },
  }
}

/** A runtime installed by hand: the pointer, the version folder, its manifest, `.complete`. */
function runtimeIn(home, manifest) {
  const dir = join(home, "media", manifest.version)
  mkdirSync(join(dir, "tool"), { recursive: true })
  writeFileSync(join(dir, "tool", "tool.bin"), "core")
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(dir, ".complete"), "core-hash")
  writeFileSync(join(home, "media", "current.json"), JSON.stringify({ current: manifest.version, previous: null }))
  return dir
}

const LUT3D = { filters: new Set(["lut3d"]) }

test("ET-RCP-01 for packs: each is data that names its operations, needs and licences, never a command, path, URL or price", () => {
  for (const [id, pack] of Object.entries(PACKS)) {
    assert.match(id, /^pack-[a-z-]+$/)
    assert.deepEqual(Object.keys(pack).sort(), ["artifacts", "does", "filters", "licences", "ops", "title"])
    assert.ok(pack.licences.length && pack.licences.every((l) => licenceVerdict(l.licence.replace(/\s*\(.*\)$/, ""), "runtime").ok), id)
    assert.doesNotMatch(JSON.stringify(pack), /https?:|\/Users\/|[$₹]|\bnpx?\b|\bpip\b|\bcurl\b/)
  }
  assert.deepEqual([packFor("match_color"), packFor("apply_lut"), packFor("parallax"), packFor("keep_range")], ["pack-color", "pack-color", "pack-depth", null])
  assert.deepEqual(packsForPlan({ segments: [{ node: { picture: [{ effects: [{ type: "grade", match: { key: "k" } }] }] } }] }), ["pack-color"])
  assert.deepEqual(packsForPlan({ segments: [{ node: { picture: [{ effects: [{ type: "grade", gamma: 1.1 }] }] } }] }), [])
})

test("ET-PK-01: each pack is optional and, when absent, says why in plain words", () => {
  const none = packStatus({ runtime: null, capabilities: { filters: new Set() }, platform: PLATFORM })
  assert.match(none["pack-color"].missing, /no lut3d filter/)
  assert.match(none["pack-depth"].missing, /needs the Media Runtime, which isn't installed/)
  assert.match(none["pack-voice-clean"].missing, /needs the Media Runtime/)
  assert.throws(() => requirePack("pack-color", none), (e) => e instanceof EngineFailure && e.reason === "missing_pack" && /lut3d/.test(e.message))
  assert.throws(() => requirePack("pack-nothing", none), /no pack called pack-nothing/)

  const runtime = { version: "2026.11.0", dir: "/nowhere", manifest: { platforms: { [PLATFORM]: {} } } }
  const status = packStatus({ runtime, capabilities: LUT3D, platform: PLATFORM })
  assert.equal(status["pack-color"].installed, true, "the colour pack is FFmpeg's own lut3d")
  assert.match(status["pack-depth"].missing, /doesn't offer the Depth motion pack yet/)
})

test("ET-PK-01, -03: a pack installs beside the core from the signed manifest, is removed alone, and the core never changes", async () => {
  const home = freshHome()
  const data = Buffer.alloc(40_000, 5)
  const files = await fileServer({ "/depth.bin": data })
  try {
    const manifest = manifestWith(files.url, { data })
    const core = runtimeIn(home, manifest)
    const coreBefore = ["tool/tool.bin", "manifest.json", ".complete"].map((f) => readFileSync(join(core, f), "utf8"))
    const before = packStatus({ runtime: activeRuntime(home), capabilities: LUT3D, platform: PLATFORM })
    assert.match(before["pack-depth"].missing, /isn't installed\. Run kriya edit setup --pack depth/)

    const said = []
    const dir = await installPack(open(manifest), "pack-depth", { home, platform: PLATFORM, free: () => 1e12, say: (line) => said.push(line) })
    assert.deepEqual(readFileSync(join(dir, "depth-anything-v2-small", "model.bin")), data)
    assert.ok(existsSync(join(dir, ".complete")))
    assert.equal(packStatus({ runtime: activeRuntime(home), capabilities: LUT3D, platform: PLATFORM })["pack-depth"].installed, true)
    assert.match(said.join("\n"), /Downloading depth-anything-v2-small[\s\S]*pack is ready/)
    // Again: nothing to do
    await installPack(open(manifest), "pack-depth", { home, platform: PLATFORM, free: () => 1e12, say: (line) => said.push(line) })
    assert.match(said.at(-1), /already installed/)

    removePack("pack-depth", { home })
    assert.match(packStatus({ runtime: activeRuntime(home), capabilities: LUT3D, platform: PLATFORM })["pack-depth"].missing, /isn't installed/)
    assert.throws(() => removePack("pack-depth", { home }), /isn't installed/)
    assert.throws(() => removePack("../core", { home }), /isn't a pack's name/)
    assert.deepEqual(["tool/tool.bin", "manifest.json", ".complete"].map((f) => readFileSync(join(core, f), "utf8")), coreBefore, "the core is untouched")

    // A wrong hash: refused, the pack's folder gone, the core as it was
    const bad = manifestWith(files.url, { data, weights: Buffer.alloc(40_000, 9) })
    await assert.rejects(installPack(open(bad), "pack-depth", { home, platform: PLATFORM, free: () => 1e12 }), /doesn't match its hash/)
    assert.equal(existsSync(join(core, "packs", "pack-depth")), false)
    assert.deepEqual(["tool/tool.bin", "manifest.json", ".complete"].map((f) => readFileSync(join(core, f), "utf8")), coreBefore)

    // Not offered, another version, no room: plain reasons, nothing downloaded
    await assert.rejects(installPack(open(manifest), "pack-voice-clean", { home, platform: PLATFORM }), /doesn't offer pack-voice-clean/)
    await assert.rejects(installPack(open({ ...manifest, version: "2026.12.0" }), "pack-depth", { home, platform: PLATFORM }), /run kriya edit setup first/)
    await assert.rejects(installPack(open(manifest), "pack-depth", { home, platform: PLATFORM, free: () => 10 }), /GB free/)
    await assert.rejects(installPack(open(manifest), "pack-depth", { home: freshHome(), platform: PLATFORM }), /Install the Media Runtime first/)
  } finally {
    await files.close()
  }
})

test("ET-PK-03, ET-LIC-01: a pack's weight needs a recorded licence inside the table, or nothing installs", async () => {
  const data = Buffer.alloc(1000, 1)
  const noLicence = manifestWith("https://example.com", { data, packLicence: "" })
  assert.throws(() => open(noLicence), (e) => e instanceof RuntimeError && /depth-anything-v2-small has no licence recorded/.test(e.message))
  const home = freshHome()
  const nonCommercial = manifestWith("http://127.0.0.1:9", { data, packLicence: "CC-BY-NC-4.0" })
  runtimeIn(home, nonCommercial)
  await assert.rejects(installPack(open(nonCommercial), "pack-depth", { home, platform: PLATFORM, free: () => 1e12 }), /outside Kriya's licence table, so nothing was installed: darwin-arm64\/pack-depth\/depth-anything-v2-small/)
})

test("ET-LIC-01: the licence table, item by item", () => {
  const cases = [
    ["MIT", "client", true],
    ["Apache-2.0 OR BSD-2-Clause", "client", true],
    ["MIT OR GPL-3.0", "client", true],
    ["BSD-2-Clause AND Apache-2.0 WITH LLVM-exception", "client", true],
    ["BSD-3-Clause and third-party notices (LICENSE.headless_shell in the archive)", "runtime", true],
    ["MPL-2.0", "client", true],
    ["Apache-2.0 AND CNRI-Python", "runtime", true],
    ["Apache-2.0 AND CNRI-Python", "client", false],
    ["PSF-2.0", "weight", false],
    ["GPL-3.0", "client", false],
    ["AGPL-3.0", "runtime", false],
    ["CC-BY-NC-4.0", "weight", false],
    ["PolyForm-Noncommercial-1.0.0", "client", false],
    ["BSD", "runtime", false],
    ["", "client", false],
    ["Custom licence, see website", "client", false],
  ]
  for (const [licence, where, ok] of cases) assert.equal(licenceVerdict(licence, where).ok, ok, `${licence} for the ${where}`)
  assert.match(licenceVerdict("", "client").why, /all rights reserved/)
})

test("ET-LIC-01: what ships has a licence in the table; no Remotion or GSAP anywhere (lockfile, Studio bundle, sources, runtime manifest)", async () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
  const { metafile } = await buildStudio()
  const sources = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(m?js|html|css)$/.test(name)) sources.push({ file: path.slice(ROOT.length + 1), text: readFileSync(path, "utf8") })
    }
  }
  for (const dir of ["src/edit", "studio/src", "plugins/edit"]) walk(join(ROOT, dir))
  assert.deepEqual(bundleLicenceProblems({ lock, metafile, sources }), [])
  // The check bites: a refused package, a foreign bundle input and an import are each named
  const planted = bundleLicenceProblems({ lock: { packages: { "node_modules/gsap": {}, "node_modules/@remotion/player": {} } }, metafile: { inputs: { "node_modules/lottie-web/index.js": {} } }, sources: [{ file: "x.js", text: 'import { gsap } from "gsap"' }] })
  assert.deepEqual(planted.map((p) => p.item), ["gsap", "@remotion/player", "node_modules/lottie-web/index.js", "x.js"])
  // Every package the release installs: npm's own licence field, through the same table
  const release = Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev && !pkg.optional)
  const unlisted = release.filter(([, pkg]) => !licenceVerdict(pkg.license, "client").ok).map(([path, pkg]) => `${path}: ${pkg.license}`)
  // HF-09's exceptions are for exact name@version pairs
  const excepted = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, "notices-exceptions.json"), "utf8")).packages))
  const versionOf = (line) => lock.packages[line.slice(0, line.indexOf(": "))].version
  assert.deepEqual(unlisted.filter((line) => !excepted.has(`${line.slice(line.lastIndexOf("node_modules/") + 13, line.indexOf(": "))}@${versionOf(line)}`)), [], "each is allowed, or an owner's recorded exception")

  // The Media Runtime manifest Kriya serves, where this worktree sits beside Kriya's
  const served = join(ROOT, "..", "Kriya-Tavi", "lib", "editing", "runtime")
  if (existsSync(served)) for (const name of readdirSync(served).filter((n) => /^manifest\..*\.json$/.test(n))) assert.deepEqual(manifestLicenceProblems(JSON.parse(readFileSync(join(served, name), "utf8"))), [], name)
  // And the check's own command line still works for the release (the existing notices gate)
  assert.doesNotThrow(() => execFileSync(process.execPath, [join(ROOT, "scripts", "notices.js"), "--check"], { stdio: "pipe" }))
})

test("ET-RCP-01: every recipe and caption look is data, with no command, path, URL, model or price", async () => {
  const { REEL_TALKING_HEAD } = await import("../src/edit/recipes/reel.js")
  const { SHORT_FROM_LONG } = await import("../src/edit/recipes/short-from-long.js")
  const { TUTORIAL } = await import("../src/edit/recipes/tutorial.js")
  const { YOUTUBE_LONGFORM } = await import("../src/edit/recipes/youtube.js")
  const { PODCAST_MULTICAM } = await import("../src/edit/recipes/multicam.js")
  const { LOOKS } = await import("../src/edit/engine/captions.js")
  const recipes = { REEL_TALKING_HEAD, SHORT_FROM_LONG, TUTORIAL, YOUTUBE_LONGFORM, PODCAST_MULTICAM }
  for (const [name, data] of Object.entries({ ...recipes, LOOKS })) {
    const text = JSON.stringify(data)
    assert.doesNotMatch(text, /"(command|cmd|path|file|url|href|model|price|cost|shell|exec|script)"\s*:/i, name)
    assert.doesNotMatch(text, /https?:\/\/|\/usr\/|\/Users\/|\.sh\b|ffmpeg|[$₹]/i, name)
    // Plain data: no function hides in it
    const walk = (value) => (typeof value === "function" ? assert.fail(`${name} holds a function`) : value && typeof value === "object" ? Object.values(value).forEach(walk) : null)
    walk(data)
  }
  for (const [name, recipe] of Object.entries(recipes)) assert.match(recipe.id, /^[a-z-]+$/, name)
})
