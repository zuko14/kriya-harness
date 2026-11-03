import { findProjects } from "../../src/projects.js"

// The Projects page, node half: one read-only route on DSH's shared /api
// channel, inside Connection's fence (Host/Origin checks, the signed browser
// cookie, owner Peers only), as the Skills page's routes are. The browser
// names nothing; it gets the list the Host finds.

export const name = "kriya-projects"
export const inject = ["connection"]

export const ROUTE = "/api/kriya.projects"

export function apply(ctx) {
  const log = ctx.logger("kriya-projects")
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: ROUTE,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: () => {
        try {
          return Response.json(findProjects(), { headers: { "cache-control": "no-store" } })
        } catch (error) {
          log.warn(error)
          return Response.json({ error: "Kriya couldn't list the projects; see the terminal for details." }, { status: 500 })
        }
      },
    })
  )
}
