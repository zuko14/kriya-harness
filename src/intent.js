// The intent router's brief (plugins/router; Kriya-Tavi
// docs/kriya-harness/INTENT_ROUTER_AND_LONG_HORIZON.md): from the person's
// request, by code, which skills of the live catalog are likely to help
// (BM25 over each skill's name, description and when-to-use) and which tools
// to start with (fixed intent classes, naming only tools this agent has).
// It hides nothing and adds no tool: a short hint the model may ignore, so a
// weak model starts with the right skill and the project's check instead of
// guessing. Deterministic: the same request and catalog give the same brief.

const STOP = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so that the their them then there these this to us was we were what when where which who why will with would you your".split(" ")
)

/** Lower-case word stems: letters and digits, simple plural and -ing/-ed endings dropped */
export function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => {
      const base = w.replace(/(ies)$/, "y")
      const stem = base.replace(/(ing|ed|es|s)$/, (m, _e, _i, str) => (str.length - m.length >= 3 ? "" : m))
      // "debugging" → "debugg" → "debug", "running" → "run" (not "ll", "ss", "zz")
      return stem !== base && /(ing|ed)$/.test(base) && /([b-df-hj-km-np-rtv-y])\1$/.test(stem) ? stem.slice(0, -1) : stem
    })
}

/**
 * BM25 over the catalog (k1 1.2, b 0.75). A skill's name parts count twice:
 * a name is the most deliberate routing signal it has.
 * @param {string} query
 * @param {Array<{ name: string, description?: string, whenToUse?: string }>} skills
 * @returns {Array<{ name: string, score: number }>} positive scores, best first, ties by name
 */
export function rankSkills(query, skills) {
  const q = [...new Set(tokens(query))]
  if (!q.length || !skills.length) return []
  const docs = skills.map((s) => {
    const name = tokens(s.name.replace(/-/g, " "))
    return [...name, ...name, ...tokens(s.description), ...tokens(s.whenToUse)]
  })
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]))
  const N = docs.length
  return skills
    .map((s, i) => {
      const d = docs[i]
      let score = 0
      for (const t of q) {
        const f = d.filter((w) => w === t).length
        if (!f) continue
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5))
        score += idf * ((f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * d.length) / avg)))
      }
      return { name: s.name, score: Math.round(score * 1000) / 1000 }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// Intent classes: words that signal them, and the tools to start with (each
// tool listed only if this agent has it), in the order to use them
export const INTENTS = [
  { id: "fix", label: "fix a failure", words: ["bug", "error", "fail", "failing", "broken", "crash", "fix", "exception", "regression", "wrong", "doesn't", "not working", "issue"], tools: [["kriya_verify", "reproduce the failure first"], ["grep", "find where it happens"], ["read", "read the code"], ["edit", "fix the cause once"]] },
  { id: "build", label: "build something new", words: ["add", "build", "implement", "create", "feature", "support", "new", "make"], tools: [["kriya_plan", "plan it if it has several parts"], ["glob", "see how the project is laid out"], ["read", "follow the existing patterns"], ["write", "add files"], ["edit", "change files"]] },
  { id: "test", label: "tests", words: ["test", "tests", "coverage", "spec", "tdd", "unit"], tools: [["kriya_verify", "run the project's check"], ["read", "read the existing tests"]] },
  { id: "refactor", label: "restructure code", words: ["refactor", "rename", "clean", "simplify", "migrate", "move", "split", "extract", "reorganize"], tools: [["grep", "find every caller first"], ["kriya_plan", "plan it in checkable steps"], ["edit", "change files"]] },
  { id: "web", label: "a web page or UI", words: ["page", "ui", "button", "form", "css", "layout", "frontend", "browser", "localhost", "react", "component", "screen", "style", "html"], tools: [["browser_open", "open the running app"], ["browser_read", "see its text and elements"], ["browser_screenshot", "see its layout"], ["browser_console", "check for errors"]] },
  { id: "review", label: "review", words: ["review", "pr", "pull request", "diff", "audit", "check my"], tools: [["bash", "git diff to see the change"], ["read", "read the connected code"]] },
  { id: "explain", label: "explain or find", words: ["explain", "what", "how", "why", "understand", "where", "find", "show", "describe", "overview"], tools: [["glob", "see the layout"], ["grep", "find the place"], ["read", "read it"]] },
  { id: "git", label: "git", words: ["commit", "branch", "push", "merge", "rebase", "git", "stash", "cherry-pick"], tools: [["bash", "git status first; ask before commit or push"]] },
  { id: "security", label: "security", words: ["auth", "login", "password", "token", "secret", "injection", "xss", "csrf", "security", "permission", "vulnerab"], tools: [["grep", "find where untrusted input enters"], ["read", "follow it"]] },
]

