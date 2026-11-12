// The storyboard (ASSEMBLY_AND_INTENT §4.1): the assembly, drawn. A strip of cards in the
// film's order, with the clips not used under it. Every action is one set_assembly, so
// Cmd+Z undoes it. Labels and file names are untrusted text: only ever textContent.

import { clear, h } from "./dom.js"
import { CLIP_MIME, clock, thumbEl } from "./mentions.js"

const SPINE = ["story", "whole"]
// auto is nothing chosen: the make fills a clip of the film's shape, follows a face, and otherwise blurs behind (TP2, §6.2)
export const FITS = { auto: "Automatic", fill: "Fill the frame", fit: "Fit, with bars", blur: "Fit, blur behind" }

export const partsOf = (project) => project.sequences.find((q) => q.id === project.active)?.assembly?.parts ?? []
export const spineOf = (parts) => parts.filter((part) => SPINE.includes(part.use))

/** The one operation any storyboard action sends. */
export const assemblyOp = (parts) => ({ op: "set_assembly", assembly: { version: 1, parts } })

/** A part one place earlier (-1) or later (1) in the film's order. @returns {object[] | null} null at either end */
export function movePart(parts, id, by) {
  const spine = spineOf(parts)
  const from = spine.findIndex((part) => part.id === id)
  const other = spine[from + by]
  if (from < 0 || !other) return null
  const next = [...parts]
  const a = next.indexOf(spine[from])
  const b = next.indexOf(other)
  ;[next[a], next[b]] = [next[b], next[a]]
  return next
}

/** A part dropped before another (null: at the end). @returns {object[] | null} null when nothing moves */
export function placePart(parts, id, before) {
  const part = parts.find((item) => item.id === id)
  if (!part || id === before) return null
  const rest = parts.filter((item) => item !== part)
  const at = before === null ? rest.length : rest.findIndex((item) => item.id === before)
  if (at < 0) return null
  const next = [...rest.slice(0, at), part, ...rest.slice(at)]
  return next.every((item, i) => item === parts[i]) ? null : next
}

/** Without a part, and without anything that played over it. */
export const removePart = (parts, id) => parts.filter((part) => part.id !== id && part.at?.part !== id)

/** A clip added to the film, whole or as a stretch, before another part or at the end. */
export function addPart(parts, { asset, from, to }, before = null) {
  let n = parts.length + 1
  while (parts.some((part) => part.id === `p${n}`)) n++
  const ranged = Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from
  const part = { id: `p${n}`, asset, ...(ranged ? { from, to } : {}), use: "whole", why: "storyboard" }
  return placePart([...parts, part], part.id, before) ?? [...parts, part]
}

/** Automatic is the absence of the key (a default is never written); a choice, fill included, is the person's and is stored. */
export function fitPart(parts, id, fit) {
  return parts.map((part) => {
    if (part.id !== id) return part
    const { fit: _was, ...rest } = part
    return fit === "auto" ? rest : { ...rest, fit }
  })
}

// A stretch's edge as flicks: a time, or a word of the transcript
const edgeOf = (ref, words, edge) => (typeof ref === "number" ? ref : (words.find((word) => word.id === ref?.word)?.[ref?.edge ?? edge] ?? null))

/** "whole", or "0:12–0:20". */
export function stretchOf(part, words = []) {
  if (part.from === undefined && part.to === undefined) return "whole"
  const from = part.from === undefined ? 0 : edgeOf(part.from, words, "start")
  const to = part.to === undefined ? null : edgeOf(part.to, words, "end")
  return `${from === null ? "?" : clock(from)}–${to === null ? "end" : clock(to)}`
}

/** What a screen reader hears: "Part 2 of 4: clip 3, demo, whole, 0:18". */
export function partLabel(part, i, total, clip, words = []) {
  const from = part.from === undefined ? 0 : edgeOf(part.from, words, "start")
  const to = part.to === undefined ? (clip?.duration ?? null) : edgeOf(part.to, words, "end")
  const length = from === null || to === null ? null : clock(to - from)
  return [`Part ${i + 1} of ${total}: clip ${clip?.number ?? "?"}`, clip?.name, part.use, length].filter(Boolean).join(", ")
}

/**
 * @param {{ root: HTMLElement, clips: () => object[], words: () => object[], onChange: (parts: object[]) => void }} options
 *   clips: [{ asset, number, name, duration, thumb? }], the project's clips in number order
 */
