import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

import { localUrl } from "./browser.js"
import { DETECTORS, findSecrets } from "./gates/detectors.js"
import { judgeA11y, judgeUi, uiReports } from "./gates/ui.js"
import { kriyaHome } from "./paths.js"
import { projectRoot } from "./skill-switches.js"

// Harness 2.0 W17, production delivery (Kriya-Tavi docs/kriya-harness/
// upgrade_2.0/DELIVERY_AND_STABILITY.md §1–4; WD-21, WD-22).
// - G-RELEASE: local checks of a production build, each line computed by code;
//   `ready` only when every line passes (not checked withholds it).
// - The path to production: a production deploy needs `ready` and `smoked`
//   records for the same commit.
// - G-DEPLOYED: the one gate that leaves this machine: GET/HEAD to the host a
//   deploy printed, ≤ 20 requests, no cookies, credentials or body.
// - WD-22: hosted-database migrations, production environment and secret
//   changes, DNS changes and merges are never run; they're written down for
//   the person instead.

export class ReleaseError extends Error {}

const sha = (text) => createHash("sha256").update(text).digest("hex")
const projectKey = (root) => sha(root).slice(0, 16)
const releaseFile = () => join(kriyaHome(), "release.json")
const stateFile = (root) => join(kriyaHome(), "releases", `${projectKey(root)}.json`)

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/* ───────────────────────────── settings ───────────────────────────── */

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const ROUTE = /^\/[A-Za-z0-9._~\/-]{0,200}$/

/**
 * `kriya release use`: the person confirms how a production build is made and
 * checked, once per project. The production server is one the person started
 * and confirmed (`--app`, loopback only): spike S2 didn't establish that a
 * sandboxed command may listen on loopback, so the harness doesn't start it.
 */
export function useRelease(cwd, options = {}, now = () => new Date()) {
  const root = projectRoot(cwd)
  const all = readJson(releaseFile(), {})
  const entry = { ...(all[root] ?? {}) }
  if (options.build !== undefined) {
    const b = String(options.build).trim()
    if (!b || b.length > 300 || /[\r\n]/.test(b)) throw new ReleaseError("Give the production build command on one line, e.g. --build \"npm run build\".")
    entry.build = b
  }
  if (options.app !== undefined) {
    const checked = localUrl(String(options.app))
    if (checked.error) throw new ReleaseError(`--app: ${checked.error}`)
    entry.app = checked.url ?? String(options.app)
  }
  if (options.out !== undefined) {
    const o = String(options.out).trim()
    if (!o || o.startsWith("/") || o.split(/[\\/]/).includes("..")) throw new ReleaseError("--out is a folder inside the project, e.g. --out dist.")
    entry.out = o
  }
  if (options.budgetKb !== undefined) {
    const n = Number(options.budgetKb)
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new ReleaseError("--budget-kb is a whole number of kilobytes.")
    entry.budgetKb = n
  }
  if (options.routes !== undefined) {
    const list = String(options.routes).split(",").map((r) => r.trim()).filter(Boolean)
    if (!list.length || list.length > 10 || list.some((r) => !ROUTE.test(r))) throw new ReleaseError("--routes is up to 10 paths like /,/pricing (no query strings).")
    entry.routes = list
  }
  if (options.domain !== undefined) {
    const d = String(options.domain).trim().toLowerCase()
    if (!HOST.test(d)) throw new ReleaseError("--domain is a host name like app.example.com.")
    entry.domain = d
  }
  if (options.headers !== undefined) {
    const allowed = ["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options"]
    const list = String(options.headers).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
    if (list.some((h) => !allowed.includes(h))) throw new ReleaseError(`--headers names some of: ${allowed.join(", ")}.`)
    entry.headers = list
  }
  if (options.marker !== undefined) {
    const m = String(options.marker)
    if (!m || m.length > 120) throw new ReleaseError("--marker is a short text the home page contains.")
    entry.marker = m
  }
  if (!entry.build) throw new ReleaseError('A release needs --build "<command>".')
  entry.confirmedAt = now().toISOString()
  all[root] = entry
  writeJson(releaseFile(), all)
  return entry
}

export const readRelease = (cwd) => readJson(releaseFile(), {})[projectRoot(cwd)]

/* ───────────────────────────── G-RELEASE ───────────────────────────── */

