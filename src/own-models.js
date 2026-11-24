import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { kriyaHome } from "./paths.js"

// Own models (Kriya-Tavi docs/kriya-harness/OWN_MODELS.md): the person's own
// API keys for OpenAI-compatible providers, and their own orchestration (head
// and worker from Kriya's tiers, their own models and the S-1 local model).
// Keys live only in ~/.kriya/own-models.json (mode 600) and in the launcher's
// memory for the relay. They never go to Kriya, a log, the Web UI (last four
// characters only), DSH's process (hashes only, for redaction) or a model.

export class OwnModelsError extends Error {}

export const PROVIDERS = [
  { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", keys: "https://openrouter.ai/settings/keys" },
  { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", keys: "https://platform.openai.com/api-keys" },
  { id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com/v1", keys: "https://platform.deepseek.com/api_keys" },
  { id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1", keys: "https://console.groq.com/keys" },
  { id: "together", name: "Together AI", url: "https://api.together.xyz/v1", keys: "https://api.together.xyz/settings/api-keys" },
  { id: "mistral", name: "Mistral", url: "https://api.mistral.ai/v1", keys: "https://console.mistral.ai/api-keys" },
  { id: "custom", name: "Custom (OpenAI-compatible)", url: null, keys: null },
]

export const KEY = /^[\x21-\x7e]{8,400}$/
export const MODEL = /^[\w.:\/@+-]{1,120}$/
export const MAX_MODELS = 12
const TIERS = ["balanced", "budget", "escalation"]
export const DEFAULT_CONTEXT = 131_072
const clampContext = (n) => Math.min(2_000_000, Math.max(16_384, Number.isSafeInteger(n) ? n : DEFAULT_CONTEXT))

export const ownFile = (home = kriyaHome()) => join(home, "own-models.json")

const empty = () => ({ version: 1, keys: {}, models: [], orchestra: null })

/** The stored setup; an empty one when the file is missing or broken */
export function readOwn(file = ownFile()) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"))
    return {
      version: 1,
      keys: v.keys && typeof v.keys === "object" ? Object.fromEntries(Object.entries(v.keys).filter(([p, k]) => PROVIDERS.some((x) => x.id === p) && typeof k?.key === "string" && KEY.test(k.key))) : {},
      models: Array.isArray(v.models) ? v.models.filter((m) => typeof m?.id === "string" && MODEL.test(m.model ?? "") && v.keys?.[m.provider]).slice(0, MAX_MODELS) : [],
      orchestra: v.orchestra && typeof v.orchestra.head === "string" && typeof v.orchestra.worker === "string" ? { head: v.orchestra.head, worker: v.orchestra.worker } : null,
    }
  } catch {
    return empty()
  }
}

function write(state, file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return state
}

/** A custom endpoint: https only, no credentials in the address */
export function customUrl(value) {
  let url
  try {
    url = new URL(String(value ?? "").trim())
  } catch {
    throw new OwnModelsError("That isn't an address. A custom provider is an https URL ending at its API, e.g. https://api.example.com/v1.")
  }
  if (url.protocol !== "https:") throw new OwnModelsError("A custom provider must use https. For a model on this computer, use --local-model.")
  if (url.username || url.password || url.search || url.hash) throw new OwnModelsError("Put the key in the key field, not in the address.")
  return url.href.replace(/\/+$/, "")
}

export const providerUrl = (provider, stored) => PROVIDERS.find((p) => p.id === provider)?.url ?? stored?.url ?? null

export function saveKey(provider, key, url, file = ownFile()) {
  if (!PROVIDERS.some((p) => p.id === provider)) throw new OwnModelsError("Kriya doesn't know that provider.")
  const k = String(key ?? "").trim()
  if (!KEY.test(k)) throw new OwnModelsError("That doesn't look like an API key (8 to 400 characters, no spaces).")
  const state = readOwn(file)
  state.keys[provider] = { key: k, ...(provider === "custom" && { url: customUrl(url) }) }
  return write(state, file)
}

/** Removes a provider's key, its models, and an orchestration that used them */
export function removeKey(provider, file = ownFile()) {
  const state = readOwn(file)
  delete state.keys[provider]
  const gone = new Set(state.models.filter((m) => m.provider === provider).map((m) => m.id))
  state.models = state.models.filter((m) => !gone.has(m.id))
  if (state.orchestra && (gone.has(state.orchestra.head) || gone.has(state.orchestra.worker))) state.orchestra = null
  return write(state, file)
}

export function addModel(provider, model, contextWindow, file = ownFile()) {
  const state = readOwn(file)
  if (!state.keys[provider]) throw new OwnModelsError("Add that provider's key first.")
  if (!MODEL.test(String(model ?? ""))) throw new OwnModelsError("That isn't a model id.")
  if (state.models.some((m) => m.provider === provider && m.model === model)) return state
  if (state.models.length >= MAX_MODELS) throw new OwnModelsError(`At most ${MAX_MODELS} of your own models; remove one first.`)
  const n = Math.max(0, ...state.models.map((m) => Number(/-(\d+)$/.exec(m.id)?.[1] ?? 0))) + 1
  state.models.push({ id: `own-${n}`, provider, model, contextWindow: clampContext(contextWindow) })
  return write(state, file)
}

export function removeModel(id, file = ownFile()) {
  const state = readOwn(file)
  state.models = state.models.filter((m) => m.id !== id)
  if (state.orchestra && (state.orchestra.head === id || state.orchestra.worker === id)) state.orchestra = null
  return write(state, file)
}

/** The person's orchestration: head and worker, each a Kriya tier, one of their models, or "local"; null clears it */
export function setOrchestra(choice, file = ownFile()) {
  const state = readOwn(file)
  if (choice === null) return write({ ...state, orchestra: null }, file)
  const ok = (id) => TIERS.includes(id) || id === "local" || state.models.some((m) => m.id === id)
  if (!ok(choice?.head) || !ok(choice?.worker)) throw new OwnModelsError("Choose the head and the worker from the lists.")
  if (choice.head === choice.worker) throw new OwnModelsError("The head and the worker must be different models.")
  if (choice.head === "local") throw new OwnModelsError("The local model builds; the head plans, so choose a stronger model for it.")
  return write({ ...state, orchestra: { head: choice.head, worker: choice.worker } }, file)
}

// Short in the model picker: "Custom", not "Custom (OpenAI-compatible)"
const label = (m) => `${m.provider === "custom" ? "Custom" : (PROVIDERS.find((p) => p.id === m.provider)?.name ?? m.provider)} · ${m.model}`.slice(0, 80)

/** What the Web UI may see: no key, only its last four characters */
export function publicView(file = ownFile()) {
  const s = readOwn(file)
  return {
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, keysUrl: p.keys, saved: Boolean(s.keys[p.id]), ...(s.keys[p.id] && { last4: s.keys[p.id].key.slice(-4) }), ...(p.id === "custom" && s.keys.custom?.url && { url: s.keys.custom.url }) })),
    models: s.models.map((m) => ({ id: m.id, provider: m.provider, model: m.model, name: label(m), contextWindow: m.contextWindow })),
    orchestra: s.orchestra,
  }
}

