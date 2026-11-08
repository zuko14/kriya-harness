// The Media Runtime manifest (DECISIONS EDD-05, ES-08): fetched from Kriya, and
// trusted only when a key pinned here signed those exact bytes. The private key
// stays offline with the owner, so a compromised web service can't sign one.

import { createHash, createPublicKey, verify } from "node:crypto"
import { createReadStream } from "node:fs"

/** Ed25519 public keys, base64 SPKI DER, from `npx tsx lib/editing/sign.ts keygen` in Kriya. */
export const TRUSTED_KEYS = []

export class RuntimeError extends Error {}

const signedBy = (text, signature, key) => {
  try {
    return verify(null, Buffer.from(text), createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"))
  } catch {
    return false
  }
}

const bad = (what) => {
  throw new RuntimeError(`The runtime manifest is invalid: ${what}.`)
}

const isLoopback = (url) => url.protocol === "http:" && url.hostname === "127.0.0.1"

function checkArtifact(artifact) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(artifact.id)) bad("an artifact id isn't safe")
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) bad(`${artifact.id} has no sha256`)
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) bad(`${artifact.id} has no size`)
  if (!["none", "zip"].includes(artifact.unpack)) bad(`${artifact.id} can't be unpacked that way`)
  if (artifact.entry.startsWith("/") || artifact.entry.split("/").includes("..")) bad(`${artifact.id} points outside the runtime`)
  const url = new URL(artifact.url)
  if (url.protocol !== "https:" && !isLoopback(url)) bad(`${artifact.id} isn't on https`)
}

function checkManifest(data) {
  if (data?.schema !== 1) bad("this client doesn't know its schema")
  if (!/^\d+\.\d+\.\d+$/.test(data.version)) bad("its version isn't safe")
  for (const platform of Object.values(data.platforms ?? {})) {
    platform.artifacts.forEach(checkArtifact)
    // Capability packs (ED13): each artifact pinned by hash, with its licence recorded (ET-PK-03)
    for (const [id, pack] of Object.entries(platform.packs ?? {})) {
      if (!/^pack-[a-z0-9-]+$/.test(id)) bad("a pack's name isn't safe")
      if (!Array.isArray(pack.artifacts) || !pack.artifacts.length) bad(`${id} has nothing to install`)
      for (const artifact of pack.artifacts) {
        checkArtifact(artifact)
        if (typeof artifact.licence !== "string" || !artifact.licence.trim()) bad(`${artifact.id} has no licence recorded`)
      }
    }
    if (!/^\d+\.\d+$/.test(platform.python.version)) bad("its Python version isn't exact")
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(platform.python.check)) bad("its Python check isn't a module name")
  }
}

/**
 * Verifies the signature over the exact text, then reads it.
 * @param {{ manifest: string, signature: string | null }} body
 * @param {string[]} trusted
 * @returns {{ text: string, data: object }}
 */
export function openManifest({ manifest, signature }, trusted = TRUSTED_KEYS) {
  if (!signature || !trusted.some((key) => signedBy(manifest, signature, key))) throw new RuntimeError("This runtime isn't signed by a key this client trusts, so it won't be installed.")
  const data = JSON.parse(manifest)
  checkManifest(data)
  return { text: manifest, data }
}

export async function fileSha256(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
