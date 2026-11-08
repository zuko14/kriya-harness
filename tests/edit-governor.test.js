import assert from "node:assert/strict"
import { test } from "node:test"

import { createAsk } from "../src/edit/director/ask.js"
import { createGovernor, GovernorError, LIMITS, PRIORITY } from "../src/edit/loop/governor.js"

// The Model Call Governor against a fake gateway with the real limits (HD-16: three
// open answers per person; rate per minute), on a short clock so a "minute" is 300 ms.

const WINDOW = 300
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** A gateway that refuses a fourth open answer, as Kriya's does, and records everything. */
function gateway({ answerMs = 20, open = 3 } = {}) {
  const state = { open: 0, maxOpen: 0, starts: [], refused: 0, bodies: [] }
  const answer = async (body) => {
    state.bodies.push(body)
    if (state.open >= open) {
      state.refused++
      throw Object.assign(new Error("Too many answers in progress"), { status: 429, code: "rate_limited", extra: { retryAfter: 0.02 } })
    }
    state.open++
    state.maxOpen = Math.max(state.maxOpen, state.open)
    state.starts.push(Date.now())
    await sleep(answerMs)
    state.open--
    return { choices: [{ message: { content: "{}" } }] }
  }
  return { state, answer }
}

const most = (starts, window) => Math.max(0, ...starts.map((t) => starts.filter((u) => u >= t && u < t + window).length))

test("ET-GOV-01: never more than 2 open answers, nor 20 calls a minute", async () => {
  const fake = gateway()
  const governor = createGovernor({ send: fake.answer, windowMs: WINDOW })
  await Promise.all(Array.from({ length: 50 }, (_, i) => governor.call({ model: "budget", messages: [] }, { maxTokens: 100 + i })))
  assert.ok(fake.state.maxOpen <= LIMITS.open, `open at once: ${fake.state.maxOpen}`)
  assert.ok(most(fake.state.starts, WINDOW) <= LIMITS.rpm, `calls in one window: ${most(fake.state.starts, WINDOW)}`)
  assert.equal(fake.state.refused, 0)
  assert.equal(governor.stats.calls, 50)
})

test("ET-GOV-02: during a job, a live chat on the same account sees no 429", async () => {
  const run = async (governed) => {
    const fake = gateway({ answerMs: 25 })
    let chatRefused = 0
    let live = true
    const job = governed
      ? createGovernor({ send: fake.answer, windowMs: WINDOW, rpm: 1000, live: () => live })
      : { call: (body) => fake.answer(body) } // naive fan-out: every slot at once
    const work = Promise.all(Array.from({ length: 40 }, () => job.call({ model: "budget" }, { maxTokens: 50 }).catch(() => {})))
    // The person's chat: one answer at a time, steadily, while the job runs
    const chat = (async () => {
      for (let i = 0; i < 12; i++) {
        await fake.answer({ model: "balanced", chat: true }).catch(() => chatRefused++)
        await sleep(5)
      }
    })()
    await Promise.all([work, chat])
    live = false
    return chatRefused
  }
  assert.ok((await run(false)) > 0, "without the Governor the chat is refused: the test can tell")
  assert.equal(await run(true), 0, "with it, never")
})

test("ET-GOV-03: retryAfter is honoured, the rate halves and recovers, and max_tokens is always set", async () => {
  let refusals = 2
  const seen = []
  const send = async (body) => {
    seen.push({ at: Date.now(), body })
    if (refusals-- > 0) throw Object.assign(new Error("busy"), { status: 429, code: "rate_limited", extra: { retryAfter: 0.15 } })
    return { ok: true }
  }
  const governor = createGovernor({ send, windowMs: WINDOW })
  const started = Date.now()
  assert.deepEqual(await governor.call({ model: "budget" }, { maxTokens: 321 }), { ok: true })
  assert.equal(seen.length, 3)
  assert.ok(seen[1].at - seen[0].at >= 140, `waited ${seen[1].at - seen[0].at} ms after the first 429`)
  assert.ok(seen[2].at - started >= 290, "and again after the second")
  assert.ok(seen.every(({ body }) => body.max_tokens === 321), "every attempt carries its budget")
  assert.equal(governor.stats.rateLimited, 2)
  assert.equal(governor.rate, LIMITS.rpm / 4 + 1, "halved twice, then one step back up")
  for (let i = 0; i < 20; i++) await governor.call({ model: "budget" }, { maxTokens: 10 })
  assert.equal(governor.rate, LIMITS.rpm, "recovered, never above the cap")
  await assert.rejects(governor.call({ model: "budget" }, {}), GovernorError, "a call with no budget is refused before it's sent")
  await assert.rejects(createGovernor({ send: async () => Promise.reject(Object.assign(new Error("cap"), { status: 403, code: "cap_reached" })) }).call({}, { maxTokens: 5 }), /cap/, "a refusal that isn't a rate limit isn't retried")
})

test("the person's revision goes before a running job's slots", async () => {
  const order = []
  const governor = createGovernor({ send: async (body) => (order.push(body.tag), await sleep(5)), windowMs: WINDOW })
  const all = [...Array.from({ length: 6 }, (_, i) => governor.call({ tag: `job${i}` }, { maxTokens: 1, priority: PRIORITY.job })), governor.call({ tag: "person" }, { maxTokens: 1, priority: PRIORITY.person })]
  await Promise.all(all)
  assert.ok(order.indexOf("person") <= 2, `the person's call ran at position ${order.indexOf("person")}`)
})

test("ET-GOV: a call given up on leaves the queue at once, and the others go on", async () => {
  let release
  const gate = new Promise((done) => (release = done))
  const governor = createGovernor({ send: () => gate.then(() => ({ ok: true })) })
  const stop = new AbortController()
  const running = [governor.call({ model: "budget" }, { maxTokens: 10 }), governor.call({ model: "budget" }, { maxTokens: 10 })]
  const waiting = governor.call({ model: "budget" }, { maxTokens: 10, signal: stop.signal })
  stop.abort(new Error("given up"))
  await assert.rejects(waiting, /given up/)
  release()
  await Promise.all(running)
  assert.equal(governor.stats.calls, 2, "the one given up on never ran")
})

test("a slot that waits too long takes its default, and the job's later slots don't queue at all", async () => {
  const sent = []
  const never = { call: (body, { signal }) => (sent.push(body), new Promise((_, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true }))) }
  const ask = createAsk({ governor: never, slotWaitMs: 20 })
  const slot = { task: "story", schema: { type: "object" }, view: "", request: "", maxOutput: 10, fallback: () => ({ fell: true }) }
  const first = await ask(slot)
  assert.deepEqual(first.value, { fell: true })
  assert.equal(first.source, "default")
  assert.match(first.reason, /wasn't available/)
  const second = await ask(slot)
  assert.equal(second.source, "default")
  assert.equal(sent.length, 1, "nothing more was sent")
})
