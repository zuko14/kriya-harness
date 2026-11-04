import { execFile } from "node:child_process"
import { promisify } from "node:util"

// The Overview tab's data (plugins/overview, workspace panel phase P1 in
// the Kriya repository's docs/kriya-harness/WORKSPACE_PANEL_SKILLS_PLUGINS.md):
// where a session runs, read with read-only git. A remote URL can carry a
// user name or a token (https://user:token@host/…); only the host and the
// repository path ever leave this file.

const run = promisify(execFile)

/** The origin remote as { host, path, github }, or null; never any credentials */
export function parseRemote(url) {
  const text = typeof url === "string" ? url.trim() : ""
  if (!text) return null
  let host
  let path
  // scp-like: git@github.com:owner/repo.git
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) [, host, path] = scp
  else {
    try {
      const u = new URL(text)
      if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol)) return null
      host = u.hostname
      path = u.pathname
    } catch {
      return null
    }
  }
  path = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "")
  if (!host || !/^[\w.-]+$/.test(host) || !/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return null
  return { host: host.toLowerCase(), path, github: host.toLowerCase() === "github.com" }
}

/** The repository's origin remote, parsed, or null (no repository, no origin, or git missing) */
export async function originOf(root) {
  try {
    const { stdout } = await run("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      timeout: 10_000,
    })
    return parseRemote(stdout)
  } catch {
    return null
  }
}

const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined)

/** The context and usage figures the token meter keeps for a live session, numbers only */
export function meterFigures(values = {}) {
  const p = values.contextPressure ?? {}
  const u = values.tokenUsage ?? {}
  const context = { window: num(p.contextWindow), used: num(p.pressureTokens) ?? num(p.projectedTokens) ?? num(p.surfaceTokens) }
  const usage = { input: num(u.uncachedInputTokens), output: num(u.outputTokens), cacheRead: num(u.cacheReadTokens) }
  return {
    context: context.used === undefined ? null : context,
    usage: Object.values(usage).every((v) => v === undefined) ? null : usage,
  }
}

const JOB_LIMIT = 20

/** A session's background jobs, newest first, as the panel shows them */
export function jobRows(jobs = []) {
  return jobs
    .map((j) => ({ id: j.id, kind: j.kind, label: String(j.label ?? "").slice(0, 200), status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, progress: j.progress }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, JOB_LIMIT)
}
