import assert from "node:assert/strict"
import { test } from "node:test"

import { apply } from "../src/edit/core/ops.js"
import { newProject } from "../src/edit/core/project.js"
import { ALL_GRAPHIC_KINDS, cleanGraphic, GRAPHIC_KINDS } from "../src/edit/engine/graphics.js"
import { graphicOps } from "../src/edit/recipes/graphic-clips.js"
import { indexOf, lengthOf, wordId } from "./edit/script.js"

// EH-92 (TOP_TIER_FORENSIC_AUDIT §4.1, fixed in TP11): an approved plan's motion kit 2 graphics reach the cut.
// The make route is the switch's gate (editing.typeKit, and editing.customMotion for a drawn callout); what passes
// it is placed by graphicOps. Off, the route drops kit 2 exactly as before. Real renders: tests/edit/media/type-kit.test.js.

const F = 705_600_000
const index = indexOf("a1")

function world() {
  const facts = { width: 1080, height: 1920, hasAudio: true, duration: Math.round((lengthOf() + 2) * F), vfr: false, fps: { n: 30, d: 1 }, color: { primaries: "bt709", transfer: "bt709", range: "tv", tagged: true, hdr: false } }
  let made = apply(newProject({ id: "p", name: "Kit" }), [{ op: "add_asset", id: "a1", kind: "video", fingerprint: "f-a1", path: "a1.mov", linked: true, rights: "own", facts }], { author: "code" })
  made = apply(made.project, [{ op: "keep_range", asset: "a1", from: 0, to: Math.round(lengthOf() * F) }], { index, author: "agent" })
  return made.project
}

test("EH-92: approved kit 2 graphics (list, count, card, cta, handle, frame, an unmarked callout, the new straps) are placed, keeping their own fields", () => {
  const project = world()
  const kept = index.words
  const at = (text) => wordId(index, text)
  const graphics = [
    { kind: "list", style: "steps", text: "How we did it", steps: ["Start small", "ship fast"], stepAt: [0, 400], at: at("built") },
    { kind: "count", text: "50", subtitle: "thousand rupees", at: at("cost") },
    { kind: "callout", style: "ring", text: "", point: { x: 540, y: 700 }, at: at("hardest") },
    { kind: "lower", style: "underline", text: "Our users", at: at("users") },
  ]
  const { ops, notes } = graphicOps({ graphics, project, index, asset: "a1", kept })
  assert.deepEqual(notes, [])
  assert.deepEqual(ops.map((op) => op.variables.kind), ["list", "count", "callout", "lower"])
  assert.deepEqual(ops[0].variables.steps, ["Start small", "ship fast"])
  assert.deepEqual(ops[0].variables.stepAt, [0, 400])
  assert.deepEqual(ops[2].variables.point, { x: 540, y: 700 })
  assert.equal(ops[3].variables.style, "underline")
  assert.ok(ops.every((op) => op.variables.plan === true), "a remake still replaces them")
  assert.ok(apply(project, ops, { index, author: "agent" }).applied)
})

test("EH-92 off: the make route's table without the type kit drops every kit 2 kind and style; MG1's are unchanged", () => {
  for (const kind of ["list", "count", "card", "cta", "handle", "frame", "callout"]) assert.equal(GRAPHIC_KINDS[kind], undefined, kind)
  assert.equal(cleanGraphic({ kind: "count", text: "50", subtitle: "x" }, GRAPHIC_KINDS), null)
  assert.equal(cleanGraphic({ kind: "lower", style: "underline", text: "Asha" }, GRAPHIC_KINDS).style, "bar", "an unknown strap style falls back to MG1's")
  assert.equal(cleanGraphic({ kind: "count", text: "50", subtitle: "x" }, ALL_GRAPHIC_KINDS).kind, "count")
  assert.deepEqual(cleanGraphic({ kind: "title", style: "slam", text: "Fifty" }, GRAPHIC_KINDS), cleanGraphic({ kind: "title", style: "slam", text: "Fifty" }, ALL_GRAPHIC_KINDS))
})
