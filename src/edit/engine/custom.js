// Custom motion (MG2, TP9; DIRECTOR_AND_AGENT §11, EDD-44): the one place a model's design becomes a
// tile. The model never writes script: it sends CSS, a small body of allow-listed elements and its Web
// Animations as data. This file checks those parts structurally (an allow-list, not a deny-list); the
// document around them is Kriya's (motion.js customDocument), and customComposition then lints the
// whole document and puts Kriya's CSP first. Every visible word arrives through a slot, as data, so it
// is grounded by code and escaped by code (ET-SEC-02); the markup itself may hold no text at all.

export const CUSTOM_BLOCK = "custom"
export const CUSTOM_VERSION = 1
export const LIMITS = { css: 20_000, body: 20_000, elements: 400, depth: 24, animations: 24, keyframes: 32, texts: 6, text: 80, name: 40, ms: 60_000 }
// Ids Kriya's document uses itself: the model can't style or animate them
const RESERVED = new Set(["stage", "clip", "mg"])
const TAGS = new Set(["div", "span", "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"])
const ATTRS = new Set(["id", "class", "data-slot", "viewBox", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "opacity", "fill-opacity", "stroke-opacity", "transform", "preserveAspectRatio"])
const IDENT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
// An attribute's or a keyframe's value: no colon (no scheme), no slash (no //host), no quote, no backslash, no angle bracket
const VALUE = /^[A-Za-z0-9 #.,%()_+-]*$/
const EASING = /^(?:linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(\s*-?\d*\.?\d+(?:\s*,\s*-?\d*\.?\d+){3}\s*\)|steps\(\s*\d{1,3}\s*(?:,\s*(?:start|end|jump-start|jump-end|jump-none|jump-both))?\s*\))$/
const KEYFRAME_PROPS = new Set(["offset", "easing", "opacity", "transform", "color", "backgroundColor", "fill", "stroke", "strokeDashoffset", "strokeDasharray", "strokeWidth", "clipPath", "width", "height", "left", "top", "right", "bottom", "borderRadius", "filter"])
const OPTIONS = { duration: "ms", delay: "ms", endDelay: "ms", iterations: "count", easing: "easing", fill: ["none", "forwards", "backwards", "both", "auto"], direction: ["normal", "reverse", "alternate", "alternate-reverse"] }
const PSEUDO = new Set(["first-child", "last-child", "nth-child", "nth-of-type", "before", "after", "not"])

/** The parts' schema for the model: only data, no script. */
export const PARTS_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: LIMITS.name },
    css: { type: "string", maxLength: LIMITS.css },
    body: { type: "string", maxLength: LIMITS.body },
    animations: { type: "array", maxItems: LIMITS.animations, items: { type: "object" } },
    texts: { type: "array", maxItems: LIMITS.texts, items: { type: "string", maxLength: LIMITS.text } },
  },
  required: ["css", "body", "animations", "texts"],
  additionalProperties: false,
}

