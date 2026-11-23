import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { Ajv2020 } from "ajv/dist/2020.js"

import { CONTRACTS_DIR } from "../contracts.js"
import { readStack } from "../stack.js"
import { Budget, fill, local } from "./http.js"

// Harness 2.0 W5: G-TENANT (Kriya-Tavi docs/kriya-harness/upgrade_2.0/GATES.md
// §3). For every tenant-scoped resource of .kriya/contracts/auth_matrix.json:
// two local test identities A and B, proved different first; B creates an
// object (control), B reads it (control), then A tries to read, change,
// delete and list it, as the matrix allows, and each must be refused
// (403/404) with B's object unchanged. A server that refuses everything fails
// its controls, so it can't pass. How to sign in and call each resource is in
// .kriya/gates/tenants.json (written by the security step; test identities of
// the local app only). Credentials and tokens never appear in an excerpt.

export const TENANTS_FILE = join(".kriya", "gates", "tenants.json")

const call = { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", pattern: "^/\\S{0,300}$" }, method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, body: {}, idField: { type: "string", maxLength: 80 } } }
const SCHEMA = {
  type: "object",
  required: ["signIn", "tenants", "token", "whoami", "resources"],
  additionalProperties: false,
  properties: {
    signIn: call,
    tenants: { type: "object", required: ["A", "B"], additionalProperties: false, properties: { A: { type: "object", properties: { body: {} } }, B: { type: "object", properties: { body: {} } } } },
    token: {
      oneOf: [
        { type: "object", required: ["from", "field"], additionalProperties: false, properties: { from: { const: "json" }, field: { type: "string", maxLength: 80 } } },
        { type: "object", required: ["from", "name"], additionalProperties: false, properties: { from: { const: "cookie" }, name: { type: "string", pattern: "^[\\w.-]{1,80}$" } } },
      ],
    },
    whoami: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", pattern: "^/\\S{0,300}$" }, field: { type: "string", maxLength: 80 } } },
    resources: { type: "object", maxProperties: 50, additionalProperties: { type: "object", additionalProperties: false, properties: { create: call, read: call, update: call, delete: call, list: call } } },
  },
}
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA)

/** The project's tenants.json, checked: { config } or { problem } */
export function tenantConfig(root) {
  const file = join(root, TENANTS_FILE)
  if (!existsSync(file)) return { problem: `${TENANTS_FILE} is missing: the security step writes how two local test identities sign in and how each tenant-scoped resource is called` }
  let value
  try {
    value = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { problem: `${TENANTS_FILE} isn't valid JSON` }
  }
  if (!validate(value)) return { problem: `${TENANTS_FILE}: ${validate.errors.slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}` }
  return { config: value }
}

/** "data.user.id" → the value in a JSON body */
export const pick = (value, field = "id") => String(field).split(".").reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), value)

