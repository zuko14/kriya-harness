import assert from "node:assert/strict"
import { test } from "node:test"

import { anchorText, MAX_CHARS } from "../plugins/anchor/index.js"

// Harness upgrade U7 (HU-AN-01): the kept-request section, without DSH. The
// real-DSH drill is HU-M-06 in tests/drills-run.test.js.

test("HU-AN-01: every message word for word, numbered; over the cap the oldest after the first go", () => {
  assert.equal(anchorText([]), "")
  const text = anchorText(["Fix the parser. Keep {{braces}}.", "Also add a test."])
  assert.match(text, /1\. Fix the parser\. Keep \{\{braces\}\}\.\n\n2\. Also add a test\./)
  assert.match(text, /outrank any summary/)
  const long = anchorText(["FIRST", "a".repeat(MAX_CHARS), "LAST"])
  assert.match(long, /1\. FIRST/)
  assert.match(long, /2\. LAST/)
  assert.doesNotMatch(long, /aaaa/)
  // A first message over the cap is cut, never dropped
  assert.ok(anchorText(["b".repeat(MAX_CHARS * 2)]).length < MAX_CHARS + 400)
})
