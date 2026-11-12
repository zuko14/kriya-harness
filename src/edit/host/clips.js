// The clips a computer advertises for an offered folder (TP11, CRAFT_UPGRADE §9): each clip's number and
// the person's own label, read from the folder's editing project on this computer. Never a path, a file
// name, a transcript or a reference: Tavi may only name an order by what the person can see in the Studio.
// Loaded lazily by the daemon, only with KRIYA_EDIT on and after Kriya advertised taviOrder (rule 17).

import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { join } from "node:path"

import { clipNumbers, cleanLabel } from "../core/project.js"
import { editHome } from "./paths.js"

export const MAX_CLIPS = 50

/** @returns {{ n: number, label?: string }[]} empty when the folder has no project or it can't be read */
export function advertisedClips(folder, { home } = {}) {
  try {
    const registry = JSON.parse(readFileSync(join(editHome(home), "projects.json"), "utf8"))
    const entry = registry.find((item) => item && typeof item.file === "string" && dirname(item.file) === folder)
    if (!entry) return []
    const project = JSON.parse(readFileSync(entry.file, "utf8"))
    const numbers = clipNumbers(project)
    return project.assets
      .filter((asset) => numbers.has(asset.id) && asset.kind === "video")
      .map((asset) => {
        const label = cleanLabel(asset.label)
        return { n: numbers.get(asset.id), ...(label ? { label } : {}) }
      })
      .slice(0, MAX_CLIPS)
  } catch {
    return []
  }
}