// Words on screen: one line of text, markup characters gone, control characters (but a newline) gone
export const cleanSlotText = (text) => String(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim()

/**
 * The body, parsed against the allow-list and written out again in a canonical form, so what renders
 * is exactly what passed. Slots come out as `<span data-slot="0" data-text>⟦0⟧</span>`, filled later.
 * @returns {{ html: string, stored: string, ids: Set<string>, slots: number[] } | { problem: string }}
 */
export function parseBody(body) {
  if (typeof body !== "string" || body.length > LIMITS.body) return { problem: `the body is text of up to ${LIMITS.body} characters` }
  const TOKEN = /<\/([A-Za-z][A-Za-z0-9]*)\s*>|<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*\s*=\s*"[^"<>]*")*)\s*(\/?)>|([^<]+)|(<)/gy
  const ATTR = /\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*"([^"<>]*)"/g
  const out = []
  const stored = [] // the same, slots empty: what a project keeps, parsed again before every render
  const stack = []
  const ids = new Set()
  const slots = []
  let elements = 0
  for (let m = TOKEN.exec(body); m; m = TOKEN.exec(body)) {
    const [, close, open, attrs, selfClose, text, stray] = m
    if (stray) return { problem: "the body has a stray <" }
    if (text !== undefined) {
      // Every visible word comes through a slot, as data; markup holds none
      if (/\S/.test(text)) return { problem: "the body has text in it; put words in `texts` and a <span data-slot> where each goes" }
      continue
    }
    if (close) {
      const tag = close.toLowerCase()
      if (stack.pop() !== tag) return { problem: `</${tag}> closes nothing open` }
      out.push(`</${tag}>`)
      stored.push(`</${tag}>`)
      continue
    }
    const tag = open.toLowerCase()
    if (!TAGS.has(tag)) return { problem: `<${tag}> isn't allowed: ${[...TAGS].join(", ")}` }
    if (++elements > LIMITS.elements) return { problem: `the body has more than ${LIMITS.elements} elements` }
    if (stack.length >= LIMITS.depth) return { problem: `the body nests deeper than ${LIMITS.depth}` }
    const parts = []
    const seen = new Set()
    let slot = null
    for (const [, rawName, value] of attrs.matchAll(ATTR)) {
      const name = rawName === "viewBox" || rawName === "preserveAspectRatio" ? rawName : rawName.toLowerCase()
      if (!ATTRS.has(name)) return { problem: `the attribute ${rawName} isn't allowed` }
      if (seen.has(name)) return { problem: `${name} is given twice` }
      seen.add(name)
      if (!VALUE.test(value) || /url\s*\(|expression|javascript/i.test(value)) return { problem: `${name}="${value.slice(0, 40)}" has characters that aren't allowed` }
      if (name === "id") {
        if (!IDENT.test(value) || RESERVED.has(value)) return { problem: `the id "${value}" isn't allowed` }
        if (ids.has(value)) return { problem: `the id "${value}" is used twice` }
        ids.add(value)
      }
      if (name === "class" && !value.split(/\s+/).filter(Boolean).every((c) => IDENT.test(c))) return { problem: `the class "${value}" isn't allowed` }
      if (name === "data-slot") {
        if (!/^[0-9]$/.test(value) || !["span", "div"].includes(tag)) return { problem: "a data-slot is a digit, on a span or a div" }
        slot = Number(value)
        if (slots.includes(slot)) return { problem: `slot ${slot} is used twice` }
        slots.push(slot)
      }
      parts.push(`${name}="${value}"`)
    }
    if (slot !== null) {
      // A slot holds its words and nothing else
      if (selfClose) return { problem: "a slot needs a closing tag" }
      const end = new RegExp(`\\s*</${tag}\\s*>`, "y")
      end.lastIndex = TOKEN.lastIndex
      if (!end.test(body)) return { problem: `slot ${slot} must be empty: its words come from \`texts\`` }
      TOKEN.lastIndex = end.lastIndex
      out.push(`<${tag} ${parts.join(" ")} data-text>⟦${slot}⟧</${tag}>`)
      stored.push(`<${tag} ${parts.join(" ")}></${tag}>`)
      continue
    }
    if (selfClose) {
      if (["div", "span"].includes(tag)) return { problem: `<${tag}/> can't close itself` }
      out.push(`<${tag}${parts.length ? ` ${parts.join(" ")}` : ""}/>`)
    } else {
      stack.push(tag)
      out.push(`<${tag}${parts.length ? ` ${parts.join(" ")}` : ""}>`)
    }
    stored.push(out.at(-1))
  }
  if (stack.length) return { problem: `<${stack.at(-1)}> is never closed` }
  return { html: out.join(""), stored: stored.join(""), ids, slots }
}

/**
 * The CSS: printable ASCII, no comments, escapes, imports, fonts, addresses or generated text; each
 * rule's prelude a selector of allowed tags, ids and classes, or one @keyframes.
 * @returns {string | null} why it is refused
 */
