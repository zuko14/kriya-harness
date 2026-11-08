// Slots for `cpu`, `gpu`, `encoder`, `chrome`, `model`, `disk` (ARCHITECTURE §8).
// Real work goes first, then speculation. Within that, turns pass between owners, so
// a long job can't starve a short one, and each owner's work keeps its arrival order.
// A waiter takes all its resources at once or none, so two nodes can't deadlock.

import { availableParallelism } from "node:os"

export const DEFAULT_SLOTS = { cpu: Math.max(2, availableParallelism() - 2), gpu: 1, encoder: 2, chrome: 1, model: 2, disk: 2 }

export function createScheduler(slots = DEFAULT_SLOTS) {
  const held = new Map()
  const holders = new Set()
  const waiting = []
  const served = new Map() // owner → when it last got a slot
  let turn = 0

  const busy = (resource) => held.get(resource) ?? 0
  const free = (resources) => resources.every((resource) => busy(resource) < (slots[resource] ?? 1))

  function grant(waiter) {
    served.set(waiter.owner, ++turn)
    for (const resource of waiter.resources) held.set(resource, busy(resource) + 1)
    const holder = { resources: waiter.resources, speculate: waiter.speculate, preempt: waiter.preempt }
    holders.add(holder)
    waiter.done(() => {
      if (!holders.delete(holder)) return
      for (const resource of holder.resources) held.set(resource, busy(resource) - 1)
      pump()
    })
  }

  // shortcut: a waiter for several slots can be overtaken by single-slot ones, fine until a node needs two scarce slots at once
  function pump() {
    for (;;) {
      const ready = waiting.filter((waiter) => free(waiter.resources))
      if (ready.length === 0) return
      const rank = (waiter) => [waiter.speculate ? 1 : 0, served.get(waiter.owner) ?? 0, waiting.indexOf(waiter)]
      const next = ready.reduce((best, waiter) => {
        const [a, b] = [rank(waiter), rank(best)]
        return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] ? (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0 ? waiter : best : best
      })
      waiting.splice(waiting.indexOf(next), 1)
      grant(next)
    }
  }

  function preempt(resources) {
    for (const holder of holders) {
      if (holder.speculate && holder.resources.some((resource) => resources.includes(resource))) holder.preempt?.()
    }
  }

  /**
   * @param {string[]} resources
   * @param {{ speculate?: boolean, preempt?: () => void, signal?: AbortSignal, owner?: unknown }} [options]
   * @returns {Promise<() => void>} the release function
   */
  function acquire(resources, { speculate = false, preempt: onPreempt, signal, owner } = {}) {
    return new Promise((done, fail) => {
      if (signal?.aborted) return fail(signal.reason)
      const waiter = { resources, speculate, preempt: onPreempt, done, owner }
      waiting.push(waiter)
      signal?.addEventListener(
        "abort",
        () => {
          const at = waiting.indexOf(waiter)
          if (at === -1) return
          waiting.splice(at, 1)
          fail(signal.reason)
        },
        { once: true },
      )
      pump()
      if (waiting.includes(waiter) && !speculate) preempt(resources)
    })
  }

  return { acquire, busy }
}
