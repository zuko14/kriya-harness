import { call, KriyaError } from "./api.js"

// Own models (Kriya-Tavi docs/kriya-harness/OWN_MODELS.md): the counts of
// calls through the person's own keys (and S-1's local model), sent to Kriya
// in batches: provider, model, requests, tokens and the provider's reported
// cost. Never a prompt, an answer or a key. Kriya answering 404 means the
// owner's harness.ownModels is off: reporting stops for this run.

export const FLUSH_MS = 30_000
const MAX_BATCH = 50
const MAX_KEYS = 500

/**
 * @param {{ device: { url: string, token: string }, post?: (body: any) => Promise<any>, every?: number, log?: (text: string) => void }} options
 */
export function usageReporter({ device, post = (body) => call(device.url, "POST", "/own-usage", { token: device.token, body }), every = FLUSH_MS, log = () => {} }) {
  const pending = new Map()
  let stopped = false
  let flushing = null
  // One line per outage, not one every FLUSH_MS
  let warned = false
  const add = (e) => {
    if (stopped || !e?.provider || !e?.model) return
    const key = `${e.provider}\0${e.model}`
    const now = pending.get(key) ?? { provider: e.provider, model: String(e.model).slice(0, 120), requests: 0, inputTokens: 0, outputTokens: 0 }
    now.requests += e.requests ?? 1
    now.inputTokens += e.inputTokens ?? 0
    now.outputTokens += e.outputTokens ?? 0
    // A cost only while every call so far reported one: a partial sum would understate
    if (e.reportedCostMicroUsd !== undefined && (now.requests === (e.requests ?? 1) || now.reportedCostMicroUsd !== undefined)) now.reportedCostMicroUsd = (now.reportedCostMicroUsd ?? 0) + e.reportedCostMicroUsd
    else delete now.reportedCostMicroUsd
    if (pending.size < MAX_KEYS || pending.has(key)) pending.set(key, now)
  }
  const flush = () =>
    (flushing ??= (async () => {
      while (!stopped && pending.size) {
        const batch = [...pending.values()].slice(0, MAX_BATCH)
        for (const e of batch) pending.delete(`${e.provider}\0${e.model}`)
        try {
          await post({ entries: batch.map((e) => ({ ...e, requests: Math.min(e.requests, 10_000) })) })
          warned = false
        } catch (error) {
          if (error instanceof KriyaError && error.status === 404) {
            stopped = true
            pending.clear()
            return
          }
          // Kept for the next try, bounded
          for (const e of batch) if (pending.size < MAX_KEYS) pending.set(`${e.provider}\0${e.model}`, e)
          if (!warned) log(`own-model usage not sent yet (${error?.code ?? error?.message ?? "error"}); will retry quietly`)
          warned = true
          return
        }
      }
    })().finally(() => (flushing = null)))
  const timer = setInterval(flush, every)
  timer.unref?.()
  return {
    add,
    flush,
    pending: () => [...pending.values()],
    close: () => {
      clearInterval(timer)
      return flush()
    },
  }
}
