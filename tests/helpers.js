import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Ajv2020 } from "ajv/dist/2020.js"

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")

/** A fresh, empty Kriya home for one test (never the person's ~/.kriya). */
export function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "kriya-test-"))
  process.env.KRIYA_HOME = home
  return home
}

export const contract = JSON.parse(readFileSync(join(ROOT, "contract", "contract.json"), "utf8"))

// Formats are carried by patterns in the contract; strict mode would refuse
// the `format` keywords zod emits
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true })

export function route(method, path) {
  const found = contract.routes.find((r) => r.method === method && r.path === path)
  if (!found) throw new Error(`contract has no ${method} ${path}`)
  return found
}

/** @returns {string[]} schema errors, empty when valid */
export function violations(schema, value) {
  if (!schema) return value === null || value === undefined ? [] : ["expected no body"]
  const validate = ajv.compile(schema)
  return validate(value) ? [] : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`)
}
