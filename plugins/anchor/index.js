// The person's own words, kept (harness upgrade U7, HU-F-16). DSH's
// compaction replaces older history with a model-written checkpoint; the
// person's request then survives only as well as that summary keeps it
// (HU-M-06: a summary that drops a requirement loses it). The system prompt
// is never compacted (dsh-compaction-basic: the range starts after surface
// node 0), so this keeps every message the person sent in this session,
// word for word, in a late section: after DSH's own sections, so their
// cached prefix stays the same. Only `source.kind === "user"` messages: no
// tool output, reminder or runtime context gets in. Per agent, so a step's
// builder keeps its own step. Off unless kriya was started with --anchor.

export const name = "kriya-anchor"
export const inject = ["systemPrompt"]

// The most kept; the first message always stays, the oldest after it go first
export const MAX_CHARS = 8000

const textOf = (message) =>
  (Array.isArray(message.content) ? message.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()

/** The section's text for one agent's kept messages; empty when none. */
export function anchorText(kept) {
  if (!kept.length) return ""
  const [first, ...rest] = kept
  const later = [...rest]
  const size = () => [first, ...later].reduce((n, t) => n + t.length, 0)
  while (later.length && size() > MAX_CHARS) later.shift()
  const lines = [first.slice(0, MAX_CHARS), ...later].map((t, i) => `${i + 1}. ${t}`)
  return (
    "The person's own messages in this session, word for word (later ones refine earlier ones). " +
    "They outrank any summary of the conversation: if a summary leaves out a requirement here, the requirement still holds.\n\n" +
    lines.join("\n\n")
  )
}

export function apply(ctx) {
  /** @type {WeakMap<object, string[]>} */
  const kept = new WeakMap()
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message?.source?.kind !== "user") return
    const text = textOf(message)
    if (!text) return
    kept.set(agent, [...(kept.get(agent) ?? []), text])
  })
  ctx.systemPrompt.section({
    name: "kriya:anchor",
    // After DSH's environment suffix (10200), so the shared prefix is unchanged
    order: 10300,
    interpolate: false,
    text: ({ scope }) => anchorText((scope && kept.get(scope)) ?? []),
  })
}
