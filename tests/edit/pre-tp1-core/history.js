// History (EDIT_ENGINE §4, DATA_MODEL §5.4): an append-only log. Undo moves HEAD and
// nothing is deleted. The caller passes the time, so this stays pure.

import { apply, opShapeErrors } from "./ops.js"
import { canonical, check, hashProject, sha256 } from "./project.js"

const ENTRY = {
  id: "id",
  parent: { nullable: "id" },
  author: { enum: ["person", "agent", "code"] },
  ops: { list: "plain" },
  "promptRef?": "str",
  hash: "str",
  at: "str",
}

export const createLog = (project) => ({ root: project, entries: [], head: null, current: project })

const entryOf = (log, id) => {
  const entry = log.entries.find((e) => e.id === id)
  if (!entry) throw new RangeError(`no version "${id}"`)
  return entry
}

/** The project at a version, rebuilt from the root by replay. */
export function projectAt(log, id, ctx) {
  const chain = []
  for (let at = id; at !== null; at = entryOf(log, at).parent) chain.unshift(entryOf(log, at))
  let project = log.root
  for (const entry of chain) {
    const result = apply(project, entry.ops, { ...ctx, author: entry.author })
    if (!result.applied) throw new RangeError(`version "${entry.id}" no longer replays: ${result.diagnostics[0].message}`)
    project = result.project
  }
  return project
}

/** Applies operations at HEAD and appends the entry; refused operations change nothing. */
export function commit(log, { ops, author, at, promptRef }, ctx) {
  const result = apply(log.current, ops, { ...ctx, author })
  if (!result.applied) return { ok: false, log, project: log.current, diagnostics: result.diagnostics }
  const id = sha256(canonical([log.entries.length, log.head, author, ops, at])).slice(0, 16)
  const entry = { id, parent: log.head, author, ops, ...(promptRef === undefined ? {} : { promptRef }), hash: hashProject(result.project), at }
  return { ok: true, log: { ...log, entries: [...log.entries, entry], head: id, current: result.project }, project: result.project, diagnostics: [] }
}

/** Moves HEAD to a version. New work from there starts a branch. */
export function checkout(log, id, ctx) {
  return { ...log, head: id, current: projectAt(log, id, ctx) }
}

export function undo(log, ctx) {
  return log.head === null ? log : checkout(log, entryOf(log, log.head).parent, ctx)
}

/** Re-applies every entry and compares its hash. */
export function replay(log, ctx) {
  const mismatches = log.entries.filter((entry) => {
    try {
      return hashProject(projectAt(log, entry.id, ctx)) !== entry.hash
    } catch {
      return true
    }
  })
  return { ok: mismatches.length === 0, mismatches: mismatches.map((entry) => entry.id) }
}

/** The compact Version list mirrored into the project file. */
export function versions(log) {
  let next = 0
  return log.entries.map(({ id, parent, author, ops, hash, at }) => {
    const opsRange = [next, (next += ops.length)]
    const name = ops.findLast((op) => op.op === "name_version")?.name
    return { id, parent, ...(name === undefined ? {} : { name }), author, opsRange, hash, at }
  })
}

/** One ops.jsonl line, validated against the same schema as live operations. */
export function parseEntry(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return { ok: false, errors: [{ path: "", reason: "this history line isn't valid JSON" }] }
  }
  const errors = []
  check(entry, ENTRY, "", errors)
  if (errors.length === 0) for (const op of entry.ops) errors.push(...opShapeErrors(op).map(({ message }) => ({ path: "ops", reason: message })))
  return errors.length ? { ok: false, errors } : { ok: true, entry, errors }
}
