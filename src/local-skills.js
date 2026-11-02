import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

import { PACKAGE_ROOT, kriyaHome } from "./paths.js"

// `kriya skills`: local SKILL.md skills (superpowers, ponytail, ECC, your
// own) for the agent on this machine. DSH reads them from the folder's
// .dsh/skills and .agents/skills, ~/.kriya/skills and ~/.agents/skills; Kriya
// account skills come on top through the kriya bundle (H7) and aren't listed.

const require = createRequire(join(PACKAGE_ROOT, "package.json"))

/** Where `kriya skills link` puts skills: DSH_HOME/skills for every Kriya profile. */
export const skillsDir = () => join(kriyaHome(), "skills")

// The catalog renders at most this much of each description (dsh-tool-skill's
// catalogDescriptionMaxLength default), plus the name
const CATALOG_DESCRIPTION = 500
/** DSH's root labels, as folders a person recognises. */
export const SKILL_ROOTS = {
  "project-dsh": ".dsh/skills (this project)",
  "project-agents": ".agents/skills (this project)",
  custom: "custom folder",
  "user-dsh": "~/.kriya/skills",
  "user-agents": "~/.agents/skills",
}

/** Above this many catalog characters, `kriya skills` warns about the cost. */
export const HEAVY_CATALOG = 40_000

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The skills the agent's catalog gets in `cwd`, read by DSH's own provider so
 * this never disagrees with it. A name in several roots: the lower rank wins.
 * shortcut: a minimal stand-in for DSH's Context (logger, get, effect, on);
 * the exact DSH pin and tests/local-skills.test.js catch a change on upgrade.
 * @param {string} cwd
 * @param {{ agentsHome?: string }} [roots]
 */
export async function visibleSkills(cwd, roots = {}) {
  const { FileSystemSkillProvider } = await import(require.resolve("@deepseek-ai/dsh-skill-filesystem"))
  const warnings = []
  const note = (...args) => warnings.push(args.map(String).join(" "))
  // DSH calls both ctx.logger(name) and ctx.logger.warn(...)
  const logger = Object.assign(() => logger, { warn: note, error: note, info() {}, debug() {} })
  const ctx = { logger, get: () => undefined, effect() {}, on: () => () => {} }
  const provider = new FileSystemSkillProvider(
    ctx,
    { invalidate() {}, signal: new AbortController().signal },
    { dshHome: kriyaHome(), agentsHome: roots.agentsHome, watch: false }
  )
  const found = [...(await provider.list({ cwd }))].sort((a, b) => a.rank - b.rank)
  const skills = []
  const shadowed = []
  for (const skill of found) (skills.some((s) => s.name === skill.name) ? shadowed : skills).push(skill)
  const catalogChars = skills
    .filter((s) => s.invocation?.modelInvocable !== false)
    .reduce((n, s) => n + s.name.length + Math.min(s.description.replace(/\s+/g, " ").trim().length, CATALOG_DESCRIPTION), 0)
  // Links in ~/.kriya/skills whose target is gone (a plugin updated or moved)
  const dir = skillsDir()
  const broken = existsSync(dir)
    ? readdirSync(dir).filter((name) => isLink(join(dir, name)) && !existsSync(join(dir, name)))
    : []
  return { skills, shadowed, catalogChars, broken, warnings }
}

export class SkillsError extends Error {}

/**
 * Links each `<name>/SKILL.md` bundle in `folder` into ~/.kriya/skills. A name
 * already there is left alone (yours, or linked before). Links, not copies,
 * so a `git pull` of the source reaches the agent.
 * @param {string} folder
 * @param {string[]} [only] names to link; all by default
 */
export function linkSkills(folder, only) {
  const from = resolve(folder)
  if (!existsSync(from)) throw new SkillsError(`${folder}: no such folder`)
  const bundles = readdirSync(from).filter((name) => existsSync(join(from, name, "SKILL.md")))
  if (only) {
    const unknown = only.filter((name) => !bundles.includes(name))
    if (unknown.length) throw new SkillsError(`not a skill in ${folder}: ${unknown.join(", ")}`)
  }
  if (bundles.length === 0) throw new SkillsError(`${folder} has no <name>/SKILL.md skills`)
  const target = skillsDir()
  mkdirSync(target, { recursive: true })
  const linked = []
  const kept = []
  for (const name of only ?? bundles) {
    const at = join(target, name)
    if (existsSync(at) || isLink(at)) {
      kept.push(name)
      continue
    }
    symlinkSync(join(from, name), at, "dir")
    linked.push(name)
  }
  return { linked, kept }
}

/** Removes a linked skill; a real folder in ~/.kriya/skills is never deleted. */
export function unlinkSkill(name) {
  // A skill name, never a path out of ~/.kriya/skills
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new SkillsError(`${name} isn't a skill name`)
  const at = join(skillsDir(), name)
  if (!isLink(at)) {
    throw new SkillsError(
      existsSync(at) ? `${name} is a folder, not a link; remove it yourself if you mean to` : `${name} isn't linked`
    )
  }
  unlinkSync(at)
}
