import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, rmdirSync, unlinkSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import { kriyaHome } from "./paths.js"

// Step checkpoints and undo (H14b, K3; KRIYA_LOOP.md in the Kriya
// repository). Before the agent changes files, the working tree (tracked
// and untracked files, never ignored ones) is saved as a commit on Kriya's
// own ref, refs/kriya/checkpoints/<session>/<n>. `kriya undo` puts the
// working tree back one step. What's never touched: the person's branches,
// tags, stash, HEAD and index (every git call that stages uses a separate
// index file), ignored files, and anything under .git but Kriya's refs and
// git's object store. Before an undo changes a file, the state it replaces
// is saved too (refs/kriya/undone/<n>), so an undo can be undone.

export const REF_ROOT = "refs/kriya"
export const KEEP = 100 // checkpoints kept per session; older refs are dropped
const MB = 1024 * 1024
const SESSION = /^[A-Za-z0-9_-]{1,128}$/
// Neutral identity, so a checkpoint never depends on (or pretends to be) the person's git config
const IDENTITY = {
  GIT_AUTHOR_NAME: "Kriya Harness",
  GIT_AUTHOR_EMAIL: "harness@kriya.invalid",
  GIT_COMMITTER_NAME: "Kriya Harness",
  GIT_COMMITTER_EMAIL: "harness@kriya.invalid",
}

export class CheckpointError extends Error {}

function git(cwd, args, { env, input } = {}) {
  return new Promise((done, fail) => {
    const child = execFile("git", args, { cwd, env: { ...process.env, ...env }, encoding: "buffer", maxBuffer: 256 * MB }, (error, stdout, stderr) => {
      if (error) fail(new CheckpointError(stderr.toString().trim().split("\n")[0] || error.message))
      else done(stdout)
    })
    if (input !== undefined) child.stdin.end(input)
  })
}
const text = async (cwd, args, options) => (await git(cwd, args, options)).toString().trim()

