// The graph runtime (EDIT_LOOP §4; Mokhov, Mitchell, Peyton Jones, Build Systems à
// la Carte). A node is a function of what it reads. Each result stores a verifying
// trace: the hashes it read and the hash it produced. Nothing runs until demanded;
// an unchanged output stops the work downstream. It knows nothing of what a node means.

import { createHash } from "node:crypto"

import { createScheduler, DEFAULT_SLOTS } from "./scheduler.js"

export class Interrupted extends Error {
  constructor(message = "Interrupted") {
    super(message)
  }
}

const sorted = (_, value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value)
export const hashOf = (value) => createHash("sha256").update(JSON.stringify(value ?? null, sorted)).digest("hex")

const idOf = (name, key) => (key ? `${name}:${key}` : name)

/**
 * @param {{ journal: ReturnType<import("./journal.js").openJournal>, nodes: Record<string, { version: number, resources?: string[], valid?: (value: any) => boolean, run: (ctx: object) => Promise<any> }>, slots?: Record<string, number>, scheduler?: ReturnType<typeof createScheduler> }} options
 * One Host shares one scheduler across its projects' graphs.
 */
export function createGraph({ journal, nodes, slots = DEFAULT_SLOTS, scheduler = createScheduler(slots) }) {
  const owner = Symbol("graph") // Turns pass between graphs on a shared scheduler
  const inputs = new Map()
  const known = new Map() // id → { round, hash, value }, so one round checks each node once
  const flying = new Map()
  let round = 1

  const inputHash = (name) => inputs.get(name)?.hash ?? hashOf(null)

  async function fresh(trace, node, ctx) {
    if (!trace || trace.version !== node.version) return false
    if (node.valid && !node.valid(trace.value)) return false
    // In the order they were read: a changed dep may mean later ones no longer apply
    for (const dep of trace.deps) {
      const hash = dep.input ? inputHash(dep.input) : (await build(dep.name, dep.key, ctx)).hash
      if (hash !== dep.hash) return false
    }
    return true
  }

  async function execute(name, key, id, node, ctx) {
    const resources = node.resources ?? []
    if (ctx.speculate && resources.includes("model")) throw new Interrupted("Speculation never spends model tokens")
    const kind = name
    const job = ctx.job ?? 0
    const controller = new AbortController()
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal
    const options = { speculate: ctx.speculate, signal, owner, preempt: () => controller.abort(new Interrupted("Real work needed this slot")) }
    let release = await scheduler.acquire(resources, options)
    const deps = []
    // A node gives up its slots while it waits on another, so a chain can't deadlock
    const waiting = async (work) => {
      release()
      try {
        return await work()
      } finally {
        release = await scheduler.acquire(resources, options)
      }
    }
    journal.step({ job, id, kind, status: "running", resources: resources.join(",") })
    try {
      const value = await node.run({
        key,
        job: ctx.job,
        signal,
        input: async (input) => {
          deps.push({ input, hash: inputHash(input) })
          return inputs.get(input)?.value
        },
        need: (other, otherKey = "") =>
          waiting(async () => {
            const result = await build(other, otherKey, { ...ctx, stack: [...ctx.stack, id] })
            deps.push({ name: other, key: otherKey, hash: result.hash })
            return result.value
          }),
      })
      const hash = hashOf(value)
      journal.saveTrace({ id, version: node.version, deps, hash, value })
      journal.step({ job, id, kind, status: "done", outputKey: hash })
      return { hash, value }
    } catch (error) {
      journal.step({ job, id, kind, status: error instanceof Interrupted ? "pending" : "failed", log: String(error?.message ?? error) })
      throw error
    } finally {
      release()
    }
  }

  async function compute(name, key, id, node, ctx) {
    const trace = journal.trace(id)
    const reusable = await fresh(trace, node, { ...ctx, stack: [...ctx.stack, id] })
    const result = reusable ? { hash: trace.hash, value: trace.value } : await execute(name, key, id, node, ctx)
    known.set(id, { round, ...result })
    return result
  }

  async function build(name, key, ctx) {
    const node = nodes[name]
    if (!node) throw new Error(`no node "${name}"`)
    const id = idOf(name, key)
    if (ctx.stack.includes(id)) throw new Error(`a cycle through ${id}`)
    const memo = known.get(id)
    if (memo?.round === round) return memo
    const running = flying.get(id)
    if (running) {
      try {
        return await running
      } catch (error) {
        // Real work joined speculation that lost its slot: do it properly
        if (error instanceof Interrupted && !ctx.speculate) return build(name, key, ctx)
        throw error
      }
    }
    const work = compute(name, key, id, node, ctx).finally(() => flying.delete(id))
    flying.set(id, work)
    return work
  }

  return {
    /** Sets a leaf value. An equal value changes nothing. */
    set(name, value) {
      const hash = hashOf(value)
      if (inputHash(name) !== hash) round++
      inputs.set(name, { value, hash })
    },
    /** Forces the next demand to re-check traces, as after a cache eviction. */
    touch() {
      round++
    },
    /** @param {string} name @param {string} [key] @param {{ speculate?: boolean, job?: number, signal?: AbortSignal }} [options] */
    async demand(name, key = "", { speculate = false, job, signal } = {}) {
      return (await build(name, key, { stack: [], speculate, job, signal })).value
    },
  }
}
