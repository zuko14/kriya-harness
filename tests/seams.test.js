import assert from "node:assert/strict"
import { test } from "node:test"

import { readInstalled, SEAMS, seamProblems } from "../scripts/check-seams.js"

// HU-SEAM-01 (harness upgrade U5): the installed DSH has every seam Kriya
// uses, and a DSH that changed one is reported by name.

test("HU-SEAM-01: every seam present in the pinned DSH", () => {
  assert.deepEqual(seamProblems(readInstalled), [])
})

test("HU-SEAM-01: a renamed hook, a missing file or a changed overflow pattern is named", () => {
  const broken = (file, text) => (f) => (f === file ? text : readInstalled(f))
  const preStep = SEAMS[0]
  const renamed = seamProblems(broken(preStep.file, readInstalled(preStep.file).replaceAll("'agent/pre-step'", "'agent/before-step'")))
  assert.equal(renamed.length, 1)
  assert.match(renamed[0], /agent\/pre-step waterfall can reject a step .*Used by plugins\/budget/)
  assert.match(seamProblems(broken("dsh-tools/lib/types/index.d.ts", null))[0], /file missing/)
  const overflow = SEAMS.find((s) => s.check)
  const narrowed = readInstalled(overflow.file).replace("(?:length|window)", "(?:window)")
  assert.match(seamProblems(broken(overflow.file, narrowed)).join("\n"), /no longer matches 400 "context_length_exceeded"/)
})