/** The repository's top folder, or undefined when `cwd` isn't in one. */
export async function repoRoot(cwd) {
  try {
    return await text(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    return undefined
  }
}

// Kriya's own index per repository, kept between snapshots so `add -A` only
// rereads what changed; outside the repository, so .git gains nothing else
const indexFile = (root) => join(kriyaHome(), "checkpoint-index", `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.index`)

/** The working tree as a tree object: tracked and untracked files, not ignored ones. */
export async function snapshot(root) {
  const index = indexFile(root)
  mkdirSync(dirname(index), { recursive: true })
  const env = { GIT_INDEX_FILE: index }
  await git(root, ["add", "-A", "--", "."], { env })
  return text(root, ["write-tree"], { env })
}

const seq = (ref) => Number(ref.split("/").pop())

/** Kriya's checkpoints, newest first: { ref, commit, tree, at, label, session, kind } */
export async function listCheckpoints(root) {
  const out = await text(root, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(tree)%09%(creatordate:iso-strict)%09%(contents:subject)", REF_ROOT])
  if (!out) return []
  return out
    .split("\n")
    .map((line) => {
      const [ref, commit, tree, at, label] = line.split("\t")
      const parts = ref.split("/")
      const kind = parts[2] === "undone" ? "undone" : "checkpoint"
      return { ref, commit, tree, at, label, kind, session: kind === "checkpoint" ? parts[3] : undefined, n: seq(ref) }
    })
    .sort((a, b) => b.at.localeCompare(a.at) || b.n - a.n)
}

async function save(root, prefix, tree, label, now) {
  const existing = (await listCheckpoints(root)).filter((c) => c.ref.startsWith(`${prefix}/`))
  const n = existing.reduce((max, c) => Math.max(max, c.n), 0) + 1
  const date = now().toISOString()
  const commit = await text(root, ["commit-tree", tree, "-m", label], {
    env: { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
  const ref = `${prefix}/${String(n).padStart(6, "0")}`
  await git(root, ["update-ref", ref, commit])
  // Keep the newest KEEP; dropping a ref leaves its objects to git's own gc
  for (const old of existing.sort((a, b) => b.n - a.n).slice(KEEP - 1)) await git(root, ["update-ref", "-d", old.ref])
  return { ref, commit, tree, at: date, label }
}

/**
 * Saves the working tree before a change, unless it's the same as the
 * session's last checkpoint.
 * @returns {Promise<undefined | { ref: string, commit: string, tree: string, created: boolean }>} undefined outside a git repository
 */
export async function checkpoint(cwd, sessionId, label, now = () => new Date()) {
  if (!SESSION.test(sessionId)) throw new CheckpointError("That session id can't name a checkpoint.")
  const root = await repoRoot(cwd)
  if (!root) return undefined
  const tree = await snapshot(root)
  const prefix = `${REF_ROOT}/checkpoints/${sessionId}`
  const last = (await listCheckpoints(root)).find((c) => c.ref.startsWith(`${prefix}/`))
  if (last?.tree === tree) return { ...last, created: false }
  return { ...(await save(root, prefix, tree, String(label).replace(/\s+/g, " ").slice(0, 200), now)), created: true }
}

/** The files that differ between two trees, by what restoring `to` does to each. */
async function differences(root, from, to) {
  const out = (await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to])).toString()
  const fields = out.split("\0").filter(Boolean)
  const write = []
  const remove = []
  for (let i = 0; i + 1 < fields.length; i += 2) (fields[i] === "D" ? remove : write).push(fields[i + 1])
  return { write, remove }
}

/**
 * One step back from the files as they are: if they match a checkpoint
 * (a previous undo landed there), the newest older one that differs;
 * otherwise (new work since) the newest that differs. Never forward.
 * @param {Array<{ tree: string }>} checkpoints newest first
 */
export function stepBack(checkpoints, current) {
  const here = checkpoints.findIndex((c) => c.tree === current)
  return checkpoints.slice(here + 1).find((c) => c.tree !== current)
}

/**
 * Puts the working tree back to a checkpoint. With no `target`, one step
 * back (stepBack).
 * @param {string} cwd
 * @param {{ target?: number, now?: () => Date }} [options] target: a number from `kriya undo --list`
 */
export async function undo(cwd, { target, now = () => new Date() } = {}) {
  const root = await repoRoot(cwd)
  if (!root) throw new CheckpointError("This folder isn't a git repository, so there are no checkpoints to go back to.")
  const all = await listCheckpoints(root)
  const current = await snapshot(root)
  const chosen = target === undefined ? stepBack(all.filter((c) => c.kind === "checkpoint"), current) : all[target - 1]
  if (!chosen) throw new CheckpointError(target === undefined ? "Nothing to undo: no checkpoint differs from the files as they are." : `There's no checkpoint ${target}; kriya undo --list shows them.`)
  if (chosen.tree === current) return { root, restored: chosen, changed: 0, saved: undefined }

  const { write, remove } = await differences(root, current, chosen.tree)
  // What this undo replaces is kept first: nothing is lost
  const saved = await save(root, `${REF_ROOT}/undone`, current, `before undo to ${chosen.label}`, now)

  if (write.length) {
    const index = join(dirname(indexFile(root)), `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.restore.index`)
    const env = { GIT_INDEX_FILE: index }
    await git(root, ["read-tree", chosen.tree], { env })
    await git(root, ["checkout-index", "-f", "-z", "--stdin"], { env, input: `${write.join("\0")}\0` })
    try {
      unlinkSync(index)
    } catch {
      // Already gone
    }
  }
  for (const path of remove) {
    const file = resolve(root, path)
    if (relative(root, file).startsWith("..")) continue
    try {
      unlinkSync(file)
    } catch {
      continue
    }
    // Folders the undo emptied go too, never the root
    for (let dir = dirname(file); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
      try {
        rmdirSync(dir)
      } catch {
        break
      }
    }
  }
  // Kriya's index now matches the restored files
  await snapshot(root)
  return { root, restored: chosen, changed: write.length + remove.length, saved }
}
