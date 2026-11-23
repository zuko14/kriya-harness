import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { groundingTools, HINT } from "../plugins/grounding/index.js"
import { apiChanges, apiLookup, apiVersion, hasInstalled, MAX_ANSWER } from "../plugins/grounding/lookup.js"
import { SWITCHES } from "../src/modes.js"
import { ROOT } from "./helpers.js"

// Harness 2.0 W15 (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GROUNDING_AND_CONNECTORS.md §5, WD-20): grounding from installed files.
// WT-GRD-01…06. Fixture projects only: nothing installed, nothing fetched.

function project(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kriya-grd-")))
  mkdirSync(join(dir, ".git"))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof text === "string" ? text : JSON.stringify(text))
  }
  return dir
}
// Code that leaves a mark if anything ever runs it
const RUNS = (dir) => `require("fs").writeFileSync(${JSON.stringify(join(dir, "RAN"))}, "x")\n`

const tsProject = () => {
  const dir = project({ "package.json": { dependencies: { "kv-client": "^2.1.0" } } })
  const files = {
    "node_modules/kv-client/package.json": { name: "kv-client", version: "2.3.1", exports: { ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" }, require: "./dist/index.cjs" } } },
    "node_modules/kv-client/dist/index.mjs": RUNS(dir),
    "node_modules/kv-client/dist/index.cjs": RUNS(dir),
    "node_modules/kv-client/dist/index.d.mts": 'export * from "./client.js"\nexport { Session } from "./session.js"\n',
    "node_modules/kv-client/dist/client.d.ts": [
      "/**",
      " * Connects to the store.",
      " * @param url the store's address",
      " */",
      "export declare function createClient(url: string, options?: ClientOptions): Client;",
      "export interface ClientOptions {",
      "  timeoutMs?: number",
      "  retries?: number",
      "}",
      "export declare function createClientPool(size: number): Client[];",
      "",
    ].join("\n"),
    "node_modules/kv-client/dist/session.d.ts": "export declare class Session {\n  /** Ends the session */\n  close(force?: boolean): Promise<void>\n}\n",
    "node_modules/kv-client/CHANGELOG.md": "# Changelog\n\n## 2.4.0\n- Unreleased here\n\n## 2.3.0\n- createClient takes options.timeoutMs\n\n## 2.2.0\n- Session.close takes force\n\n## 2.1.0\n- First 2.1\n",
    "package-lock.json": { lockfileVersion: 3, packages: { "node_modules/kv-client": { version: "2.3.1" } } },
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof text === "string" ? text : JSON.stringify(text))
  }
  return dir
}

test("WT-GRD-01: TypeScript exports types are resolved, through re-exports, with doc comments; exact name, then prefix", () => {
  const dir = tsProject()
  const a = apiLookup(dir, "kv-client", "createClient")
  assert.equal(a.found, 1)
  assert.match(a.text, /^kv-client 2\.3\.1, from its type definitions:/)
  assert.match(a.text, /\* Connects to the store\.\n[\s\S]*export declare function createClient\(url: string, options\?: ClientOptions\): Client;/)
  assert.match(a.text, /node_modules\/kv-client\/dist\/client\.d\.ts:5/)
  assert.match(apiLookup(dir, "kv-client", "ClientOptions").text, /timeoutMs\?: number[\s\S]*\}/)
  // A class and its member, from the second file of the re-exports
  assert.match(apiLookup(dir, "kv-client", "close").text, /Ends the session[\s\S]*close\(force\?: boolean\): Promise<void>/)
  const missing = apiLookup(dir, "kv-client", "create")
  assert.equal(missing.found, 0)
  assert.match(missing.text, /no declaration named create\. Names starting with it: createClient, createClientPool\./)
  assert.match(apiLookup(dir, "not-here", "x").text, /isn't installed/)
})

test("WT-GRD-02: without shipped types, @types/<pkg> answers (scoped names too)", () => {
  const dir = project({
    "node_modules/legacy-dates/package.json": { name: "legacy-dates", version: "1.0.4", main: "index.js" },
    "node_modules/legacy-dates/index.js": "module.exports = () => {}",
    "node_modules/@types/legacy-dates/package.json": { name: "@types/legacy-dates", version: "1.0.0", types: "index.d.ts" },
    "node_modules/@types/legacy-dates/index.d.ts": "/** Formats a date as DD/MM/YYYY */\ndeclare function formatDay(d: Date): string;\nexport = formatDay;\n",
    "node_modules/@acme/widgets/package.json": { name: "@acme/widgets", version: "3.0.0" },
    "node_modules/@types/acme__widgets/index.d.ts": "export declare const WIDGET_SIZES: readonly number[];\n",
    "node_modules/@types/acme__widgets/package.json": { name: "@types/acme__widgets" },
  })
  const a = apiLookup(dir, "legacy-dates", "formatDay")
  assert.match(a.text, /from @types\/legacy-dates:[\s\S]*Formats a date[\s\S]*declare function formatDay\(d: Date\): string;/)
  assert.match(apiLookup(dir, "@acme/widgets", "WIDGET_SIZES").text, /from @types\/acme__widgets:[\s\S]*WIDGET_SIZES: readonly number\[\]/)
  const none = project({ "node_modules/plain/package.json": { name: "plain", version: "1.0.0" } })
  assert.match(apiLookup(none, "plain", "x").text, /ships no type definitions and there is no @types\/plain installed/)
})

test("WT-GRD-03: Python answers from .pyi stubs, else def/class lines of the source; versions from dist-info", () => {
  const site = ".venv/lib/python3.12/site-packages"
  const dir = project({
    "requirements.txt": "fetchkit>=1.2\nslugs==0.3.0\n",
    [`${site}/fetchkit/__init__.py`]: "import os\nos.system('echo ran')\ndef get(url, params=None, **kw):\n    return 1\n",
    [`${site}/fetchkit/__init__.pyi`]: "from typing import Any\n\ndef get(\n    url: str,\n    params: dict[str, Any] | None = ...,\n) -> Response: ...\nclass Response:\n    status_code: int\n",
    [`${site}/fetchkit-1.4.2.dist-info/METADATA`]: "Name: fetchkit\nVersion: 1.4.2\n",
    [`${site}/slugs/__init__.py`]: "def slugify(text: str, sep: str = '-') -> str:\n    '''Lower-case words joined by sep.'''\n    return text\n",
  })
  const a = apiLookup(dir, "fetchkit", "get")
  assert.match(a.text, /from its \.pyi stubs:[\s\S]*def get\(\n\s+url: str,\n\s+params: dict\[str, Any\] \| None = \.\.\.,\n\) -> Response: \.\.\./)
  assert.match(apiLookup(dir, "fetchkit", "Response").text, /class Response:/)
  const b = apiLookup(dir, "slugs", "slugify")
  assert.match(b.text, /from its source \(def and class lines only\)[\s\S]*def slugify\(text: str, sep: str = '-'\) -> str:/)
  assert.doesNotMatch(b.text, /return text/)
  assert.deepEqual(apiVersion(dir, "fetchkit"), { package: "fetchkit", declared: ">=1.2", installed: "1.4.2" })
  assert.equal(hasInstalled(dir), true)
})

test("WT-GRD-04: nothing is imported, required or executed", async () => {
  const dir = tsProject()
  const site = ".venv/lib/python3.12/site-packages"
  mkdirSync(join(dir, site, "danger"), { recursive: true })
  writeFileSync(join(dir, site, "danger", "__init__.py"), `open(${JSON.stringify(join(dir, "RAN"))}, "w").write("x")\ndef boom(): ...\n`)
  // Every way to start a process counts; none may be used
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]
  const original = Object.fromEntries(names.map((n) => [n, childProcess[n]]))
  const calls = []
  for (const n of names) childProcess[n] = (...args) => (calls.push(n), original[n](...args))
  syncBuiltinESMExports()
  try {
    const tools = Object.fromEntries(groundingTools({ cwd: async () => dir }).map((t) => [t.name, t]))
    const exec = { agent: { id: "a" }, signal: new AbortController().signal }
    await tools.api_lookup.execute({ package: "kv-client", symbol: "createClient" }, exec)
    await tools.api_changes.execute({ package: "kv-client" }, exec)
    await tools.api_version.execute({ package: "kv-client" }, exec)
    await tools.api_lookup.execute({ package: "danger", symbol: "boom" }, exec)
  } finally {
    for (const n of names) childProcess[n] = original[n]
    syncBuiltinESMExports()
  }
  assert.deepEqual(calls, [])
  assert.equal(existsSync(join(dir, "RAN")), false)
})

