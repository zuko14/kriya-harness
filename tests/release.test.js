import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { pinProblems } from "../scripts/check-pins.js"
import { buildNotices, licenseAllowed } from "../scripts/notices.js"
import { ROOT } from "./helpers.js"

// HT-REL-01: exact pins and a lockfile; THIRD_PARTY_NOTICES.md current.
// HT-REL-02: a release fails on an unknown or disallowed license.

const read = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"))

test("HT-REL-01: every dependency is exact and locked", () => {
  assert.deepEqual(pinProblems(read("package.json"), read("package-lock.json")), [])
})

test("HT-REL-01: a range or a lockfile mismatch is caught", () => {
  const lock = { lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } }
  assert.deepEqual(pinProblems({ dependencies: { a: "1.0.0" } }, lock), [])
  assert.equal(pinProblems({ dependencies: { a: "^1.0.0" } }, lock).length, 2)
  assert.equal(pinProblems({ dependencies: { a: "1.0.1" } }, lock).length, 1)
  assert.equal(pinProblems({ dependencies: { a: "1.0.0" } }, null).length, 2)
})

test("HT-REL-01: THIRD_PARTY_NOTICES.md is current and carries DeepSeek Harness's license", () => {
  const exceptions = (() => {
    try {
      return read("notices-exceptions.json")
    } catch {
      return {}
    }
  })()
  const { markdown } = buildNotices(read("package-lock.json"), exceptions)
  assert.equal(readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8"), markdown)
  assert.match(markdown, /## DeepSeek Harness\n\nMIT License\n\nCopyright \(c\) 2026 DeepSeek/)
  // The fonts inlined into the theme carry their license
  for (const font of ["fraunces", "geist", "jetbrains-mono"])
    assert.match(markdown, new RegExp(`### @fontsource-variable/${font}@[\\d.]+ \\(OFL-1\\.1\\)\\n\\n\`\`\`text\\n.*SIL OPEN FONT LICENSE`, "s"))
})

test("HT-REL-02: licenses outside the allow-list, or unknown, block a release", () => {
  for (const ok of ["MIT", "Apache-2.0", "(MIT OR CC0-1.0)", "BSD-3-Clause AND MIT"]) assert.ok(licenseAllowed(ok), ok)
  for (const bad of ["MPL-2.0", "LGPL-3.0-or-later", "Apache-2.0 AND LGPL-3.0-or-later", "Unlicense", "", null, "SEE LICENSE IN x"])
    assert.ok(!licenseAllowed(bad), String(bad))
  const lock = {
    packages: {
      "": {},
      "node_modules/fine": { version: "1.0.0", license: "MIT" },
      "node_modules/odd": { version: "2.0.0", license: "MPL-2.0" },
      "node_modules/mystery": { version: "3.0.0" },
      "node_modules/tool": { version: "4.0.0", license: "GPL-3.0", dev: true },
    },
  }
  const { problems } = buildNotices(lock, {}, "/nonexistent", [])
  assert.deepEqual(problems, [
    "mystery@3.0.0: license unknown isn't allowed",
    "odd@2.0.0: license MPL-2.0 isn't allowed",
  ])
  // A recorded exception (an owner decision) clears exactly that package and version
  assert.deepEqual(buildNotices(lock, { "odd@2.0.0": "reason", "mystery@3.0.0": "reason" }, "/nonexistent", []).problems, [])
})

test("HT-REL-01: the notices come out the same on every system", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const lock = {
    packages: {
      "": {},
      "node_modules/everywhere": { version: "1.0.0", license: "MIT" },
      "node_modules/mac-only": { version: "1.0.0", license: "MIT", os: ["darwin"], cpu: ["arm64"] },
      "node_modules/maybe": { version: "1.0.0", license: "MIT", optional: true },
    },
  }
  const install = (withMacOnly) => {
    const root = mkdtempSync(join(tmpdir(), "kriya-notices-"))
    for (const name of withMacOnly ? ["everywhere", "mac-only", "maybe"] : ["everywhere"]) {
      mkdirSync(join(root, "node_modules", name), { recursive: true })
      writeFileSync(join(root, "node_modules", name, "LICENSE"), `License of ${name}`)
    }
    return buildNotices(lock, {}, root, []).markdown
  }
  const onMac = install(true)
  assert.equal(onMac, install(false))
  assert.match(onMac, /\| mac-only \| 1\.0\.0 \| MIT \| darwin, arm64 \|/)
  assert.match(onMac, /\| maybe \| 1\.0\.0 \| MIT \| optional \|/)
  assert.doesNotMatch(onMac, /License of (mac-only|maybe)/)
})
