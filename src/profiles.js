import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { kriyaHome, PACKAGE_ROOT } from "./paths.js"
import { ensureHome } from "./store.js"

// The Kriya profiles under the Kriya home (DSH_HOME). Each is a DSH profile
// directory: package.json naming its bundles in order, and a link from its
// node_modules to this package, which DSH then resolves as the "kriya"
// bundle (bundle/cordis.patch.yml). The person's own cordis.patch.yml in a
// profile is never touched, so DSH's settings pages keep working.

export const PROFILES = {
  // `kriya`: DSH's local Web UI
  kriya: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@kriya-ai/harness"],
  // `kriya run "…"`: one job, final answer printed
  "kriya-run": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@kriya-ai/harness"],
  // `kriya acp`: DSH's ACP server over stdio, for editors (HD-13)
  "kriya-acp": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "@kriya-ai/harness"],
}

function manifest(name, bundles) {
  return (
    JSON.stringify(
      { name: `${name}-profile`, private: true, dsh: { profile: { bundles } } },
      null,
      2
    ) + "\n"
  )
}

// Packages of this repository a profile resolves by name: the bundle itself
// and the plugins the bundle mounts (the Web UI brand, approvals from the
// phone, the session mirror, Kriya skills and memory, the Skills page, the Changes tab)
export const LINKED = {
  "@kriya-ai/harness": PACKAGE_ROOT,
  "@kriya-ai/harness-brand": join(PACKAGE_ROOT, "plugins", "brand"),
  "@kriya-ai/harness-approvals": join(PACKAGE_ROOT, "plugins", "approvals"),
  "@kriya-ai/harness-mirror": join(PACKAGE_ROOT, "plugins", "mirror"),
  "@kriya-ai/harness-tools": join(PACKAGE_ROOT, "plugins", "kriya-tools"),
  "@kriya-ai/harness-skills": join(PACKAGE_ROOT, "plugins", "skills"),
  "@kriya-ai/harness-changes": join(PACKAGE_ROOT, "plugins", "changes"),
  "@kriya-ai/harness-overview": join(PACKAGE_ROOT, "plugins", "overview"),
  "@kriya-ai/harness-progress": join(PACKAGE_ROOT, "plugins", "progress"),
  "@kriya-ai/harness-preview": join(PACKAGE_ROOT, "plugins", "preview"),
  "@kriya-ai/harness-graph": join(PACKAGE_ROOT, "plugins", "graph"),
  "@kriya-ai/harness-browser": join(PACKAGE_ROOT, "plugins", "browser"),
  "@kriya-ai/harness-remote": join(PACKAGE_ROOT, "plugins", "remote"),
  "@kriya-ai/harness-sessions": join(PACKAGE_ROOT, "plugins", "sessions"),
  "@kriya-ai/harness-rea": join(PACKAGE_ROOT, "plugins", "rea"),
  "@kriya-ai/harness-router": join(PACKAGE_ROOT, "plugins", "router"),
  "@kriya-ai/harness-projects": join(PACKAGE_ROOT, "plugins", "projects"),
  "@kriya-ai/harness-fs-freshness": join(PACKAGE_ROOT, "plugins", "fs-freshness"),
  "@kriya-ai/harness-loop": join(PACKAGE_ROOT, "plugins", "loop"),
  "@kriya-ai/harness-budget": join(PACKAGE_ROOT, "plugins", "budget"),
  "@kriya-ai/harness-anchor": join(PACKAGE_ROOT, "plugins", "anchor"),
  "@kriya-ai/harness-edit": join(PACKAGE_ROOT, "plugins", "edit"),
}

function link(dir, name, target) {
  const path = join(dir, "node_modules", ...name.split("/"))
  mkdirSync(dirname(path), { recursive: true })
  let current = null
  try {
    current = lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : "not-a-link"
  } catch {
    // Missing: created below
  }
  if (current === resolve(target)) return
  // Only ever our own link (or a stale one from an older install) is replaced
  if (current !== null) rmSync(path, { force: true, recursive: current === "not-a-link" })
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir")
}

/** Creates or repairs one profile; returns its directory. Idempotent. */
export function ensureProfile(name) {
  const bundles = PROFILES[name]
  if (!bundles) throw new Error(`Unknown Kriya profile ${name}`)
  ensureHome()
  const dir = join(kriyaHome(), "profiles", name)
  mkdirSync(dir, { recursive: true })
  // Rewritten each time: the bundle list is this package's, not the person's
  writeFileSync(join(dir, "package.json"), manifest(name, bundles))
  for (const [packageName, target] of Object.entries(LINKED)) link(dir, packageName, target)
  return dir
}

export function ensureProfiles() {
  return Object.keys(PROFILES).map(ensureProfile)
}

export const hasProfile = (name) => existsSync(join(kriyaHome(), "profiles", name, "package.json"))
