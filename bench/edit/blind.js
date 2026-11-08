// Blind packaging for raters (EVALUATION_PLAN §6): files renamed, order randomised, metadata
// stripped, no arm or tool name left inside. The key stays with whoever runs the analysis.

import { execFile } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** A stream copy with no container, stream or chapter metadata. Pixels and sound aren't touched. */
export const stripArgs = (input, output) => ["-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:v", "-map", "0:a?", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-c", "copy", "-movflags", "+faststart", "-y", output]

/**
 * @param {{ task: string, arm: string, file: string }[]} outputs
 * @param {{ out: string, secret: string }} options secret decides the names and the order, so a package can be rebuilt
 * @returns {Promise<{ blind: string, task: string }[]>} what raters see; the key is written apart
 */
export async function blindPackage(outputs, { out, secret }) {
  mkdirSync(join(out, "raters"), { recursive: true })
  const key = []
  for (const output of outputs) {
    const blind = `${createHmac("sha256", secret).update(`${output.task}\u0000${output.arm}`).digest("hex").slice(0, 12)}.mp4`
    await run("ffmpeg", stripArgs(output.file, join(out, "raters", blind)))
    key.push({ blind, task: output.task, arm: output.arm })
  }
  key.sort((a, b) => a.blind.localeCompare(b.blind))
  writeFileSync(join(out, "key.json"), JSON.stringify(key, null, 2), { mode: 0o600 })
  return key.map(({ blind, task }) => ({ blind, task }))
}
