import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ROLES } from "../src/cartridges.js"
import { CONTRACT_NAMES, contractProblems } from "../src/contracts.js"
import { DETECTORS } from "../src/gates/detectors.js"
import { assetLicences, BUILT, detect } from "../src/gates/index.js"
import { ROOT } from "./helpers.js"

// Harness 2.0 W13 (WD-17): the graphics role's detectors (GX-*, FE-ASSET-LICENCE),
// the scene_direction contract and the ids copied from Kriya's contract.

const file = (path, content, { isNew = true } = {}) => ({ path, content, added: content.split("\n").map((text, i) => ({ line: i + 1, text })), isNew, siblings: [] })
const hits = (id, f, context) => detect([f], [{ id, severity: "error" }], context).map((h) => h.line)

test("WT-GX-01: GX-COLOR flags a renderer with no output colour space or tone mapping", () => {
  assert.deepEqual(hits("GX-COLOR", file("src/scene.js", "const r = new THREE.WebGLRenderer({ antialias: true })\nr.setSize(1, 1)")), [1])
  assert.deepEqual(hits("GX-COLOR", file("src/scene.js", "const r = new WebGLRenderer()\nr.outputColorSpace = SRGBColorSpace\nr.toneMapping = AgXToneMapping")), [])
  assert.deepEqual(hits("GX-COLOR", file("src/scene.js", "const r = new WebGLRenderer()\nr.outputColorSpace = SRGBColorSpace")), [1], "tone mapping too")
})

test("WT-GX-02: GX-ALLOC-LOOP flags allocations inside the animation callback only", () => {
  const code = ["const tmp = new THREE.Vector3()", "function animate() {", "  const v = new THREE.Vector3(1, 2, 3)", "  tmp.set(1, 2, 3)", "  renderer.render(scene, camera)", "}", "renderer.setAnimationLoop(() => {", "  const q = new Quaternion()", "})"].join("\n")
  assert.deepEqual(hits("GX-ALLOC-LOOP", file("src/scene.js", code)), [3, 8])
})

test("WT-GX-03: GX-NO-DISPOSE flags GPU resources with no dispose path", () => {
  assert.deepEqual(hits("GX-NO-DISPOSE", file("src/Mesh.jsx", "const g = new THREE.BoxGeometry(1, 1, 1)\nconst m = new MeshStandardMaterial()")), [1])
  assert.deepEqual(hits("GX-NO-DISPOSE", file("src/Mesh.jsx", "const g = new BoxGeometry()\nreturn () => g.dispose()")), [])
})

test("WT-GX-04: GX-DPR flags an uncapped devicePixelRatio, not a capped one", () => {
  assert.deepEqual(hits("GX-DPR", file("src/scene.ts", "renderer.setPixelRatio(window.devicePixelRatio)")), [1])
  assert.deepEqual(hits("GX-DPR", file("src/scene.ts", "renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))")), [])
})

test("WT-GX-05: FE-ASSET-LICENCE: a new asset needs a scene_direction.json entry with licence and source", () => {
  const root = mkdtempSync(join(tmpdir(), "kriya-gx-"))
  mkdirSync(join(root, ".kriya", "contracts"), { recursive: true })
  writeFileSync(join(root, ".kriya", "contracts", "scene_direction.json"), JSON.stringify({ assets: [{ path: "public/models/chair.glb", licence: "CC0-1.0", source: "made in-house" }, { path: "public/hdri/studio.hdr", licence: "CC0-1.0" }] }))
  const ctx = { assetLicensed: assetLicences(root) }
  assert.deepEqual(hits("FE-ASSET-LICENCE", file("public/models/chair.glb", ""), ctx), [])
  assert.deepEqual(hits("FE-ASSET-LICENCE", file("public/hdri/studio.hdr", ""), ctx), [1], "no source, no licence")
  assert.deepEqual(hits("FE-ASSET-LICENCE", file("public/textures/wood.ktx2", ""), ctx), [1])
  assert.deepEqual(hits("FE-ASSET-LICENCE", file("public/textures/wood.ktx2", "", { isNew: false }), ctx), [], "only new assets")
  assert.deepEqual(hits("FE-ASSET-LICENCE", file("src/logo.png", ""), ctx), [], "outside the asset folders")
})

test("WT-GX-06: the graphics role, G-3D, its detectors and scene_direction come from Kriya's contract", () => {
  const ids = JSON.parse(readFileSync(join(ROOT, "contract", "contract.json"), "utf8")).cartridgeIds
  assert.ok(ROLES.includes("graphics") && ids.roles.length === 16)
  assert.ok(ids.gates.includes("G-3D") && BUILT.includes("G-3D"))
  for (const d of ["GX-COLOR", "GX-ALLOC-LOOP", "GX-NO-DISPOSE", "GX-DPR", "FE-ASSET-LICENCE"]) assert.ok(ids.detectors.includes(d) && DETECTORS[d], d)
  assert.deepEqual([...CONTRACT_NAMES].sort(), [...ids.contracts].sort())
})

test("WT-GX-07: scene_direction.json is checked against its schema", () => {
  const root = mkdtempSync(join(tmpdir(), "kriya-gx-"))
  mkdirSync(join(root, ".kriya", "contracts"), { recursive: true })
  const write = (v) => writeFileSync(join(root, ".kriya", "contracts", "scene_direction.json"), JSON.stringify(v))
  const good = { mood: "late-afternoon studio", lighting: "studio-product", toneMapping: "agx", motion: "subtle", tiers: { low: { drawCalls: 60 } }, routes: [{ path: "/", unmount: "/about" }], camera: { fov: 40 }, materials: { roughness: [0.2, 0.8] }, assets: [{ path: "public/a.glb", licence: "CC0-1.0", source: "in-house" }] }
  write(good)
  assert.deepEqual(contractProblems(root, "scene_direction"), [])
  for (const bad of [{ ...good, lighting: "rainbow" }, { ...good, routes: [] }, { ...good, tiers: { ultra: {} } }, { ...good, command: "exit 0" }, { ...good, camera: { fov: 400 } }]) {
    write(bad)
    assert.ok(contractProblems(root, "scene_direction").length > 0, JSON.stringify(bad))
  }
})
