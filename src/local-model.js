// S-1 local models (Kriya-Tavi docs/kriya-harness/LOCAL_MODELS.md; owner
// decision SI-01, 2026-11-24): with the owner's harness.localModels and
// `kriya --local-model`, a model on this computer or the person's own network
// (Ollama, LM Studio, vLLM: any OpenAI-compatible server) builds the
// orchestra's worker steps. Kriya's head still plans, reviews and takes over;
// the person stays signed in. Only loopback and private addresses: code never
// goes to a public host this way. The relay (src/gateway-proxy.js) sends the
// `local` model's requests there, without the Kriya device token.

import { isIP } from "node:net"

/** The model id DSH and the loop use for the local worker; never a Kriya tier */
export const LOCAL_WORKER = "local"

/** Where a local server usually answers: Ollama, then LM Studio */
export const KNOWN_SERVERS = [
  { name: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { name: "LM Studio", url: "http://127.0.0.1:1234/v1" },
]

export const PROBE_MS = 1500
// Ollama serves 4,096 tokens unless told otherwise (OLLAMA_CONTEXT_LENGTH); a builder needs more
export const DEFAULT_CONTEXT = 32_768
const MODEL_ID = /^[\w.:\/@+-]{1,120}$/

/** Loopback, private (RFC 1918, IPv6 ULA) or a .local name: the person's own computer or network */
export function isLocalAddress(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  if (url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".local")) return true
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (isIP(host) === 6) return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host)
  return false
}

/** The model to use: the one named (only if served), else the first "coder", else the first */
export function chooseModel(ids, wanted) {
  const served = ids.filter((id) => typeof id === "string" && MODEL_ID.test(id))
  if (wanted) return served.includes(wanted) ? wanted : null
  return served.find((id) => /coder/i.test(id)) ?? served[0] ?? null
}

/**
 * Finds the local server and its model. `url` from the person, else the known servers in turn.
 * @returns {Promise<{ url: string, model: string, server: string } | { error: string }>}
 */
export async function findLocalModel({ url, name, fetchImpl = fetch, timeoutMs = PROBE_MS } = {}) {
  const candidates = url ? [{ name: "your server", url: url.replace(/\/+$/, "") }] : KNOWN_SERVERS
  if (url && !isLocalAddress(url)) return { error: `${url} isn't on this computer or a private network; --local-model takes a loopback or private address only.` }
  for (const candidate of candidates) {
    let ids
    try {
      const answer = await fetchImpl(`${candidate.url}/models`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" })
      if (!answer.ok) continue
      const body = await answer.json()
      ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id) : []
    } catch {
      continue
    }
    const model = chooseModel(ids, name)
    if (model) return { url: candidate.url, model, server: candidate.name }
    return { error: name ? `${candidate.name} at ${candidate.url} doesn't serve ${name}.` : `${candidate.name} at ${candidate.url} has no model yet (for Ollama: ollama pull qwen2.5-coder:14b).` }
  }
  return { error: url ? `Nothing answered at ${url}.` : "No local model server is running (Ollama on port 11434 or LM Studio on 1234)." }
}

/** Takes `--local-model [url]` and `--local-model-name <name>` out of `args` into `env` */
export function localModelArgs(args, env = process.env) {
  const at = args.indexOf("--local-model")
  if (at !== -1) {
    const next = args[at + 1]
    const withUrl = typeof next === "string" && /^https?:\/\//.test(next)
    args.splice(at, withUrl ? 2 : 1)
    env.KRIYA_LOCAL_MODEL = withUrl ? next : "on"
  }
  const named = args.indexOf("--local-model-name")
  if (named !== -1) {
    env.KRIYA_LOCAL_MODEL_NAME = args[named + 1] ?? ""
    args.splice(named, 2)
  }
}

/**
 * Whether and where the local worker runs for this launch: the person asked
 * (KRIYA_LOCAL_MODEL), the owner offers it (GET /models `localModels: 1`), the
 * orchestra is on (the local model only builds), and a server answered.
 * @returns {Promise<{ local?: { url: string, model: string, server: string }, note?: string }>}
 */
export async function localWorker(env, { offered, orchestra }, find = findLocalModel) {
  const asked = env.KRIYA_LOCAL_MODEL
  if (!asked || asked === "off") return {}
  if (!offered) return { note: "local models aren't turned on for your Kriya account yet (the owner's harness.localModels); using Kriya's models." }
  if (!orchestra) return { note: "a local model builds the orchestra's worker steps, and the orchestra is off; using Kriya's models." }
  const found = await find({ url: asked === "on" ? undefined : asked, name: env.KRIYA_LOCAL_MODEL_NAME || undefined })
  if ("error" in found) return { note: `${found.error} Using Kriya's models.` }
  return {
    local: found,
    note: `${found.model} (${found.server}, ${found.url}) builds on this computer; Kriya's ${orchestra.head} plans, reviews and takes over when it's stuck.${found.server === "Ollama" ? " Give Ollama a 32k context: OLLAMA_CONTEXT_LENGTH=32768 ollama serve." : ""}`,
  }
}
