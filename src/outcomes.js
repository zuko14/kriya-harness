import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { kriyaHome } from "./paths.js"

// Harness 2.0 W11 (Kriya-Tavi docs/kriya-harness/upgrade_2.0/SELF_EVOLUTION.md
// §6; HD-24, WD-15): the person's sharing opt-in, and the outcome counts it
// allows. Off by default (`kriya share on|off|status`, stored in the Kriya
// home, never in a project). Off, nothing is counted or kept. On, each step
// built with a role cartridge adds one to that cartridge version's count of
// verified, blocked or not checked steps; the mirror sends the counts with
// its next turn, if Kriya takes them. Counts only: no text, names or files.

const shareFile = () => join(kriyaHome(), "share.json")
const pendingFile = () => join(kriyaHome(), "outcomes-pending.json")

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/** The person's choice: on only when they turned it on. */
export function shareStatus() {
  const saved = readJson(shareFile())
  return { on: saved?.on === true, ...(saved?.changedAt && { changedAt: saved.changedAt }) }
}

/** `kriya share on|off`. Turning it off drops counts not yet sent. */
export function setShare(on, now = () => new Date().toISOString()) {
  writeJson(shareFile(), { on: Boolean(on), changedAt: now() })
  if (!on) writeJson(pendingFile(), {})
}

const KEY = /^(kriya-role-[a-z]{2,20})@(\d{1,3}\.\d{1,3}\.\d{1,3})$/
const FIELD = { pass: "verified", blocked: "blocked", "not checked": "notChecked" }

/**
 * One step's outcome for the cartridge version that built it ("id@version").
 * Nothing without the opt-in, for another status, or for a step built
 * without a cartridge.
 */
export function recordOutcome(cartridge, status) {
  if (!shareStatus().on || !KEY.test(cartridge ?? "") || !FIELD[status]) return false
  // shortcut: two sessions finishing a step in the same instant can lose one count; a lock comes if counts matter more
  const pending = readJson(pendingFile()) ?? {}
  const row = pending[cartridge] ?? { verified: 0, blocked: 0, notChecked: 0, undone: 0 }
  row[FIELD[status]] = Math.min(10_000, row[FIELD[status]] + 1)
  pending[cartridge] = row
  writeJson(pendingFile(), pending)
  return true
}

/** The counts to send (at most 20 versions), taken off the pending file; [] without the opt-in. */
export function takeOutcomes() {
  if (!shareStatus().on) return []
  const pending = readJson(pendingFile()) ?? {}
  const keys = Object.keys(pending).filter((k) => KEY.test(k)).slice(0, 20)
  if (!keys.length) return []
  const out = keys.map((k) => {
    const [, cartridgeId, version] = KEY.exec(k)
    return { cartridgeId, version, ...pending[k] }
  })
  for (const k of keys) delete pending[k]
  writeJson(pendingFile(), pending)
  return out
}

/** Counts taken for a turn that Kriya then didn't store: back into the pending file. */
export function returnOutcomes(outcomes) {
  if (!outcomes?.length || !shareStatus().on) return
  const pending = readJson(pendingFile()) ?? {}
  for (const o of outcomes) {
    const key = `${o.cartridgeId}@${o.version}`
    const row = pending[key] ?? { verified: 0, blocked: 0, notChecked: 0, undone: 0 }
    for (const f of ["verified", "blocked", "notChecked", "undone"]) row[f] = Math.min(10_000, row[f] + (o[f] ?? 0))
    pending[key] = row
  }
  writeJson(pendingFile(), pending)
}
