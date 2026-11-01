import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { call } from "../../src/api.js"

// Handoff and pull (H8, HD-11; docs/kriya-harness/ARCHITECTURE.md §3.4 in
// the Kriya repository).
// - `kriya handoff [note]`: the repository's HEAD must be on GitHub; the
//   working tree against HEAD (untracked files included, ignored ones left
//   out) becomes one binary patch in track C's checkpoint format, uploaded
//   with its sha256 to POST /handoff. A Kriya agent then carries on in a
//   cloud workspace.
// - `kriya pull [workspaceId]`: the workspace's latest checkpoint, checked
//   against its sha256, applied on a new branch kriya/pull-<id> at the
//   workspace's base commit. The person's own branch is never touched.
// Nothing here runs a command the person didn't ask for beyond git.

const UPLOAD_MS = 5 * 60_000
// The person's note (the contract's limit)
const NOTE_MAX = 2000
const MB = 1024 * 1024

export class HandoffError extends Error {}

/**
 * git in `cwd`; stdout as a Buffer
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: Buffer, env?: NodeJS.ProcessEnv }} [options]
 */
function git(cwd, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: env ?? process.env, encoding: "buffer", maxBuffer: 1024 * MB },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString().trim().split("\n")[0] || error.message
          reject(new HandoffError(detail))
        } else resolve(stdout)
      }
    )
    if (input) child.stdin.end(input)
  })
}

const text = async (cwd, args) => (await git(cwd, args)).toString().trim()

async function repoRoot(cwd) {
  try {
    return await text(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    throw new HandoffError("This folder isn't a git repository; run kriya handoff inside one.")
  }
}

/** owner/name from a GitHub remote URL (https, ssh or scp form); null otherwise */
export function githubRepo(remote) {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
    remote.trim()
  )
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * The working tree against HEAD as track C's runner writes a checkpoint:
 * `git diff --cached --binary --no-renames HEAD` over a throwaway index that
 * has every file added, so untracked files come along and the person's own
 * index is never changed.
 * @param {string} root
 */
export async function checkpointPatch(root) {
  const dir = mkdtempSync(join(tmpdir(), "kriya-handoff-"))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") }
  try {
    await git(root, ["read-tree", "HEAD"], { env })
    await git(root, ["add", "-A"], { env })
    return await git(root, ["diff", "--cached", "--binary", "--no-renames", "HEAD"], { env })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

/**
 * What a handoff sends, without sending it: the checks HD-11 asks of the
 * client (a GitHub repository, a branch, HEAD pushed) and the patch.
 * @param {string} cwd
 * @param {string} [note]
 */
export async function prepareHandoff(cwd, note = "") {
  if (note.length > NOTE_MAX) throw new HandoffError(`The note is over ${NOTE_MAX} characters.`)
  const root = await repoRoot(cwd)
  let baseSha
  try {
    baseSha = await text(root, ["rev-parse", "--verify", "HEAD^{commit}"])
  } catch {
    throw new HandoffError("This repository has no commits yet; commit and push first.")
  }
  const baseRef = await text(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (baseRef === "HEAD") throw new HandoffError("HEAD is detached; check out a branch first.")
  let remote = ""
  try {
    remote = await text(root, ["remote", "get-url", "origin"])
  } catch {}
  const repo = githubRepo(remote)
  if (!repo) throw new HandoffError("The origin remote isn't a GitHub repository; Kriya works from GitHub.")
  // The cloud workspace starts from GitHub at this commit (HD-11)
  const pushed = await text(root, ["branch", "-r", "--contains", baseSha])
  if (!pushed) throw new HandoffError(`Commit ${baseSha.slice(0, 12)} isn't on GitHub yet; push your branch first.`)
  const patch = await checkpointPatch(root)
  return {
    meta: {
      repo,
      baseRef,
      baseSha,
      ...(note.trim() && { note: note.trim() }),
      sha256: sha256(patch),
      bytes: patch.length,
    },
    patch,
  }
}

/**
 * @param {{ url: string, token: string }} device
 * @param {string} cwd
 * @param {string} [note]
 * @returns {Promise<{ threadId: string, workspaceId: string, taskId: string, url: string, bytes: number }>}
 */
export async function handoff(device, cwd, note) {
  const { meta, patch } = await prepareHandoff(cwd, note)
  const form = new FormData()
  form.set("meta", JSON.stringify(meta))
  form.set("patch", new Blob([patch], { type: "application/octet-stream" }), "checkpoint.patch")
  const answer = await call(device.url, "POST", "/handoff", {
    token: device.token,
    body: form,
    signal: AbortSignal.timeout(UPLOAD_MS),
  })
  return { ...answer, bytes: meta.bytes }
}

/**
 * @param {{ url: string, token: string }} device
 * @param {string} cwd
 * @param {string} workspaceId
 * @returns {Promise<{ branch: string, baseSha: string, bytes: number }>}
 */
export async function pull(device, cwd, workspaceId) {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new HandoffError("That isn't a workspace id.")
  const root = await repoRoot(cwd)
  if ((await text(root, ["status", "--porcelain"])) !== "")
    throw new HandoffError("This repository has uncommitted changes; commit or stash them first.")
  const branch = `kriya/pull-${workspaceId}`
  const taken = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false
  )
  if (taken) throw new HandoffError(`Branch ${branch} already exists; delete it or switch to it.`)

  const response = await call(device.url, "GET", `/workspaces/${workspaceId}/checkpoint`, {
    token: device.token,
    raw: true,
    signal: AbortSignal.timeout(UPLOAD_MS),
  })
  const patch = Buffer.from(await response.arrayBuffer())
  const expected = response.headers.get("x-kriya-sha256")
  const baseSha = response.headers.get("x-kriya-base-sha") ?? ""
  if (!expected || sha256(patch) !== expected)
    throw new HandoffError("The checkpoint was damaged on the way; nothing was applied. Pull again.")
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new HandoffError("Kriya didn't say which commit the work starts from.")
  try {
    await git(root, ["cat-file", "-e", `${baseSha}^{commit}`])
  } catch {
    throw new HandoffError(`Commit ${baseSha.slice(0, 12)} isn't in this clone; run git fetch and pull again.`)
  }

  await git(root, ["switch", "--quiet", "-c", branch, baseSha])
  try {
    if (patch.length) await git(root, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch })
  } catch (error) {
    // git apply is all or nothing; put the person back where they were
    await git(root, ["checkout", "--quiet", "-"])
    await git(root, ["branch", "-D", "--quiet", branch])
    throw new HandoffError(`The checkpoint doesn't apply cleanly (${error.message}); nothing was changed.`)
  }
  return { branch, baseSha, bytes: patch.length }
}
