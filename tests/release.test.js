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
  const exceptions = read("notices-exceptions.json")
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
  // A recorded exception (an owner decision) clears exactly that package, version and license
  const decision = { id: "HF-x", date: "2026-11-01", record: "Owner decided." }
  const decided = {
    decision,
    packages: {
      "odd@2.0.0": { license: "MPL-2.0", reason: "Needed for x." },
      "mystery@3.0.0": { license: null, reason: "Checked by hand." },
    },
  }
  assert.deepEqual(buildNotices(lock, decided, "/nonexistent", []).problems, [])
  assert.match(buildNotices(lock, decided, "/nonexistent", []).markdown, /## License exceptions \(HF-x, 2026-11-01\)\n\nOwner decided\.\n[\s\S]*\| odd@2\.0\.0 \| MPL-2\.0 \| Needed for x\. \|/)
})

test("HT-REL-02: an exception without a decision, for another license, or for a package not installed fails", () => {
  const lock = { packages: { "": {}, "node_modules/odd": { version: "2.0.0", license: "MPL-2.0" } } }
  const exception = { license: "MPL-2.0", reason: "Needed for x." }
  const decision = { id: "HF-x", date: "2026-11-01", record: "Owner decided." }
  const problems = (file) => buildNotices(lock, file, "/nonexistent", []).problems
  assert.equal(problems({ packages: { "odd@2.0.0": exception } }).length, 1)
  assert.match(problems({ decision, packages: { "odd@2.0.0": { ...exception, license: "MIT" } } })[0], /doesn't match/)
  assert.match(problems({ decision, packages: { "odd@2.0.0": exception, "odd@1.0.0": exception } })[0], /odd@1\.0\.0: exception for a package this release doesn't install/)
})

test("HF-09: every exception is decided, matches the lockfile, and the release gate is clean", () => {
  const file = read("notices-exceptions.json")
  assert.equal(file.decision.id, "HF-09")
  assert.match(file.decision.stillOpen, /HQ-C1/)
  const { problems } = buildNotices(read("package-lock.json"), file)
  assert.deepEqual(problems, [])
  assert.equal(Object.keys(file.packages).length, 21)
})

test("HG-5: npm run sbom writes a CycloneDX SBOM of the release, from the lockfile, without dev tools", async () => {
  const { execFileSync } = await import("node:child_process")
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const sbom = JSON.parse(execFileSync(npm, ["run", "-s", "sbom"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))
  assert.equal(sbom.bomFormat, "CycloneDX")
  const pins = read("package.json").dependencies
  const dsh = sbom.components.find((c) => c.purl?.startsWith("pkg:npm/%40deepseek-ai/dsh@"))
  assert.equal(dsh?.version, pins["@deepseek-ai/dsh"])
  for (const dev of Object.keys(read("package.json").devDependencies).filter((n) => n.startsWith("@fontsource")))
    assert.ok(!sbom.components.some((c) => c.purl?.includes(encodeURIComponent(dev).replace("%2F", "/"))), dev)
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

test("HG-6: SAFETY.md's defaults are the composed profiles' defaults, and it covers what leaves the machine", () => {
  const safety = readFileSync(join(ROOT, "SAFETY.md"), "utf8")
  for (const profile of ["kriya", "kriya-run", "kriya-acp"]) {
    const dump = readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8")
    // Kriya modes: without --mode, the folder sandbox and approvals ask
    assert.match(dump, /process\.env\.KRIYA_SANDBOX : 'workspace-write'/, profile)
    assert.match(dump, /process\.env\.KRIYA_APPROVAL === ''never'' \? ''never'' : ''ask''/, profile)
    assert.match(dump, /process\.env\.KRIYA_PRESET : 'ask'/, profile)
  }
  for (const fact of [
    /has not had a\nsecurity audit/,
    /\| `ask` \(default\) \| this folder \| ask \|/,
    /\| `full` \| none \| never \|/,
    /Network access and which programs run aren't\s+limited by it, in any mode/,
    /temporary areas/,
    /DSH_PERMISSION_MODE/,
    /Never start it in `\/`, your home folder/,
    /\*\*unconfirmed\*\* until you confirm them/,
    /\*\*which is not redacted\*\*/,
    /\*\*including untracked files\*\*/,
    /removes variables with `TOKEN` in their name/,
  ])
    assert.match(safety, fact)
})
