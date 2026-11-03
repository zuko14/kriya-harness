import {
  copySkill,
  createSkill,
  readSkillFile,
  saveSkillFile,
  skillsPage,
  SkillsError,
  unlinkSkill,
} from "../../src/local-skills.js"
import { setSkillSwitch, SwitchError } from "../../src/skill-switches.js"

// The Skills page, node half: routes on DSH's shared /api channel, inside
// Connection's fence (Host/Origin checks, the signed browser cookie, owner
// Peers only), the way DSH's own deliverables and uploads register theirs.
// Skills are always found through the catalog of the folder the agent works
// in; the browser never names a file path.

export const name = "kriya-skills"
export const inject = ["connection"]

export const ROUTES = {
  list: "/api/kriya.skills",
  read: "/api/kriya.skill",
  save: "/api/kriya.skill.save",
  copy: "/api/kriya.skill.copy",
  create: "/api/kriya.skill.create",
  unlink: "/api/kriya.skill.unlink",
  switch: "/api/kriya.skill.switch",
}

const reply = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

async function body(request) {
  try {
    const value = await request.json()
    if (value && typeof value === "object" && !Array.isArray(value)) return value
  } catch {
    // Falls through to the plain refusal
  }
  throw new SkillsError("Send a JSON object.")
}

/**
 * The route handlers, separate from DSH so tests call them directly.
 * @param {() => string} cwd the folder the agent works in
 * @param {{ agentsHome?: string }} [roots]
 */
export function handlers(cwd, roots = {}) {
  return {
    [ROUTES.list]: () => skillsPage(cwd(), roots),
    [ROUTES.read]: (request) => readSkillFile(cwd(), new URL(request.url).searchParams.get("name"), roots),
    [ROUTES.save]: async (request) => {
      const { name, content } = await body(request)
      return saveSkillFile(cwd(), name, content, roots)
    },
    [ROUTES.copy]: async (request) => copySkill(cwd(), (await body(request)).name, roots),
    [ROUTES.create]: async (request) => {
      const { name, description } = await body(request)
      return createSkill(cwd(), name, description, roots)
    },
    [ROUTES.unlink]: async (request) => {
      const { name } = await body(request)
      unlinkSkill(typeof name === "string" ? name : "")
      return { ok: true }
    },
    // On, off for this project, or off everywhere; the agent's next step
    // gets the new catalog
    [ROUTES.switch]: async (request) => {
      const { name, state } = await body(request)
      return setSkillSwitch(cwd(), name, state)
    },
  }
}

/** Runs one handler: a SkillsError is the person's to fix (400), anything else is ours (500). */
export async function answer(handler, request, log = () => {}) {
  try {
    return reply(await handler(request))
  } catch (error) {
    if (error instanceof SkillsError || error instanceof SwitchError) return reply({ error: error.message }, 400)
    log(error)
    return reply({ error: "Kriya couldn't do that; see the terminal for details." }, 500)
  }
}

export function apply(ctx) {
  const table = handlers(() => process.cwd())
  const log = (error) => ctx.logger("kriya-skills").warn(error)
  for (const [path, handler] of Object.entries(table)) {
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path,
        methods: path === ROUTES.list || path === ROUTES.read ? ["GET"] : ["POST"],
        requestBody: "buffered",
        fetch: (request) => answer(handler, request, log),
      })
    )
  }
}
