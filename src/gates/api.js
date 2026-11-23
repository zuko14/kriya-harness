import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { Ajv2020 } from "ajv/dist/2020.js"

import { CONTRACTS_DIR, resolvePointer } from "../contracts.js"
import { readStack } from "../stack.js"
import { Budget, fill, local, median, p95 } from "./http.js"
import { signIn, tenantConfig } from "./tenant.js"

// Harness 2.0 W5: G-API (Kriya-Tavi docs/kriya-harness/upgrade_2.0/GATES.md
// §3). Against the app the person confirmed (`kriya stack use --app`), for
// each operation of .kriya/contracts/api.openapi.json that carries an
// `x-kriya-example`: the example answers the contract's status with a body
// its schema accepts; seeded bad inputs get a 4xx, never a 5xx or a 2xx; an
// operation marked `x-kriya-idempotent` has one effect for ten concurrent
// requests with one Idempotency-Key. Latency is reported, never gated.
// These requests reach the person's local app, writes included; never anything else.

export const MAX_OPERATIONS = 10
const METHODS = ["get", "post", "put", "patch", "delete"]
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")

/** Bad request bodies made from the request schema, deterministic: [why, body] */
export function badBodies(schema, example) {
  const out = []
  const props = schema?.properties ?? {}
  const base = example && typeof example === "object" && !Array.isArray(example) ? example : {}
  for (const field of (schema?.required ?? []).slice(0, 3)) {
    const { [field]: _gone, ...rest } = base
    void _gone
    out.push([`without required "${field}"`, rest])
  }
  const WRONG = { string: 12345, integer: "not a number", number: "not a number", boolean: "not a boolean", array: { not: "an array" }, object: "not an object" }
  for (const [field, p] of Object.entries(props).slice(0, 3)) if (WRONG[p?.type] !== undefined) out.push([`"${field}" of the wrong type`, { ...base, [field]: WRONG[p.type] }])
  for (const [field, p] of Object.entries(props)) {
    if (p?.type === "string" && Number.isInteger(p.maxLength)) {
      out.push([`"${field}" longer than its maxLength ${p.maxLength}`, { ...base, [field]: "x".repeat(p.maxLength + 1) }])
      break
    }
  }
  out.push(["a body that isn't JSON", "{"])
  return out
}

const countOf = (r) => (Array.isArray(r.json) ? r.json.length : Number.isFinite(r.json?.count) ? r.json.count : Number.isFinite(r.json?.total) ? r.json.total : undefined)

/**
 * @param {{ root: string, request?: typeof fetch }} input
 * @returns {Promise<{ id: string, status: string, kind?: string, excerpt?: string, reason?: string, optional?: boolean, note?: string }>}
 */
export async function apiGate({ root, request }) {
  const id = "G-API"
  const file = join(root, CONTRACTS_DIR, "api.openapi.json")
  if (!existsSync(file)) return { id, status: "pass", note: "no API contract in this project" }
  const { app } = readStack(root)
  if (!app) return { id, status: "not_checked", optional: true, reason: "no app is confirmed for this project (kriya stack use --app http://localhost:<port>)" }
  let doc
  try {
    doc = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { id, status: "not_checked", reason: "api.openapi.json isn't valid JSON (G-CONTRACT reports it)" }
  }
  const ops = Object.entries(doc.paths ?? {})
    .flatMap(([path, item]) => METHODS.filter((m) => item?.[m]?.["x-kriya-example"]).map((method) => ({ path, method, op: item[method] })))
    .slice(0, MAX_OPERATIONS)
  if (!ops.length) return { id, status: "not_checked", reason: 'no operation in api.openapi.json has an "x-kriya-example" to call' }
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
  ajv.addSchema(doc, "kriya-api")
  const budget = new Budget()
  const problems = []
  const times = []
  const tenants = tenantConfig(root)
  const auth = {}
  const headersFor = async (who) => {
    if (!who) return {}
    if (!tenants.config) throw new Error(`the example signs in as ${who}, but .kriya/gates/tenants.json is missing`)
    auth[who] ??= await signIn(app, tenants.config, who, budget, request)
    return auth[who].headers
  }
  try {
    for (const { path, method, op } of ops) {
      const ex = op["x-kriya-example"]
      const label = `${method.toUpperCase()} ${path}`
      const url = fill(ex.path ?? path, ex.params)
      const headers = await headersFor(ex.auth)
      const res = await local(app, url, { method: method.toUpperCase(), body: ex.body, headers, budget, request })
      times.push(res.ms)
      const wanted = ex.status ?? Number(Object.keys(op.responses ?? {}).find((s) => /^2\d\d$/.test(s)))
      if (res.status === 0) {
        problems.push(`${label}: no answer (${res.error})`)
        continue
      }
      if (res.status !== wanted) problems.push(`${label}: answered ${res.status}, the contract's example expects ${wanted}${res.status >= 500 ? " (a server error)" : ""}`)
      const pointer = `/paths/${esc(path)}/${method}/responses/${res.status}/content/application~1json/schema`
      if (resolvePointer(doc, pointer) !== undefined) {
        const validate = ajv.compile({ $ref: `kriya-api#${pointer}` })
        if (!validate(res.json)) problems.push(`${label}: the ${res.status} body doesn't match the contract: ${validate.errors.slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`)
      }
      const reqPointer = `/paths/${esc(path)}/${method}/requestBody/content/application~1json/schema`
      let schema = resolvePointer(doc, reqPointer)
      if (schema?.$ref?.startsWith("#/")) schema = resolvePointer(doc, schema.$ref.slice(1))
      if (schema && ["post", "put", "patch"].includes(method))
        for (const [why, body] of badBodies(schema, ex.body)) {
          const bad = await local(app, url, { method: method.toUpperCase(), body, headers, budget, request })
          if (bad.status < 400 || bad.status >= 500) problems.push(`${label} ${why}: answered ${bad.status || bad.error}, expected a 4xx`)
        }
      const idem = op["x-kriya-idempotent"]
      if (idem?.count) {
        const before = countOf(await local(app, idem.count, { headers, budget, request }))
        const key = randomUUID()
        const replies = await Promise.all(Array.from({ length: 10 }, () => local(app, url, { method: method.toUpperCase(), body: ex.body, headers: { ...headers, "Idempotency-Key": key }, budget, request })))
        const after = countOf(await local(app, idem.count, { headers, budget, request }))
        const statuses = [...new Set(replies.map((r) => r.status))]
        if (before === undefined || after === undefined) problems.push(`${label}: ${idem.count} doesn't return a list or { count }, so the effect can't be counted`)
        else if (after - before !== 1) problems.push(`${label}: ten requests with one Idempotency-Key made ${after - before} effects, expected 1`)
        if (statuses.some((s) => s < 200 || s >= 300)) problems.push(`${label}: with one Idempotency-Key, answers were ${statuses.join(", ")}`)
      }
    }
  } catch (error) {
    return { id, status: "fail", kind: "gate", excerpt: `G-API: ${String(error?.message ?? error).slice(0, 300)}` }
  }
  const note = `${ops.length} operation(s); latency p50 ${Math.round(median(times) ?? 0)} ms, p95 ${Math.round(p95(times) ?? 0)} ms (reported, not gated)`
  if (problems.length) return { id, status: "fail", kind: "gate", excerpt: `G-API (against ${app}):\n${problems.slice(0, 15).map((p) => `- ${p}`).join("\n")}`, note }
  return { id, status: "pass", note }
}
