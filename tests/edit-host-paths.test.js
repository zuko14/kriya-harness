import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { isPipe, socketPath } from "../src/edit/host/paths.js"
import { ROOT } from "./helpers.js"

// The Host's own channel on Windows: a named pipe, which is not a file.

test("the Host listens on a Unix socket in its folder, and on Windows on a named pipe of its own", () => {
  assert.equal(socketPath("/home/a/.kriya", "darwin"), join("/home/a/.kriya", "edit", "host.sock"))
  assert.equal(socketPath("/home/a/.kriya", "linux"), join("/home/a/.kriya", "edit", "host.sock"))
  assert.equal(isPipe(socketPath("/home/a/.kriya", "darwin")), false)
  const pipe = socketPath("C:\\Users\\A\\.kriya", "win32")
  assert.match(pipe, /^\\\\\.\\pipe\\kriya-edit-host-[0-9a-f]{16}$/)
  assert.equal(isPipe(pipe), true)
  assert.equal(socketPath("C:\\Users\\A\\.kriya", "win32"), pipe, "the same home, the same pipe")
  assert.equal(socketPath("c:\\users\\a\\.KRIYA", "win32"), pipe, "Windows paths have no case")
  assert.notEqual(socketPath("C:\\Users\\B\\.kriya", "win32"), pipe, "another home, another Host")
})

test("the Host never removes or sets a mode on a pipe: every such call on its socket is guarded", () => {
  const main = readFileSync(join(ROOT, "src", "edit", "host", "main.js"), "utf8")
  const touching = main.split("\n").filter((line) => /\b(?:rmSync|chmodSync)\((?:socket\b|socketPath\()/.test(line))
  assert.equal(touching.length, 3)
  for (const line of touching) assert.match(line, /if \(!isPipe\(/, line.trim())
})
