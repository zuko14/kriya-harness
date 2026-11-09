// The transcript (L2 words, L5 flags): one button per word. A click seeks to the
// word's first frame; Shift+click selects a run, and Delete cuts it from the edit.
// Double-click (or F2) fixes a word the recogniser misheard: Enter keeps it, Escape doesn't.
// Fillers, stutters and takes that lost are struck through, never hidden: the
// person sees what Kriya would cut. Words are untrusted text: only ever textContent.

import { clear, h } from "./dom.js"

const STRUCK = new Set(["filler", "stutter", "restart"])

/**
 * @param {{ root: HTMLElement, onSeek: (word: object) => void, onCut: (first: object, last: object) => void, onFix?: (word: object, text: string) => Promise<void> }} options
 */
export function createTranscript({ root, onSeek, onCut, onFix = async () => {} }) {
  let words = []
  let byId = new Map()
  let anchor = null
  let selected = []
  let current = null

  const mark = () => {
    for (const el of root.querySelectorAll(".word[aria-pressed='true']")) el.setAttribute("aria-pressed", "false")
    for (const id of selected) root.querySelector(`[data-word="${CSS.escape(id)}"]`)?.setAttribute("aria-pressed", "true")
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest(".word")
    if (!el) return
    const word = byId.get(el.dataset.word)
    if (event.shiftKey && anchor) {
      const [a, b] = [words.indexOf(anchor), words.indexOf(word)].sort((x, y) => x - y)
      selected = words.slice(a, b + 1).filter((w) => w.asset === word.asset).map((w) => w.id)
    } else {
      anchor = word
      selected = [word.id]
      onSeek(word)
    }
    mark()
  })

  /** Swaps a word for a field with its text; the word comes back on Enter, Escape or leaving it. */
  function fix(el) {
    const word = byId.get(el.dataset.word)
    if (!word) return
    const input = h("input", { class: "word-edit", value: word.text, size: String(Math.max(4, word.text.length + 2)), maxlength: "60", "aria-label": `Fix the word "${word.text}"` })
    el.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = async (keep) => {
      if (done) return
      done = true
      const text = input.value.trim()
      input.replaceWith(el)
      if (keep && text && text !== word.text) await onFix(word, text)
      else el.focus()
    }
    input.addEventListener("keydown", (event) => {
      event.stopPropagation()
      if (event.key === "Enter") (event.preventDefault(), finish(true))
      else if (event.key === "Escape") (event.preventDefault(), finish(false))
    })
    input.addEventListener("blur", () => finish(true))
  }

  root.addEventListener("dblclick", (event) => {
    const el = event.target.closest(".word")
    if (el) fix(el)
  })

  root.addEventListener("keydown", (event) => {
    if (event.key === "F2" && event.target.closest(".word")) {
      event.preventDefault()
      event.stopPropagation()
      return fix(event.target.closest(".word"))
    }
    if ((event.key === "Backspace" || event.key === "Delete") && selected.length) {
      event.preventDefault()
      event.stopPropagation()
      onCut(byId.get(selected[0]), byId.get(selected.at(-1)))
    }
  })

  return {
    /** @param {{ words: object[], sentences: object[], takes: object[] }} index from GET /projects/{id}/index */
    load({ words: list = [], sentences = [], takes = [] }) {
      words = list
      byId = new Map(list.map((w) => [w.id, w]))
      selected = selected.filter((id) => byId.has(id))
      const best = new Map(takes.map((t) => [t.sentence, t]))
      clear(root)
      if (!list.length) {
        root.append(h("p", { class: "note" }, "No transcript yet. Index a clip in the bin to read its words."))
        return
      }
      // Without L5 there are words and no sentences: one line per asset
      const lines = sentences.length ? sentences : [...new Set(list.map((w) => w.asset))].map((asset) => {
        const own = list.filter((w) => w.asset === asset)
        return { id: null, asset, firstWord: own[0].id, lastWord: own.at(-1).id, score: 1 }
      })
      for (const s of lines) {
        const take = best.get(s.id)
        const lost = (take && take.rank > 1) || s.score === 0
        const first = Number(s.firstWord.split(":w")[1])
        const last = Number(s.lastWord.split(":w")[1])
        const line = h("p", { class: `sentence${lost ? " lost" : ""}`, dataset: s.id ? { sentence: s.id } : {} })
        if (take) line.append(h("span", { class: "tag" }, take.rank === 1 ? "best take" : `take ${take.rank}`))
        for (let n = first; n <= last; n++) {
          const word = byId.get(`${s.asset}:w${n}`)
          if (!word) continue
          const struck = lost || word.flags.some((flag) => STRUCK.has(flag))
          const label = struck ? `${word.text} (${lost ? "retake" : word.flags.filter((f) => STRUCK.has(f)).join(", ")})` : null
          const fixed = typeof word.heard === "string"
          const el = h("button", { type: "button", class: `word${struck ? " struck" : ""}${!fixed && word.flags.includes("low_confidence") ? " unsure" : ""}${fixed ? " fixed" : ""}`, "aria-pressed": "false", "aria-label": label ?? (fixed ? `${word.text} (fixed; heard as ${word.heard})` : null), title: fixed ? `Heard as "${word.heard}". Double-click to change.` : "Double-click to fix this word", dataset: { word: word.id } })
          el.textContent = word.text
          line.append(el, " ")
        }
        root.append(line)
      }
      mark()
    },
    /** Highlights the word playing now; null when the playhead isn't on one. */
    playing(id) {
      if (id === current) return
      root.querySelector(".word.now")?.classList.remove("now")
      current = id
      if (id) root.querySelector(`[data-word="${CSS.escape(id)}"]`)?.classList.add("now")
    },
    words: () => words,
    /** The selected run as [first id, last id], or null: what "this" means in a request. */
    selection: () => (selected.length ? [selected[0], selected.at(-1)] : null),
    clear() {
      selected = []
      anchor = null
      mark()
    },
  }
}
