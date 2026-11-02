import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"

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

/* ─────────────────────── the Skills page (plugins/skills) ─────────────────────── */

/** A skill name as DSH accepts it: kebab-case. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The largest SKILL.md the Skills page saves. */
export const MAX_SKILL_BYTES = 64 * 1024

const named = (name) => {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) throw new SkillsError("That isn't a skill name.")
  return name
}

// linked: a link into ~/.kriya/skills or a project root (editing would change
// its source, a plugin or a repository); yours: a real folder you own
function describe(skill) {
  const folder = skill.locator?.directory ?? dirname(skill.locator?.path ?? "")
  const linked = isLink(folder)
  return {
    name: skill.name,
    description: skill.description.replace(/\s+/g, " ").trim(),
    where: SKILL_ROOTS[skill.source] ?? skill.source,
    source: skill.source,
    path: skill.locator?.path ?? null,
    linked,
    linkTarget: linked ? safeRealpath(folder) : null,
    // A link in ~/.kriya/skills can become your own copy; elsewhere it can't
    canCopy: linked && skill.source === "user-dsh",
    editable: !linked && Boolean(skill.locator?.path),
    modelInvocable: skill.invocation?.modelInvocable !== false,
    userInvocable: skill.invocation?.userInvocable !== false,
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Everything the Skills page shows for the folder the agent works in. */
export async function skillsPage(cwd, roots = {}) {
  const seen = await visibleSkills(cwd, roots)
  return {
    skills: seen.skills.map(describe),
    shadowed: seen.shadowed.map(describe),
    broken: seen.broken,
    warnings: seen.warnings,
    catalogChars: seen.catalogChars,
    catalogTokens: Math.round(seen.catalogChars / 4),
    heavy: seen.catalogChars > HEAVY_CATALOG,
    skillsDir: skillsDir(),
  }
}

async function find(cwd, name, roots) {
  const { skills } = await visibleSkills(cwd, roots)
  const skill = skills.find((s) => s.name === named(name))
  if (!skill) throw new SkillsError(`No skill named ${name} here.`)
  return skill
}

/** One skill's SKILL.md, found through the catalog (never a path from the caller). */
export async function readSkillFile(cwd, name, roots = {}) {
  const skill = await find(cwd, name, roots)
  return { ...describe(skill), content: readFileSync(skill.locator.path, "utf8") }
}

const frontmatterName = (content) => /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(content)?.[1]

/**
 * Saves a skill you own. DSH's parser checks the result: if it would drop the
 * skill (bad frontmatter), the old file goes back and its warning is returned.
 */
export async function saveSkillFile(cwd, name, content, roots = {}) {
  if (typeof content !== "string") throw new SkillsError("Nothing to save.")
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new SkillsError("A skill can be at most 64 KB.")
  const skill = await find(cwd, name, roots)
  const info = describe(skill)
  if (!info.editable) {
    throw new SkillsError(
      info.canCopy
        ? "This skill is linked from elsewhere. Make your own copy first, so the source stays as it is."
        : "This skill is linked from elsewhere; edit it where it comes from."
    )
  }
  if (frontmatterName(content) !== name) {
    throw new SkillsError(`Keep "name: ${name}" in the frontmatter; to rename, create a new skill.`)
  }
  // The file must really live in the skill's own folder (no link out of it)
  const file = skill.locator.path
  const real = safeRealpath(file)
  if (!real || relative(safeRealpath(dirname(file)), real).startsWith("..")) {
    throw new SkillsError("This skill's file is a link; edit it where it comes from.")
  }
  const before = readFileSync(file, "utf8")
  const temp = `${file}.kriya-saving`
  writeFileSync(temp, content)
  renameSync(temp, file)
  const after = await visibleSkills(cwd, roots)
  if (!after.skills.some((s) => s.name === name)) {
    writeFileSync(temp, before)
    renameSync(temp, file)
    const why = after.warnings.find((w) => w.includes(file) || w.includes(name)) ?? after.warnings[0]
    throw new SkillsError(`Not saved: the agent couldn't read it${why ? ` (${why})` : ""}. Your previous version is kept.`)
  }
  return readSkillFile(cwd, name, roots)
}

/** Turns a link in ~/.kriya/skills into your own folder, a copy of its source. */
export async function copySkill(cwd, name, roots = {}) {
  const at = join(skillsDir(), named(name))
  if (!isLink(at)) throw new SkillsError(`${name} isn't a linked skill in ${skillsDir()}.`)
  const source = safeRealpath(at)
  if (!source) throw new SkillsError(`${name}'s source folder is gone; unlink it.`)
  const temp = join(skillsDir(), `.${name}.kriya-copy`)
  rmSync(temp, { recursive: true, force: true })
  cpSync(source, temp, { recursive: true, dereference: true })
  unlinkSync(at)
  renameSync(temp, at)
  return readSkillFile(cwd, name, roots)
}

/** A new skill of yours in ~/.kriya/skills, with a starting outline. */
export async function createSkill(cwd, name, description, roots = {}) {
  named(name)
  const text = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : ""
  if (text.length < 10) throw new SkillsError("Say when the agent should use it (at least 10 characters).")
  if (text.length > 1000) throw new SkillsError("Keep the description under 1,000 characters.")
  const { skills } = await visibleSkills(cwd, roots)
  if (skills.some((s) => s.name === name)) throw new SkillsError(`There's already a skill named ${name}.`)
  const folder = join(skillsDir(), name)
  if (existsSync(folder) || isLink(folder)) throw new SkillsError(`${folder} already exists.`)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(text)}\n---\n\n# ${name}\n\nWrite how to do this job well: the steps, what to check, and what to avoid.\n`
  )
  return readSkillFile(cwd, name, roots)
}
