// Mentions (ASSEMBLY_AND_INTENT §4.2): pointing at a clip in chat. Typing @ opens the clip
// picker; a clip dragged onto the chat box lands as the same token, with its stretch when it
// has one: "@1 0:12–0:20". On send the tokens become numbered places and a typed list the
// Host checks. Labels and file names are untrusted text: only ever textContent.

import { h } from "./dom.js"
import { FLICKS } from "./time.js"

/** What a dragged clip carries: { asset, from?, to?, part? } as JSON. */
export const CLIP_MIME = "application/x-kriya-clip"

const TOKEN = /(?<![\p{L}\p{N}])@(\d{1,3})(?: (\d+:\d{2}(?:\.\d)?)–(\d+:\d{2}(?:\.\d)?))?/gu

/** "0:12", or "0:12.5" when it isn't on a whole second. */
export function clock(flicks) {
  const tenths = Math.round((Math.max(0, flicks) * 10) / FLICKS)
  const seconds = Math.floor(tenths / 10)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${tenths % 10 ? `.${tenths % 10}` : ""}`
}
const flicksOf = (text) => {
  const [minutes, seconds] = text.split(":")
  return Math.round((Number(minutes) * 60 + Number(seconds)) * FLICKS)
}

export const chipText = (number, range) => `@${number}${range ? ` ${clock(range.from)}–${clock(range.to)}` : ""}`

/** The @… being typed just before the caret, or null. */
export function mentionQuery(text, caret) {
  const match = /(?:^|[^\p{L}\p{N}@])@([\p{L}\p{N}]*)$/u.exec(text.slice(0, caret))
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null
}

/** The clips a query could mean: by number first, then by label or file name. Eight at most. */
export function pickClips(clips, query) {
  const asked = query.toLocaleLowerCase()
  if (!asked) return clips.slice(0, 8)
  const byNumber = clips.filter((clip) => String(clip.number).startsWith(asked))
  const byName = clips.filter((clip) => !byNumber.includes(clip) && clip.name.toLocaleLowerCase().includes(asked))
  return [...byNumber, ...byName].slice(0, 8)
}

/**
 * A clip's small picture. A video's is the first tile of its sheet of thumbnails; a sound has none.
 * Set through the style property: the Studio's CSP refuses style attributes.
 * @param {{ thumb?: { url: string, sheet: boolean } | null } | undefined} clip
 */
export function thumbEl(clip) {
  const thumb = h("span", { class: `thumb${clip?.thumb?.sheet ? " sheet" : ""}`, "aria-hidden": "true" }, clip?.thumb ? null : "♪")
  if (clip?.thumb) thumb.style.backgroundImage = `url("${clip.thumb.url}")`
  return thumb
}

/** A message split at its tokens, so the chat can draw each one as a chip. */
export function tokensIn(text) {
  const out = []
  let last = 0
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) })
    out.push({ text: match[0], number: Number(match[1]) })
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/**
 * The message as the Host takes it: each token of a known clip becomes ⟦n⟧, with the clip and
 * its stretch in the list. A token for no clip stays as typed.
 * @param {{ asset: string, number: number }[]} clips
 * @param {Map<string, { from: number, to: number }>} [exact] a dropped stretch's own flicks, by its token
 * @returns {{ text: string, mentions: { asset: string, from?: number, to?: number }[] }}
 */
export function toMessage(text, clips, exact = new Map()) {
  const mentions = []
  const out = text.replace(TOKEN, (token, number, from, to) => {
    const clip = clips.find((item) => item.number === Number(number))
    if (!clip) return token
    const range = exact.get(token) ?? (from ? { from: flicksOf(from), to: flicksOf(to) } : null)
    mentions.push({ asset: clip.asset, ...(range ? { from: range.from, to: range.to } : {}) })
    return `⟦${mentions.length}⟧`
  })
  return { text: out, mentions }
}

/**
 * The picker and the drop target on the chat box.
 * @param {{ input: HTMLTextAreaElement, clips: () => { asset: string, number: number, name: string, thumb?: object }[] }} options
 * @returns {{ el: HTMLElement, open: boolean, insert: (mention: object) => void, take: (text: string) => object }}
 */
export function attachMentions({ input, clips }) {
  const list = h("ul", { class: "mention-list", id: "mention-list", role: "listbox", "aria-label": "Clips to mention", hidden: true })
  const exact = new Map()
  let options = []
  let active = 0
  let query = null
  input.setAttribute("aria-controls", "mention-list")
  input.setAttribute("aria-autocomplete", "list")
  input.setAttribute("aria-expanded", "false")

  const close = () => {
    query = null
    list.hidden = true
    list.replaceChildren()
    input.setAttribute("aria-expanded", "false")
    input.removeAttribute("aria-activedescendant")
  }
  const put = (text, start, end) => {
    input.setRangeText(text, start, end, "end")
    input.focus()
  }
  const choose = (clip) => {
    if (clip && query) put(`${chipText(clip.number)} `, query.start, input.selectionStart)
    close()
  }
  function draw() {
    list.replaceChildren(
      ...options.map((clip, i) => {
        // mousedown, not click: the chat box keeps its focus and its caret
        return h("li", { class: "mention-option", role: "option", id: `mention-${i}`, "aria-selected": String(i === active), onmousedown: (event) => (event.preventDefault(), choose(clip)) }, thumbEl(clip), h("span", { class: "badge" }, String(clip.number)), h("span", { class: "name" }, clip.name))
      }),
    )
    list.hidden = false
    input.setAttribute("aria-expanded", "true")
    input.setAttribute("aria-activedescendant", `mention-${active}`)
  }
  function refresh() {
    query = mentionQuery(input.value, input.selectionStart)
    options = query ? pickClips(clips(), query.query) : []
    if (!options.length) return close()
    active = Math.min(active, options.length - 1)
    draw()
  }
  input.addEventListener("input", refresh)
  input.addEventListener("blur", close)
  // Before the chat's own keys: with the picker open, Enter chooses and Escape only closes it
  input.addEventListener(
    "keydown",
    (event) => {
      if (list.hidden) return
      const move = { ArrowDown: 1, ArrowUp: -1 }[event.key]
      if (move) active = (active + move + options.length) % options.length
      else if (event.key === "Enter" || event.key === "Tab") choose(options[active])
      else if (event.key === "Escape") close()
      else return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (move) draw()
    },
    true,
  )

  /** Puts a clip's token at the caret; a stretch keeps its exact flicks for the send. */
  function insert({ asset, from, to }) {
    const clip = clips().find((item) => item.asset === asset)
    if (!clip) return
    const range = Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from ? { from, to } : null
    const token = chipText(clip.number, range)
    if (range) exact.set(token, range)
    const at = input.selectionStart
    put(`${at > 0 && !/\s$/.test(input.value.slice(0, at)) ? " " : ""}${token} `, at, input.selectionEnd)
  }
  input.addEventListener("dragover", (event) => event.dataTransfer?.types.includes(CLIP_MIME) && event.preventDefault())
  input.addEventListener("drop", (event) => {
    const data = event.dataTransfer?.getData(CLIP_MIME)
    if (!data) return
    event.preventDefault()
    try {
      insert(JSON.parse(data))
    } catch {
      // Not a clip: nothing to add
    }
  })

  return {
    el: list,
    get open() {
      return !list.hidden
    },
    insert,
    take: (text) => toMessage(text, clips(), exact),
  }
}
