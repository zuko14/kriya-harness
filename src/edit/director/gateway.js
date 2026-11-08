// The Director's route to a model: the person's own Kriya gateway, with the device the
// Edit Host reads itself (STUDIO_APP §2). Tier aliases only; Kriya maps them to models
// and meters the spend. Signed out, every call fails plainly and slots take defaults.

import { call, KriyaError } from "../../api.js"
import { readDevice } from "../../store.js"

/** @returns {(body: object, signal?: AbortSignal) => Promise<object>} */
export function gatewaySend({ device = readDevice, timeoutMs = 120_000 } = {}) {
  return async (body, signal) => {
    const signedIn = device()
    if (!signedIn) throw new KriyaError(401, "signed_out", "This computer isn't signed in to Kriya. Run kriya login.")
    const limit = AbortSignal.timeout(timeoutMs)
    return call(signedIn.url, "POST", "/chat/completions", { token: signedIn.token, body: { ...body, stream: false }, signal: signal ? AbortSignal.any([signal, limit]) : limit })
  }
}