export function cssProblem(css) {
  if (typeof css !== "string" || css.length > LIMITS.css) return `the CSS is text of up to ${LIMITS.css} characters`
  if (/[^\x20-\x7e\n\t]/.test(css)) return "the CSS has characters outside plain ASCII"
  // No < (it could close the style element), no backslash (escapes hide words), no comments (they hide preludes)
  if (/[<\\]|\/\*|\*\//.test(css)) return "the CSS has <, a backslash or a comment"
  if (/@(?!keyframes\b)/i.test(css)) return "the only at-rule allowed is @keyframes"
  if (/\b(?:url|image|image-set|element|expression|attr|counter|counters|paint|env)\s*\(|-moz-binding|behavior\s*:/i.test(css)) return "the CSS loads, builds or reads something from outside"
  if (/\bcontent\s*:\s*(?!(?:""|''|none)\s*(?:;|}|!))/i.test(css)) return 'only an empty `content: ""` is allowed: words come from `texts`'
  if (/position\s*:\s*fixed/i.test(css)) return "position: fixed isn't allowed"
  let depth = 0
  let since = 0
  let inKeyframes = -1
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === "{") {
      const prelude = css.slice(since, i).trim()
      const why = inKeyframes >= 0 && depth > inKeyframes ? (/^(?:from|to|\d{1,3}(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d{1,3}(?:\.\d+)?%))*$/.test(prelude) ? null : `"${prelude.slice(0, 40)}" isn't a keyframe`) : preludeProblem(prelude)
      if (why) return why
      if (/^@keyframes/i.test(prelude)) {
        if (depth !== 0) return "@keyframes must be at the top level"
        inKeyframes = depth
      }
      depth++
      since = i + 1
    } else if (c === "}") {
      depth--
      if (depth < 0) return "the CSS closes a } it never opened"
      if (depth === inKeyframes) inKeyframes = -1
      since = i + 1
    } else if (c === ";") since = i + 1
  }
  if (depth !== 0) return "the CSS leaves a { open"
  return null
}

