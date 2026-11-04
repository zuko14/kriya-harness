import {
  copySkill,
  createSkill,
  readSkillFile,
  saveSkillFile,
  skillsPage,
  SkillsError,
  unlinkSkill,
} from "../../src/local-skills.js"
import { offFor, setSkillSwitch, SwitchError } from "../../src/skill-switches.js"
import { kriyaSkills } from "../kriya-tools/index.js"

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

// Skills from Kriya (H7): the Kriya default skills (kriya-*, from the Kriya
// Harness team, WORKSPACE_PANEL_SKILLS_PLUGINS.md §4) and the person's
// Kriya agent's own, as rows of the same page. Read-only here; the same
// switches turn them off. A local skill of the same name wins (rank)
export const KRIYA_DEFAULTS = "Kriya default skills"
export const KRIYA_AGENT = "From your Kriya agent"

const kriyaRow = (c, off) => ({
  name: c.name,
  description: String(c.description ?? "").replace(/\s+/g, " ").trim(),
  where: c.name.startsWith("kriya-") ? KRIYA_DEFAULTS : KRIYA_AGENT,
  source: "kriya",
  path: null,
  linked: false,
  linkTarget: null,
  canCopy: false,
  editable: false,
  modelInvocable: true,
  userInvocable: true,
  version: c.locator?.version,
  state: off.has(c.name) ? `off-${off.get(c.name)}` : "on",
})

async function kriyaList(kriya) {
  const listed = await kriya.list().catch(() => [])
  return Array.isArray(listed) ? { candidates: listed, complete: true } : { candidates: listed.candidates ?? [], complete: false }
}

/** The local page with the Kriya skills first; Kriya's own unreachable is a warning, not an error */
export async function withKriya(page, kriya, off) {
  const { candidates, complete } = await kriyaList(kriya)
  const local = new Set(page.skills.map((s) => s.name))
  const rows = candidates.map((c) => kriyaRow(c, off))
  const shown = rows.filter((r) => !local.has(r.name))
  const onChars = shown.filter((r) => r.state === "on").reduce((n, r) => n + r.name.length + r.description.length, 0)
  return {
    ...page,
    skills: [...shown, ...page.skills],
    shadowed: [...rows.filter((r) => local.has(r.name)), ...page.shadowed],
    warnings: complete ? page.warnings : [...page.warnings, "Kriya isn't answering, so its skills may be out of date."],
    catalogChars: page.catalogChars + onChars,
    catalogTokens: Math.round((page.catalogChars + onChars) / 4),
  }
}

/** A Kriya skill's instructions, read-only, or undefined when it isn't one */
export async function readKriya(kriya, name, off) {
  const { candidates } = await kriyaList(kriya)
  const found = candidates.find((c) => c.name === name)
  if (!found) return undefined
  const body = await kriya.get(found)
  if (!body?.content) throw new SkillsError("Kriya didn't send this skill's instructions; try again in a moment.")
  return { ...kriyaRow(found, off), content: body.content }
}

/**
 * The route handlers, separate from DSH so tests call them directly.
 * @param {() => string} cwd the folder the agent works in
 * @param {{ agentsHome?: string }} [roots]
 * @param {{ list: Function, get: Function }} [kriya] Kriya's skill source (kriya-tools' kriyaSkills)
 */
export function handlers(cwd, roots = {}, kriya = kriyaSkills()) {
  return {
    [ROUTES.list]: async () => withKriya(await skillsPage(cwd(), roots), kriya, offFor(cwd())),
    [ROUTES.read]: async (request) => {
      const name = new URL(request.url).searchParams.get("name")
      try {
        return await readSkillFile(cwd(), name, roots)
      } catch (error) {
        // Not a local skill: maybe one of Kriya's
        const remote = error instanceof SkillsError ? await readKriya(kriya, name, offFor(cwd())) : undefined
        if (remote) return remote
        throw error
      }
    },
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
