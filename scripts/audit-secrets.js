#!/usr/bin/env node
// EG-2 (ED17): what the Editing Studio leaves on disk holds no secret, and what a person
// shares (receipts, reports) holds no path of theirs. Scans ~/.kriya/edit/ (logs,
// journals, indexes, history, outbox) and each project's exports/. Prints where and
// what kind, never the value. Exit 1 on any finding.
//
//   node scripts/audit-secrets.js [--home <kriya home>] [--exports <folder>]...

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, extname, join } from "node:path"

import { kriyaHome } from "../src/paths.js"

// Media and pictures: no text a secret could be written into, and they're large
const SKIP = new Set([".mp4", ".mov", ".m4a", ".wav", ".mp3", ".webm", ".mkv", ".jpg", ".jpeg", ".png", ".f32", ".pcm", ".raw", ".cube"])
const SHARED = /\.(receipt\.json|report\.html|report\.json)$/

const PATTERNS = [
  ["bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["provider key", /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}/],
  ["Studio cookie", /kriya_edit=[A-Za-z0-9_-]{20,}/],
  ["launch token", /\/launch#[A-Za-z0-9_-]{43}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
]
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|COOKIE/i

/** Literal values to look for: the device token and secret-named variables of this environment. */
export function secretValues({ home, env = process.env }) {
  const values = new Map()
  try {
    const device = JSON.parse(readFileSync(join(home, "device.json"), "utf8"))
    if (typeof device.token === "string" && device.token.length >= 16) values.set(device.token, "device token")
  } catch {
    // Not signed in on this computer
  }
  // A path or a sentence in a secret-named variable is a setting, not a secret
  for (const [name, value] of Object.entries(env)) if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= 16 && !/^[/~.]|\s/.test(value) && !values.has(value)) values.set(value, `value of ${name}`)
  return values
}

/** The person's own paths, as they'd appear in a shared file. */
export function pathPatterns(home = homedir()) {
  return [
    ["home path", new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ["user path", /(?:\/Users|\/home)\/[^/\s"'<>]+\//],
    ["user path", /[A-Za-z]:\\\\?Users\\\\?[^\\\s"'<>]+/],
  ]
}

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

/** The exports folders of every registered project. */
export function exportsOf(home) {
  const registry = join(home, "edit", "projects.json")
  if (!existsSync(registry)) return []
  try {
    return JSON.parse(readFileSync(registry, "utf8")).map((p) => join(dirname(p.file), "exports"))
  } catch {
    return []
  }
}

/**
 * @param {{ home: string, exports?: string[], env?: object, user?: string }} options
 * @returns {{ files: number, findings: { file: string, kind: string }[] }}
 */
export function audit({ home, exports = exportsOf(home), env = process.env, user = homedir() }) {
  const values = secretValues({ home, env })
  const paths = pathPatterns(user)
  const findings = []
  let files = 0
  const scan = (file, shared) => {
    if (SKIP.has(extname(file).toLowerCase())) return
    let text
    try {
      if (statSync(file).size > 1 << 30) return
      // latin1 keeps every byte, so text inside SQLite pages is found too
      text = readFileSync(file).toString("latin1")
    } catch (error) {
      // A SQLite -shm or a temporary file can go while it's read
      if (error.code === "ENOENT") return
      throw error
    }
    files++
    for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) findings.push({ file, kind })
    for (const [value, kind] of values) if (text.includes(value)) findings.push({ file, kind })
    if (shared) for (const [kind, pattern] of paths) if (pattern.test(text)) findings.push({ file, kind })
  }
  for (const file of walk(join(home, "edit"))) scan(file, SHARED.test(file))
  for (const dir of exports) for (const file of walk(dir)) if (SHARED.test(file)) scan(file, true)
  return { files, findings: findings.filter((f, i) => findings.findIndex((g) => g.file === f.file && g.kind === f.kind) === i) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const home = args.includes("--home") ? args[args.indexOf("--home") + 1] : kriyaHome()
  const extra = args.flatMap((arg, i) => (arg === "--exports" ? [args[i + 1]] : []))
  const { files, findings } = audit({ home, exports: [...exportsOf(home), ...extra] })
  for (const f of findings) console.log(`${f.file}: ${f.kind}`)
  console.log(`audit-secrets: ${files} files scanned, ${findings.length} findings`)
  process.exit(findings.length ? 1 : 0)
}
