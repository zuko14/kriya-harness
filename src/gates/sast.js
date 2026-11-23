import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Harness 2.0 W5: G-SAST (Kriya-Tavi docs/kriya-harness/upgrade_2.0/GATES.md
// §3). Semgrep, only if installed, only with the rules the project committed
// (.semgrep.yml / .semgrep.yaml / .semgrep/), read as they are at HEAD so a
// builder can't weaken them (GATES rule 9). Never `--config auto` or a
// registry config: those fetch rules over the network. Metrics and the version
// check are off. ERROR findings in the changed files fail.

const MS = 5 * 60_000

const exec = (cmd, args, options = {}) =>
  new Promise((done) =>
    execFile(cmd, args, { timeout: MS, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, missing: error?.code === "ENOENT", stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    )
  )

/** The committed rules, copied out of HEAD into a temp folder; { path } or { reason } */
export async function committedRules(root, dir, run = exec) {
  for (const name of [".semgrep.yml", ".semgrep.yaml"]) {
    const shown = await run("git", ["show", `HEAD:${name}`], { cwd: root })
    if (shown.code === 0 && shown.stdout.trim()) {
      const path = join(dir, name)
      writeFileSync(path, shown.stdout)
      return { path }
    }
  }
  const listed = await run("git", ["ls-tree", "-r", "--name-only", "HEAD", ".semgrep"], { cwd: root })
  if (listed.code === 0 && listed.stdout.trim()) {
    const archived = await run("sh", ["-c", 'git archive HEAD .semgrep | tar -x -C "$1"', "sh", dir], { cwd: root })
    if (archived.code === 0 && existsSync(join(dir, ".semgrep"))) return { path: join(dir, ".semgrep") }
  }
  return { reason: "the project has no committed Semgrep rules (.semgrep.yml or .semgrep/)" }
}

/** @param {{ root: string, changed: string[], run?: typeof exec }} input */
export async function sastGate({ root, changed, run = exec }) {
  const id = "G-SAST"
  const files = changed.filter((rel) => existsSync(join(root, rel))).slice(0, 200)
  if (!files.length) return { id, status: "pass", note: "no changed file to scan" }
  const version = await run("semgrep", ["--version"])
  if (version.missing) return { id, status: "not_checked", reason: "Semgrep isn't installed" }
  const dir = mkdtempSync(join(tmpdir(), "kriya-sast-"))
  try {
    const rules = await committedRules(root, dir, run)
    if (!rules.path) return { id, status: "not_checked", reason: rules.reason }
    const out = await run("semgrep", ["scan", "--config", rules.path, "--json", "--metrics", "off", "--disable-version-check", "--quiet", "--", ...files], { cwd: root, env: { ...process.env, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" } })
    let report
    try {
      report = JSON.parse(out.stdout)
    } catch {
      return { id, status: "not_checked", reason: `Semgrep didn't finish (exit ${out.code}): ${out.stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}` }
    }
    const errors = (report.results ?? []).filter((r) => String(r?.extra?.severity).toUpperCase() === "ERROR")
    if (!errors.length) return { id, status: "pass", note: `${(report.results ?? []).length} finding(s), none at ERROR` }
    return { id, status: "fail", kind: "gate", excerpt: `G-SAST (the project's committed Semgrep rules):\n${errors.slice(0, 12).map((r) => `- ${r.path}:${r.start?.line ?? "?"} ${r.check_id}: ${String(r.extra?.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
