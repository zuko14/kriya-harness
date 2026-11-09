// The one place the runtime talks to Kriya, kept apart from manifest.js so the
// Engine can use the rest with no path to the API client (ARCHITECTURE §6).

import { call, KriyaError } from "../../api.js"
import { openManifest, RuntimeError, TRUSTED_KEYS } from "./manifest.js"

/**
 * What this Kriya has switched on for editing (EH-01). Any failure, a server with no such
 * route among them, means off: the server ships first, and a client never assumes (track E rule 17).
 * @returns {Promise<{ visuals: boolean, playbooks: boolean, mediaSearch: boolean }>}
 */
export async function fetchFeatures(device) {
  try {
    const found = await call(device.url, "GET", "/editing/features", { token: device.token })
    return { visuals: found?.visuals === true, playbooks: found?.playbooks === true, mediaSearch: found?.mediaSearch === true }
  } catch {
    return { visuals: false, playbooks: false, mediaSearch: false }
  }
}

/** Licensed pictures for these words; nothing found on any failure, so a plan never fails on a search. */
export async function searchMedia(device, queries) {
  try {
    return (await call(device.url, "POST", "/editing/media", { token: device.token, body: { queries } }))?.results ?? []
  } catch {
    return []
  }
}

/** Cited definitions for these terms; none on any failure. */
export async function defineTerms(device, terms) {
  try {
    return (await call(device.url, "POST", "/editing/define", { token: device.token, body: { terms } }))?.definitions ?? []
  } catch {
    return []
  }
}

/** The manifest for this device. A 404 is how a client learns this Kriya has no editing (EH-01). */
export async function fetchManifest(device, trusted = TRUSTED_KEYS) {
  try {
    return openManifest(await call(device.url, "GET", "/editing/manifest", { token: device.token }), trusted)
  } catch (error) {
    if (error instanceof KriyaError && error.status === 404) throw new RuntimeError("Editing isn't available on your Kriya yet.")
    throw error
  }
}