const line = (id, status, detail) => ({ id, status, ...(detail && { detail: String(detail).slice(0, 1500) }) })
const SOURCE = /\.(m?[jt]sx?|cjs|py|svelte|vue|astro)$/
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".venv", "venv", "__pycache__"])
const ENV_READ = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g, /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g, /os\.environ\[["']([A-Z][A-Z0-9_]*)["']\]/g, /os\.environ\.get\(["']([A-Z][A-Z0-9_]*)["']/g, /os\.getenv\(["']([A-Z][A-Z0-9_]*)["']/g]
// Set by platforms and runtimes themselves, never by the person's deployment
const PLATFORM_ENV = new Set(["NODE_ENV", "CI", "PORT", "HOME", "PATH", "PWD", "TZ", "LANG", "VERCEL", "VERCEL_ENV", "VERCEL_URL"])

function walk(root, dir = root, out = [], limit = 3000) {
  for (const name of (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()) {
    if (out.length >= limit) break
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(root, full, out, limit)
    else out.push(relative(root, full))
  }
  return out
}

/** REL-ENV: every variable the source reads is named in .env.example (names only, never values). */
export function envCompleteness(root) {
  const read = new Set()
  for (const rel of walk(root).filter((f) => SOURCE.test(f))) {
    let text
    try {
      text = readFileSync(join(root, rel), "utf8")
    } catch {
      continue
    }
    if (text.length > 1024 * 1024) continue
    for (const re of ENV_READ) for (const m of text.matchAll(re)) if (!PLATFORM_ENV.has(m[1])) read.add(m[1])
  }
  const example = existsSync(join(root, ".env.example")) ? readFileSync(join(root, ".env.example"), "utf8") : ""
  const named = new Set([...example.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]))
  const missing = [...read].filter((v) => !named.has(v)).sort()
  if (!read.size) return line("REL-ENV", "pass", "the source reads no environment variables")
  return missing.length ? line("REL-ENV", "fail", `Read in the source but not in .env.example: ${missing.join(", ")}. A deployment wouldn't know to set them.`) : line("REL-ENV", "pass")
}

/** The build output's JS and CSS against the budget in release.json. */
export function bundleBudget(root, release) {
  if (!release?.budgetKb) return line("BUNDLE", "pass", "no budget set (kriya release use --budget-kb)")
  const out = join(root, release.out ?? "dist")
  if (!existsSync(out)) return line("BUNDLE", "not_checked", `no build output at ${release.out ?? "dist"}`)
  let total = 0
  for (const rel of walk(out, out, [], 20_000)) if (/\.(m?js|css)$/.test(rel)) total += statSync(join(out, rel)).size
  const kb = Math.ceil(total / 1024)
  return kb > release.budgetKb ? line("BUNDLE", "fail", `${kb} KB of JS and CSS, over the ${release.budgetKb} KB budget`) : line("BUNDLE", "pass", `${kb} KB of ${release.budgetKb} KB`)
}

/** Lockfile present and in step with package.json; production dependencies' licences on the allow-list. */
export function dependencies(root) {
  const pkg = readJson(join(root, "package.json"), undefined)
  if (!pkg) return line("DEPS", "pass", "no package.json")
  const lock = readJson(join(root, "package-lock.json"), undefined)
  const hasOther = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb"].some((f) => existsSync(join(root, f)))
  if (!lock && !hasOther) return line("DEPS", "fail", "no lockfile: the deployment could install other versions than the ones checked")
  const problems = []
  if (lock) {
    const locked = lock.packages?.[""] ?? {}
    for (const field of ["dependencies", "devDependencies"])
      for (const [name, range] of Object.entries(pkg[field] ?? {}))
        if (locked[field]?.[name] !== range) problems.push(`${name} ${range} isn't in package-lock.json as declared (run the install again)`)
  }
  const ALLOWED = /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|MPL-2\.0|Unlicense|CC0-1\.0|BlueOak-1\.0\.0)$/
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const dep = readJson(join(root, "node_modules", name, "package.json"), undefined)
    if (!dep) continue
    const lic = typeof dep.license === "string" ? dep.license : dep.license?.type
    const ok = typeof lic === "string" && lic.replace(/[()]/g, "").split(/\s+OR\s+/).some((l) => ALLOWED.test(l.trim()))
    if (!ok) problems.push(`${name}: licence ${lic ?? "not stated"} isn't on the allow-list`)
  }
  return problems.length ? line("DEPS", "fail", problems.slice(0, 12).join("\n")) : line("DEPS", "pass")
}

