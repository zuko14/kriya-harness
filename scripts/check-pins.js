import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// HT-REL-01 (pins): every direct dependency is an exact version, the
// lockfile exists and names the same versions. A range would let a DSH
// release candidate change under us (HD-02: upgrades are recorded bumps).

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export function pinProblems(pkg, lock) {
  const problems = []
  if (!lock || lock.lockfileVersion < 3) problems.push("package-lock.json missing or older than lockfileVersion 3")
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!EXACT.test(spec)) problems.push(`${name}@${spec} isn't an exact version`)
      const locked = lock?.packages?.[`node_modules/${name}`]?.version
      if (locked !== spec) problems.push(`${name}: package.json ${spec}, lockfile ${locked ?? "missing"}`)
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  let lock = null
  try {
    lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
  } catch {
    // Reported as a problem below
  }
  const problems = pinProblems(pkg, lock)
  for (const problem of problems) console.error(`pins: ${problem}`)
  if (problems.length) process.exit(1)
  console.log("pins: every dependency exact and locked")
}
