import { brief } from "../../src/intent.js"

// The intent router (Kriya-Tavi docs/kriya-harness/INTENT_ROUTER_AND_LONG_HORIZON.md):
// for the person's latest message, a short brief naming the skills of the
// live catalog likely to help and the tools to start with (src/intent.js),
// in a late system-prompt section, so DSH's cached prefix stays the same.
// It hides no skill or tool and adds none (KriyaBench showed hiding tools
// cost this model passes): a hint the model may ignore. The skill catalog is
// read in the background (it's asynchronous; the prompt section isn't), on
// start and on each message, so the brief uses the newest copy it has.
// Off unless kriya was started with --router (KRIYA_ROUTER=on).

export const name = "kriya-router"
export const inject = ["systemPrompt", "skills", "tools"]

const textOf = (message) =>
  (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()

/**
 * The router's state, apart from DSH so tests drive it directly.
 * @param {{ listSkills: (agent?: any) => Promise<any[]>, toolNames: (agent?: any) => Iterable<string> }} host
 */
export function router(host) {
  const requests = new WeakMap()
  const catalogs = new WeakMap()
  let shared = []
  const refresh = async (agent) => {
    try {
      const list = await host.listSkills(agent)
      if (agent) catalogs.set(agent, list)
      else shared = list
    } catch {
      // The last catalog stays
    }
  }
  return {
    refresh,
    /** agent/inbox/inserted: the person's newest message for that agent */
    onMessage({ agent, message }) {
      if (message?.source?.kind !== "user") return undefined
      const text = textOf(message)
      if (!text) return undefined
      requests.set(agent, text)
      return refresh(agent)
    },
    /** The section's text for one agent: "" before any message */
    text(agent) {
      const request = agent && requests.get(agent)
      if (!request) return ""
      let tools = []
      try {
        tools = [...host.toolNames(agent)]
      } catch {
        // No tool list: skills only
      }
      return brief(request, catalogs.get(agent) ?? shared, tools)
    },
  }
}

export async function apply(ctx) {
  const r = router({
    // The session's folder selects workspace skills (project and .agents ones)
    listSkills: (agent) => ctx.skills.list({ cwd: process.cwd(), ...(agent && { scope: agent }) }),
    toolNames: (agent) => ctx.tools.schemas(agent).map((s) => s.name),
  })
  ctx.on("agent/inbox/inserted", (event) => {
    r.onMessage(event)
  })
  ctx.systemPrompt.section({
    name: "kriya:router",
    // After DSH's suffix and the loop state, before the anchor
    order: 10260,
    interpolate: false,
    text: ({ scope }) => r.text(scope),
  })
  // The first catalog is read before the plugin is up, so a headless run's
  // first request already has it (about 0.1 s); never more than 3 s
  await Promise.race([r.refresh(), new Promise((done) => setTimeout(done, 3000).unref?.())])
}
