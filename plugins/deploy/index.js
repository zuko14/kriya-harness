import { defineTool } from "@deepseek-ai/dsh-tools"

import { runner } from "../repo/repo.js"
import { forPerson, gDeployed, gRelease, personsOnly, productionAllowed, readRelease, readState, recordReady, recordSmoke, ReleaseError } from "../../src/release.js"
import { projectRoot } from "../../src/skill-switches.js"

// Harness 2.0 W17, deploy (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// DELIVERY_AND_STABILITY.md; WD-21, WD-22). release_check runs G-RELEASE;
// deploy_preview and deploy_production run the provider's own CLI, signed in
// by the person (no credential read), each after the person approves the
// exact provider, target, commit and command; Auto, Read only and Full access
// refuse. The deployment URL is captured from the CLI's output by code and
// must match the provider's host (or the person's confirmed domain), else no
// smoke runs. Production needs a passing release check and a passing preview
// smoke of the same commit. A guard refuses, in the agent's own shell, the
// commands that are the person's alone (WD-22) and writes them down for them.
// Off unless kriya was started with --deploy (KRIYA_DEPLOY=on).

export const name = "kriya-deploy"
export const inject = ["tools", "workingDirectory", "shell", "shellEnv"]

const OBJECT = { schema: { type: "object", additionalProperties: true, properties: {} } }
const DECLINED = "The person didn't approve it (in Auto, Read only or Full access mode Kriya can't ask, so it refuses: use Ask mode)."

/**
 * Adapters whose CLI behaviour spike S1 confirmed from the provider's own
 * documentation (2026-11-23). Vercel: "When deploying, stdout is the
 * Deployment URL" (JSON in non-interactive mode, which still contains it);
 * `--prod` for production; `--yes` skips setup questions; `vercel rollback`.
 * Netlify, Cloudflare Pages and Fly.io weren't confirmed (their pages don't
 * say how the URL is printed), so they aren't shipped.
 */
export const ADAPTERS = {
  vercel: {
    cli: "vercel",
    preview: ["deploy", "--yes"],
    production: ["deploy", "--prod", "--yes"],
    rollback: ["rollback"],
    host: /^[a-z0-9-]+\.vercel\.app$/,
  },
}

