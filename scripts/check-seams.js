import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// HU-SEAM-01 (harness upgrade U5): the DeepSeek Harness seams Kriya's
// plugins and rows depend on, checked in the installed DSH. A DSH bump that
// renames or drops one fails here with the seam's name and who depends on
// it, before any behaviour test has to be read. Behaviour itself is proven
// by tests/upgrade-run.test.js and tests/drills-run.test.js on the same pin.
// The bump checklist: docs/kriya-harness/harness_upgradation/DSH_UPGRADE.md
// in the Kriya repository.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const DSH = join(ROOT, "node_modules", "@deepseek-ai")

export const SEAMS = [
  {
    seam: "agent/pre-step waterfall can reject a step",
    file: "dsh-agent/lib/types/runtime-types.d.ts",
    must: [/'agent\/pre-step'\(/, /kind: 'reject'/],
    users: "plugins/budget (turn budget, U2)",
  },
  {
    seam: "a local file's version ends in its ctime, and the intent waterfalls can be wrapped",
    file: "dsh-fs-local/lib/index.js",
    must: [/FsVersion\(`\$\{info\.dev\}:\$\{info\.ino\}:\$\{info\.size\}:\$\{info\.mtimeNs\}:\$\{info\.ctimeNs\}`\)/],
    users: "plugins/fs-freshness (edits after a metadata-only change)",
  },
  {
    seam: "agent/turn-stopping and Agent.steer",
    file: "dsh-agent/lib/types/runtime-types.d.ts",
    must: [/'agent\/turn-stopping'\(/, /steer\(message: UserMessage\): void/],
    users: "plugins/loop recheckHook (U8)",
  },
  {
    seam: "agent/inbox/inserted carries the agent and the message",
    file: "dsh-agent/lib/types/runtime-types.d.ts",
    must: [/'agent\/inbox\/inserted'\(this: Scoped<Agent>, payload: \{\s*agent: Agent;\s*message: UserMessage;/],
    users: "plugins/anchor (U7)",
  },
  {
    seam: "tools/pre-execute and tools/post-execute waterfalls",
    file: "dsh-tools/lib/types/index.d.ts",
    must: [/'tools\/pre-execute'\(/, /'tools\/post-execute'\(this: Scoped<ToolRuntime>, exec: ToolExecution, result:/],
    users: "plugins/approvals, plugins/loop checkpoints, plugins/budget repeats",
  },
  {
    seam: "createUserMessage exported by dsh-llm",
    file: "dsh-llm/lib/types/message.d.ts",
    must: [/export declare function createUserMessage/],
    users: "plugins/budget, plugins/loop",
  },
  {
    seam: "system-prompt sections: text provider with the assembly's scope",
    file: "dsh-system-prompt/lib/types/index.d.ts",
    must: [/readonly text: string \| \(\(context: AssembleContext\) => string\)/, /scope\?: ScopeKey/],
    users: "plugins/anchor (U7)",
  },
  {
    seam: "context overflow recognised from `context_length_exceeded`",
    file: "dsh-llm/lib/index.js",
    must: [/STRUCTURED_CONTEXT_OVERFLOW = new RegExp/],
    check: (text) => {
      // The pattern itself, applied to what the gateway sends (U1)
      const source = /STRUCTURED_CONTEXT_OVERFLOW = new RegExp\((String\.raw`[^`]*`) \+ (String\.raw`[^`]*`), "i"\)/.exec(text)
      if (!source) return "the overflow pattern's shape changed"
      const re = new RegExp(new Function(`return ${source[1]} + ${source[2]}`)(), "i")
      return re.test('400 "context_length_exceeded"') ? null : "no longer matches 400 \"context_length_exceeded\""
    },
    users: "lib/harness/gateway.ts in Kriya (U1)",
  },
  {
    seam: "compaction-basic per-model headroomTokens",
    file: "dsh-compaction-basic/lib/index.js",
    must: [/modelPolicies/, /headroomTokens/],
    users: "bundle compaction-basic row (U3)",
  },
  {
    seam: "pi-ai route defaults (262,144 window, the base of WORKING_WINDOW)",
    file: "dsh-llm-pi-ai/lib/index.js",
    must: [/defaultContextWindow: source\.defaultContextWindow \?\? 262144/],
    users: "src/launch.js WORKING_WINDOW (U3)",
  },
  {
    seam: "the agent loop still has no turn budget of its own",
    file: "dsh-agent-loop/README.md",
    must: [/No built-in turn budget/],
    users: "plugins/budget: if DSH adds one, compare and drop ours (KU-ADR-04)",
  },
  {
    seam: "a child agent can be told from its owner and its tools masked before its first step",
    file: "dsh-agent/lib/index.js",
    must: [/isOwnedBy\(id, owner\)/],
    users: "plugins/loop (--jit-tools)",
  },
  {
    seam: "sidebar.panellist: a list slot of global panel rows, each opening its main panel",
    file: "dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts",
    must: [/'sidebar\.panellist': \{\s*kind: 'list';/],
    users: "plugins/edit (Editing Studio row, ED6), plugins/projects",
  },
  {
    seam: "connection.fetch.register: an exact route inside Connection's fence, owner peers only",
    file: "dsh-client-connection/lib/types/rpc.d.ts",
    must: [/register\(route: ConnectionFetchRoute\): \(\) => Promise<void>;/, /readonly fetch: \(request: Request\) => Promise<Response>;/, /a 403 response for an exact route and a non-owner Peer/],
    users: "plugins/edit (POST /api/kriya.edit.launch, ED6), plugins/projects and the other page routes",
  },
  {
    seam: "tools.restrict masks tools on one agent's context",
    file: "dsh-tools/lib/index.js",
    must: [/restrict\(filter\)/],
    users: "plugins/loop (--jit-tools)",
  },
]

/**
 * @param {(file: string) => string | null} read the file's text, null when missing
 * @returns {string[]} one line per broken seam
 */
export function seamProblems(read, seams = SEAMS) {
  const problems = []
  for (const s of seams) {
    const text = read(s.file)
    const missing = text === null ? "file missing" : s.must.filter((re) => !re.test(text)).map((re) => `no ${re}`).join("; ") || s.check?.(text) || null
    if (missing) problems.push(`${s.seam} (${s.file}): ${missing}. Used by ${s.users}`)
  }
  return problems
}

export const readInstalled = (file) => {
  try {
    return readFileSync(join(DSH, file), "utf8")
  } catch {
    return null
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = seamProblems(readInstalled)
  for (const problem of problems) console.error(`seams: ${problem}`)
  if (problems.length) process.exit(1)
  console.log(`seams: all ${SEAMS.length} DSH seams Kriya depends on are present`)
}
