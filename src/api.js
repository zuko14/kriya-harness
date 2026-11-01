import { CLIENT_VERSION } from "./paths.js"

// The Kriya Harness API client (docs/kriya-harness/API_AND_CONTRACTS.md in
// the Kriya repository; the same contract as contract/contract.json). Every
// request carries X-Kriya-Harness; authenticated ones the device token.
// Errors come back as { error, message } and are thrown as KriyaError.

export const BASE_PATH = "/api/harness/v1"

export class KriyaError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/**
 * @param {string} url Kriya origin
 * @param {string} method
 * @param {string} path below BASE_PATH
 * @param {{ token?: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, raw?: boolean }} [options]
 *   `raw`: the Response itself for 2xx and 304 (a skill body, an ETag check, a checkpoint)
 *   A FormData body goes as multipart (fetch sets the boundary); anything else as JSON
 */
export async function call(url, method, path, { token, body, signal, headers: extra = {}, raw = false } = {}) {
  const headers = { "X-Kriya-Harness": CLIENT_VERSION, Accept: "application/json", ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  const form = body instanceof FormData
  if (body !== undefined && !form) headers["Content-Type"] = "application/json"
  let response
  try {
    response = await fetch(`${url}${BASE_PATH}${path}`, {
      method,
      headers,
      body: body === undefined || form ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new KriyaError(0, "network", `Couldn't reach ${url} (${error?.cause?.code ?? error?.name ?? "network error"}).`)
  }
  if (raw && (response.ok || response.status === 304)) return response
  if (response.status === 204) return null
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: a proxy page or an outage; reported below without its body
  }
  if (!response.ok) {
    const { error, message, ...extra } = data && typeof data === "object" ? data : {}
    throw new KriyaError(
      response.status,
      typeof error === "string" ? error : "http_error",
      typeof message === "string" ? message : `Kriya answered ${response.status}.`,
      extra
    )
  }
  return data
}

/**
 * Inside DSH: the signed-in device, from the variables the launcher sets
 * (src/launch.js), for the Kriya plugins. Null when signed out.
 */
export function deviceFromEnv(env = process.env) {
  const token = env.KRIYA_DEVICE_TOKEN
  const gateway = env.KRIYA_GATEWAY_URL
  if (!token || !gateway?.endsWith(BASE_PATH)) return null
  return { token, url: gateway.slice(0, -BASE_PATH.length) }
}

/** @param {string} url @param {{ deviceName: string, platform: string }} device */
export const deviceCode = (url, device) =>
  call(url, "POST", "/device/code", { body: { ...device, clientVersion: CLIENT_VERSION } })

/** @param {string} url @param {string} code */
export const deviceToken = (url, code) =>
  call(url, "POST", "/device/token", { body: { deviceCode: code } })

/** @param {string} url @param {string} token */
export const me = (url, token) => call(url, "GET", "/me", { token })

/** @param {string} url @param {string} token */
export const models = (url, token) => call(url, "GET", "/models", { token })

/** @param {string} url @param {string} token */
export const revokeDevice = (url, token) => call(url, "DELETE", "/device", { token })
