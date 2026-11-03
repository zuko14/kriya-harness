import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { kriyaHome } from "./paths.js"

// Skills turned off, per project or everywhere, so their catalog entries stop
// costing tokens on every request. Nothing is moved or edited: a provider at
// rank 0 (below every root DSH scans, 100+, and Kriya's own, 100) reports each
// turned-off name with both invocation surfaces off, so it wins the duplicate
// name under the registry's own rules and the catalog, the `skill` tool and
// `/name` all leave it out. Turning it back on removes that entry.

/** A skill name as DSH accepts it: kebab-case. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const switchesFile = () => join(kriyaHome(), "skill-switches.json")

/** The folder a project is keyed by: the nearest ancestor with .git (DSH's own rule), else the folder. */
export function projectRoot(cwd) {
  const start = resolve(cwd)
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return safeRealpath(dir)
    if (dirname(dir) === dir) return safeRealpath(start)
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const names = (value) => (Array.isArray(value) ? value.filter((n) => typeof n === "string" && SKILL_NAME.test(n)) : [])

/** The saved switches; a missing or unreadable file means every skill is on. */
export function readSwitches() {
  try {
    const raw = JSON.parse(readFileSync(switchesFile(), "utf8"))
    const projects = {}
    for (const [root, list] of Object.entries(raw?.projects ?? {})) if (names(list).length) projects[root] = names(list)
    return { everywhere: names(raw?.everywhere), projects }
  } catch {
    return { everywhere: [], projects: {} }
  }
}

function writeSwitches(switches) {
  const file = switchesFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, ...switches }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/** Each turned-off name for `cwd`: "here" (this project) or "everywhere". */
export function offFor(cwd) {
  const switches = readSwitches()
  const off = new Map()
  for (const name of switches.projects[projectRoot(cwd)] ?? []) off.set(name, "here")
  for (const name of switches.everywhere) off.set(name, "everywhere")
  return off
}

// Invalidators of the providers registered in this process (kriya-tools), so
// a switch from the Skills page reaches the agent's next step at once
const listeners = new Set()

export class SwitchError extends Error {}

/**
 * Sets one skill's switch for the project `cwd` is in.
 * @param {string} cwd
 * @param {string} name
 * @param {"on" | "off-here" | "off-everywhere"} state "on" clears both
 */
export function setSkillSwitch(cwd, name, state) {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) throw new SwitchError("That isn't a skill name.")
  if (!["on", "off-here", "off-everywhere"].includes(state)) throw new SwitchError("Say on, off-here or off-everywhere.")
  const root = projectRoot(cwd)
  const switches = readSwitches()
  const here = new Set(switches.projects[root] ?? [])
  const everywhere = new Set(switches.everywhere)
  here.delete(name)
  everywhere.delete(name)
  if (state === "off-here") here.add(name)
  if (state === "off-everywhere") everywhere.add(name)
  if (here.size) switches.projects[root] = [...here].sort()
  else delete switches.projects[root]
  writeSwitches({ everywhere: [...everywhere].sort(), projects: switches.projects })
  for (const invalidate of listeners) invalidate()
  return { name, state, project: root }
}

/**
 * The DSH skill provider (registered by plugins/kriya-tools): one rank-0
 * entry per turned-off name, invisible to the model and to `/name`.
 * @param {{ signal?: AbortSignal, invalidate?: () => void }} [control]
 */
export function switchProvider(control = {}) {
  if (control.invalidate) {
    const invalidate = control.invalidate
    listeners.add(invalidate)
    // `kriya skills off` in a terminal is another process: polled
    const file = switchesFile()
    watchFile(file, { interval: 2000, persistent: false }, invalidate)
    control.signal?.addEventListener("abort", () => {
      listeners.delete(invalidate)
      unwatchFile(file, invalidate)
    })
  }
  return {
    name: "kriya-switches",
    async list({ cwd } = {}) {
      return [...offFor(cwd ?? process.cwd())].map(([name, where]) => ({
        name,
        description: where === "here" ? "Turned off for this project in Kriya Harness." : "Turned off in Kriya Harness.",
        invocation: { modelInvocable: false, userInvocable: false },
        source: "custom",
        provider: "kriya-switches",
        rank: 0,
        locator: null,
      }))
    },
    async get() {
      return undefined
    },
  }
}
