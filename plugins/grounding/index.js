import { defineTool } from "@deepseek-ai/dsh-tools"

import { projectRoot } from "../../src/skill-switches.js"
import { apiChanges, apiLookup, apiVersion, GroundingError, hasInstalled } from "./lookup.js"

// Harness 2.0 W15, grounding (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// GROUNDING_AND_CONNECTORS.md §5, WD-20): three read-only tools that answer
// facts about the packages this project has installed from their own files,
// and one line in a late system-prompt section naming them. Cheap models fail
// most on APIs that moved in the installed version; these give the fact
// instead of another guess. Nothing is imported or executed, nothing leaves
// the machine. Off unless kriya was started with --grounding
// (KRIYA_GROUNDING=on): off, no tool or section exists.

export const name = "kriya-grounding"
export const inject = ["tools", "workingDirectory", "systemPrompt"]

const OBJECT = { schema: { type: "object", additionalProperties: true, properties: {} } }
const PACKAGE = { type: "string", required: true, description: "The package's name as installed, e.g. react, @supabase/supabase-js, requests." }

export const HINT =
  "Before calling a package's API you aren't sure of, check the installed version's facts: api_lookup (a signature and its doc comment), api_changes (what changed since the version the project declares) and api_version. They read the project's own installed files, so they're exact for this project."

export function groundingTools(host) {
  const guarded = (fn) => async (args, exec) => {
    if (!exec.agent) throw new GroundingError("This tool needs a session.")
    return fn(projectRoot(await host.cwd(exec)), args ?? {})
  }
  return [
    defineTool({
      name: "api_lookup",
      description: "The installed version's declaration of an exported name in a package, with its doc comment: from its TypeScript type definitions (or @types), or Python .pyi stubs. Reads files only.",
      parameters: { package: PACKAGE, symbol: { type: "string", required: true, description: "The exported name, e.g. createClient, useEffect, Session." } },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: v.text }] },
      execute: guarded((root, args) => apiLookup(root, args.package, args.symbol)),
      presentCall: (args) => ({ card: "generic", title: "Look up an API", kind: "read", rawInput: `${args.package ?? ""} ${args.symbol ?? ""}`.trim() }),
    }),
    defineTool({
      name: "api_changes",
      description: "What changed in a package between the version the project declares (or `since`) and the one installed, from the package's own changelog.",
      parameters: { package: PACKAGE, since: { type: "string", description: "The version the code was written for, if not the declared one, e.g. 4.2.0." } },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: v.text }] },
      execute: guarded((root, args) => apiChanges(root, args.package, args.since)),
      presentCall: (args) => ({ card: "generic", title: "Package changes", kind: "read", rawInput: String(args.package ?? "") }),
    }),
    defineTool({
      name: "api_version",
      description: "A package's declared range, locked version and installed version in this project.",
      parameters: { package: PACKAGE },
      output: { ...OBJECT, render: (_a, v) => [{ type: "text", text: [`${v.package}:`, v.declared && `declared ${v.declared}`, v.locked && `locked ${v.locked}`, v.installed ? `installed ${v.installed}` : (v.note ?? "not installed")].filter(Boolean).join(" ") }] },
      execute: guarded((root, args) => apiVersion(root, args.package)),
      presentCall: (args) => ({ card: "generic", title: "Package version", kind: "read", rawInput: String(args.package ?? "") }),
    }),
  ]
}

export function apply(ctx) {
  const folders = new WeakMap()
  const host = {
    async cwd(exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      folders.set(exec.agent, cwd)
      return cwd
    },
  }
  for (const tool of groundingTools(host)) ctx.tools.register(tool)
  // One line, late (after DSH's suffix), only in a project with installed packages
  ctx.systemPrompt.section({
    name: "kriya:grounding",
    order: 10260,
    interpolate: false,
    text: ({ scope }) => {
      const cwd = scope && (folders.get(scope) ?? scope.session?.header?.cwd)
      try {
        return cwd && hasInstalled(projectRoot(cwd)) ? HINT : ""
      } catch {
        return ""
      }
    },
  })
}