/** Signs one test identity in; its request headers (never shown) */
export async function signIn(app, config, who, budget, request) {
  const res = await local(app, config.signIn.path, { method: config.signIn.method ?? "POST", body: config.tenants[who].body, budget, request })
  if (res.status < 200 || res.status >= 300) throw new Error(`signing in as ${who} answered ${res.status || res.error}`)
  if (config.token.from === "json") {
    const token = pick(res.json, config.token.field)
    if (typeof token !== "string" || !token) throw new Error(`signing in as ${who} returned no token at "${config.token.field}"`)
    return { headers: { authorization: `Bearer ${token}` } }
  }
  const cookie = (res.headers?.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${config.token.name}=`))
  if (!cookie) throw new Error(`signing in as ${who} set no "${config.token.name}" cookie`)
  return { headers: { cookie } }
}

/** True when any object in a JSON value has `field` equal to `id` */
const holds = (value, field, id) => {
  if (Array.isArray(value)) return value.some((v) => holds(v, field, id))
  if (value && typeof value === "object") return String(pick(value, field)) === String(id) || Object.values(value).some((v) => holds(v, field, id))
  return false
}
const refused = (s) => s === 403 || s === 404

/** Tenant-scoped resources and the actions the matrix allows on each */
export function scopedResources(root) {
  const file = join(root, CONTRACTS_DIR, "auth_matrix.json")
  if (!existsSync(file)) return new Map()
  let rows = []
  try {
    rows = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return new Map()
  }
  const out = new Map()
  for (const r of Array.isArray(rows) ? rows : []) if (r?.tenantScoped) out.set(r.resource, new Set([...(out.get(r.resource) ?? []), r.action]))
  return out
}

/** @param {{ root: string, request?: typeof fetch }} input */
export async function tenantGate({ root, request }) {
  const id = "G-TENANT"
  const scoped = scopedResources(root)
  if (!scoped.size) return { id, status: "pass", note: "nothing in the auth matrix is tenant-scoped" }
  const { app } = readStack(root)
  if (!app) return { id, status: "not_checked", optional: true, reason: "no app is confirmed for this project (kriya stack use --app http://localhost:<port>)" }
  const { config, problem } = tenantConfig(root)
  if (problem) return { id, status: "not_checked", reason: problem }
  const budget = new Budget()
  const leaks = []
  const broken = []
  try {
    const A = await signIn(app, config, "A", budget, request)
    const B = await signIn(app, config, "B", budget, request)
    const [whoA, whoB] = [await local(app, config.whoami.path, { headers: A.headers, budget, request }), await local(app, config.whoami.path, { headers: B.headers, budget, request })]
    const [idA, idB] = [pick(whoA.json, config.whoami.field), pick(whoB.json, config.whoami.field)]
    if (whoA.status !== 200 || whoB.status !== 200 || idA === undefined || idB === undefined) return { id, status: "fail", kind: "gate", excerpt: `G-TENANT: ${config.whoami.path} must answer 200 with "${config.whoami.field ?? "id"}" for both test identities (answered ${whoA.status}, ${whoB.status})` }
    if (String(idA) === String(idB)) return { id, status: "fail", kind: "gate", excerpt: "G-TENANT: test identities A and B are the same user, so isolation can't be proved; give them different accounts in tenants.json" }
    for (const [name, actions] of scoped) {
      const r = config.resources[name]
      if (!r?.create) {
        broken.push(`${name}: tenants.json has no "create" call for it, so there's no object of B's to probe`)
        continue
      }
      const made = await local(app, r.create.path, { method: r.create.method ?? "POST", body: r.create.body, headers: B.headers, budget, request })
      const objectId = pick(made.json, r.create.idField ?? "id")
      if (made.status < 200 || made.status >= 300 || objectId === undefined) {
        broken.push(`${name}: control failed: B couldn't create one (${made.status || made.error})`)
        continue
      }
      const path = (c) => fill(c.path, { id: objectId })
      const ownRead = r.read && (await local(app, path(r.read), { headers: B.headers, budget, request }))
      if (r.read && ownRead.status !== 200) {
        broken.push(`${name}: control failed: B couldn't read its own #${objectId} (${ownRead.status || ownRead.error})`)
        continue
      }
      const still = async () => r.read && (await local(app, path(r.read), { headers: B.headers, budget, request }))
      if (actions.has("read") && r.read) {
        const probe = await local(app, path(r.read), { headers: A.headers, budget, request })
        if (!refused(probe.status)) leaks.push(`${name}: tenant A read B's #${objectId} (expected 403/404, got ${probe.status})`)
      }
      if (actions.has("update") && r.update) {
        const probe = await local(app, path(r.update), { method: r.update.method ?? "PATCH", body: r.update.body, headers: A.headers, budget, request })
        if (!refused(probe.status)) leaks.push(`${name}: tenant A changed B's #${objectId} (expected 403/404, got ${probe.status})`)
        const after = await still()
        if (after && after.text !== ownRead.text) leaks.push(`${name}: B's #${objectId} is different after A's refused update`)
      }
      if (actions.has("delete") && r.delete) {
        const probe = await local(app, path(r.delete), { method: "DELETE", headers: A.headers, budget, request })
        if (!refused(probe.status)) leaks.push(`${name}: tenant A deleted B's #${objectId} (expected 403/404, got ${probe.status})`)
        const after = await still()
        if (after && after.status !== 200) leaks.push(`${name}: B's #${objectId} is gone after A's delete`)
      }
      if (actions.has("list") && r.list) {
        const probe = await local(app, r.list.path, { headers: A.headers, budget, request })
        if (probe.status === 200 && holds(probe.json, r.create.idField ?? "id", objectId)) leaks.push(`${name}: tenant A's list includes B's #${objectId}`)
      }
      for (const action of actions) if (!r[action] && action !== "create") broken.push(`${name}: the matrix allows "${action}" but tenants.json has no call for it to probe`)
    }
  } catch (error) {
    return { id, status: "fail", kind: "gate", excerpt: `G-TENANT: ${String(error?.message ?? error).slice(0, 300)}` }
  }
  if (leaks.length || broken.length)
    return { id, status: "fail", kind: "gate", excerpt: `G-TENANT (against ${app}):\n${[...leaks, ...broken].slice(0, 15).map((p) => `- ${p}`).join("\n")}${leaks.length ? "\nEnforce ownership from the verified session in the service and with row-level security, not from ids the client sends." : ""}` }
  return { id, status: "pass", note: `${scoped.size} tenant-scoped resource(s) probed with paired controls` }
}
