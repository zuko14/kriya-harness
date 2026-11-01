import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// THIRD_PARTY_NOTICES.md from the lockfile (DSH_DISTRIBUTION §6, HT-REL-01,
// HT-REL-02). Every package the release installs (not dev tools) must have
// a license on the allow-list, or a recorded exception in
// notices-exceptions.json; an unknown license fails. `--check` regenerates
// in memory and fails when the committed file differs; `--strict` (the
// release gate) also fails on any license problem, which `--check` only
// reports.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md")

export const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Python-2.0",
])

/** An SPDX expression is allowed when every alternative of an OR, or every part of an AND, is. */
export function licenseAllowed(expression) {
  if (typeof expression !== "string" || !expression.trim()) return false
  const clean = expression.replace(/[()]/g, " ").trim()
  if (/\sOR\s/.test(clean)) return clean.split(/\s+OR\s+/).some((part) => licenseAllowed(part))
  if (/\sAND\s/.test(clean)) return clean.split(/\s+AND\s+/).every((part) => licenseAllowed(part))
  return ALLOWED.has(clean)
}

function licenseText(dir) {
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name))
  return file ? readFileSync(join(dir, file), "utf8").trim() : null
}

/** The release's packages from a lockfile: name, version, license, its notice text. */
export function releasePackages(lock, root = ROOT) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.startsWith("node_modules/") && !entry.dev && !entry.link)
    .map(([path, entry]) => ({
      name: entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      version: entry.version,
      license: entry.license ?? null,
      text: licenseText(join(root, path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)))
}

/** @returns {{ markdown: string, problems: string[] }} */
export function buildNotices(lock, exceptions = {}, root = ROOT) {
  const packages = releasePackages(lock, root)
  const problems = []
  for (const pkg of packages) {
    if (!licenseAllowed(pkg.license) && !exceptions[`${pkg.name}@${pkg.version}`])
      problems.push(`${pkg.name}@${pkg.version}: license ${pkg.license ?? "unknown"} isn't allowed`)
  }
  const dsh = packages.find((pkg) => pkg.name === "@deepseek-ai/dsh")
  let markdown = `# Third-party notices

Kriya Harness is built on DeepSeek Harness. This file lists every package a
release installs, with its license, generated from package-lock.json by
\`npm run notices\` (do not edit by hand).

## DeepSeek Harness

${dsh?.text ?? "(license text missing)"}

## Packages

| Package | Version | License |
| --- | --- | --- |
`
  for (const pkg of packages) markdown += `| ${pkg.name} | ${pkg.version} | ${pkg.license ?? "unknown"} |\n`
  markdown += "\n## License texts\n"
  // One copy of each distinct text, with every package that ships it
  const texts = new Map()
  for (const pkg of packages) {
    if (!pkg.text) continue
    const list = texts.get(pkg.text) ?? []
    list.push(`${pkg.name}@${pkg.version}`)
    texts.set(pkg.text, list)
  }
  for (const [text, names] of texts)
    markdown += `\n### ${names.join(", ")}\n\n\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\`\n`
  return { markdown, problems }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
  const exceptionsFile = join(ROOT, "notices-exceptions.json")
  const exceptions = existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, "utf8")) : {}
  const { markdown, problems } = buildNotices(lock, exceptions)
  for (const problem of problems) console.error(`notices: ${problem}`)
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : ""
    if (current !== markdown) {
      console.error("notices: THIRD_PARTY_NOTICES.md is out of date; run npm run notices")
      process.exit(1)
    }
    if (problems.length && process.argv.includes("--strict")) process.exit(1)
    console.log(
      problems.length
        ? `notices: current; ${problems.length} license problems block a release (npm run release:check)`
        : "notices: current, every license allowed"
    )
  } else {
    writeFileSync(OUT, markdown)
    console.log(`notices: wrote THIRD_PARTY_NOTICES.md`)
  }
}