export function createStoryboard({ root, clips, words, onChange }) {
  let parts = []
  let focus = null // the part to put the focus back on after the next draw
  const cards = h("ol", { class: "sb-cards", "aria-label": "The film's order" })
  const unused = h("ul", { class: "sb-unused", "aria-label": "Clips not used" })
  const empty = h("p", { class: "note small" }, "Nothing in the storyboard yet. Add clips in the order the film should play.")
  const said = h("p", { class: "sr-only", role: "status", "aria-live": "polite" })

  const send = (next, keep = null, announce = "") => {
    if (!next) return
    focus = keep
    said.textContent = announce
    onChange(next)
  }
  const carried = (event) => {
    try {
      return JSON.parse(event.dataTransfer.getData(CLIP_MIME))
    } catch {
      return null
    }
  }
  const allow = (event) => event.dataTransfer?.types.includes(CLIP_MIME) && event.preventDefault()
  // A card moves; a bin row or a stretch of the transcript is added
  const dropBefore = (before) => (event) => {
    const drop = carried(event)
    if (!drop) return
    event.preventDefault()
    event.stopPropagation()
    if (drop.part) send(placePart(parts, drop.part, before), drop.part, "Moved.")
    else if (clips().some((clip) => clip.asset === drop.asset)) send(addPart(parts, drop, before), null, "Added to the film.")
  }

  function draw() {
    const byAsset = new Map(clips().map((clip) => [clip.asset, clip]))
    const spine = spineOf(parts)
    clear(cards)
    spine.forEach((part, i) => {
      const clip = byAsset.get(part.asset)
      const fit = h("select", { class: "field select", "aria-label": `How clip ${clip?.number ?? "?"} fits the frame`, onchange: () => send(fitPart(parts, part.id, fit.value), part.id) }, Object.entries(FITS).map(([value, label]) => h("option", { value }, label)))
      fit.value = part.fit ?? "auto"
      const card = h(
        "div",
        {
          class: "sb-card",
          role: "group",
          tabindex: "0",
          draggable: "true",
          "aria-label": partLabel(part, i, spine.length, clip, words()),
          "aria-keyshortcuts": "Alt+ArrowLeft Alt+ArrowRight Delete",
          dataset: { part: part.id },
          ondragstart: (event) => event.dataTransfer.setData(CLIP_MIME, JSON.stringify({ part: part.id, asset: part.asset, ...(typeof part.from === "number" && typeof part.to === "number" ? { from: part.from, to: part.to } : {}) })),
          onkeydown: (event) => {
            // Only the card's own keys: its buttons and its menu keep theirs
            if (event.target !== card) return
            const by = event.altKey ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key] : null
            if (by) send(movePart(parts, part.id, by), part.id, `Part ${i + 1 + by} of ${spine.length}.`)
            else if (event.key === "Delete" || event.key === "Backspace") send(removePart(parts, part.id), spine[i + 1]?.id ?? spine[i - 1]?.id ?? null, "Left out of the film.")
            else return
            // The transport has these keys too (a frame back, delete the clip): not from here
            event.preventDefault()
            event.stopPropagation()
          },
        },
        thumbEl(clip),
        h("span", { class: "badge" }, String(clip?.number ?? "?")),
        h("span", { class: "name" }, clip?.name ?? "A missing clip"),
        h("span", { class: "stretch label-mono" }, stretchOf(part, words())),
        fit,
        h(
          "span",
          { class: "sb-moves" },
          h("button", { type: "button", class: "btn move", disabled: i === 0, "aria-label": `Move clip ${clip?.number ?? "?"} up`, onclick: () => send(movePart(parts, part.id, -1), part.id, `Part ${i} of ${spine.length}.`) }, "Move up"),
          h("button", { type: "button", class: "btn move", disabled: i === spine.length - 1, "aria-label": `Move clip ${clip?.number ?? "?"} down`, onclick: () => send(movePart(parts, part.id, 1), part.id, `Part ${i + 2} of ${spine.length}.`) }, "Move down"),
          h("button", { type: "button", class: "btn", "aria-label": `Leave clip ${clip?.number ?? "?"} out of the film`, onclick: () => send(removePart(parts, part.id), spine[i + 1]?.id ?? spine[i - 1]?.id ?? null, "Left out of the film.") }, "Remove"),
        ),
      )
      cards.append(h("li", { ondragover: allow, ondrop: dropBefore(part.id) }, card))
    })
    empty.hidden = spine.length > 0
    const used = new Set(parts.map((part) => part.asset))
    clear(unused)
    for (const clip of clips().filter((item) => !used.has(item.asset))) {
      unused.append(
        h(
          "li",
          {},
          h("button", { type: "button", class: "btn sb-add", draggable: "true", "aria-label": `Add clip ${clip.number}, ${clip.name}, to the film`, ondragstart: (event) => event.dataTransfer.setData(CLIP_MIME, JSON.stringify({ asset: clip.asset })), onclick: () => send(addPart(parts, { asset: clip.asset }), null, `Added clip ${clip.number} to the film.`) }, h("span", { class: "badge" }, String(clip.number)), h("span", { class: "name" }, clip.name), h("span", { "aria-hidden": "true" }, " +")),
        ),
      )
    }
    if (!unused.children.length) unused.append(h("li", { class: "note small" }, clips().length ? "Every clip is in the film." : "Add files to the project first."))
    if (focus) cards.querySelector(`[data-part="${CSS.escape(focus)}"]`)?.focus()
    focus = null
  }

  root.append(h("h2", {}, "Storyboard"), cards, empty, h("h3", { class: "sb-head" }, "Not used"), unused, said)
  // Dropped past the last card: at the end. Dropped on "Not used": out of the film
  cards.addEventListener("dragover", allow)
  cards.addEventListener("drop", dropBefore(null))
  root.addEventListener("dragover", allow)
  unused.addEventListener("drop", (event) => {
    const drop = carried(event)
    if (!drop?.part) return
    event.preventDefault()
    send(removePart(parts, drop.part), null, "Left out of the film.")
  })

  return {
    /** @param {object} project the project as it is now */
    load(project) {
      parts = partsOf(project)
      draw()
    },
  }
}