/** Migrations and secrets over the release diff: DB-DROP and OPS-MIGRATE-LOCK as errors here; G-SECRETS. */
export function diffChecks(files) {
  const migrations = []
  for (const id of ["DB-DROP", "OPS-MIGRATE-LOCK"]) {
    const d = DETECTORS[id]
    for (const f of files.filter((f) => d.files(f.path))) for (const hit of d.find(f)) migrations.push(`${f.path}:${hit.line} ${hit.why}`)
  }
  const secrets = files.flatMap((f) => findSecrets(f).map((s) => `${f.path}:${s.line} (${s.why})`))
  return [
    migrations.length ? line("MIGRATIONS", "fail", `Needs an explicit two-step plan in the contract:\n${migrations.join("\n")}`) : line("MIGRATIONS", "pass"),
    secrets.length ? line("G-SECRETS", "fail", secrets.join("\n")) : line("G-SECRETS", "pass"),
  ]
}

/**
 * G-RELEASE on the current commit. `host.run(command)` runs the confirmed
 * build under the session's sandbox; `host.files` gives the release diff's
 * files ({ path, content, added }); `host.rendered(app)` runs G-UI and G-A11Y
 * against the production server.
 */
export async function gRelease(cwd, host) {
  const root = projectRoot(cwd)
  const release = readRelease(root)
  if (!release) throw new ReleaseError('No release is confirmed for this project. The person runs kriya release use --build "<command>" --app http://localhost:<port> once.')
  const lines = []
  const built = await host.run(release.build)
  lines.push(built.exitCode === 0 && !built.timedOut ? line("BUILD", "pass") : line("BUILD", "fail", `${release.build} exited ${built.timedOut ? "on its time limit" : built.exitCode}:\n${String(built.output ?? "").slice(-1200)}`))
  if (!release.app) lines.push(line("RENDERED", "not_checked", "no production server is confirmed: start it and run kriya release use --app http://localhost:<port>"))
  else {
    const results = await (host.rendered ?? defaultRendered(root))(release.app)
    for (const r of results) lines.push(line(r.id, r.status, r.excerpt ?? r.reason))
  }
  lines.push(envCompleteness(root), bundleBudget(root, release), dependencies(root), ...diffChecks(await host.files()))
  const ready = lines.every((l) => l.status === "pass")
  return { commit: await host.commit(), ready, lines }
}

const defaultRendered = (root) => async (app) => {
  const pages = await uiReports({ root, label: "release", app })
  return [judgeUi(pages), judgeA11y(pages)].map((r) => (r.status === "not_checked" && r.optional ? { ...r, status: "not_checked" } : r))
}

/* ─────────────────────────── ready and smoked ─────────────────────────── */

export const readState = (root) => readJson(stateFile(root), { records: [], forPerson: [] })
function record(root, entry) {
  const state = readState(root)
  state.records = [...state.records, entry].slice(-50)
  writeJson(stateFile(root), state)
  return state
}
export const recordReady = (root, commit, ready, lines) => record(root, { kind: "ready", commit, ready, lines: lines.map((l) => ({ id: l.id, status: l.status })), at: new Date().toISOString() })
export const recordSmoke = (root, entry) => record(root, { kind: "smoke", at: new Date().toISOString(), ...entry })

/** Production needs a passing `ready` and a passing preview `smoked` for this very commit. */
export function productionAllowed(root, commit) {
  const records = readState(root).records
  const ready = records.findLast((r) => r.kind === "ready" && r.commit === commit)
  const smoked = records.findLast((r) => r.kind === "smoke" && r.target === "preview" && r.commit === commit)
  if (!ready?.ready) return { ok: false, why: "G-RELEASE hasn't passed on this commit (release_check)." }
  if (!smoked?.ok) return { ok: false, why: "No preview of this commit has passed G-DEPLOYED yet (deploy a preview first)." }
  return { ok: true }
}

/* ─────────────────────────── WD-22: the person's ─────────────────────────── */

// Commands the harness never runs; each is written down for the person instead
export const PERSONS_ONLY = [
  [/\bsupabase\s+db\s+(push|reset)\b/i, "applies migrations to a hosted database"],
  [/\bsupabase\s+migration\s+up\b[^\n]*--linked/i, "applies migrations to a hosted database"],
  [/\bprisma\s+(migrate\s+(deploy|reset)|db\s+push)\b/i, "changes the schema of the database DATABASE_URL points at"],
  [/\b(drizzle-kit|knex|sequelize|typeorm|alembic|flyway|liquibase)\b[^\n]*\b(migrate|push|upgrade|migration:run)\b/i, "runs database migrations"],
  [/\b(vercel|netlify)\s+env\s+(add|rm|remove|set|unset|pull)\b|\bnetlify\s+env:(set|unset|import)\b/i, "changes a deployment's environment variables"],
  [/\bwrangler\s+secret\s+(put|delete|bulk)\b|\b(fly|flyctl)\s+secrets\s+(set|unset|import)\b|\bheroku\s+config:(set|unset)\b/i, "changes production secrets"],
  [/\b(vercel\s+(dns|domains)|netlify\s+(dns|domains)|wrangler\s+dns|(fly|flyctl)\s+(certs|ips)|aws\s+route53|gcloud\s+dns)\b/i, "changes DNS or domains"],
  [/\bgh\s+pr\s+merge\b|\bglab\s+mr\s+merge\b|\bgit\s+merge\b|\bgit\s+push\b[^\n]*\s(-f|--force|--force-with-lease)\b|\bgit\s+push\b[^\n]*[\s:](main|master)(\s|$)/i, "merges or rewrites a shared branch"],
  [/\b(vercel\s+(rm|remove)|netlify\s+sites:delete|wrangler\s+pages\s+(project|deployment)\s+delete|(fly|flyctl)\s+(apps\s+destroy|destroy))\b/i, "deletes a deployment or app"],
]

