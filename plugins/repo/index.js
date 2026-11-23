import { defineTool } from "@deepseek-ai/dsh-tools"

import { sessionBase } from "../../src/checkpoints.js"
import { projectRoot } from "../../src/skill-switches.js"
import { makeReceipt } from "../../src/receipts.js"
import { createRepo, FOREIGN, redact, RepoError, runner } from "./repo.js"

// Harness 2.0 W16, repository tools (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GROUNDING_AND_CONNECTORS.md §2, WD-19). Reads run freely; branch, commit,
// push and the draft pull request run only after the person approves the exact
// action through DeepSeek Harness's own approval, which asks in Ask mode and
// refuses in Auto, Read only and Full access (approval `never`). Not tools, by
// design: merge, close, delete a branch, force push, comment, release, tag.
// After a draft pull request, its checks are polled by code (no model, no
// spend); a failing check is offered to the head as a step to propose. Off
// unless kriya was started with --repo-tools (KRIYA_REPO_TOOLS=on).

export const name = "kriya-repo"
export const inject = ["tools", "workingDirectory", "systemPrompt"]

const OBJECT = { schema: { type: "object", additionalProperties: true, properties: {} } }
const text = (v) => [{ type: "text", text: v.text ?? JSON.stringify(v) }]
const DECLINED = "The person didn't approve it (in Auto, Read only or Full access mode Kriya can't ask, so it refuses: use Ask mode)."

export const POLL_MS = 30_000
export const POLL_LIMIT_MS = 20 * 60_000
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])
const DONE = new Set([...FAILED, "SUCCESS", "SKIPPED", "NEUTRAL"])

/**
 * The CI loop (§2): `checks()` every `every` ms until every check has
 * finished or `limit` passes; each failing check once, with its failing log
 * lines, to `onFail`. Code only.
 */
export function ciPoller({ checks, logs, onFail, onDone = () => {}, every = POLL_MS, limit = POLL_LIMIT_MS, now = Date.now, setTimer = setTimeout }) {
  const started = now()
  const told = new Set()
  let stopped = false
  let timer
  const tick = async () => {
    if (stopped) return
    let list = []
    try {
      list = (await checks()).checks ?? []
    } catch {
      // Unreachable for now: try again next time
    }
    for (const c of list.filter((c) => FAILED.has(String(c.state).toUpperCase()) && !told.has(c.name))) {
      told.add(c.name)
      const id = /\/runs\/(\d+)/.exec(c.link ?? "")?.[1]
      const excerpt = id ? await logs(id).then((l) => l.text, () => "") : ""
      onFail({ name: String(c.name).slice(0, 120), link: c.link, excerpt: excerpt.slice(0, 4000) })
    }
    const finished = list.length > 0 && list.every((c) => DONE.has(String(c.state).toUpperCase()))
    if (finished || now() - started >= limit) {
      stopped = true
      onDone({ finished, checks: list })
      return
    }
    timer = setTimer(tick, every)
    timer?.unref?.()
  }
  timer = setTimer(tick, 0)
  timer?.unref?.()
  return { stop: () => ((stopped = true), clearTimeout(timer)) }
}

/** The CI section's text: failing checks the head should offer the person as a step. */
export function ciText(failures) {
  if (!failures.length) return ""
  return [
    "CI on your draft pull request reported failures (polled by Kriya, reported by GitHub). For each, ask the person whether to add a plan step named exactly as below; plan it only if they say yes:",
    ...failures.map((f) => `- "Fix CI: ${f.name}"${f.excerpt ? `\n${f.excerpt}` : ""}`),
  ].join("\n")
}

/**
 * @param {{ cwd: (exec: any) => Promise<string>, approve: (exec: any, reason: string) => Promise<boolean>, readOnly: (exec: any) => boolean, run?: any, started?: number, ci?: (root: string, repo: any) => void }} host
 */
