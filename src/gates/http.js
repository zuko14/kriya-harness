import { localUrl } from "../browser.js"

// Harness 2.0 W5: the only way the API and tenant gates reach an app
// (Kriya-Tavi docs/kriya-harness/upgrade_2.0/GATES.md rule 4). Every URL must
// pass the agent browser's loopback rule; redirects are never followed (a 3xx
// is just the answer); each request is time-boxed and each gate run has a
// request budget, so a gate can't flood even the person's own app.

export const REQUEST_MS = 10_000
export const BUDGET = 80

export class Budget {
  constructor(limit = BUDGET) {
    this.left = limit
  }
  take() {
    if (this.left <= 0) throw new Error(`the gate's request budget (${BUDGET}) ran out`)
    this.left--
  }
}

/** One request to the confirmed local app; never anything else. */
export async function local(base, path, { method = "GET", body, headers = {}, budget, request = fetch } = {}) {
  const target = localUrl(new URL(path, base).href)
  if (target.error) throw new Error(`refused ${path}: ${target.error}`)
  budget?.take()
  const started = performance.now()
  let response
  try {
    response = await request(target.url, {
      method,
      redirect: "manual",
      headers: { accept: "application/json", ...(body !== undefined && typeof body !== "string" && { "content-type": "application/json" }), ...headers },
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_MS),
    })
  } catch (error) {
    return { status: 0, error: String(error?.cause?.code ?? error?.name ?? error).slice(0, 80), ms: performance.now() - started }
  }
  const text = await response.text().catch(() => "")
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    // Not JSON
  }
  return { status: response.status, text: text.slice(0, 20_000), json, headers: response.headers, ms: performance.now() - started }
}

/** "/orders/{id}" with { id: 7 } → "/orders/7" (values URI-encoded) */
export const fill = (path, values = {}) => String(path).replace(/\{(\w+)\}/g, (m, k) => (values[k] === undefined ? m : encodeURIComponent(String(values[k]))))

export const median = (xs) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
export const p95 = (xs) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}
