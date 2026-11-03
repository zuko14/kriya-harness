import { defineTool } from "@deepseek-ai/dsh-tools"

import { call, deviceFromEnv } from "../../src/api.js"
import { switchProvider } from "../../src/skill-switches.js"

// Kriya's skills and memory inside DeepSeek Harness (H7, HD-10):
// - a skill source in DSH's registry (`ctx.skills`): the device agent's
//   Kriya skills, ranked below the person's own local skills so theirs win
//   a name, bodies fetched once per version;
// - `kriya_memory_search`: the notes the device's agent can see in Kriya;
// - `kriya_memory_save`: a note saved to Kriya, always unconfirmed until
//   the person confirms it there (what runs on this machine is untrusted to
//   Kriya);
// - the skill switches (src/skill-switches.js): skills the person turned off
//   for a project or everywhere leave the catalog, in every profile.
// No connector tools: those run only in Kriya's own worker (invariant 5).

export const name = "kriya-tools"
export const inject = ["tools", "skills"]

// The list is rechecked (with its ETag) at most once a minute
const LIST_TTL = 60_000
// Higher ranks lose a duplicate name: local skills come first
const RANK = 100
const SIGNED_OUT = "Kriya Harness is signed out; run kriya login to use Kriya's memory."

/** @param {{ now?: () => number }} [options] */
export function kriyaSkills({ now = Date.now } = {}) {
  let cached = null
  const bodies = new Map()

  const candidate = (skill) => ({
    name: skill.id,
    description: skill.description,
    whenToUse: `A Kriya skill (${skill.name}, v${skill.version}). Use when the request is about: ${skill.activation.keywords.slice(0, 12).join(", ")}.`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "custom",
    provider: "kriya",
    rank: RANK,
    locator: { id: skill.id, version: skill.version },
  })

  return {
    name: "kriya",
    async list({ signal } = {}) {
      const device = deviceFromEnv()
      if (!device) return []
      if (cached && now() - cached.at < LIST_TTL) return cached.candidates
      try {
        const response = await call(device.url, "GET", "/skills", {
          token: device.token,
          signal,
          raw: true,
          headers: cached ? { "If-None-Match": cached.etag } : {},
        })
        if (response.status !== 304) {
          const { skills } = await response.json()
          cached = { etag: response.headers.get("etag") ?? "", candidates: skills.map(candidate) }
        }
        cached.at = now()
        return cached.candidates
      } catch {
        // Kriya unreachable: the last list stays, and DSH keeps its last good catalog
        return { candidates: cached?.candidates ?? [], complete: false }
      }
    },
    async get(found, { signal } = {}) {
      const device = deviceFromEnv()
      const { id, version } = found.locator
      const key = `${id}@${version}`
      if (!bodies.has(key)) {
        if (!device) return undefined
        try {
          const response = await call(device.url, "GET", `/skills/${id}/${version}`, {
            token: device.token,
            signal,
            raw: true,
          })
          bodies.set(key, await response.text())
        } catch {
          return undefined
        }
      }
      const { rank: _rank, locator: _locator, ...summary } = found
      return { ...summary, content: bodies.get(key) }
    },
  }
}

const signedIn = () => {
  const device = deviceFromEnv()
  if (!device) throw new Error(SIGNED_OUT)
  return device
}

const NOTE = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    content: { type: "string", required: true },
    kind: { type: "string", required: true },
    confirmed: { type: "boolean", required: true },
    shared: { type: "boolean", required: true },
  },
}

export const memorySearch = defineTool({
  name: "kriya_memory_search",
  description:
    "Search the person's Kriya memory: the notes their Kriya agent keeps (preferences, facts, decisions). Unconfirmed notes haven't been checked by the person yet.",
  parameters: {
    query: { type: "string", required: true, description: "Words to look for, up to 500 characters." },
    limit: { type: "number", description: "How many notes, 1 to 20 (default 8)." },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { notes: { type: "array", required: true, items: NOTE } },
    },
    render: (_args, value) => [
      {
        type: "text",
        text: value.notes.length
          ? value.notes
              .map((n) => `- ${n.confirmed ? "" : "(unconfirmed) "}${n.shared ? "(shared) " : ""}${n.content}`)
              .join("\n")
          : "No notes in Kriya match that.",
      },
    ],
  },
  async execute(args, exec) {
    const device = signedIn()
    const body = {
      query: String(args.query).slice(0, 500),
      ...(args.limit !== undefined && { limit: Math.min(20, Math.max(1, Math.trunc(args.limit))) }),
    }
    const { notes } = await call(device.url, "POST", "/memory/search", {
      token: device.token,
      body,
      signal: exec.signal,
    })
    return { notes }
  },
  presentCall: (args) => ({ card: "generic", title: "Search Kriya memory", kind: "read", rawInput: String(args.query) }),
})

export const memorySave = defineTool({
  name: "kriya_memory_save",
  description:
    "Save one short note (a fact, preference or decision, up to 1000 characters) to the person's Kriya memory for their agent. It stays unconfirmed until they confirm it in Kriya. Never save passwords, card numbers, OTPs or other secrets.",
  parameters: {
    content: { type: "string", required: true, description: "The note, one fact per note." },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", required: true },
        confirmed: { type: "boolean", required: true },
      },
    },
    render: () => [
      {
        type: "text",
        text: "Saved to Kriya. It stays unconfirmed until the person confirms it in Kriya.",
      },
    ],
  },
  async execute(args, exec) {
    const device = signedIn()
    const saved = await call(device.url, "POST", "/memory", {
      token: device.token,
      body: { content: String(args.content) },
      signal: exec.signal,
    })
    return { id: saved.id, confirmed: saved.confirmed }
  },
  presentCall: (args) => ({ card: "generic", title: "Save to Kriya memory", kind: "edit", rawInput: String(args.content) }),
})

export function apply(ctx) {
  ctx.skills.registerProvider(() => kriyaSkills())
  ctx.skills.registerProvider((control) => switchProvider(control))
  ctx.tools.register(memorySearch)
  ctx.tools.register(memorySave)
}