test("WT-GRD-05: bounded answers, checked inputs, nothing read outside the project", () => {
  const big = Array.from({ length: 3000 }, (_, i) => `/** overload ${i}: ${"a long explanation ".repeat(30)}*/\nexport declare function pick(x: T${i}): T${i};`).join("\n")
  const dir = project({
    "node_modules/huge/package.json": { name: "huge", version: "1.0.0", types: "index.d.ts" },
    "node_modules/huge/index.d.ts": big,
    "node_modules/toolarge/package.json": { name: "toolarge", version: "1.0.0", types: "index.d.ts" },
    "node_modules/toolarge/index.d.ts": `export declare const A: 1;\n${"// pad\n".repeat(400_000)}`,
  })
  const a = apiLookup(dir, "huge", "pick")
  assert.ok(a.text.length <= MAX_ANSWER, String(a.text.length))
  assert.match(a.text, /cut at 8 KB/)
  const short = project({
    "node_modules/many/package.json": { name: "many", version: "1.0.0", types: "index.d.ts" },
    "node_modules/many/index.d.ts": Array.from({ length: 30 }, (_, i) => `export declare function pick(x: T${i}): T${i};`).join("\n"),
  })
  assert.match(apiLookup(short, "many", "pick").text, /\(20 of 30 declarations shown\)$/)
  // A file over 2 MB isn't read
  assert.match(apiLookup(dir, "toolarge", "A").text, /ships no type definitions/)
  for (const bad of ["../secret", "/etc/passwd", "a b", ""]) assert.throws(() => apiLookup(dir, bad, "x"), /isn't a package name/, bad)
  for (const bad of ["a.b", "x;rm", "", "1abc"]) assert.throws(() => apiLookup(dir, "huge", bad), /one exported name/, bad)
  // A package linked from outside the project isn't followed
  const outside = project({ "package.json": { name: "outside", version: "9.9.9", types: "index.d.ts" }, "index.d.ts": "export declare const SECRET: string;\n" })
  mkdirSync(join(dir, "node_modules"), { recursive: true })
  symlinkSync(outside, join(dir, "node_modules", "outside"))
  assert.match(apiLookup(dir, "outside", "SECRET").text, /isn't installed/)
})

test("WT-GRD-06: offline: changelog sections between the declared and installed versions, lockfile versions, no network", async () => {
  const dir = tsProject()
  const fetched = []
  const fetch = globalThis.fetch
  globalThis.fetch = async (...args) => (fetched.push(args), fetch(...args))
  try {
    const c = apiChanges(dir, "kv-client")
    assert.equal(c.since, "2.1.0")
    assert.match(c.text, /CHANGELOG\.md, 2\.1\.0 → 2\.3\.1:/)
    assert.match(c.text, /## 2\.3\.0[\s\S]*## 2\.2\.0/)
    assert.doesNotMatch(c.text, /2\.4\.0|First 2\.1/)
    assert.match(apiChanges(dir, "kv-client", "2.2.0").text, /## 2\.3\.0/)
    assert.doesNotMatch(apiChanges(dir, "kv-client", "2.2.0").text, /## 2\.2\.0/)
    assert.deepEqual(apiVersion(dir, "kv-client"), { package: "kv-client", declared: "^2.1.0", locked: "2.3.1", installed: "2.3.1" })
    const bare = project({ "node_modules/nolog/package.json": { name: "nolog", version: "1.0.0" } })
    assert.match(apiChanges(bare, "nolog").text, /ships no changelog/)
  } finally {
    globalThis.fetch = fetch
  }
  assert.deepEqual(fetched, [])
})

test("WT-GRD-00: off by default; the bundle row needs the switch; the hint is one line", async () => {
  assert.deepEqual(SWITCHES.find(([f]) => f === "grounding"), ["grounding", "KRIYA_GROUNDING", false])
  const { readFileSync } = await import("node:fs")
  for (const profile of ["kriya", "kriya-run", "kriya-acp"])
    assert.match(readFileSync(join(ROOT, "expected", `${profile}.dump.yml`), "utf8"), /- id: kriya-grounding\n {2}name: '@kriya-ai\/harness-grounding'\n {2}disabled: !!js process\.env\.KRIYA_GROUNDING !== 'on'/)
  assert.equal(HINT.includes("\n"), false)
  assert.equal(hasInstalled(project({})), false)
})
