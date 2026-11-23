import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, sep } from "node:path"

import { chromeInstalled } from "./browser.js"
import { call, models, me } from "./api.js"
import { dumpConfig } from "./launch.js"
import { CLIENT_VERSION } from "./paths.js"
import { PROFILES } from "./profiles.js"
import { readDevice } from "./store.js"

// `kriya doctor`: what's needed to run, checked in order, each with a plain
// fix. Exit code 0 only when every check passes.

export const MIN_NODE = [24, 9]

// Whether iCloud syncs ~/Desktop and ~/Documents on this Mac
function icloudDesktop() {
  try {
    return process.platform === "darwin" && execFileSync("defaults", ["read", "com.apple.finder", "FXICloudDriveDesktop"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "1"
  } catch {
    return false
  }
}

const within = (dir, parent) => dir === parent || dir.startsWith(`${parent}${sep}`)

/** Why `dir` is a poor home for a project, or undefined. Kriya works there; syncing node_modules and builds is what suffers */
export function syncedFolder(dir, home = homedir(), desktopSynced = icloudDesktop()) {
  const icloud = "this folder is synced by iCloud, which slows installs and builds and can hold files back; a folder like ~/Developer is better for projects"
  if (within(dir, join(home, "Library", "Mobile Documents"))) return icloud
  if (within(dir, join(home, "Library", "CloudStorage"))) return "this folder is synced to the cloud, which slows installs and builds; a folder like ~/Developer is better for projects"
  return desktopSynced && (within(dir, join(home, "Documents")) || within(dir, join(home, "Desktop"))) ? icloud : undefined
}

/** Tiers that all run one model can't step up; undefined when they differ or a name is missing */
export function tierNote(data) {
  const names = new Set(data.map((m) => m.name))
  return data.length > 1 && names.size === 1 && data[0].name ? `every tier runs one model (${data[0].name}), so a harder task can't step up: set routing.* in the Owner console` : undefined
}

export function nodeOk(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

// Rows the kriya bundle must keep disabled in every profile (HD-17, HD-02)
export const MUST_BE_DISABLED = [
  "deepseek-account",
  "llm-deepseek",
  "llm-deepseek-account",
  "web-search-deepseek",
  "web-deepseek-api",
  "session-log-deepseek",
  "otel",
  "session-telemetry-otel",
  // Web UI profile only
  "ui-settings-session-log",
  "account-controller",
  "ui-settings-account",
  "desktop-product-telemetry",
  "product-analytics",
]

/** The composed rows of a --dump-config: id → whether the row is disabled (literally true). */
export function rowStates(yaml) {
  const rows = new Map()
  let current = null
  for (const line of yaml.split("\n")) {
    const id = /^(?:\s*)- id: ([\w-]+)\s*$/.exec(line)
    if (id) {
      current = id[1]
      if (!rows.has(current)) rows.set(current, false)
      continue
    }
    if (current && /^\s+disabled: true\s*$/.test(line)) rows.set(current, true)
  }
  return rows
}

/** @param {{ say?: (line: string) => void }} [io] */
export async function doctor(io = {}) {
  const say = io.say ?? ((line) => process.stdout.write(`${line}\n`))
  let ok = true
  const check = (pass, label, fix) => {
    say(`${pass ? "ok  " : "FAIL"}  ${label}${pass || !fix ? "" : ` — ${fix}`}`)
    if (!pass) ok = false
  }

  check(
    nodeOk(),
    `Node ${process.versions.node} (needs ${MIN_NODE.join(".")} or later)`,
    "install Node 24.9 or later from nodejs.org"
  )
  say(`ok    Kriya Harness ${CLIENT_VERSION}`)

  for (const profile of Object.keys(PROFILES)) {
    try {
      const rows = rowStates(dumpConfig(profile))
      const open = MUST_BE_DISABLED.filter((id) => rows.has(id) && !rows.get(id))
      check(open.length === 0, `profile ${profile} composes`, `rows not disabled: ${open.join(", ")}`)
    } catch (error) {
      check(false, `profile ${profile} composes`, error.message)
    }
  }

  // Not a failure: everything else works without it
  say(`ok    agent's browser: ${chromeInstalled() ? "ready" : "off (install Chrome, Edge, Brave or Chromium to turn it on)"}`)

  const synced = syncedFolder(process.cwd())
  if (synced) say(`note  ${synced}`)

  const device = readDevice()
  check(!!device, device ? `signed in to ${device.url}` : "signed in", "run kriya login")
  if (device) {
    try {
      const who = await me(device.url, device.token)
      check(true, `Kriya account reachable (${who.displayName ?? "you"} · ${who.agent?.name ?? "agent"})`)
      check(
        who.harness?.enabled === true,
        "Kriya Harness on for this account",
        "Kriya Harness isn't on for your plan yet"
      )
      const list = await models(device.url, device.token)
      const tiers = list.data.map((model) => model.id)
      check(tiers.length > 0, `gateway models: ${tiers.join(", ") || "none"}`, "your plan allows no models")
      const single = tierNote(list.data)
      if (single) say(`note  ${single}`)
      // An empty report writes nothing: 400 means the route is on, 404 that it's switched off
      const live = await call(device.url, "POST", "/live", { token: device.token, body: {} }).catch((error) => error.status)
      say(`ok    Remote Control on Kriya: ${live === 404 ? "off (harness.remoteControl in the Owner console)" : "on"}`)
    } catch (error) {
      check(false, "Kriya account reachable", error.message)
    }
  }
  return ok
}

/* ─────────────── Harness 2.0 W17: gates on this machine (kriya doctor --gates) ─────────────── */

/** Whether a program is on PATH, found by looking, never by running it. */
export function onPath(name, env = process.env, exists = existsSync) {
  const dirs = String(env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean)
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""]
  return dirs.some((d) => exts.some((e) => exists(join(d, `${name}${e}`))))
}

/**
 * The capability matrix (DELIVERY_AND_STABILITY §5): which gates can run
 * here and, for the others, what they would need. Nothing is started.
 */
export async function gateMatrix({ has = (n) => onPath(n), chrome } = {}) {
  const browser = chrome ?? chromeInstalled()
  const row = (gate, ok, needs) => ({ gate, works: Boolean(ok), ...(!ok && { needs }) })
  return [
    row("G-CONTRACT", true),
    row("G-DETECT", true),
    row("G-SECRETS", true),
    row("G-TRACE", true),
    row("G-FLAKE", true),
    row("G-UI", browser, "Google Chrome or another Chromium browser"),
    row("G-A11Y", browser, "Google Chrome or another Chromium browser"),
    row("G-STACK", has("psql"), "psql (PostgreSQL client) and kriya stack use --db"),
    row("G-API", true),
    row("G-TENANT", true),
    row("G-SAST", has("semgrep"), "semgrep and the project's own rules file"),
    row("G-DATA", true),
    row("G-EVAL", true),
    row("G-SAN", has("clang") || has("gcc"), "a C/C++ toolchain (clang or gcc)"),
    row("G-IAC", has("tofu") || has("terraform"), "OpenTofu or Terraform"),
    row("G-SIM", has("xcrun") || has("adb"), "Xcode (xcrun) or Android platform tools (adb)"),
    row("G-DEPLOYED", has("vercel"), "a confirmed provider CLI (vercel), signed in by you"),
    row("G-3D", browser, "Google Chrome or another Chromium browser that creates WebGL"),
  ]
}

/**
 * Self-tests of the gates that need nothing installed: each checks a clean
 * and a mutant fixture, so a gate that stopped catching what it should is
 * seen here before it misses something in a real step.
 */
export async function gateSelfTests() {
  const { DETECTORS, findSecrets } = await import("./gates/detectors.js")
  const file = (path, text) => ({ path, content: text, added: text.split("\n").map((t, i) => ({ line: i + 1, text: t })) })
  const tests = [
    ["G-SECRETS", findSecrets(file("src/a.js", "const key = process.env.KEY\n")).length === 0, findSecrets(file("src/a.js", `const key = "${"AKIA" + "QWERTYUIOPASDFGH"}"\n`)).length > 0],
    ["G-DETECT DB-DROP", DETECTORS["DB-DROP"].find(file("db/1.sql", "create table t (id int);")).length === 0, DETECTORS["DB-DROP"].find(file("db/2.sql", "drop table t;")).length > 0],
    ["G-DETECT OPS-MIGRATE-LOCK", DETECTORS["OPS-MIGRATE-LOCK"].find(file("db/1.sql", "create index concurrently i on t (a);")).length === 0, DETECTORS["OPS-MIGRATE-LOCK"].find(file("db/2.sql", "create index i on t (a);")).length > 0],
  ]
  return tests.map(([name, clean, mutant]) => ({ name, ok: clean && mutant, clean, mutant }))
}

/** `kriya doctor --gates`: the matrix and the self-tests; false if a self-test fails. */
export async function doctorGates(io = {}) {
  const say = io.say ?? ((line) => process.stdout.write(`${line}\n`))
  let ok = true
  for (const t of await gateSelfTests()) {
    say(`${t.ok ? "ok  " : "FAIL"}  self-test ${t.name}${t.ok ? "" : ` — ${t.clean ? "" : "flags clean code"}${!t.clean && !t.mutant ? ", " : ""}${t.mutant ? "" : "misses the planted problem"}`}`)
    if (!t.ok) ok = false
  }
  for (const r of await gateMatrix(io)) say(`${r.works ? "works" : "not checked here"}  ${r.gate}${r.works ? "" : ` (needs ${r.needs})`}`)
  return ok
}
