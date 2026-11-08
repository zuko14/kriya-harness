// The Model Call Governor (EDIT_LOOP §8): every Director call goes through one queue
// in the Edit Host, because the harness shares its limits with the person's own
// work. At most 2 open answers (1 while anything else of theirs is live), at most
// 20 calls a minute, AIMD on 429 with the gateway's retryAfter honoured, and
// max_tokens always set so the gateway's reservation stays small (EH-36).

export const LIMITS = { rpm: 20, open: 2, openWhileLive: 1, retries: 3 }
export const PRIORITY = { person: 0, job: 1, background: 2 }

export class GovernorError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const isRateLimit = (error) => error?.status === 429 || error?.code === "rate_limited"

/**
 * @param {{ send: (body: object, signal?: AbortSignal) => Promise<object>, live?: () => boolean, rpm?: number, windowMs?: number, now?: () => number, onWait?: (ms: number) => void }} options
 *   send: one request to the gateway; rejects with { status, code, extra: { retryAfter } } on refusal
 */
export function createGovernor({ send, live = () => false, rpm = LIMITS.rpm, windowMs = 60_000, now = Date.now }) {
  const queue = [] // { priority, order, run }
  const starts = [] // when each recent call started
  let order = 0
  let open = 0
  let rate = rpm // the AIMD rate, ≤ rpm
  let pausedUntil = 0
  let timer = null
  const stats = { calls: 0, maxOpen: 0, rateLimited: 0, retries: 0 }

  const allowed = () => (live() ? LIMITS.openWhileLive : LIMITS.open)

  function pump() {
    clearTimeout(timer)
    timer = null
    while (queue.length && open < allowed()) {
      const t = now()
      while (starts.length && starts[0] <= t - windowMs) starts.shift()
      const wait = Math.max(pausedUntil - t, starts.length >= Math.floor(rate) ? starts[0] + windowMs - t : 0)
      if (wait > 0) {
        timer = setTimeout(pump, wait)
        return
      }
      queue.sort((a, b) => a.priority - b.priority || a.order - b.order)
      const next = queue.shift()
      starts.push(t)
      open++
      stats.calls++
      stats.maxOpen = Math.max(stats.maxOpen, open)
      next.run().finally(() => {
        open--
        pump()
      })
    }
  }

  return {
    stats,
    get rate() {
      return rate
    },

    /**
     * One model call. maxTokens is required: a call without its budget is refused here.
     * @param {object} body the chat request, without max_tokens
     * @param {{ maxTokens: number, priority?: number, signal?: AbortSignal }} options
     */
    call(body, { maxTokens, priority = PRIORITY.job, signal } = {}) {
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) return Promise.reject(new GovernorError("no_budget", "Every model call needs its output budget (max_tokens)."))
      const request = { ...body, max_tokens: maxTokens }
      return new Promise((resolve, reject) => {
        let attempt = 0
        const entry = {
          priority,
          order: order++,
          run: async () => {
            if (signal?.aborted) return reject(signal.reason)
            try {
              const value = await send(request, signal)
              rate = Math.min(rpm, rate + 1) // additive increase
              resolve(value)
            } catch (error) {
              if (!isRateLimit(error) || attempt >= LIMITS.retries) return reject(error)
              attempt++
              stats.rateLimited++
              stats.retries++
              rate = Math.max(1, rate / 2) // multiplicative decrease
              const retryAfter = Number(error.extra?.retryAfter ?? error.retryAfter ?? 5)
              pausedUntil = Math.max(pausedUntil, now() + Math.max(0, retryAfter) * 1000)
              // A model call is a read: retried, behind everything already waiting at its priority
              queue.push({ ...entry, order: order++ })
            }
          },
        }
        queue.push(entry)
        pump()
        // Given up while still waiting its turn: out of the queue now, not when its turn comes
        signal?.addEventListener(
          "abort",
          () => {
            const waiting = queue.findIndex((item) => item.order === entry.order || item.run === entry.run)
            if (waiting !== -1) queue.splice(waiting, 1)
            reject(signal.reason)
          },
          { once: true }
        )
      })
    },
  }
}
