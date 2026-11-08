// Capability packs (CAPABILITY_PACKS, EDD-43): optional, local, typed. A pack is
// reached only by the operations it lists; nothing in the core depends on one. Its
// files come from the signed Media Runtime manifest (`platforms.<id>.packs`), placed
// beside the core by `kriya edit setup --pack <name>` and removed the same way, never
// touching the core. When a pack is missing, the operation that needs it fails with a
// plain reason before anything renders, and everything else keeps working.

import { existsSync } from "node:fs"
import { join } from "node:path"

import { platformId } from "../runtime/setup.js"
import { EngineFailure } from "./tool.js"

/**
 * The packs this client knows. `filters` are FFmpeg's; `artifacts` are ids the
 * runtime manifest must ship for the pack; `ops` are the operations that need it.
 * Data only: no command, path, URL or price.
 */
export const PACKS = {
  "pack-color": {
    title: "Colour",
    does: "colour matching between shots, and LUTs",
    ops: ["match_color", "apply_lut"],
    filters: ["lut3d"],
    artifacts: [],
    licences: [{ item: "FFmpeg lut3d", licence: "LGPL-2.1-or-later (FFmpeg, EQ-02)" }],
  },
  "pack-voice-clean": {
    title: "Clean voice",
    does: "noise and room removal with DeepFilterNet; without it, FFmpeg's own filters clean the voice",
    ops: [],
    filters: [],
    artifacts: ["deepfilternet3"],
    licences: [{ item: "DeepFilterNet", licence: "MIT or Apache-2.0" }],
  },
  "pack-depth": {
    title: "Depth motion",
    does: "stills that move with parallax, from Depth Anything V2's permissively licensed sizes",
    ops: ["parallax"],
    filters: [],
    artifacts: ["depth-anything-v2-small"],
    licences: [{ item: "Depth Anything V2 Small", licence: "Apache-2.0" }],
  },
}

export const packName = (id) => id.replace(/^pack-/, "")

/** Where a pack's files sit in a runtime version. */
export const packDir = (runtime, id) => join(runtime.dir, "packs", id)

/**
 * Each pack's state on this computer: installed, or why not, in plain words.
 * @param {{ runtime: { dir: string, manifest: object } | null, capabilities: { filters: Set<string> }, platform?: string }} where
 * @returns {Record<string, { title: string, installed: boolean, missing: string | null }>}
 */
export function packStatus({ runtime, capabilities, platform = platformId() }) {
  const status = {}
  for (const [id, pack] of Object.entries(PACKS)) {
    const filter = pack.filters.find((name) => !capabilities.filters.has(name))
    let missing = null
    if (filter) missing = `This FFmpeg has no ${filter} filter, which ${pack.title.toLowerCase()} needs. Install an FFmpeg with it (kriya edit doctor says which).`
    else if (pack.artifacts.length) {
      const offered = runtime?.manifest?.platforms?.[platform]?.packs?.[id]
      if (!runtime) missing = `The ${pack.title} pack needs the Media Runtime, which isn't installed.`
      else if (!offered) missing = `This Media Runtime (${runtime.version}) doesn't offer the ${pack.title} pack yet.`
      else if (!existsSync(join(packDir(runtime, id), ".complete"))) missing = `The ${pack.title} pack isn't installed. Run kriya edit setup --pack ${packName(id)}.`
    }
    status[id] = { title: pack.title, installed: missing === null, missing }
  }
  return status
}

/** The pack an operation needs, if any. */
export const packFor = (op) => Object.keys(PACKS).find((id) => PACKS[id].ops.includes(op)) ?? null

/** Throws the plain reason when `id` isn't installed. */
export function requirePack(id, status) {
  const state = status[id]
  if (!state) throw new EngineFailure("environment", "missing_pack", `There is no pack called ${id}.`)
  if (!state.installed) throw new EngineFailure("environment", "missing_pack", state.missing)
}

/** The packs a compiled plan needs: colour for a LUT or a colour match. */
export function packsForPlan(plan) {
  const effects = plan.segments.flatMap((s) => s.node.picture.flatMap((item) => item.effects))
  return effects.some((e) => e.type === "lut" || (e.type === "grade" && e.match)) ? ["pack-color"] : []
}
