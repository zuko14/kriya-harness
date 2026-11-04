import { planStatus } from "../../src/loop.js"
import { projectRoot } from "../../src/skill-switches.js"
import { confirmCheck, confirmedCheck, currentVerdict, discoverChecks, readProgress } from "../../src/verify.js"
import { ChangesError } from "../../src/changes.js"

// The Progress tab, node half: one read-only route inside Connection's
// fence (as plugins/changes). For one session, what the Kriya loop recorded
// (src/verify.js, src/loop.js): the goal and plan, each step's status and
// attempts, every check run with its exit code and failure class, and the
// verdict against the files as they are now. All of it comes from verified
// runs the harness made, never from what the model wrote.

export const name = "kriya-progress"
export const inject = ["connection", "sessions"]

export const ROUTE = "/api/kriya.progress"
// The person confirms one of the checks the harness found (as `kriya verify use <number>`)
export const CHECK_ROUTE = "/api/kriya.progress.check"
const SUGGESTIONS = 5
const RUNS = 30

/** @param {{ folderOf: (id: string) => Promise<string | undefined>, verdictOf?: typeof currentVerdict }} host */
export function handler({ folderOf, verdictOf = currentVerdict }) {
  return async (request) => {
    const id = new URL(request.url).searchParams.get("session")
    if (!id || id.length > 200) throw new ChangesError("Which session?")
    const cwd = await folderOf(id)
    if (!cwd) throw new ChangesError("That session isn't known here.")
    const check = confirmedCheck(cwd)
    let progress
    try {
      progress = readProgress(projectRoot(cwd), id)
    } catch {
      // A session id that can't name a progress file has no progress
      progress = { runs: [] }
    }
    const verdict = progress.runs.length ? await verdictOf(cwd, id) : { status: "not checked", steps: [] }
    const plan = progress.plan
      ? { goal: progress.plan.goal, at: progress.plan.at, steps: planStatus(cwd, id).map((s, i) => ({ ...s, doneWhen: progress.plan.steps[i].doneWhen, files: progress.plan.steps[i].files })) }
      : null
    return {
      check: check ? { command: check.command, source: check.source ?? "kriya verify use" } : null,
      ...(!check && { suggestions: discoverChecks(cwd).slice(0, SUGGESTIONS).map((s) => ({ command: s.command, source: s.source })) }),
      plan,
      earlierPlans: progress.earlier?.length ?? 0,
      verdict: { status: verdict.status, ...(verdict.stale && { stale: true }), ...(verdict.touched && { touched: verdict.touched }) },
      runs: progress.runs
        .slice(-RUNS)
        .reverse()
        .map((r) => ({ at: r.at, step: r.step, status: r.status, exitCode: r.exitCode ?? null, timedOut: Boolean(r.timedOut), durationMs: r.durationMs, ...(r.kind && { kind: r.kind }), ...(r.weakened && { weakened: r.weakened }) })),
    }
  }
}

/**
 * The person's one click in the Progress tab: confirm one of the checks the
 * harness discovered for the session's folder. Only a discovered command is
 * accepted (a typed one stays `kriya verify use` in a terminal), and only
 * from the Web UI, inside Connection's fence; no agent tool reaches it.
 * @param {{ folderOf: (id: string) => Promise<string | undefined> }} host
 */
export function checkHandler({ folderOf }) {
  return async (request) => {
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) throw new ChangesError("Send JSON.")
    const body = await request.json().catch(() => null)
    const id = typeof body?.session === "string" ? body.session : ""
    if (!id || id.length > 200) throw new ChangesError("Which session?")
    const cwd = await folderOf(id)
    if (!cwd) throw new ChangesError("That session isn't known here.")
    const found = discoverChecks(cwd).slice(0, SUGGESTIONS).find((s) => s.command === body?.command)
    if (!found) throw new ChangesError("That isn't one of the checks found for this project; use kriya verify use in a terminal.")
    const { command } = confirmCheck(cwd, found.command)
    return { check: { command, source: "kriya verify use" } }
  }
}

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

export async function answer(route, request, log = () => {}) {
  try {
    return reply(await route(request))
  } catch (error) {
    if (error instanceof ChangesError) return reply({ error: error.message }, 400)
    log(error)
    return reply({ error: "Kriya couldn't read this session's progress; see the terminal for details." }, 500)
  }
}

export function apply(ctx) {
  const folderOf = async (id) => {
    const live = ctx.sessions.get(id)?.header
    const stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(id) : undefined
    return (live ?? stored?.header)?.cwd
  }
  const route = handler({ folderOf })
  const log = (error) => ctx.logger("kriya-progress").warn(error)
  ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE, methods: ["GET"], requestBody: "buffered", fetch: (request) => answer(route, request, log) }))
  const confirm = checkHandler({ folderOf })
  ctx.effect(() => ctx.connection.fetch.register({ path: CHECK_ROUTE, methods: ["POST"], requestBody: "buffered", fetch: (request) => answer(confirm, request, log) }))
}