/** The provider's models (GET <url>/models with the person's key), with context windows where the provider says */
export async function listProviderModels(provider, file = ownFile(), fetchImpl = fetch) {
  const s = readOwn(file)
  const stored = s.keys[provider]
  if (!stored) throw new OwnModelsError("Add that provider's key first.")
  const url = providerUrl(provider, stored)
  let answer
  try {
    answer = await fetchImpl(`${url}/models`, { headers: { authorization: `Bearer ${stored.key}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error" })
  } catch {
    throw new OwnModelsError(`Couldn't reach ${new URL(url).host}.`)
  }
  if (answer.status === 401 || answer.status === 403) throw new OwnModelsError("The provider refused that key. Check it and save it again.")
  if (!answer.ok) throw new OwnModelsError(`The provider answered ${answer.status}.`)
  const body = await answer.json().catch(() => ({}))
  const list = Array.isArray(body?.data) ? body.data : []
  return list
    .filter((m) => typeof m?.id === "string" && MODEL.test(m.id))
    .map((m) => ({ id: m.id, ...(Number.isSafeInteger(m.context_length) && { contextWindow: m.context_length }) }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 2000)
}

/** sha256 of each saved key: DSH's redactor gets these, never a key */
export const keyHashes = (file = ownFile()) => Object.values(readOwn(file).keys).map((k) => createHash("sha256").update(k.key).digest("hex"))

/**
 * What a launch uses, only with the owner's harness.ownModels: the models the
 * picker lists (no key, no address), the relay's routes (with keys, launcher
 * memory only) and the person's orchestration when every part of it is usable.
 * @param {{ allowed: string[], local?: boolean }} opts
 */
export function launchOwn(file = ownFile(), { allowed = TIERS, local = false } = {}) {
  const s = readOwn(file)
  const models = s.models.map((m) => ({ id: m.id, name: label(m), contextWindow: clampContext(m.contextWindow) }))
  const routes = Object.fromEntries(s.models.map((m) => [m.id, { url: providerUrl(m.provider, s.keys[m.provider]), model: m.model, key: s.keys[m.provider].key, provider: m.provider }]))
  const usable = (id) => allowed.includes(id) || Boolean(routes[id]) || (id === "local" && local)
  const orchestra = s.orchestra && usable(s.orchestra.head) && usable(s.orchestra.worker) ? s.orchestra : undefined
  return { models, routes, ...(orchestra && { orchestra }), hashes: keyHashes(file) }
}