function preludeProblem(prelude) {
  if (/^@keyframes\s+[A-Za-z][A-Za-z0-9_-]{0,31}$/i.test(prelude)) return null
  if (!prelude || !/^[A-Za-z0-9#.\s>+~,:()_-]+$/.test(prelude)) return `the selector "${prelude.slice(0, 40)}" isn't allowed`
  for (const selector of prelude.split(",")) {
    const words = selector.replace(/::?([a-z-]+)(\([^)]*\))?/g, (_, name) => (PSEUDO.has(name) ? " " : " \u0000 "))
    if (words.includes("\u0000")) return `the selector "${selector.trim().slice(0, 40)}" uses a pseudo-class that isn't allowed`
    for (const id of words.matchAll(/#([A-Za-z0-9_-]+)/g)) if (RESERVED.has(id[1])) return `#${id[1]} is Kriya's own and can't be styled`
    const tags = words.replace(/[#.][A-Za-z0-9_-]+/g, " ").split(/[\s>+~]+/).filter(Boolean)
    for (const tag of tags) if (!TAGS.has(tag.toLowerCase())) return `the selector names "${tag}", which isn't an allowed element`
  }
  return null
}

/** The animations as data: each on an element of the body, keyframes of allowed properties and values, finite. @returns {string | null} */
export function animationsProblem(animations, ids) {
  if (!Array.isArray(animations) || animations.length > LIMITS.animations) return `animations is a list of up to ${LIMITS.animations}`
  for (const [i, a] of animations.entries()) {
    const at = `animation ${i + 1}`
    if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => !["id", "keyframes", "options"].includes(k))) return `${at} is { id, keyframes, options }`
    if (typeof a.id !== "string" || !ids.has(a.id)) return `${at} animates an id the body doesn't have`
    if (!Array.isArray(a.keyframes) || a.keyframes.length < 1 || a.keyframes.length > LIMITS.keyframes) return `${at} has 1 to ${LIMITS.keyframes} keyframes`
    for (const frame of a.keyframes) {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return `${at}: a keyframe is an object`
      for (const [key, value] of Object.entries(frame)) {
        if (!KEYFRAME_PROPS.has(key)) return `${at}: the property ${key} isn't allowed`
        if (key === "offset") {
          if (typeof value !== "number" || !(value >= 0 && value <= 1)) return `${at}: an offset is a number from 0 to 1`
        } else if (key === "easing") {
          if (typeof value !== "string" || !EASING.test(value)) return `${at}: that easing isn't allowed`
        } else if (typeof value === "number") {
          if (!Number.isFinite(value)) return `${at}: ${key} isn't a finite number`
        } else if (typeof value !== "string" || value.length > 200 || !VALUE.test(value) || /url\s*\(|expression|attr\s*\(/i.test(value)) return `${at}: ${key} has characters that aren't allowed`
      }
    }
    const options = a.options ?? {}
    if (typeof options !== "object" || Array.isArray(options)) return `${at}: options is an object`
    for (const [key, value] of Object.entries(options)) {
      const rule = OPTIONS[key]
      if (!rule) return `${at}: the option ${key} isn't allowed`
      if (rule === "ms" && !(Number.isInteger(value) && value >= 0 && value <= LIMITS.ms)) return `${at}: ${key} is whole milliseconds up to ${LIMITS.ms}`
      // Finite only, so every frame of the tile is decided by its time (no "Infinity" that never ends)
      if (rule === "count" && !(Number.isInteger(value) && value >= 1 && value <= 50)) return `${at}: iterations is a whole number from 1 to 50`
      if (rule === "easing" && !(typeof value === "string" && EASING.test(value))) return `${at}: that easing isn't allowed`
      if (Array.isArray(rule) && !rule.includes(value)) return `${at}: ${key} is one of ${rule.join(", ")}`
    }
    if (!Number.isInteger(options.duration) || options.duration < 1) return `${at} needs a duration in whole milliseconds`
  }
  return null
}

/**
 * Every structural problem of a model's parts, or none. Words are checked by the caller (they need the
 * transcript); here only that each text has its slot and each slot its text.
 * @returns {{ problems: string[], parsed?: { html: string, ids: Set<string>, slots: number[] }, texts?: string[] }}
 */
export function partsProblems(parts) {
  if (!parts || typeof parts !== "object" || Array.isArray(parts)) return { problems: ["the answer is { css, body, animations, texts }"] }
  const problems = []
  const parsed = parseBody(parts.body)
  if (parsed.problem) problems.push(parsed.problem)
  const css = cssProblem(parts.css)
  if (css) problems.push(css)
  if (!parsed.problem) {
    const why = animationsProblem(parts.animations, parsed.ids)
    if (why) problems.push(why)
  }
  const texts = Array.isArray(parts.texts) ? parts.texts.map(cleanSlotText) : null
  if (!texts || texts.length > LIMITS.texts || texts.some((t) => !t || t.length > LIMITS.text)) problems.push(`texts is a list of up to ${LIMITS.texts} non-empty lines of up to ${LIMITS.text} characters`)
  else if (!parsed.problem) {
    for (let i = 0; i < texts.length; i++) if (!parsed.slots.includes(i)) problems.push(`text ${i} has no <span data-slot="${i}">`)
    for (const slot of parsed.slots) if (slot >= texts.length) problems.push(`slot ${slot} has no text`)
  }
  if (parts.name !== undefined && (typeof parts.name !== "string" || parts.name.length > LIMITS.name)) problems.push(`a name is up to ${LIMITS.name} characters`)
  return problems.length ? { problems } : { problems, parsed, texts }
}

/** The stored block's variables, from parts that passed: canonical body, cleaned texts. */
export function customVariables(parts) {
  const { problems, parsed, texts } = partsProblems(parts)
  if (problems.length) return null
  const name = typeof parts.name === "string" ? parts.name.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, LIMITS.name) : ""
  return { ...(name ? { name } : {}), css: parts.css, body: parsed.stored, animations: parts.animations, texts }
}