// A request about a shipped artifact rather than source: words only this kind of work uses
const REVERSE = /\b(reverse[- ]engineer\w*|decompil\w*|disassembl\w*|deobfuscat\w*|binary analysis|ghidra|frida|apk|ipa|asar|dylib|mach-?o|pcap|firmware (image|dump)|what does this (binary|app)|how does (this|the) (binary|electron app))\b|\.(exe|dll|so|wasm|elf)\b/i

/** Whether a request is reverse-engineering work (plugins/rea) */
export const isReverseEngineering = (request) => REVERSE.test(String(request ?? ""))

/** The request's intents, strongest first (at most two), by whole-word or phrase matches */
export function classify(request) {
  const text = ` ${String(request ?? "").toLowerCase().replace(/\s+/g, " ")} `
  return INTENTS.map((intent) => ({
    intent,
    // Short words whole (so "pr" isn't "print"); longer ones as word starts ("fail" in "failing")
    score: intent.words.filter((w) => new RegExp(`[^a-z]${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${w.length <= 3 ? "(?![a-z])" : ""}`).test(text)).length,
  }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || INTENTS.indexOf(a.intent) - INTENTS.indexOf(b.intent))
    .slice(0, 2)
    .map((r) => r.intent)
}

const MAX_SKILLS = 4
export const MAX_BRIEF = 700

/**
 * The brief for one request, or "" when nothing is worth saying.
 * @param {string} request the person's latest message
 * @param {Array<{ name: string, description?: string, whenToUse?: string, invocation?: { modelInvocable?: boolean } }>} skills the live catalog
 * @param {Iterable<string>} toolNames the tools this agent has
 */
export function brief(request, skills, toolNames) {
  const have = new Set(toolNames)
  const usable = skills.filter((s) => s.invocation?.modelInvocable !== false)
  const intents = classify(request)
  // The intents' own words join the query, so "it crashes" finds debugging skills
  const query = [request, ...intents.map((i) => i.label)].join(" ")
  const picked = rankSkills(query, usable).slice(0, MAX_SKILLS).map((r) => r.name)
  const seen = new Set()
  const tools = intents
    .flatMap((i) => i.tools)
    .filter(([name]) => have.has(name) && !seen.has(name) && seen.add(name))
    .slice(0, 5)
  if (!picked.length && !tools.length) return ""
  const lines = ["Routing for this request, chosen by Kriya Harness from its words (a hint, not a rule):"]
  if (intents.length) lines.push(`Intent: ${intents.map((i) => i.label).join("; ")}.`)
  if (picked.length) lines.push(`Skills likely to help: ${picked.join(", ")}.${have.has("skill") ? " Load the ones that fit with the skill tool before you start." : ""}`)
  if (tools.length) lines.push(`Start with: ${tools.map(([name, why]) => `${name} (${why})`).join(", ")}.`)
  if (have.has("kriya_verify") && intents.some((i) => ["fix", "build", "test", "refactor"].includes(i.id))) lines.push("Finish with kriya_verify: only its result says the work passes.")
  const text = lines.join("\n")
  return text.length > MAX_BRIEF ? `${text.slice(0, MAX_BRIEF - 1)}…` : text
}