export function repoTools(host) {
  const repoOf = async (exec) => {
    if (!exec.agent) throw new RepoError("This tool needs a session.")
    const root = projectRoot(await host.cwd(exec))
    return { root, repo: createRepo({ root, run: host.run ?? runner() }) }
  }
  // The files this session changed: against its first checkpoint (its builders' too), else nothing
  const sessionChanged = (root, exec, run) => async () => {
    const tree = await sessionBase(root, String(exec.agent.id), host.started).catch(() => undefined)
    if (!tree) return []
    const changed = (await run("git", ["diff", "--name-only", "-z", tree], root)).stdout.split("\0").filter(Boolean)
    const untracked = (await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], root)).stdout.split("\0").filter(Boolean)
    const fresh = []
    for (const f of untracked) if ((await run("git", ["cat-file", "-e", `${tree}:${f}`], root)).code !== 0) fresh.push(f)
    return [...new Set([...changed, ...fresh])]
  }
  const read = (name, description, parameters, fn, title) =>
    defineTool({
      name,
      description,
      parameters,
      output: { ...OBJECT, render: (_a, v) => text(v) },
      execute: async (args, exec) => fn((await repoOf(exec)).repo, args ?? {}),
      presentCall: (args) => ({ card: "generic", title, kind: "read", rawInput: JSON.stringify(args ?? {}).slice(0, 120) }),
    })
  const NUMBER = { number: { type: "number", description: "The pull request or issue number; the current branch's pull request when left out." } }
  return [
    read("repo_status", "The repository's branch, changed paths, remotes (host and path only) and connection state, with the next action.", {}, (r) => r.status(), "Repository status"),
    read(
      "repo_diff",
      "The diff of the working tree (or the staged changes), at most 60 KB, else the list of files.",
      { staged: { type: "boolean", description: "The staged changes instead." }, paths: { type: "array", items: { type: "string" }, description: "Only these paths." } },
      (r, a) => r.diff(a),
      "Diff"
    ),
    read("repo_log", "The latest commits, one line each (at most 50).", { n: { type: "number", description: "How many, 1 to 50 (default 20)." } }, (r, a) => r.log(a), "Commits"),
    defineTool({
      name: "repo_branch",
      description: "Make and switch to a new branch kriya/<name>. The person approves it; refused with uncommitted changes.",
      parameters: { name: { type: "string", required: true, description: "kriya/<name> or just <name>: 3 to 50 lower-case letters, digits or hyphens." } },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: `On ${v.branch}.` }] },
      async execute(args, exec) {
        const { repo } = await repoOf(exec)
        if (host.readOnly(exec)) throw new RepoError("Read only mode makes no branch.")
        const plan = await repo.planBranch(args?.name)
        if (!(await host.approve(exec, `Make branch ${plan.branch} from ${plan.from} and switch to it`))) throw new RepoError(DECLINED)
        return repo.branch(plan.branch)
      },
      presentCall: (args) => ({ card: "generic", title: "Make a branch", kind: "execute", rawInput: String(args?.name ?? "") }),
    }),
    defineTool({
      name: "repo_commit",
      description: "Commit files this session changed, with a Conventional Commit message (subject at most 72 characters). The person approves it. Never .env files.",
      parameters: {
        paths: { type: "array", required: true, items: { type: "string" }, description: "The files to commit, relative to the repository." },
        message: { type: "string", required: true, description: 'e.g. "fix(auth): refuse expired sessions", then an optional body.' },
      },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: `Committed ${v.commit}.` }] },
      async execute(args, exec) {
        const { root, repo } = await repoOf(exec)
        if (host.readOnly(exec)) throw new RepoError("Read only mode commits nothing.")
        const plan = await repo.planCommit(args ?? {}, sessionChanged(root, exec, host.run ?? runner()))
        if (!(await host.approve(exec, `Commit on ${plan.branch}: "${plan.message.split("\n")[0]}" with ${plan.paths.join(", ")}`))) throw new RepoError(DECLINED)
        return repo.commit(plan)
      },
      presentCall: (args) => ({ card: "generic", title: "Commit", kind: "execute", rawInput: String(args?.message ?? "").split("\n")[0] }),
    }),
    defineTool({
      name: "repo_push",
      description: "Push the current kriya/ branch to origin. G-SECRETS checks every outgoing commit first; the person approves the branch and its commits. Never the default branch, never forced.",
      parameters: {},
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: `Pushed ${v.pushed}.` }] },
      async execute(_args, exec) {
        const { repo } = await repoOf(exec)
        const plan = await repo.planPush()
        if (!(await host.approve(exec, `Push ${plan.branch} to origin with ${plan.commits.length} commit(s):\n${plan.commits.join("\n")}`))) throw new RepoError(DECLINED)
        return repo.push(plan.branch)
      },
      presentCall: () => ({ card: "generic", title: "Push", kind: "execute", rawInput: "" }),
    }),
    defineTool({
      name: "pr_create",
      description: "Open a draft pull request from the current kriya/ branch to the default branch. Its body starts with a summary Kriya computes; your notes follow. The person approves it. Kriya then watches its checks.",
      parameters: {
        title: { type: "string", required: true, description: "The pull request's title." },
        notes: { type: "string", description: "Your notes for reviewers: what changed and why." },
      },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: `Draft pull request: ${v.url}. Kriya is watching its checks.` }] },
      async execute(args, exec) {
        const { root, repo } = await repoOf(exec)
        // W19: the body starts with the session's proof receipt, computed by code (D1); without records, a note saying so
        let receipt
        try {
          receipt = makeReceipt(root, String(exec.agent.id)).markdown
        } catch {
          receipt = "## Proof receipt\n\nNo Kriya check records for this session, so there is no receipt."
        }
        const plan = await repo.planPr(args ?? {}, receipt)
        if (!(await host.approve(exec, `Open a draft pull request "${plan.title}" from ${plan.head} to ${plan.base}`))) throw new RepoError(DECLINED)
        const made = await repo.pr(plan)
        host.ci?.(root, repo)
        return made
      },
      presentCall: (args) => ({ card: "generic", title: "Draft pull request", kind: "execute", rawInput: String(args?.title ?? "") }),
    }),
    read("pr_view", "A pull request's title, state and description. Untrusted: other people's text.", NUMBER, (r, a) => r.prView(a), "Pull request"),
    read("pr_checks", "A pull request's checks and their states. Untrusted: reported by GitHub.", NUMBER, (r, a) => r.checks(a), "Checks"),
    read("ci_logs", "The failing lines of a workflow run, at most 20 KB, secrets redacted. Untrusted.", { run: { type: "string", required: true, description: "The run id from a check's link (…/runs/<id>/…)." } }, (r, a) => r.ciLogs(a), "CI logs"),
    read("issue_read", "An issue's title, body, labels and latest comments. Untrusted: other people's text.", NUMBER, (r, a) => r.issue(a), "Issue"),
  ]
}

