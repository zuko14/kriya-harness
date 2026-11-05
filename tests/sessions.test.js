import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { deleteSession, sessionFolders } from "../plugins/sessions/index.js"

function store() {
  const root = mkdtempSync(join(tmpdir(), "kriya-sessions-"))
  for (const id of ["session-a", "session-child", "session-other"]) {
    mkdirSync(join(root, "--proj--", id), { recursive: true })
    writeFileSync(join(root, "--proj--", id, "log"), "x")
  }
  return root
}
const list = async () => [
  { header: { id: "session-a" } },
  { header: { id: "session-child", origin: "subagent", parentSession: "session-a" } },
  { header: { id: "session-other" } },
]

test("DS-01: deleting removes the session and its subagents, nothing else, in order", async () => {
  const root = store()
  const steps = []
  const done = await deleteSession("session-a", {
    root,
    list,
    archive: async () => steps.push("archive"),
    forget: async () => steps.push("forget"),
    unarchive: async () => steps.push(existsSync(join(root, "--proj--", "session-a")) ? "too early" : "unarchive"),
  })
  assert.deepEqual(done, { deleted: 2 })
  assert.deepEqual(steps, ["archive", "forget", "unarchive"])
  assert.equal(sessionFolders("session-child", root).length, 0)
  assert.equal(sessionFolders("session-other", root).length, 1)
})

test("DS-02: an unknown or path-like id deletes nothing", async () => {
  const root = store()
  const host = { root, list, archive: async () => assert.fail(), unarchive: async () => assert.fail() }
  await assert.rejects(deleteSession("../x", host), RangeError)
  await assert.rejects(deleteSession("missing", host), RangeError)
  assert.equal(sessionFolders("session-a", root).length, 1)
})
