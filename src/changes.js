import { execFile } from "node:child_process"
import { lstatSync, openSync, readSync, closeSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

// The Changes tab (plugins/changes): what the agent (or you) changed in a
// session's folder, as git sees it against HEAD — staged, unstaged and
// untracked together, like a review. Read-only: git is run with an argument
// array (never a shell), without optional locks, and a file's diff is only
// ever produced for a path git itself listed as changed.

const run = promisify(execFile)
// git's own tree for "nothing": the base of a repository with no commit yet
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const MAX_FILES = 500
const MAX_DIFF_BYTES = 512 * 1024
// Untracked files are counted by reading them; bigger ones show no line count
const MAX_COUNT_BYTES = 1024 * 1024

export class ChangesError extends Error {}

async function git(root, args, { okCodes = [0], maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await run("git", ["-C", root, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      maxBuffer,
      timeout: 15_000,
    })
    return stdout
  } catch (error) {
    // `git diff --no-index` exits 1 when the files differ
    if (okCodes.includes(error.code) && typeof error.stdout === "string") return error.stdout
    throw error
  }
}

/** The repository holding `cwd`, or null when it isn't in one (or git is missing). */
export async function repoRoot(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null
  } catch {
    return null
  }
}

async function base(root) {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
    return "HEAD"
  } catch {
    return EMPTY_TREE
  }
}

// `git status --porcelain=v1 -z`: "XY path\0", renames add "orig\0"
function parseStatus(text) {
  const out = []
  const parts = text.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const renamed = x === "R" || x === "C"
    const from = renamed ? parts[++i] : undefined
    const status =
      x === "?" ? "added" : x === "D" || y === "D" ? "deleted" : renamed ? "renamed" : x === "A" ? "added" : x === "U" || y === "U" ? "conflict" : "modified"
    out.push({ path, status, untracked: x === "?", ...(from && { from }) })
  }
  return out
}

// `git diff --numstat -z`: "added\tdeleted\tpath\0" or, for a rename,
// "added\tdeleted\t\0from\0to\0"; binary files show "-\t-"
function parseNumstat(text) {
  const counts = new Map()
  const parts = text.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i])
    if (!match) continue
    let path = match[3]
    if (path === "") {
      i++
      path = parts[++i]
    }
    counts.set(path, match[1] === "-" ? { binary: true } : { added: Number(match[1]), deleted: Number(match[2]) })
  }
  return counts
}

function countLines(file) {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile()) return { binary: true }
    if (stat.size > MAX_COUNT_BYTES) return {}
    const buffer = Buffer.alloc(stat.size)
    const fd = openSync(file, "r")
    try {
      readSync(fd, buffer, 0, stat.size, 0)
    } finally {
      closeSync(fd)
    }
    if (buffer.includes(0)) return { binary: true }
    const text = buffer.toString("utf8")
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
    return { added: lines, deleted: 0 }
  } catch {
    return {}
  }
}

/**
 * Every changed file under `cwd`'s repository against HEAD, with line counts.
 * @param {string} cwd
 */
export async function listChanges(cwd) {
  const root = await repoRoot(cwd)
  if (!root) return { git: false }
  const [statusText, branchText, from] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
    base(root),
  ])
  const counts = parseNumstat(await git(root, ["diff", "--numstat", "-z", "-M", from, "--"]))
  const all = parseStatus(statusText)
  const files = all.slice(0, MAX_FILES).map((file) => ({
    ...file,
    ...(file.untracked ? countLines(join(root, file.path)) : (counts.get(file.path) ?? {})),
  }))
  const sum = (key) => files.reduce((n, f) => n + (f[key] ?? 0), 0)
  return {
    git: true,
    root,
    branch: branchText.trim() === "HEAD" ? null : branchText.trim() || null,
    files,
    truncated: all.length > MAX_FILES,
    added: sum("added"),
    deleted: sum("deleted"),
  }
}

/**
 * One changed file's unified diff against HEAD. `path` must be one that
 * listChanges reported, so the browser can't name any other file.
 * @param {string} cwd
 * @param {unknown} path
 */
export async function fileDiff(cwd, path) {
  if (typeof path !== "string" || path === "" || path.includes("\0")) throw new ChangesError("Which file?")
  const changes = await listChanges(cwd)
  if (!changes.git) throw new ChangesError("This folder isn't a git repository.")
  const file = changes.files.find((f) => f.path === path)
  if (!file) throw new ChangesError("That file has no changes.")
  if (file.binary) return { path, binary: true, diff: "", truncated: false }
  const args = file.untracked
    ? ["diff", "--no-color", "--no-index", "--", "/dev/null", path]
    : ["diff", "--no-color", "-M", await base(changes.root), "--", ...(file.from ? [file.from] : []), path]
  const text = await git(changes.root, args, { okCodes: [0, 1], maxBuffer: 32 * 1024 * 1024 })
  const truncated = Buffer.byteLength(text) > MAX_DIFF_BYTES
  return { path, binary: false, diff: truncated ? Buffer.from(text).subarray(0, MAX_DIFF_BYTES).toString("utf8") : text, truncated }
}
