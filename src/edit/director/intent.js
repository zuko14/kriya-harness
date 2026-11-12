// The intent frame (TP4, ASSEMBLY_AND_INTENT §7, EDD-61), behind editing.intent: what the person
// asked for, in any language, read by the model inside the call that already happens for the
// message (the plan's, or the console's: never a second call, EH-64), each field with the exact
// words it came from. Code keeps a field only when those words are in the message, numbers
// included, and code's own reading of the message wins where both read one. Whatever no field
// covers is listed as "Not in this cut", never dropped. Questions are choices with a default.

export const MAX_QUESTIONS = 2

// Digits in the scripts people here write numbers in read as ASCII, so "౬౦" and "६०" are the 60 a value says:
// ASCII, Arabic-Indic, Persian, Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, full-width
const ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10]
const digits = (text) =>
  String(text).replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0)
    const zero = ZEROS.find((z) => code >= z && code < z + 10)
    return zero === undefined ? d : String(code - zero)
  })
// NFC, lower case, one space, digits as ASCII: the same message typed or pasted reads the same
export const plain = (text) => digits(String(text ?? "").normalize("NFC").toLocaleLowerCase().replace(/\s+/g, " ").trim())

/** True when `evidence` is literally a piece of `message` and holds every number of `value`. */
export function grounded(evidence, message, value) {
  const quote = plain(evidence)
  if (quote.length < 2) return false
  // Literally in the message, and never part of a longer number: "60" isn't in "600"
  const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (!new RegExp(`${/^\d/.test(quote) ? "(?<!\\d)" : ""}${escaped}${/\d$/.test(quote) ? "(?!\\d)" : ""}`, "u").test(plain(message))) return false
  const numbers = String(typeof value === "object" ? JSON.stringify(value) : value).match(/\d+/g) ?? []
  return numbers.every((n) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(quote))
}

/** A plan setting's schema → the values a field may take; the fields are the plan's own settings. */
export function fieldsOf(settingsSchema) {
  return Object.fromEntries(Object.entries(settingsSchema.properties).filter(([, s]) => s.enum || s.type === "integer" || s.type === "boolean").map(([key, s]) => [key, s]))
}
const fits = (schema, value) =>
  schema.enum ? schema.enum.includes(value) : schema.type === "integer" ? Number.isInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity) : schema.type === "boolean" ? typeof value === "boolean" : false

/** The `intent` property added to a schema; its values are checked by code after, not trusted from here. */
export function intentSchema(fields) {
  const keys = Object.keys(fields)
  const value = { anyOf: [{ type: "string", maxLength: 64 }, { type: "integer" }, { type: "boolean" }] }
  const quote = { type: "string", maxLength: 300 }
  return {
    type: "object",
    properties: {
      understood: { type: "array", maxItems: 12, items: { type: "object", properties: { field: { type: "string", enum: keys }, value, evidence: quote }, required: ["field", "value", "evidence"], additionalProperties: false } },
      cannot: { type: "array", maxItems: 8, items: { type: "object", properties: { evidence: quote, nearest: { type: "string", maxLength: 160 } }, required: ["evidence"], additionalProperties: false } },
      questions: { type: "array", maxItems: 4, items: { type: "object", properties: { field: { type: "string", enum: keys }, question: { type: "string", maxLength: 160 }, options: { type: "array", minItems: 2, maxItems: 4, items: value }, default: value, evidence: quote }, required: ["field", "question", "options", "default", "evidence"], additionalProperties: false } },
    },
    required: ["understood", "cannot", "questions"],
    additionalProperties: false,
  }
}

/**
 * The model's `intent` cut to what the schema allows, before the schema sees it: a malformed item is
 * dropped here, so the frame never costs a repair call or sinks the plan it rides in (EH-64).
 */
export function tidyIntent(intent, fields) {
  const quote = (v) => typeof v === "string" && v.length > 0 && v.length <= 300
  const primitive = (v) => (typeof v === "string" && v.length <= 64) || Number.isInteger(v) || typeof v === "boolean"
  const list = (v, max) => (Array.isArray(v) ? v.filter((item) => item && typeof item === "object").slice(0, max) : [])
  return {
    understood: list(intent?.understood, 12).filter((u) => Object.hasOwn(fields, u.field) && primitive(u.value) && quote(u.evidence)).map(({ field, value, evidence }) => ({ field, value, evidence })),
    cannot: list(intent?.cannot, 8).filter((c) => quote(c.evidence)).map(({ evidence, nearest }) => ({ evidence, ...(typeof nearest === "string" && nearest.length <= 160 ? { nearest } : {}) })),
    questions: list(intent?.questions, 4).filter((q) => Object.hasOwn(fields, q.field) && typeof q.question === "string" && q.question.length <= 160 && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && q.options.every(primitive) && primitive(q.default) && quote(q.evidence)).map(({ field, question, options, default: chosen, evidence }) => ({ field, question, options, default: chosen, evidence })),
  }
}

