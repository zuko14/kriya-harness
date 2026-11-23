import { defineTool } from "@deepseek-ai/dsh-tools"

// Harness 2.0 W0 spikes (Kriya-Tavi docs/kriya-harness/upgrade_2.0/IMPLEMENTATION_PLAN.md):
// S1 — does a spawn child with agentOptions.model run on that tier alias?
// S2 — may a child spawn from inside a tool call (its own parent vs the head),
//      and does a tool mask set before startActivation apply to the new child?
// Loaded only by tests/workforce/spike-w0.test.js through a test profile's own
// cordis.patch.yml; never in bundle/cordis.patch.yml.

export const name = "kriya-spike-w0"
export const inject = ["tools"]

const OBJECT = { schema: { type: "object", additionalProperties: true } }

export async function apply(ctx) {
  let head = null
  const masks = new Map()
  ctx.on("agent/created", ({ agent }) => {
    for (const [parent, deny] of masks) if (ctx.get("agents")?.isOwnedBy(agent.id, parent)) agent.ctx.tools.restrict({ deny })
  })
  ctx.tools.register(
    defineTool({
      name: "spike_delegate",
      description: "Test only: run a prompt in a fresh spawn child.",
      parameters: {
        prompt: { type: "string", required: true, description: "The child's prompt." },
        model: { type: "string", description: "agentOptions.model for the child." },
        parent: { type: "string", description: "self (default) or head." },
        deny: { type: "string", description: "Comma-separated tool names to hide from the child." },
      },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
      presentCall: () => ({ card: "generic", title: "Spike delegate", kind: "read", rawInput: "" }),
      async execute(args, exec) {
        head ??= exec.agent
        const parent = args.parent === "head" ? head : exec.agent
        const deny = args.deny ? String(args.deny).split(",").map((s) => s.trim()).filter(Boolean) : []
        if (deny.length) masks.set(parent, deny)
        try {
          const subagents = ctx.get("subagents")
          if (!subagents) return { ok: false, error: "no subagents service" }
          const activation = await subagents.startActivation({
            provider: "spawn",
            label: "spike",
            request: {
              prompt: [{ type: "text", text: String(args.prompt) }],
              parent,
              signal: exec.signal,
              maxDepth: 1,
              ...(args.model && { agentOptions: { model: String(args.model) } }),
            },
            signal: exec.signal,
            delivery: "caller",
          })
          masks.delete(parent)
          const result = await activation.result
          return { ok: true, childId: String(activation.childId), stopReason: result?.stopReason ?? "completed" }
        } catch (error) {
          masks.delete(parent)
          return { ok: false, error: String(error?.message ?? error).slice(0, 400) }
        }
      },
    })
  )
}
