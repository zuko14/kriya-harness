// The taste ledger (DIRECTOR_AND_AGENT §12, EDD-31): how this person edits, from what they
// do. Code writes it and code aggregates it; a pattern seen across projects becomes a
// proposal, asked once; only the person confirms one, and only confirmed rules change
// anything. It lives on this computer, outside every project.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { editHome } from "./paths.js"

const REPEATS = 2 // At least twice, as Loop v2's rules do, and in different projects
const SIGNALS_MAX = 500
const ZOOM_STEP = 0.05

// What can be learned so far: only what a make job can then use (`defaults` below)
const KINDS = {
  caption_look: {
    read: (op) => (op.op === "caption_style" && typeof op.look === "string" ? op.look : null),
    valid: (value) => typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value),
    sentence: (value) => `You usually use the ${value} captions. Use them by default?`,
    shown: (value) => `Captions: ${value}`,
  },
  zoom: {
    read: (op) => (op.op === "punch_in" && Number.isFinite(op.scale) ? Math.round(op.scale / ZOOM_STEP) * ZOOM_STEP : null),
    valid: (value) => Number.isFinite(value) && value > 1 && value <= 3,
    sentence: (value) => `You usually zoom in to ${value.toFixed(2)}×. Use that by default?`,
    shown: (value) => `Zoom: ${value.toFixed(2)}×`,
  },
}

const keyOf = (kind, value) => `${kind}:${typeof value === "number" ? value.toFixed(2) : value}`

const fileOf = (home) => join(editHome(home), "taste.json")

/** What a person's accepted operations say, by kind. Nothing else is kept. */
export const signalsOf = (ops) =>
  ops.flatMap((op) =>
    Object.entries(KINDS).flatMap(([kind, { read, valid }]) => {
      const value = read(op)
      return value !== null && valid(value) ? [{ kind, value }] : []
    })
  )

export function createTaste({ home, now = () => new Date().toISOString() }) {
  const read = () => {
    try {
      const kept = JSON.parse(readFileSync(fileOf(home), "utf8"))
      return { signals: Array.isArray(kept.signals) ? kept.signals : [], rules: kept.rules && typeof kept.rules === "object" ? kept.rules : {} }
    } catch {
      return { signals: [], rules: {} }
    }
  }
  const write = (ledger) => {
    const file = fileOf(home)
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 })
    renameSync(temporary, file)
  }
  const view = ([key, rule]) => ({ key, kind: rule.kind, value: rule.value, status: rule.status, sentence: KINDS[rule.kind].sentence(rule.value), shown: KINDS[rule.kind].shown(rule.value) })
  const known = (rule) => KINDS[rule?.kind]?.valid(rule.value)

  // A value seen in enough projects, with no answer yet, becomes one proposal
  function propose(ledger) {
    const seen = new Map()
    for (const { kind, value, project } of ledger.signals) {
      const key = keyOf(kind, value)
      if (!seen.has(key)) seen.set(key, { kind, value, count: 0, projects: new Set() })
      const group = seen.get(key)
      group.count++
      group.projects.add(project)
    }
    for (const [key, group] of seen) {
      if (group.count >= REPEATS && group.projects.size >= REPEATS && !ledger.rules[key]) ledger.rules[key] = { kind: group.kind, value: group.value, status: "proposed", at: now() }
    }
  }

  const decide = (key, status) => {
    const ledger = read()
    const rule = ledger.rules[key]
    if (!known(rule)) return false
    // One rule per kind: the newest thing the person said yes to
    if (status === "confirmed") for (const other of Object.values(ledger.rules)) if (other.kind === rule.kind && other.status === "confirmed") other.status = "dismissed"
    rule.status = status
    rule.at = now()
    write(ledger)
    return true
  }

  return {
    /** The person's own edit, or a proposal they accepted. Never a job's own operations. */
    note(project, ops, entry) {
      const found = signalsOf(ops)
      if (!found.length) return
      const ledger = read()
      ledger.signals.push(...found.map((signal) => ({ ...signal, project, entry })))
      ledger.signals = ledger.signals.slice(-SIGNALS_MAX)
      propose(ledger)
      write(ledger)
    },
    /** They undid it: it never happened, as far as taste goes. */
    forget(project, entry) {
      const ledger = read()
      const left = ledger.signals.filter((s) => !(s.project === project && s.entry === entry))
      if (left.length !== ledger.signals.length) write({ ...ledger, signals: left })
    },
    list() {
      const rules = Object.entries(read().rules).filter(([, rule]) => known(rule)).map(view)
      return { proposed: rules.filter((r) => r.status === "proposed"), confirmed: rules.filter((r) => r.status === "confirmed") }
    },
    confirm: (key) => decide(key, "confirmed"),
    dismiss: (key) => decide(key, "dismissed"),
    /** Removed from the one screen: it stops applying, and isn't asked about again. */
    remove: (key) => decide(key, "dismissed"),
    /** One proposal for the phone, once. */
    nextToAsk() {
      const ledger = read()
      const found = Object.entries(ledger.rules).find(([, rule]) => rule.status === "proposed" && !rule.asked && known(rule))
      if (!found) return null
      found[1].asked = true
      write(ledger)
      return view(found)
    },
    /** Only confirmed rules, as a make job's defaults; what the brief says always wins. */
    defaults() {
      const out = {}
      for (const rule of Object.values(read().rules)) {
        if (rule.status !== "confirmed" || !known(rule)) continue
        if (rule.kind === "caption_look") out.captions = rule.value
        if (rule.kind === "zoom") out.zoom = rule.value
      }
      return out
    },
  }
}