export const INTENT_PROMPT =
  "Also fill `intent`, in any language the person used: `understood` lists each setting they asked for (field, value, and `evidence`: the exact words of their message it comes from, copied as they wrote them); `cannot` lists every piece of their message no setting can do, as the exact words (`evidence`) and, if there is one, the nearest thing these settings can do (`nearest`); `questions` holds a choice only where their words could mean two settings and the answer changes the cut (field, a short question, two to four options, a default, and the words it is about). Never put a word in `evidence` that they didn't write."

const clean = (text, max) => String(text ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)

/**
 * The model's frame, checked against the message and merged with code's reading.
 * @param {object | undefined} intent the model's `intent`
 * @param {{ message: string, fields: Record<string, object>, code: Record<string, unknown>, answers?: Record<string, unknown> }} context
 *   code: what code read from the person's words (it wins); answers: questions already answered on this plan (never asked again)
 * @returns {{ understood: object[], cannot: object[], questions: object[], defaulted: object[], dropped: object[], apply: Record<string, unknown> }}
 *   apply: the settings to set, code's and the kept fields', with answers over both
 */
export function readIntent(intent, { message, fields, code = {}, answers = {} }) {
  const understood = []
  const dropped = []
  const apply = {}
  for (const [field, value] of Object.entries(code)) if (Object.hasOwn(fields, field)) apply[field] = value
  for (const item of Array.isArray(intent?.understood) ? intent.understood : []) {
    const schema = fields[item?.field]
    if (!schema || !fits(schema, item.value)) {
      dropped.push({ field: String(item?.field ?? ""), reason: "not a setting a plan can make" })
      continue
    }
    if (!grounded(item.evidence, message, item.value)) {
      dropped.push({ field: item.field, reason: "its words aren't in the message" })
      continue
    }
    // Code read this field too: code's reading wins, and the card shows what it understood
    if (Object.hasOwn(code, item.field)) {
      understood.push({ field: item.field, value: code[item.field], evidence: clean(item.evidence, 300), by: "code", ...(code[item.field] !== item.value ? { model: item.value } : {}) })
      continue
    }
    apply[item.field] = item.value
    understood.push({ field: item.field, value: item.value, evidence: clean(item.evidence, 300), by: "model" })
  }
  for (const field of Object.keys(code)) if (Object.hasOwn(fields, field) && !understood.some((u) => u.field === field)) understood.push({ field, value: code[field], evidence: null, by: "code" })
  const cannot = (Array.isArray(intent?.cannot) ? intent.cannot : []).filter((c) => grounded(c?.evidence, message, "")).map((c) => ({ said: clean(c.evidence, 300), ...(c.nearest ? { nearest: clean(c.nearest, 160) } : {}) }))
  // A question needs words of the message, two real options and a default among them; one per field
  const open = []
  for (const q of Array.isArray(intent?.questions) ? intent.questions : []) {
    const schema = fields[q?.field]
    if (!schema || Object.hasOwn(answers, q.field) || Object.hasOwn(code, q.field) || open.some((o) => o.field === q.field)) continue
    const options = [...new Set((q.options ?? []).filter((o) => fits(schema, o)))]
    if (options.length < 2 || !grounded(q.evidence, message, "")) continue
    open.push({ field: q.field, question: clean(q.question, 160), options, default: options.includes(q.default) ? q.default : options[0], about: clean(q.evidence, 300) })
  }
  const questions = open.slice(0, MAX_QUESTIONS)
  const defaulted = open.slice(MAX_QUESTIONS).map((q) => ({ field: q.field, question: q.question, value: q.default, why: "default" }))
  // An open choice is made by its default until the person answers; an answer stands over everything
  for (const q of [...questions, ...defaulted]) if (!Object.hasOwn(apply, q.field)) apply[q.field] = q.default ?? q.value
  for (const [field, value] of Object.entries(answers)) if (fields[field] && fits(fields[field], value)) apply[field] = value
  return { understood, cannot, questions, defaulted, dropped, apply }
}
