// The one place the runtime talks to Kriya, kept apart from manifest.js so the
// Engine can use the rest with no path to the API client (ARCHITECTURE §6).

import { call, KriyaError } from "../../api.js"
import { openManifest, RuntimeError, TRUSTED_KEYS } from "./manifest.js"

/** The manifest for this device. A 404 is how a client learns this Kriya has no editing (EH-01). */
export async function fetchManifest(device, trusted = TRUSTED_KEYS) {
  try {
    return openManifest(await call(device.url, "GET", "/editing/manifest", { token: device.token }), trusted)
  } catch (error) {
    if (error instanceof KriyaError && error.status === 404) throw new RuntimeError("Editing isn't available on your Kriya yet.")
    throw error
  }
}
