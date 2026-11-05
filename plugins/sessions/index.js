import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { kriyaHome } from "../../src/paths.js"
import { running as remoteControl } from "../remote/index.js"

// Delete session: DSH keeps sessions for good and offers archive only, so
// this removes one for it, through the seams it has: archive (which stops any
// work and closes the session), remove its folder under the Kriya home with
// its subagents' folders, then drop the archive mark. DSH's search index
// reconciles a missing log by itself. This can't be undone, so the menu asks.

export const name = "kriya-sessions"
export const inject = ["connection", "sessions"]
export const ROUTE = "/api/kriya.session.delete"

const ID = /^[\w-]{1,100}$/

/** The session's folders: sessions/<project>/<id>, the id being "session-<uuid>" (DSH's layout, pinned by tests/sessions.test.js) */
export function sessionFolders(id, root = join(kriyaHome(), "sessions")) {
  const found = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const entry of readdirSync(join(root, project.name), { withFileTypes: true }))
      if (entry.isDirectory() && entry.name === id) found.push(join(root, project.name, entry.name))
  }
  return found
}

/**
 * @param {string} id
 * @param {{ list: () => Promise<Array<{ header: any }>>, archive: (id: string) => Promise<unknown>, unarchive: (id: string) => Promise<unknown>, forget?: (id: string) => unknown, root?: string }} host
 */
export async function deleteSession(id, host) {
  if (!ID.test(id)) throw new RangeError("Which session?")
  const stored = await host.list()
  if (!stored.some((s) => s.header.id === id)) throw new RangeError("That session isn't known here.")
  // Its subagents' sessions, at any depth
  const ids = [id]
  for (let i = 0; i < ids.length; i++)
    for (const s of stored) if (s.header.origin === "subagent" && s.header.parentSession === ids[i] && !ids.includes(s.header.id)) ids.push(s.header.id)
  if (!sessionFolders(id, host.root).length) throw new RangeError("This session has no history on disk yet.")
  await host.archive(id)
  await host.forget?.(id)
  for (const one of ids) for (const dir of sessionFolders(one, host.root)) rmSync(dir, { recursive: true, force: true })
  await host.unarchive(id)
  return { deleted: ids.length }
}

export function apply(ctx) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
  const registry = () => ctx.get("workspaceRegistry")
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          const body = await request.json().catch(() => null)
          try {
            return reply(
              await deleteSession(String(body?.session ?? ""), {
                list: () => ctx.get("sessionPersistence").list(),
                archive: (id) => registry().archiveSession(id, { stopActivity: true }),
                unarchive: (id) => registry().unarchiveSession(id),
                forget: (id) => remoteControl.current?.forget(id),
              })
            )
          } catch (error) {
            if (error instanceof RangeError) return reply({ error: error.message }, 400)
            ctx.logger("kriya-sessions").warn(error)
            return reply({ error: "Kriya Harness couldn't delete this session; see the terminal for details." }, 500)
          }
        },
      }),
    "kriya-sessions: route"
  )
}
