// The Editing Studio row, node half (UX_SPEC §1): one route on DSH's shared /api
// channel, inside Connection's fence (Host and Origin checks, the signed browser
// cookie, owner peers only). It starts the Edit Host if need be and asks it, over
// its owner-only socket, for a one-time link to the Studio. The row exists only
// with KRIYA_EDIT on (bundle/cordis.patch.yml), and src/edit loads only here, lazily.

export const name = "kriya-edit"
export const inject = ["connection"]

export const ROUTE = "/api/kriya.edit.launch"

const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })

/** @param {Request} request @param {{ warn: (e: unknown) => void }} log */
export async function launch(request, log, load = () => import("../../src/edit/host/client.js")) {
  if (process.env.KRIYA_EDIT !== "on") return json({ error: "The Editing Studio is off." }, 404)
  try {
    const { ensureHost, hostCall } = await load()
    const { kriyaHome } = await import("../../src/paths.js")
    // The Host reads the device itself; it never inherits the harness's token
    const { KRIYA_DEVICE_TOKEN: _, ...env } = process.env
    await ensureHost({ env })
    // Back to this page: the Host keeps it only if it's a loopback origin
    const back = request.headers.get("origin") ?? new URL(request.url).origin
    const { url } = await hostCall(kriyaHome(), "POST", "/internal/launch", { back })
    return json({ url })
  } catch (error) {
    log.warn(error)
    return json({ error: "The Editing Studio couldn't start; see the terminal for details." }, 500)
  }
}

/**
 * While this Web UI runs, tell a running Edit Host a person is working here, so its
 * Governor keeps to one open answer (EDIT_LOOP §8). It never starts a Host.
 */
export async function ping(load = () => import("../../src/edit/host/client.js")) {
  if (process.env.KRIYA_EDIT !== "on") return false
  try {
    const { hostCall } = await load()
    const { kriyaHome } = await import("../../src/paths.js")
    await hostCall(kriyaHome(), "POST", "/internal/live")
    return true
  } catch {
    return false // no Host running: nothing to tell
  }
}

export function apply(ctx) {
  const log = ctx.logger("kriya-edit")
  ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE, methods: ["POST"], requestBody: "buffered", fetch: (request) => launch(request, log) }))
  ctx.effect(() => {
    void ping()
    const timer = setInterval(() => void ping(), 20_000)
    timer.unref?.()
    return () => clearInterval(timer)
  })
}
