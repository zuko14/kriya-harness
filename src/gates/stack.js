import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { hostedDatabase, isLocalDatabase, readStack } from "../stack.js"

// Harness 2.0 W4: G-STACK (Kriya-Tavi docs/kriya-harness/upgrade_2.0/GATES.md
// §3, WD-05). The migrations this work added or changed really apply to the
// person's local database, and every tenant table they create has row-level
// security with a policy. All of it runs inside one transaction that is
// always rolled back (Postgres DDL is transactional), so the database is left
// exactly as it was. Only a database the person confirmed with `kriya stack
// use --db`, only on this computer, and never while the project's own env
// files point at a hosted one.

export const MIGRATION = /(^|\/)(supabase\/migrations|migrations|db\/migrations|database\/migrations)\/[^/]+\.sql$|(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/
export const CONTRACT_SCHEMA = ".kriya/contracts/schema.sql"
const PSQL_MS = 5 * 60_000
const NO_TRANSACTION = /cannot run inside a transaction block|cannot be executed inside a transaction|ALTER TYPE \.\.\. ADD cannot run inside a transaction block/i

const psql = (args, input) =>
  new Promise((done) => {
    const child = execFile("psql", args, { timeout: PSQL_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PGCONNECT_TIMEOUT: "10" } }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === "number" ? error.code : 127) : 0, missing: error?.code === "ENOENT", stdout: String(stdout), stderr: String(stderr) })
    )
    if (input !== undefined) child.stdin.end(input)
  })

/** Tables a migration creates, schema-qualified (public by default) */
export function createdTables(sql) {
  return [...sql.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?[\w]+"?\.)?"?[\w]+"?)/gi)].map((m) => {
    const name = m[1].replace(/"/g, "")
    return name.includes(".") ? name : `public.${name}`
  })
}

/** True when SQL controls transactions itself or holds psql meta-commands (outside comments and dollar-quoted bodies). */
export function ownsTransaction(sql) {
  const plain = sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
  return /(^|;)\s*(begin|start\s+transaction|commit|end|rollback|savepoint|release)\b/im.test(plain) || /^\s*\\/m.test(plain)
}

const quote = (path) => `'${path.replace(/'/g, "''")}'`

/** The script psql runs: every file in one transaction, the RLS facts between markers, then ROLLBACK. Pure, for tests. */
export function stackScript(files, tables) {
  const list = tables.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ")
  return [
    "\\set ON_ERROR_STOP 1",
    "\\pset format unaligned",
    "\\pset tuples_only on",
    "BEGIN;",
    ...files.map((f) => `\\i ${quote(f)}`),
    "\\echo KRIYA-RLS-BEGIN",
    ...(tables.length
      ? [
          `SELECT n.nspname || '.' || c.relname || '|' || c.relrowsecurity::text || '|' || (SELECT count(*) FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname || '.' || c.relname IN (${list});`,
        ]
      : []),
    "\\echo KRIYA-RLS-END",
    "ROLLBACK;",
    "",
  ].join("\n")
}

/**
 * G-STACK for one verify.
 * @param {{ root: string, changed: string[], tenantTables: (name: string) => boolean, run?: typeof psql }} input
 */
export async function stackGate({ root, changed, tenantTables, run = psql }) {
  const id = "G-STACK"
  const files = changed.filter((rel) => MIGRATION.test(rel) || rel === CONTRACT_SCHEMA).sort()
  if (!files.length) return { id, status: "pass", note: "no migration in this work" }
  const { db } = readStack(root)
  if (!db) return { id, status: "not_checked", optional: true, reason: "no local database is confirmed for this project (kriya stack use --db postgresql://…@127.0.0.1:<port>/<db>)" }
  if (!isLocalDatabase(db)) return { id, status: "not_checked", reason: "the confirmed database isn't on this computer; confirm a local one" }
  const hosted = hostedDatabase(root)
  if (hosted) return { id, status: "not_checked", reason: `${hosted.variable} in ${hosted.file} points off this computer, so no migration is run from this project` }
  const version = await run(["--version"])
  if (version.missing) return { id, status: "not_checked", reason: "psql isn't installed" }
  const texts = files.map((rel) => [rel, readFileSync(join(root, rel), "utf8")])
  // A file that ends or starts transactions itself, or runs psql meta-commands (\\connect, \\i …),
  // could commit inside ours and keep changes in the person's database: it isn't run
  const own = texts.find(([, text]) => ownsTransaction(text))
  if (own) return { id, status: "not_checked", reason: `${own[0]} manages its own transaction or uses psql commands, so it isn't applied here (nothing may be kept in your database)` }
  const tables = [...new Set(texts.flatMap(([, text]) => createdTables(text)))]
  const dir = mkdtempSync(join(tmpdir(), "kriya-stack-"))
  try {
    const script = join(dir, "gate.sql")
    writeFileSync(script, stackScript(files.map((rel) => join(root, rel)), tables), { mode: 0o600 })
    const out = await run([db, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", script])
    if (out.code !== 0) {
      const error = (out.stderr || out.stdout).replace(/postgres(ql)?:\/\/[^\s]+/g, "<database>").trim().slice(-1500)
      if (NO_TRANSACTION.test(error)) return { id, status: "not_checked", reason: "a migration can't run inside a transaction (e.g. CREATE INDEX CONCURRENTLY), so it isn't tried here" }
      if (/could not connect|connection refused|timeout expired|no such file or directory/i.test(error)) return { id, status: "not_checked", reason: "the local database doesn't answer; start it, or confirm another with kriya stack use --db" }
      return { id, status: "fail", kind: "gate", excerpt: `G-STACK: the migrations don't apply to the local database (rolled back, nothing kept):\n${error}` }
    }
    const between = /KRIYA-RLS-BEGIN\n([\s\S]*?)KRIYA-RLS-END/.exec(out.stdout)?.[1] ?? ""
    const rows = between.split("\n").filter(Boolean).map((l) => l.split("|"))
    const missing = rows.filter(([name, rls, policies]) => tenantTables(name) && (rls !== "true" || Number(policies) === 0)).map(([name, rls, policies]) => `${name}: ${rls !== "true" ? "row-level security is off" : "no policy"}${rls === "true" && Number(policies) === 0 ? " (every query is refused)" : ""}`)
    if (missing.length) return { id, status: "fail", kind: "gate", excerpt: `G-STACK: tenant tables without row-level security and a policy (checked on the local database, rolled back):\n${missing.map((m) => `- ${m}`).join("\n")}` }
    return { id, status: "pass", note: `${files.length} migration file(s) applied and rolled back; ${rows.length} table(s) checked` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
