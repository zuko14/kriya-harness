import { ChangesError, fileDiff, listChanges } from "../../src/changes.js"

// The Changes tab, node half: routes on DSH's shared /api channel, inside
// Connection's fence (Host/Origin checks, the signed browser cookie, owner
// Peers only), as plugins/skills registers its own. The browser names a
// Session, never a folder: its folder comes from the Session's header, the
// way dsh-api-workspace-files resolves one, and a diff is only produced for a
// file git lists as changed there.

export const name = "kriya-changes"
export const inject = ["connection", "sessions"]

export const ROUTES = {
  list: "/api/kriya.changes",
  diff: "/api/kriya.changes.diff",
}

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

/**
 * The route handlers, separate from DSH so tests call them directly.
 * @param {(sessionId: string) => Promise<string | undefined>} folderOf a Session's folder
 * @param {(sessionId: string) => Promise<number | undefined>} [startOf] when it began (ms)
 */
export function handlers(folderOf, startOf = async () => undefined) {
  const folder = async (request) => {
    const id = new URL(request.url).searchParams.get("session")
    if (!id || id.length > 200) throw new ChangesError("Which session?")
    const cwd = await folderOf(id)
    if (!cwd) throw new ChangesError("That session isn't known here.")
    return { cwd, id, since: await startOf(id) }
  }
  // base and now are tree ids the diff route uses; the browser doesn't need them
  const shown = ({ base, now, ...rest }) => rest
  return {
    [ROUTES.list]: async (request) => {
      const { cwd, id, since } = await folder(request)
      return shown(await listChanges(cwd, id, since))
    },
    [ROUTES.diff]: async (request) => {
      const { cwd, id, since } = await folder(request)
      return fileDiff(cwd, new URL(request.url).searchParams.get("path"), id, since)
    },
  }
}

/** Runs one handler: a ChangesError is the person's to fix (400), anything else is ours (500). */
export async function answer(handler, request, log = () => {}) {
  try {
    return reply(await handler(request))
  } catch (error) {
    if (error instanceof ChangesError) return reply({ error: error.message }, 400)
    log(error)
    return reply({ error: "Kriya couldn't read the changes; see the terminal for details." }, 500)
  }
}

export function apply(ctx) {
  // A live Session's header, else the stored one (a Session not open now)
  const headerOf = async (id) => {
    const live = ctx.sessions.get(id)?.header
    const stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(id) : undefined
    return live ?? stored?.header
  }
  const table = handlers(
    async (id) => (await headerOf(id))?.cwd,
    async (id) => (await headerOf(id))?.createdAt
  )
  const log = (error) => ctx.logger("kriya-changes").warn(error)
  for (const [path, handler] of Object.entries(table)) {
    ctx.effect(() =>
      ctx.connection.fetch.register({ path, methods: ["GET"], requestBody: "buffered", fetch: (request) => answer(handler, request, log) })
    )
  }
}