/** Why a command is the person's alone, or undefined. */
export const personsOnly = (command) => PERSONS_ONLY.find(([re]) => re.test(String(command ?? "")))?.[1]

/** Writes the refused command down for the person (it goes into the receipt and release state). */
export function forPerson(root, command, why) {
  const state = readState(root)
  const entry = { command: String(command).slice(0, 500), why, at: new Date().toISOString() }
  state.forPerson = [...(state.forPerson ?? []), entry].slice(-20)
  writeJson(stateFile(root), state)
  return entry
}

/* ───────────────────────────── G-DEPLOYED ───────────────────────────── */

export const DEPLOYED_MAX_REQUESTS = 20
const SECURITY = { "content-security-policy": "Content-Security-Policy", "strict-transport-security": "Strict-Transport-Security", "x-content-type-options": "X-Content-Type-Options", "x-frame-options": "X-Frame-Options" }

/**
 * Checks a deployed URL: only its host, GET/HEAD only, no cookies,
 * credentials or body, redirects followed only within the host, at most 20
 * requests. Each route in release.json must answer 2xx (HTML for pages),
 * the home page must contain the marker if one is set, and the headers the
 * project listed must be present. Latency is reported, never gated.
 */
export async function gDeployed(target, release, { fetchImpl = fetch, now = Date.now } = {}) {
  let base
  try {
    base = new URL(target)
  } catch {
    return { id: "G-DEPLOYED", status: "fail", problems: ["not a URL"], requests: 0 }
  }
  if (base.protocol !== "https:" || base.username || base.password) return { id: "G-DEPLOYED", status: "fail", problems: ["only an https URL without credentials is checked"], requests: 0 }
  const host = base.host
  let requests = 0
  const problems = []
  const timings = []
  const get = async (path, method = "GET") => {
    let url = new URL(path, base)
    for (let hop = 0; hop < 5; hop++) {
      if (url.host !== host || url.protocol !== "https:") throw new ReleaseError(`a redirect left ${host}`)
      if (requests >= DEPLOYED_MAX_REQUESTS) throw new ReleaseError(`the ${DEPLOYED_MAX_REQUESTS}-request limit`)
      requests++
      const started = now()
      const res = await fetchImpl(url, { method, redirect: "manual", credentials: "omit", headers: { accept: "text/html,*/*" }, signal: AbortSignal.timeout(15_000) })
      timings.push(now() - started)
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location"), url)
        continue
      }
      return res
    }
    throw new ReleaseError("too many redirects")
  }
  const routes = release?.routes?.length ? release.routes : ["/"]
  try {
    for (const route of routes) {
      const res = await get(route)
      if (res.status < 200 || res.status > 299) problems.push(`${route} answered ${res.status}`)
      else if (!/text\/html|application\/json/.test(res.headers.get("content-type") ?? "")) problems.push(`${route} answered ${res.headers.get("content-type") ?? "no content type"}`)
      if (route === routes[0]) {
        if (release?.marker && !(await res.text()).includes(release.marker)) problems.push(`${route} doesn't contain the marker text`)
        for (const h of release?.headers ?? []) {
          const v = res.headers.get(h)
          if (h === "x-frame-options" && !v && /frame-ancestors/.test(res.headers.get("content-security-policy") ?? "")) continue
          if (!v) problems.push(`the ${SECURITY[h]} header is missing`)
        }
      }
    }
  } catch (error) {
    problems.push(`stopped: ${error?.message ?? error}`)
  }
  const sorted = [...timings].sort((a, b) => a - b)
  return {
    id: "G-DEPLOYED",
    status: problems.length ? "fail" : "pass",
    host,
    requests,
    ...(sorted.length && { medianMs: sorted[Math.floor((sorted.length - 1) / 2)] }),
    ...(problems.length && { problems }),
  }
}
