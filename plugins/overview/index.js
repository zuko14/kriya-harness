import { platform } from "node:os"

import { ChangesError, listChanges } from "../../src/changes.js"
import { jobRows, meterFigures, originOf } from "../../src/overview.js"
import { readDevice } from "../../src/store.js"

// The Overview tab, node half: one read-only route on DSH's shared /api
// channel, inside Connection's fence (as plugins/changes). For one session:
// where it runs (this computer, the folder, the repository and branch), the
// token meter's context and usage figures (live sessions only), the files
// changed against HEAD, its background jobs, and what it is connected to.
// It reads; it never changes anything, and returns no credential or token.

export const name = "kriya-overview"
export const inject = ["connection", "sessions"]

export const ROUTE = "/api/kriya.overview"
const FILES = 8
const OS = { darwin: "macOS", linux: "Linux", win32: "Windows" }

/**
 * The route handler, separate from DSH so tests call it directly.
 * @param {{ folderOf: (id: string) => Promise<string | undefined>, live: (id: string) => any, meter: (session: any) => object | undefined, jobs: (id: string) => any[], kriyaUrl: () => string | undefined }} host
 */
export function handler(host) {
  return async (request) => {
    const id = new URL(request.url).searchParams.get("session")
    if (!id || id.length > 200) throw new ChangesError("Which session?")
    const cwd = await host.folderOf(id)
    if (!cwd) throw new ChangesError("That session isn't known here.")
    const changes = await listChanges(cwd)
    const session = host.live(id)
    let kriya
    try {
      const url = host.kriyaUrl()
      kriya = url ? new URL(url).host : undefined
    } catch {
      kriya = undefined
    }
    return {
      environment: {
        computer: "This computer",
        os: OS[platform()] ?? platform(),
        folder: cwd,
        git: changes.git,
        ...(changes.git && { root: changes.root, branch: changes.branch, repo: await originOf(changes.root) }),
      },
      live: Boolean(session),
      ...(session ? meterFigures(host.meter(session)) : { context: null, usage: null }),
      changes: changes.git ? { count: changes.files.length, truncated: changes.truncated, added: changes.added, deleted: changes.deleted, files: changes.files.slice(0, FILES) } : null,
      jobs: jobRows(host.jobs(id)),
      connectors: { kriya: kriya ?? null, mcp: [] },
    }
  }
}

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

/** A ChangesError is the person's to fix (400); anything else is ours (500), logged */
export async function answer(route, request, log = () => {}) {
  try {
    return reply(await route(request))
  } catch (error) {
    if (error instanceof ChangesError) return reply({ error: error.message }, 400)
    log(error)
    return reply({ error: "Kriya couldn't read this session's overview; see the terminal for details." }, 500)
  }
}

export function apply(ctx) {
  const folderOf = async (id) => {
    const live = ctx.sessions.get(id)?.header
    const stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(id) : undefined
    return (live ?? stored?.header)?.cwd
  }
  const route = handler({
    folderOf,
    live: (id) => ctx.sessions.get(id),
    // Optional services: a profile without them shows no figures, never an error
    meter: (session) => ctx.get("sessionProjections")?.snapshot(session, ["contextPressure", "tokenUsage"])?.values,
    jobs: (id) => {
      try {
        return ctx.get("jobs")?.list(id) ?? []
      } catch {
        // Not this session's to list: show none rather than fail the tab
        return []
      }
    },
    kriyaUrl: () => readDevice()?.url,
  })
  const log = (error) => ctx.logger("kriya-overview").warn(error)
  ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE, methods: ["GET"], requestBody: "buffered", fetch: (request) => answer(route, request, log) }))
}
