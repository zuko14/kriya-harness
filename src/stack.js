import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { localUrl } from "./browser.js"
import { kriyaHome } from "./paths.js"
import { projectRoot } from "./skill-switches.js"

// Harness 2.0 W4, the local stack (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GATES.md §2, WD-05): the app and database the person runs on this computer
// for live gates (G-UI, G-A11Y, G-STACK). The harness never starts Docker or a
// database itself. The person confirms them once per project with `kriya
// stack use`; both must be loopback addresses. Kept in ~/.kriya/stack.json,
// outside the project, so the agent can't point a gate somewhere else.

export class StackError extends Error {}

export const stackFile = () => join(kriyaHome(), "stack.json")

const LOOPBACK = (host) => host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)

/** A postgres URL's host, if it parses; "" for a socket path (local by definition) */
export function databaseHost(url) {
  try {
    const u = new URL(url)
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null
    const fromQuery = u.searchParams.get("host")
    if (!u.hostname && fromQuery?.startsWith("/")) return ""
    return u.hostname.replace(/^\[|\]$/g, "") || (fromQuery ?? "")
  } catch {
    return null
  }
}

export const isLocalDatabase = (url) => {
  const host = databaseHost(url)
  return host !== null && (host === "" || LOOPBACK(host))
}

/** The database URL in a form safe to show: no password. */
export function shownDatabase(url) {
  try {
    const u = new URL(url)
    u.password = u.password ? "****" : ""
    return u.href
  } catch {
    return "(unreadable)"
  }
}

function read() {
  try {
    const value = JSON.parse(readFileSync(stackFile(), "utf8"))
    return value && typeof value.projects === "object" ? value.projects : {}
  } catch {
    return {}
  }
}

function write(projects) {
  const file = stackFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/** Confirms the project's app and/or database; refuses anything that isn't on this computer. */
export function useStack(cwd, { app, db } = {}, now = () => new Date()) {
  if (!app && !db) throw new StackError('Give --app http://localhost:<port> and/or --db postgresql://…@127.0.0.1:<port>/<db>.')
  const root = projectRoot(cwd)
  const entry = { ...(read()[root] ?? {}) }
  if (app) {
    const checked = localUrl(app)
    if (checked.error) throw new StackError(`--app: ${checked.error}`)
    entry.app = checked.url
  }
  if (db) {
    if (!isLocalDatabase(db)) throw new StackError("--db must be a postgres URL on this computer (localhost, 127.0.0.1, ::1 or a socket). Gates never touch a hosted database.")
    entry.db = db
  }
  entry.confirmedAt = now().toISOString()
  const projects = read()
  projects[root] = entry
  write(projects)
  return { root, ...entry }
}

export function forgetStack(cwd) {
  const root = projectRoot(cwd)
  const projects = read()
  const had = root in projects
  delete projects[root]
  write(projects)
  return had
}

/** The confirmed stack for this project, or {} */
export function readStack(cwd) {
  return read()[projectRoot(cwd)] ?? {}
}

const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"]
const DB_VARS = /^\s*(?:export\s+)?(DATABASE_URL|DIRECT_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|SUPABASE_DB_URL|PG_URL|DB_URL)\s*=\s*["']?([^"'\s#]+)/

/**
 * A database URL in the project's own env files that points off this computer
 * (operator rule 6's lesson: a project's .env may be the live database). Stack
 * gates refuse to run while one exists. Returns the variable and file, never the URL.
 */
export function hostedDatabase(root) {
  for (const name of ENV_FILES) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = DB_VARS.exec(line)
      if (m && /^postgres(ql)?:\/\//.test(m[2]) && !isLocalDatabase(m[2])) return { variable: m[1], file: name }
    }
  }
  return null
}