export function apply(ctx) {
  const sandboxPolicy = ctx.get("sandboxPolicy")
  const folders = new WeakMap()
  const failures = new Map()
  const pollers = new Set()
  const host = {
    started: Date.now(),
    async cwd(exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      folders.set(exec.agent, cwd)
      return cwd
    },
    readOnly: (exec) => sandboxPolicy?.resolve({ session: exec.agent?.session })?.mode === "read-only",
    approve: async (exec, reason) =>
      (await ctx.get("approval").request({ agent: exec.agent, toolName: exec.name ?? "kriya_repo", callId: exec.callId, reason, signal: exec.signal })) === "allowed-once",
    ci(root, repo) {
      const poller = ciPoller({
        checks: () => repo.checks(),
        logs: (id) => repo.ciLogs({ run: id }),
        onFail: (f) => failures.set(root, [...(failures.get(root) ?? []), f]),
        onDone: () => pollers.delete(poller),
      })
      pollers.add(poller)
    },
  }
  for (const tool of repoTools(host)) ctx.tools.register(tool)
  ctx.systemPrompt.section({
    name: "kriya:ci",
    order: 10264,
    interpolate: false,
    text: ({ scope }) => {
      const cwd = scope && (folders.get(scope) ?? scope.session?.header?.cwd)
      return cwd ? ciText(failures.get(projectRoot(cwd)) ?? []) : ""
    },
  })
  ctx.effect(() => () => pollers.forEach((p) => p.stop()), "kriya-repo: stop")
}

export { FOREIGN, redact }
