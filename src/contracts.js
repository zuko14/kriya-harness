import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { Ajv2020 } from "ajv/dist/2020.js"

import { PACKAGE_ROOT } from "./paths.js"

// Harness 2.0 W3, the contract bus (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// ORCHESTRA.md §5): typed files steps hand each other instead of chat, kept in
// the project under .kriya/contracts/ so the person can read and commit them.
// Code validates them, records each one's hash when the step whose role owns
// it passes, and fails any later step of another role that changes it
// (failure class "contract changed"). Builders get slices by JSON Pointer.

export const CONTRACTS_DIR = join(".kriya", "contracts")
export const CONTRACT_FILES = {
  api: "api.openapi.json",
  schema: "schema.sql",
  auth_matrix: "auth_matrix.json",
  design_tokens: "design_tokens.json",
  component_states: "component_states.json",
  threat_model: "threat_model.json",
  // Harness 2.0 W13 (WD-17): the designer's art direction for 3D, read by G-3D
  scene_direction: "scene_direction.json",
}
export const CONTRACT_NAMES = Object.keys(CONTRACT_FILES)

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
const validators = new Map()
function validator(name) {
  if (!validators.has(name)) {
    const file = join(PACKAGE_ROOT, "contract", "schemas", `${name}.json`)
    validators.set(name, existsSync(file) ? ajv.compile(JSON.parse(readFileSync(file, "utf8"))) : null)
  }
  return validators.get(name)
}

const path = (root, name) => join(root, CONTRACTS_DIR, CONTRACT_FILES[name])
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")

/** The contracts present in the project, with their bytes' sha256. */
export function presentContracts(root) {
  const out = {}
  for (const name of CONTRACT_NAMES) {
    const file = path(root, name)
    if (existsSync(file)) out[name] = sha(readFileSync(file))
  }
  return out
}

/** Problems with one present contract: parse, schema, references; [] when sound. */
export function contractProblems(root, name, { gates = [], exists = (rel) => existsSync(join(root, rel)) } = {}) {
  const file = path(root, name)
  if (!existsSync(file)) return []
  const text = readFileSync(file, "utf8")
  if (name === "schema") return text.trim() ? [] : ["schema.sql is empty"]
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return [`${CONTRACT_FILES[name]} isn't valid JSON (${String(error.message).slice(0, 120)})`]
  }
  const validate = validator(name)
  if (validate && !validate(value)) return validate.errors.slice(0, 8).map((e) => `${CONTRACT_FILES[name]}${e.instancePath || ""} ${e.message}`)
  const problems = []
  if (name === "api") {
    for (const ref of JSON.stringify(value).match(/"\$ref":"[^"]*"/g) ?? []) {
      const pointer = ref.slice(8, -1)
      if (!pointer.startsWith("#/") || resolvePointer(value, pointer.slice(1)) === undefined) problems.push(`${CONTRACT_FILES[name]}: ${pointer} doesn't resolve`)
    }
  }
  if (name === "threat_model")
    for (const [i, row] of value.entries()) if (!gates.includes(row.test) && !exists(row.test)) problems.push(`${CONTRACT_FILES[name]}/${i}/test: "${row.test}" is neither a gate id nor a file in the project`)
  return problems
}

/** RFC 6901 JSON Pointer ("" is the whole document). */
export function resolvePointer(value, pointer) {
  if (pointer === "") return value
  if (!pointer.startsWith("/")) return undefined
  let node = value
  for (const part of pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, part)) return undefined
    node = node[part]
  }
  return node
}

/**
 * Contracts this role doesn't own that changed since their owner's step passed.
 * @param {Record<string, { sha: string }>} recorded the ledger's hashes
 */
export function drifted(root, recorded = {}, owns = []) {
  const now = presentContracts(root)
  return Object.entries(recorded)
    .filter(([name, r]) => !owns.includes(name) && now[name] !== r.sha)
    .map(([name]) => ({ name, file: join(CONTRACTS_DIR, CONTRACT_FILES[name]), removed: now[name] === undefined }))
}

/** The contracts a passing step of this role owns, hashed for the ledger. */
export function ownedHashes(root, owns = [], step) {
  const now = presentContracts(root)
  return Object.fromEntries(owns.filter((name) => now[name]).map((name) => [name, { sha: now[name], step }]))
}

export const SLICE_CHARS = 6000

/** Text for a builder: the named contract slices ("api#/paths/~1orders", "design_tokens"), deterministic and bounded. */
export function contractSlices(root, refs = []) {
  const parts = []
  for (const ref of refs) {
    const [name, pointer = ""] = String(ref).split("#")
    if (!CONTRACT_NAMES.includes(name) || !existsSync(path(root, name))) continue
    const text = readFileSync(path(root, name), "utf8")
    let body = text
    if (name !== "schema" && pointer) {
      try {
        const found = resolvePointer(JSON.parse(text), pointer)
        if (found === undefined) continue
        body = JSON.stringify(found, null, 2)
      } catch {
        continue
      }
    }
    parts.push(`${CONTRACT_FILES[name]}${pointer ? `#${pointer}` : ""}:\n\`\`\`\n${body.trim()}\n\`\`\``)
  }
  const out = parts.join("\n\n")
  return out.length <= SLICE_CHARS ? out : `${out.slice(0, SLICE_CHARS)}\n… (cut at ${SLICE_CHARS} characters; read the file for the rest)`
}
