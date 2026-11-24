import { createHash } from "node:crypto"

// Own models (Kriya-Tavi docs/kriya-harness/OWN_MODELS.md): the person's API
// keys never reach a model. DSH's sandbox limits writes, not reads, so a tool
// could print ~/.kriya/own-models.json. Two layers:
// - every tool result passes through here last: any word whose sha256 is one
//   of the saved keys' is replaced before the model sees it. This process holds
//   only the hashes (KRIYA_KEY_HASHES, from the launcher), never a key;
// - a tool call that names the key file is refused.
// No saved key, no hashes: this registers nothing.

export const name = "kriya-keyguard"
export const inject = ["tools"]

export const REDACTED = "[redacted: your API key]"
export const KEY_FILE = "own-models.json"
const WORD = /[\x21-\x7e]{8,400}/g
const STRIP = /^["'`([{<]+|["'`)\]}>,;:.]+$/g
const MAX_SCAN = 4 * 1024 * 1024

const sha = (text) => createHash("sha256").update(text).digest("hex")

/** The text with every saved key replaced, found by hash only */
export function redactKeys(text, hashes) {
  if (!hashes.size || typeof text !== "string" || !text) return text
  const scanned = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
  const out = scanned.replace(WORD, (word) => {
    if (hashes.has(sha(word))) return REDACTED
    // A key in quotes, brackets or after `=`/`:` (KEY=sk-…, "sk-…",)
    const parts = word.split(/[=:]/)
    let changed = false
    const fixed = parts.map((p) => {
      const bare = p.replace(STRIP, "")
      if (bare.length >= 8 && hashes.has(sha(bare))) {
        changed = true
        return p.replace(bare, REDACTED)
      }
      return p
    })
    return changed ? fixed.join(word.match(/[=:]/)?.[0] ?? "") : word
  })
  return text.length > MAX_SCAN ? `${out}${text.slice(MAX_SCAN)}` : out
}

/** tools/post-execute (outermost): the model-facing content, keys replaced */
export function redactHook(hashes) {
  return async (_exec, result, next) => {
    const decision = await next()
    if (decision?.kind !== "accept") return decision
    if (Object.hasOwn(decision, "value")) {
      const text = JSON.stringify(decision.value)
      const clean = redactKeys(text, hashes)
      return clean === text ? decision : { kind: "accept", content: [{ type: "text", text: clean }], ...(decision.additionalContexts && { additionalContexts: decision.additionalContexts }) }
    }
    const source = decision.content ?? result.content ?? []
    let changed = false
    const content = source.map((block) => {
      if (block?.type !== "text") return block
      const text = redactKeys(block.text, hashes)
      if (text !== block.text) changed = true
      return text === block.text ? block : { ...block, text }
    })
    return changed ? { ...decision, content } : decision
  }
}

/** A tool call that names the key file: refused */
export const fileGuard = (exec) => (JSON.stringify(exec?.arguments ?? "").includes(KEY_FILE) ? "Kriya keeps your API keys out of the agent's reach: no tool reads or changes that file." : undefined)

export function apply(ctx) {
  const hashes = new Set(String(process.env.KRIYA_KEY_HASHES ?? "").split(",").filter((h) => /^[0-9a-f]{64}$/.test(h)))
  if (!hashes.size) return
  // First in line, so it wraps every other listener and sees the final result
  ctx.on("tools/post-execute", redactHook(hashes), true)
  ctx.tools.guard(fileGuard)
}
