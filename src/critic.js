import { Ajv2020 } from "ajv/dist/2020.js"

// Harness 2.0 W6, the critic (Kriya-Tavi docs/kriya-harness/upgrade_2.0/
// ARCHITECTURE.md §4, WD-13). After a step passes every hard gate, a fresh,
// read-only child on the head level judges the work against the role's
// judgement items (taste code can't measure). It answers with JSON defects
// only. It never decides pass, fail or done: a major defect earns one polish
// attempt, which the loop keeps only if every check and gate still passes.

export const MAX_DEFECTS = 12
export const CRITIC_MS = 90_000

const SCHEMA = {
  type: "object",
  required: ["defects"],
  additionalProperties: false,
  properties: {
    defects: {
      type: "array",
      maxItems: MAX_DEFECTS,
      items: {
        type: "object",
        required: ["severity", "where", "fix"],
        additionalProperties: false,
        properties: {
          id: { type: "string", maxLength: 60 },
          severity: { enum: ["major", "minor"] },
          where: { type: "string", minLength: 1, maxLength: 200 },
          fix: { type: "string", minLength: 1, maxLength: 300 },
        },
      },
    },
  },
}
const validate = new Ajv2020({ strict: false, allErrors: false }).compile(SCHEMA)

/** What the critic is told: the role's judgement items, the step, what changed and what the gates noted. */
export function critiquePrompt({ role, judgement = [], plan, n, changed = [], notes = [] }) {
  const step = plan?.steps?.[n - 1]
  return [
    `You are reviewing one finished step as the best ${role ?? "engineer"} you know would. You can read files; you change nothing and run nothing.`,
    "Every automatic check already passed. Judge only what they can't: the standards below.",
    "",
    ...(plan ? [`Goal of the task: ${plan.goal}`] : []),
    ...(step ? [`The step: ${n}. ${step.title}`, `It is done when: ${step.doneWhen}`] : []),
    ...(changed.length ? ["", `Files the work changed: ${changed.slice(0, 40).join(", ")}`] : []),
    ...(notes.length ? ["", "What the checks noted (warnings, not failures):", ...notes.slice(0, 12).map((x) => `- ${x}`)] : []),
    "",
    "Standards for this role:",
    ...(judgement.length ? judgement.map((j) => `- ${j.id ? `${j.id}: ` : ""}${j.ask} (${j.severity})`) : ["- The result is what a person asking for it would be proud to ship."]),
    "",
    `Answer with JSON only, no other text: {"defects":[{"id":"<standard id>","severity":"major"|"minor","where":"<file:line or screen>","fix":"<one sentence>"}]}, at most ${MAX_DEFECTS}. Use major only for what a principal would block the step for. No defects: {"defects":[]}.`,
  ].join("\n")
}

/** The critic's defects from its answer; anything that isn't exactly the schema counts as none. */
export function parseDefects(text) {
  const s = String(text ?? "")
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start === -1 || end <= start) return []
  try {
    const value = JSON.parse(s.slice(start, end + 1))
    return validate(value) ? value.defects : []
  } catch {
    return []
  }
}

/** The lines a polish builder gets about the defects. */
export function polishSection(defects) {
  return [
    "",
    "This step already passes every check. A reviewer judged it against this role's standards and found these major defects:",
    ...defects.map((d) => `- ${d.where}: ${d.fix}${d.id ? ` (${d.id})` : ""}`),
    "Fix them without changing behaviour the checks cover. The harness keeps your change only if every check and gate still passes; otherwise it puts the files back as they were.",
  ]
}
