import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, resolve, sep } from "node:path"

// The Projects page (plugins/projects): folders on this computer that look
// like projects, so the person opens one as a workspace in a click, as
// Claude's desktop app lists its folders. Read-only: names, paths and
// times; nothing inside a project is read beyond the markers below.
//
// Where it looks: the usual folders under home, one level deep, and one
// more level for group folders (~/Developer/<org>/<repo>). macOS asks the
// person before an app reads Desktop, Documents or Downloads, so those are
// only searched when named in KRIYA_PROJECT_ROOTS (paths, separated like
// PATH), which also adds any other folder.

export const ROOTS = ["Developer", "Projects", "projects", "Code", "code", "src", "dev", "repos", "Repos", "workspace", "Workspace", "GitHub", "git", "Sites", "work"]

// A folder with one of these is a project
export const MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Package.swift",
  "pubspec.yaml",
  "deno.json",
  "CMakeLists.txt",
  "Makefile",
]

const SKIP = new Set(["node_modules", "Library", "Applications", "vendor", "target", "dist", "build"])
export const LIMIT = 500
// Directory listings per scan: keeps a huge home from stalling the page
const BUDGET = 4000

const isProject = (dir) => MARKERS.some((marker) => existsSync(join(dir, marker)))

function children(dir, budget) {
  if (budget.left-- <= 0) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith(".") && !SKIP.has(entry.name))
      .map((entry) => join(dir, entry.name))
  } catch {
    // Unreadable (permissions, vanished): not a place to look
    return []
  }
}

function describe(path, root, home) {
  try {
    const real = realpathSync(path)
    const stat = statSync(real)
    if (!stat.isDirectory()) return undefined
    return {
      name: real.split(sep).pop(),
      path: real,
      shown: real === home ? "~" : real.startsWith(home + sep) ? "~" + real.slice(home.length) : real,
      root,
      git: existsSync(join(real, ".git")),
      modifiedAt: stat.mtime.toISOString(),
    }
  } catch {
    return undefined
  }
}

/**
 * The project folders, most recently changed first.
 * @param {{ home?: string, cwd?: string, extra?: string }} [where] extra: KRIYA_PROJECT_ROOTS
 * @returns {{ projects: Array<{ name: string, path: string, shown: string, root: string, git: boolean, modifiedAt: string, here?: boolean }>, roots: string[], truncated: boolean }}
 */
export function findProjects({ home = homedir(), cwd = process.cwd(), extra = process.env.KRIYA_PROJECT_ROOTS ?? "" } = {}) {
  const roots = [
    ...extra.split(delimiter).filter(Boolean).map((path) => resolve(home, path.replace(/^~(?=$|\/)/, home))),
    ...ROOTS.map((name) => join(home, name)),
  ].filter((dir, i, all) => all.indexOf(dir) === i && existsSync(dir))
  const budget = { left: BUDGET }
  const found = new Map()
  const add = (path, root) => {
    const project = describe(path, root, home)
    if (project && !found.has(project.path)) found.set(project.path, project)
  }
  for (const root of roots) {
    const label = root.startsWith(home + sep) ? "~" + root.slice(home.length) : root
    for (const dir of children(root, budget)) {
      if (found.size >= LIMIT) break
      if (isProject(dir)) add(dir, label)
      else for (const inner of children(dir, budget)) if (isProject(inner)) add(inner, label)
    }
  }
  // The folder Kriya Harness was started in, project or not
  const here = describe(cwd, "Started here", home)
  if (here) found.set(here.path, { ...(found.get(here.path) ?? here), here: true })
  const projects = [...found.values()].sort((a, b) => Number(Boolean(b.here)) - Number(Boolean(a.here)) || b.modifiedAt.localeCompare(a.modifiedAt))
  return { projects: projects.slice(0, LIMIT), roots, truncated: projects.length > LIMIT || budget.left <= 0 }
}