/** The deployment URL from a CLI's output: the first https URL whose host is the provider's or the confirmed domain. */
export function captureUrl(output, adapter, domain) {
  for (const m of String(output ?? "").matchAll(/https:\/\/[^\s"'<>\\]+/g)) {
    let url
    try {
      url = new URL(m[0])
    } catch {
      continue
    }
    const host = url.hostname.toLowerCase()
    if (!url.username && !url.password && (adapter.host.test(host) || (domain && host === domain))) return `https://${url.host}/`
  }
  return undefined
}

/** The guard for the agent's shells (WD-22): a reason denies the call. */
export function personsOnlyGuard(record) {
  return (exec) => {
    if (!["bash", "pwsh", "terminal", "run_code"].includes(exec?.name)) return undefined
    const args = exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {}
    const command = [args.command, args.code, args.input].find((v) => typeof v === "string")
    const why = personsOnly(command)
    if (!why) return undefined
    record?.(command, why, exec)
    return `Kriya never runs this: it ${why}. That's the person's to do; it was written down for them (kriya receipt, the release notes for this project). Tell them, and go on with the rest.`
  }
}

export function deployTools(host) {
  const run = host.runCli ?? runner()
  const git = async (root, args) => (await run("git", args, root)).stdout.trim()
  const rootOf = async (exec) => {
    if (!exec.agent) throw new ReleaseError("This tool needs a session.")
    return projectRoot(await host.cwd(exec))
  }
  const cleanCommit = async (root) => {
    if (await git(root, ["status", "--porcelain"])) throw new ReleaseError("There are uncommitted changes. A release is checked and deployed from a commit: commit first.")
    const commit = await git(root, ["rev-parse", "--verify", "-q", "HEAD"])
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new ReleaseError("No commit to release yet.")
    return commit
  }
  // The release diff: the commits since the default branch (or everything), added lines per file
  const releaseFiles = async (root) => {
    const base = (await git(root, ["merge-base", "HEAD", "origin/HEAD"])) || (await git(root, ["merge-base", "HEAD", "main"])) || "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    const text = (await run("git", ["diff", "--no-color", "--no-ext-diff", "-U0", base, "HEAD"], root)).stdout
    const files = []
    let current
    for (const line of text.split("\n")) {
      const f = /^\+\+\+ b\/(.+)$/.exec(line)
      if (f) files.push((current = { path: f[1], content: "", added: [] }))
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
      if (h && current) current.next = Number(h[1])
      else if (current && line.startsWith("+") && !line.startsWith("+++")) current.added.push({ line: current.next++, text: line.slice(1) })
    }
    return files
  }
  const adapterOf = (root) => {
    const release = readRelease(root)
    const id = release?.provider ?? "vercel"
    const adapter = ADAPTERS[id]
    if (!adapter) throw new ReleaseError(`No confirmed adapter for ${id}.`)
    return { id, adapter, release }
  }
  async function deploy(exec, target) {
    const root = await rootOf(exec)
    if (host.readOnly(exec)) throw new ReleaseError("Read only mode deploys nothing.")
    const commit = await cleanCommit(root)
    if (target === "production") {
      const allowed = productionAllowed(root, commit)
      if (!allowed.ok) throw new ReleaseError(allowed.why)
    }
    const { id, adapter, release } = adapterOf(root)
    const argv = adapter[target]
    if (!(await host.approve(exec, `Deploy ${target} with ${id}: \`${adapter.cli} ${argv.join(" ")}\` of commit ${commit.slice(0, 12)} in this project`))) throw new ReleaseError(DECLINED)
    const out = await run(adapter.cli, argv, root)
    if (out.missing) throw new ReleaseError(`The ${id} CLI isn't installed. The person installs it and signs in (${adapter.cli} login) in a terminal.`)
    if (out.code !== 0) throw new ReleaseError(`${adapter.cli} exited ${out.code}: ${String(out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`)
    const url = captureUrl(`${out.stdout}\n${out.stderr}`, adapter, release?.domain)
    if (!url) {
      recordSmoke(root, { target, commit, ok: false, url: null, note: "URL not confirmed" })
      return { target, commit, url: null, smoke: "not run: no deployment URL on the provider's host was printed, so nothing was checked" }
    }
    const smoke = await gDeployed(url, release, { fetchImpl: host.fetch })
    recordSmoke(root, { target, commit, ok: smoke.status === "pass", host: smoke.host, requests: smoke.requests })
    const result = { target, commit, url, smoke }
    if (target === "production" && smoke.status !== "pass") {
      // Offered, never automatic: the person approves the rollback; it's always written down for them
      const rollback = `${adapter.cli} ${adapter.rollback.join(" ")}`
      forPerson(root, rollback, "rolls production back after a failed smoke check")
      if (await host.approve(exec, `The production smoke check failed. Roll back with \`${rollback}\`?`)) {
        const back = await run(adapter.cli, adapter.rollback, root)
        result.rollback = back.code === 0 ? "rolled back" : `rollback failed (${back.code}); the person runs ${rollback}`
      } else result.rollback = `not run; the person can run ${rollback}`
    }
    return result
  }
  return [
    defineTool({
      name: "release_check",
      description: "Run G-RELEASE on the current commit: the confirmed production build, the confirmed production server's pages (G-UI, G-A11Y), environment variables named in .env.example, bundle budget, lockfile and licences, migrations and secrets. Ready only when every line passes.",
      parameters: {},
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: `${v.ready ? "Ready" : "Not ready"} (commit ${v.commit.slice(0, 12)}):\n${v.lines.map((l) => `${l.status === "pass" ? "✓" : l.status === "fail" ? "✗" : "–"} ${l.id}${l.detail ? `: ${l.detail}` : ""}`).join("\n")}` }] },
      async execute(_args, exec) {
        const root = await rootOf(exec)
        const commit = await cleanCommit(root)
        const result = await gRelease(root, { run: (command) => host.runCheck(exec, command, root), files: () => releaseFiles(root), commit: async () => commit, ...(host.rendered && { rendered: host.rendered }) })
        recordReady(root, result.commit, result.ready, result.lines)
        return result
      },
      presentCall: () => ({ card: "generic", title: "Release check", kind: "execute", rawInput: "" }),
    }),
    defineTool({
      name: "deploy_preview",
      description: "Deploy the current commit as a preview with the project's provider CLI (the person approves it), then check the printed URL with G-DEPLOYED.",
      parameters: {},
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
      execute: (_args, exec) => deploy(exec, "preview"),
      presentCall: () => ({ card: "generic", title: "Deploy a preview", kind: "execute", rawInput: "" }),
    }),
    defineTool({
      name: "deploy_production",
      description: "Deploy the current commit to production (only after release_check passed and a preview of the same commit passed its smoke check; the person approves it), then check the production URL. A failed check offers a rollback.",
      parameters: {},
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
      execute: (_args, exec) => deploy(exec, "production"),
      presentCall: () => ({ card: "generic", title: "Deploy to production", kind: "execute", rawInput: "" }),
    }),
    defineTool({
      name: "release_status",
      description: "The project's release records: the latest release check and smoke checks per commit, and the commands left for the person.",
      parameters: {},
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
      async execute(_args, exec) {
        const state = readState(await rootOf(exec))
        return { records: state.records.slice(-10), forPerson: state.forPerson ?? [] }
      },
      presentCall: () => ({ card: "generic", title: "Release status", kind: "read", rawInput: "" }),
    }),
  ]
}

export function apply(ctx) {
  const sandboxPolicy = ctx.get("sandboxPolicy")
  const folders = new WeakMap()
  const host = {
    async cwd(exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      folders.set(exec.agent, cwd)
      return cwd
    },
    readOnly: (exec) => sandboxPolicy?.resolve({ session: exec.agent?.session })?.mode === "read-only",
    approve: async (exec, reason) =>
      (await ctx.get("approval").request({ agent: exec.agent, toolName: exec.name ?? "kriya_deploy", callId: exec.callId, reason, signal: exec.signal })) === "allowed-once",
    // The confirmed build runs the way the person's check does: under the session's sandbox
    async runCheck(exec, command, workdir) {
      const policy = sandboxPolicy?.resolve({ session: exec.agent.session })
      const spec = ctx.shell.resolve({ command, workdir, timeoutMs: 15 * 60_000, dshEnv: ctx.shellEnv.collect(exec), ...(policy !== undefined && { sandboxPolicy: policy }), signal: exec.signal })
      const result = await (await ctx.shell.execute(spec)).result()
      return { exitCode: result.exitCode, timedOut: result.timedOut, output: [result.stdout.text, result.stderr.text].filter(Boolean).join("\n") }
    },
  }
  for (const tool of deployTools(host)) ctx.tools.register(tool)
  ctx.tools.guard(
    personsOnlyGuard((command, why, exec) => {
      try {
        const cwd = folders.get(exec.agent) ?? exec.agent?.session?.header?.cwd ?? process.cwd()
        forPerson(projectRoot(cwd), command, why)
      } catch {
        // Writing it down is best effort; the refusal stands either way
      }
    })
  )
}
