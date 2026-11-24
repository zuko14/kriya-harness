import assert from "node:assert/strict"
import { test } from "node:test"

import { BACKEND_PACKAGES, SURFACE_PACKAGES } from "@deepseek-ai/dsh-host-directory-picker-auto"
import { pickNativeDirectory } from "@deepseek-ai/dsh-host-directory-picker-native"
import { MAC_BACKEND, packagesFor, startFolder } from "../plugins/directory-picker/index.js"
import { withStart } from "../plugins/directory-picker/native.js"

// The workspace chooser (plugins/directory-picker): on macOS DSH's panel,
// opened next to the last pick, else ~/Developer, else home.

test("KH-DIR-01: macOS native uses Kriya's backend; every other case is DSH's own pair", () => {
  assert.deepEqual(packagesFor("native", "darwin"), [MAC_BACKEND, SURFACE_PACKAGES.native])
  assert.deepEqual(packagesFor("native", "win32"), [BACKEND_PACKAGES.native, SURFACE_PACKAGES.native])
  assert.deepEqual(packagesFor("native", "linux"), [BACKEND_PACKAGES.native, SURFACE_PACKAGES.native])
  assert.deepEqual(packagesFor("browse", "darwin"), [BACKEND_PACKAGES.browse, SURFACE_PACKAGES.browse])
})

test("KH-DIR-02: start folder: beside the last pick, else ~/Developer, else home", () => {
  const has = (...paths) => (path) => paths.includes(path)
  assert.equal(startFolder("/h/Developer/app", "/h", has("/h/Developer")), "/h/Developer")
  assert.equal(startFolder("/h/work/app", "/h", has("/h/work", "/h/Developer")), "/h/work")
  assert.equal(startFolder(null, "/h", has("/h/Developer")), "/h/Developer")
  assert.equal(startFolder(null, "/h", has()), "/h")
  assert.equal(startFolder("/gone/app", "/h", has()), "/h") // last pick's folder was deleted
})

test("KH-DIR-03: DSH's real panel script gets the start folder as an argument, not as source", async () => {
  const calls = []
  const run = async (command, args) => (calls.push({ command, args }), { stdout: "/h/Developer/app\n" })
  const picked = await pickNativeDirectory(new AbortController().signal, { platform: "darwin", run: withStart(run, "/h/Dev'eloper") })
  assert.equal(picked, "/h/Developer/app")
  const [{ command, args }] = calls
  assert.equal(command, "osascript")
  assert.match(args[3], /panel\.message = argv\[0\]; if \(argv\[1\]\) panel\.directoryURL = /)
  assert.equal(args.at(-1), "/h/Dev'eloper")
  assert.ok(!args[3].includes("Dev'eloper"))
})

test("KH-DIR-04: without a folder, or for another command, the call passes unchanged", async () => {
  const seen = []
  const run = async (command, args) => (seen.push([command, args]), { stdout: "" })
  await withStart(run, null)("osascript", ["-e", "panel.message = argv[0];"])
  await withStart(run, "/h")("zenity", ["--file-selection"])
  assert.deepEqual(seen, [["osascript", ["-e", "panel.message = argv[0];"]], ["zenity", ["--file-selection"]]])
})
